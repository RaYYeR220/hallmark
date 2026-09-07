/**
 * x402 endpoint probe.
 *
 * A correct x402 endpoint answers an unpaid GET with `402` and a machine
 * readable challenge, so 402 is the success case here and a 200 is the
 * suspicious one. Two wire formats are in the wild and both are parsed: v2
 * puts a base64 JSON document in a `PAYMENT-REQUIRED` response header, v1
 * puts the same document in the 402 body (and some servers echo an
 * `X-PAYMENT`-shaped header instead).
 *
 * The prober never pays. It reads the price and walks away.
 */

import { httpRequestWithRetry } from './http.ts'
import type { HttpOptions } from './http.ts'
import type { ProtocolOutcome, RequestTrace, X402Challenge } from '../types.ts'

export type X402Source = 'header:payment-required' | 'header:x-payment' | 'header:www-authenticate' | 'body'

export type X402Parsed = { challenge: X402Challenge; source: X402Source; accepts: number }

export type ChallengeInput = {
  status: number
  headers: Headers | Record<string, string>
  body: string
}

export function parseX402Challenge(input: ChallengeInput): X402Parsed | null {
  const get = headerReader(input.headers)

  const candidates: Array<{ source: X402Source; raw: string | null }> = [
    { source: 'header:payment-required', raw: get('payment-required') },
    { source: 'header:x-payment', raw: get('x-payment') ?? get('x-payment-required') },
    { source: 'header:www-authenticate', raw: stripAuthScheme(get('www-authenticate')) },
    { source: 'body', raw: input.body.trim() === '' ? null : input.body },
  ]

  for (const candidate of candidates) {
    if (candidate.raw === null) continue
    const document = decodeChallengeDocument(candidate.raw)
    if (document === null) continue
    // The `payment-required` header is the v2 wire form, so a document that
    // arrives there and forgets to say `x402Version` is v2, not v1.
    const challenge = fromDocument(document, candidate.source === 'header:payment-required' ? 2 : 1)
    if (challenge === null) continue
    return { challenge: challenge.challenge, source: candidate.source, accepts: challenge.accepts }
  }

  return null
}

export async function probeX402(endpoint: string, opts: HttpOptions = {}): Promise<ProtocolOutcome> {
  const requests: RequestTrace[] = []
  const res = await httpRequestWithRetry(endpoint, {
    ...opts,
    method: 'GET',
    headers: { accept: 'application/json, */*;q=0.5' },
  })
  requests.push(res.trace)

  const { status, headers, text: body } = res

  if (headers !== null && status !== null) {
    const parsed = parseX402Challenge({ status, headers, body })
    if (parsed !== null) {
      return {
        // A 402 with a valid challenge is the endpoint working exactly as
        // advertised, so it counts as reachable even though it is a 4xx.
        ok: true,
        protocolOk: status === 402,
        // A decodable challenge is the whole test; the status code only
        // decides whether the server framed it correctly.
        protocolLive: true,
        failure: null,
        detail:
          status === 402
            ? null
            : `challenge served with HTTP ${status} rather than 402 (${parsed.source})`,
        status,
        latencyMs: res.latencyMs,
        requests,
        capabilities: { x402: parsed.challenge },
      }
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      protocolOk: false,
      protocolLive: false,
      failure: res.status === 402 ? 'bad-protocol' : res.failure,
      detail: res.status === 402 ? 'answered 402 but carried no parseable x402 challenge' : res.detail,
      status: res.status,
      latencyMs: res.latencyMs,
      requests,
      capabilities: {},
    }
  }

  return {
    ok: false,
    protocolOk: false,
    protocolLive: false,
    failure: 'bad-protocol',
    detail: `declared x402 but answered HTTP ${res.status} with no payment challenge`,
    status: res.status,
    latencyMs: res.latencyMs,
    requests,
    capabilities: {},
  }
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function headerReader(headers: Headers | Record<string, string>): (name: string) => string | null {
  if (typeof (headers as Headers).get === 'function') {
    return (name) => {
      const value = (headers as Headers).get(name)
      return value === null || value.trim() === '' ? null : value.trim()
    }
  }
  const lowered = new Map<string, string>()
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    lowered.set(key.toLowerCase(), value)
  }
  return (name) => {
    const value = lowered.get(name.toLowerCase())
    return value === undefined || value.trim() === '' ? null : value.trim()
  }
}

/** `WWW-Authenticate: Payment realm="x", challenge="<base64>"` and friends. */
function stripAuthScheme(value: string | null): string | null {
  if (value === null) return null
  if (!/^(payment|x-payment|x402)\b/i.test(value)) return null
  const quoted = /(?:challenge|payment)\s*=\s*"([^"]+)"/i.exec(value)
  if (quoted?.[1] !== undefined) return quoted[1]
  return value.replace(/^(payment|x-payment|x402)\s*/i, '')
}

/** The document may arrive as JSON, as base64 JSON, or as base64url JSON. */
function decodeChallengeDocument(raw: string): Record<string, unknown> | null {
  const direct = tryJson(raw)
  if (direct !== null) return direct

  const compact = raw.replace(/\s+/g, '')
  if (compact === '' || !/^[A-Za-z0-9+/=_-]+$/.test(compact)) return null
  try {
    let normalized = compact.replace(/-/g, '+').replace(/_/g, '/')
    const remainder = normalized.length % 4
    if (remainder === 2) normalized += '=='
    else if (remainder === 3) normalized += '='
    else if (remainder === 1) return null
    return tryJson(atob(normalized))
  } catch {
    return null
  }
}

function tryJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return { accepts: parsed }
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    return null
  } catch {
    return null
  }
}

function fromDocument(
  document: Record<string, unknown>,
  defaultVersion: number,
): { challenge: X402Challenge; accepts: number } | null {
  const version = numberOf(document['x402Version'] ?? document['x402_version'] ?? document['version'])

  const accepts = Array.isArray(document['accepts'])
    ? (document['accepts'] as unknown[])
    : Array.isArray(document['paymentRequirements'])
      ? (document['paymentRequirements'] as unknown[])
      : isRecord(document['accepts'])
        ? [document['accepts']]
        : null

  const requirements = accepts !== null ? accepts.find(isRecord) : looksLikeRequirement(document) ? document : null
  if (requirements === undefined || requirements === null) return null

  const scheme = stringOf(requirements['scheme']) ?? 'exact'
  const network = stringOf(requirements['network']) ?? stringOf(document['network']) ?? ''
  const payTo = stringOf(requirements['payTo'] ?? requirements['pay_to'] ?? requirements['payToAddress']) ?? ''
  const asset = stringOf(requirements['asset'] ?? requirements['token'] ?? requirements['assetAddress']) ?? ''
  const priceAtomic =
    stringOf(
      requirements['maxAmountRequired'] ??
        requirements['max_amount_required'] ??
        requirements['amountAtomic'] ??
        requirements['amount'] ??
        requirements['price'],
    ) ?? ''

  // A document with no price, no payee and no network is not a challenge, it is
  // some other JSON that happened to be sitting behind a 402.
  if (priceAtomic === '' && payTo === '' && network === '') return null

  return {
    challenge: {
      x402Version: version ?? defaultVersion,
      scheme,
      network,
      priceAtomic,
      asset,
      payTo,
      maxTimeoutSeconds:
        numberOf(requirements['maxTimeoutSeconds'] ?? requirements['max_timeout_seconds']) ?? null,
      // v1 carries `resource` as a string inside each requirement; v2 hoists it
      // to the document as `{ url, description?, mimeType? }`.
      resource: readResource(requirements['resource'] ?? document['resource']),
    },
    accepts: accepts?.length ?? 1,
  }
}

function readResource(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (isRecord(value)) return stringOf(value['url'] ?? value['uri'] ?? value['resource'])
  return null
}

function looksLikeRequirement(document: Record<string, unknown>): boolean {
  return (
    document['payTo'] !== undefined ||
    document['maxAmountRequired'] !== undefined ||
    document['scheme'] !== undefined
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'bigint') return value.toString()
  return null
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
