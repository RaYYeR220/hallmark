/**
 * What a validator sees when it visits an agent's declared endpoints.
 *
 * Each probe answers one question and returns a verdict a developer can act
 * on. The interesting distinction is between *unreachable* (nothing answered)
 * and *malformed* (something answered, but not the protocol it claimed) —
 * those have completely different fixes, and a checker that collapses them
 * into "failed" is not worth running.
 *
 * All three are read-only and all three go through `safeFetch`, so private
 * hosts, redirect loops and unbounded bodies are refused before anything is
 * sent.
 */

import { BlockedUrlError, HallmarkError } from './errors.js'
import { TimeoutError, messageOf, safeFetch, type SafeFetchOptions } from './net.js'

export type ProbeStatus = 'ok' | 'unreachable' | 'malformed' | 'refused'

export type ProbeOutcome = {
  status: ProbeStatus
  httpStatus: number | null
  latencyMs: number
  /** One sentence, written for the developer who has to fix it. */
  detail: string
  finalUrl: string | null
  evidence: Record<string, unknown>
}

export type ProbeOptions = Pick<
  SafeFetchOptions,
  'timeoutMs' | 'maxRedirects' | 'maxBytes' | 'fetchImpl' | 'lookup' | 'allowHttp'
>

const USER_AGENT = 'hallmark-doctor/0.1 (+https://github.com/hallmark)'

/* ------------------------------------------------------------------ */
/* A2A                                                                 */
/* ------------------------------------------------------------------ */

/**
 * An A2A endpoint is usable if an agent card can be read from it. Two layouts
 * are accepted, in this order: the URL itself serves the card, or the card
 * lives at `/.well-known/agent-card.json` under the same origin. The second is
 * what most A2A servers do when the declared endpoint is the JSON-RPC root.
 */
export async function probeA2A(endpoint: string, opts: ProbeOptions = {}): Promise<ProbeOutcome> {
  const attempts = [endpoint, wellKnownCardUrl(endpoint)].filter(
    (url, index, all) => url !== null && all.indexOf(url) === index,
  ) as string[]

  let last: ProbeOutcome | null = null

  for (const url of attempts) {
    const result = await attemptA2A(url, opts)
    if (result.status === 'ok' || result.status === 'refused') return result
    last = last === null || rank(result) < rank(last) ? result : last
  }

  return (
    last ?? {
      status: 'unreachable',
      httpStatus: null,
      latencyMs: 0,
      detail: 'no A2A URL to probe',
      finalUrl: null,
      evidence: {},
    }
  )
}

async function attemptA2A(url: string, opts: ProbeOptions): Promise<ProbeOutcome> {
  const fetched = await tryFetch(url, { ...opts, headers: { accept: 'application/json', 'user-agent': USER_AGENT } })
  if ('failure' in fetched) return fetched.failure

  const { response } = fetched
  if (response.status >= 400) {
    return {
      status: 'unreachable',
      httpStatus: response.status,
      latencyMs: response.latencyMs,
      detail: `HTTP ${response.status} from ${response.finalUrl}`,
      finalUrl: response.finalUrl,
      evidence: {},
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(response.body)
  } catch {
    return {
      status: 'malformed',
      httpStatus: response.status,
      latencyMs: response.latencyMs,
      detail: `answered ${response.status} but the body is not JSON (${describeBody(response.body)})`,
      finalUrl: response.finalUrl,
      evidence: { contentType: response.headers['content-type'] ?? null },
    }
  }

  if (!isRecord(parsed)) {
    return {
      status: 'malformed',
      httpStatus: response.status,
      latencyMs: response.latencyMs,
      detail: 'the body is JSON but not an object, so it cannot be an agent card',
      finalUrl: response.finalUrl,
      evidence: {},
    }
  }

  const missing = ['name', 'url', 'version'].filter((key) => typeof parsed[key] !== 'string')
  const skills = Array.isArray(parsed['skills'])
    ? parsed['skills']
        .map((skill) => (isRecord(skill) && typeof skill['id'] === 'string' ? skill['id'] : null))
        .filter((id): id is string => id !== null)
    : []

  if (typeof parsed['name'] !== 'string') {
    return {
      status: 'malformed',
      httpStatus: response.status,
      latencyMs: response.latencyMs,
      detail: 'the body is JSON but has no "name", so it is not an A2A agent card',
      finalUrl: response.finalUrl,
      evidence: { keys: Object.keys(parsed).slice(0, 12) },
    }
  }

  return {
    status: 'ok',
    httpStatus: response.status,
    latencyMs: response.latencyMs,
    detail:
      skills.length > 0
        ? `agent card "${parsed['name']}" with ${skills.length} skill${skills.length === 1 ? '' : 's'}`
        : `agent card "${parsed['name']}" declaring no skills`,
    finalUrl: response.finalUrl,
    evidence: {
      name: parsed['name'],
      skills,
      ...(missing.length > 0 ? { missingFields: missing } : {}),
    },
  }
}

function wellKnownCardUrl(endpoint: string): string | null {
  try {
    const url = new URL(endpoint)
    if (url.pathname.endsWith('agent-card.json') || url.pathname.endsWith('agent.json')) return null
    return new URL('/.well-known/agent-card.json', url.origin).toString()
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

export const MCP_PROTOCOL_VERSION = '2025-06-18'

/**
 * An MCP endpoint is usable if it completes `initialize` and then answers
 * `tools/list` with at least one tool. Streamable HTTP servers may reply with
 * either `application/json` or an SSE frame, and may hand back a session id
 * that later calls have to echo; both are handled.
 */
export async function probeMCP(endpoint: string, opts: ProbeOptions = {}): Promise<ProbeOutcome> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'user-agent': USER_AGENT,
  }

  const initialized = await tryFetch(endpoint, {
    ...opts,
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'hallmark-doctor', version: '0.1.0' },
      },
    }),
  })
  if ('failure' in initialized) return initialized.failure

  const initResponse = initialized.response
  if (initResponse.status >= 400) {
    return {
      status: 'unreachable',
      httpStatus: initResponse.status,
      latencyMs: initResponse.latencyMs,
      detail: `initialize returned HTTP ${initResponse.status}`,
      finalUrl: initResponse.finalUrl,
      evidence: {},
    }
  }

  const initMessage = parseJsonRpc(initResponse.body)
  if (initMessage === null) {
    return {
      status: 'malformed',
      httpStatus: initResponse.status,
      latencyMs: initResponse.latencyMs,
      detail: `initialize answered ${initResponse.status} but the body is not a JSON-RPC message (${describeBody(initResponse.body)})`,
      finalUrl: initResponse.finalUrl,
      evidence: {},
    }
  }
  if (isRecord(initMessage['error'])) {
    return {
      status: 'malformed',
      httpStatus: initResponse.status,
      latencyMs: initResponse.latencyMs,
      detail: `initialize failed: ${String(initMessage['error']['message'] ?? 'unknown error')}`,
      finalUrl: initResponse.finalUrl,
      evidence: { error: initMessage['error'] },
    }
  }

  const serverInfo = isRecord(initMessage['result']) ? initMessage['result']['serverInfo'] : undefined
  const sessionId = initResponse.headers['mcp-session-id']
  const sessionHeaders: Record<string, string> =
    sessionId === undefined ? headers : { ...headers, 'mcp-session-id': sessionId }

  // Required by the spec before any non-initialize request. Servers answer 202
  // with no body; a failure here is not fatal on its own.
  await tryFetch(endpoint, {
    ...opts,
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })

  const listed = await tryFetch(endpoint, {
    ...opts,
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  })
  if ('failure' in listed) {
    return {
      ...listed.failure,
      detail: `initialize succeeded but tools/list ${listed.failure.detail}`,
      status: listed.failure.status === 'refused' ? 'refused' : 'malformed',
    }
  }

  const listMessage = parseJsonRpc(listed.response.body)
  const tools =
    listMessage !== null && isRecord(listMessage['result']) && Array.isArray(listMessage['result']['tools'])
      ? listMessage['result']['tools']
          .map((tool) => (isRecord(tool) && typeof tool['name'] === 'string' ? tool['name'] : null))
          .filter((name): name is string => name !== null)
      : null

  if (tools === null) {
    return {
      status: 'malformed',
      httpStatus: listed.response.status,
      latencyMs: initResponse.latencyMs + listed.response.latencyMs,
      detail: 'initialize succeeded but tools/list did not return a tools array',
      finalUrl: listed.response.finalUrl,
      evidence: { serverInfo: serverInfo ?? null },
    }
  }

  const total = initResponse.latencyMs + listed.response.latencyMs
  if (tools.length === 0) {
    return {
      status: 'malformed',
      httpStatus: listed.response.status,
      latencyMs: total,
      detail: 'the handshake completes but the server exposes no tools, so there is nothing to call',
      finalUrl: listed.response.finalUrl,
      evidence: { serverInfo: serverInfo ?? null, tools: [] },
    }
  }

  return {
    status: 'ok',
    httpStatus: listed.response.status,
    latencyMs: total,
    detail: `initialize + tools/list succeeded, ${tools.length} tool${tools.length === 1 ? '' : 's'} exposed`,
    finalUrl: listed.response.finalUrl,
    evidence: { serverInfo: serverInfo ?? null, tools, sessionId: sessionId ?? null },
  }
}

/**
 * Streamable HTTP allows either a plain JSON body or an SSE stream whose
 * `data:` lines carry the JSON-RPC messages.
 */
function parseJsonRpc(body: string): Record<string, unknown> | null {
  const direct = tryParseObject(body)
  if (direct !== null) return direct

  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const parsed = tryParseObject(line.slice(5).trim())
    if (parsed !== null) return parsed
  }
  return null
}

/** The x402 v2 `payment-required` header: base64 of the same JSON challenge. */
function decodeChallengeHeader(value: string | undefined): Record<string, unknown> | null {
  if (value === undefined || value.trim() === '') return null
  const token = value.trim().replace(/^Payment\s+/i, '')
  try {
    const binary = atob(token.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return tryParseObject(new TextDecoder().decode(bytes))
  } catch {
    return tryParseObject(token)
  }
}

function tryParseObject(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* x402                                                                */
/* ------------------------------------------------------------------ */

/**
 * An x402 endpoint is usable if an unpaid request is answered with `402` and a
 * challenge a client could actually pay: an `accepts` array whose entries name
 * a scheme, a network, an amount, a recipient and an asset.
 *
 * A 200 here is a finding, not a pass — a paid endpoint that serves anonymous
 * traffic for free is not charging anybody.
 */
export async function probeX402(endpoint: string, opts: ProbeOptions = {}): Promise<ProbeOutcome> {
  const fetched = await tryFetch(endpoint, {
    ...opts,
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
  })
  if ('failure' in fetched) return fetched.failure

  const { response } = fetched
  if (response.status !== 402) {
    return {
      status: 'malformed',
      httpStatus: response.status,
      latencyMs: response.latencyMs,
      detail:
        response.status < 400
          ? `answered ${response.status} to an unpaid request; a priced endpoint must answer 402`
          : `answered ${response.status}, not the 402 an x402 endpoint owes an unpaid caller`,
      finalUrl: response.finalUrl,
      evidence: { wwwAuthenticate: response.headers['www-authenticate'] ?? null },
    }
  }

  // x402 v1 puts the challenge in the body; v2 moved it into a base64
  // `payment-required` header and leaves the body empty. Both are live on the
  // public internet right now, so both are accepted.
  const fromBody = tryParseObject(response.body)
  const fromHeader = decodeChallengeHeader(response.headers['payment-required'])
  const parsed =
    fromBody !== null && Array.isArray(fromBody['accepts']) ? fromBody : (fromHeader ?? fromBody)

  if (parsed === null) {
    return {
      status: 'malformed',
      httpStatus: 402,
      latencyMs: response.latencyMs,
      detail: `answered 402 but neither the body nor a payment-required header carries a challenge (${describeBody(response.body)})`,
      finalUrl: response.finalUrl,
      evidence: {},
    }
  }

  const accepts = Array.isArray(parsed['accepts']) ? parsed['accepts'] : []
  const usable = accepts.filter(
    (entry) =>
      isRecord(entry) &&
      typeof entry['scheme'] === 'string' &&
      typeof entry['network'] === 'string' &&
      typeof entry['payTo'] === 'string' &&
      typeof entry['asset'] === 'string' &&
      (typeof entry['maxAmountRequired'] === 'string' || typeof entry['amount'] === 'string'),
  )

  if (usable.length === 0) {
    return {
      status: 'malformed',
      httpStatus: 402,
      latencyMs: response.latencyMs,
      detail:
        accepts.length === 0
          ? 'answered 402 but the challenge has no "accepts" array, so a client cannot tell what to pay'
          : `answered 402 with ${accepts.length} accepts entr${accepts.length === 1 ? 'y' : 'ies'}, none of which names a scheme, network, amount, payTo and asset`,
      finalUrl: response.finalUrl,
      evidence: { x402Version: parsed['x402Version'] ?? null, accepts },
    }
  }

  const first = usable[0] as Record<string, unknown>
  return {
    status: 'ok',
    httpStatus: 402,
    latencyMs: response.latencyMs,
    detail: `402 challenge for ${String(first['maxAmountRequired'] ?? first['amount'])} of ${String(first['asset'])} on ${String(first['network'])}`,
    finalUrl: response.finalUrl,
    evidence: {
      x402Version: parsed['x402Version'] ?? null,
      accepts: usable,
      priceAtomic: String(first['maxAmountRequired'] ?? first['amount']),
      asset: String(first['asset']),
      network: String(first['network']),
    },
  }
}

/* ------------------------------------------------------------------ */
/* plain reachability                                                  */
/* ------------------------------------------------------------------ */

/** For the `web` service: it exists and answers. Nothing more is claimed. */
export async function probeWeb(endpoint: string, opts: ProbeOptions = {}): Promise<ProbeOutcome> {
  const fetched = await tryFetch(endpoint, { ...opts, headers: { 'user-agent': USER_AGENT } })
  if ('failure' in fetched) return fetched.failure

  const { response } = fetched
  if (response.status >= 400) {
    return {
      status: 'unreachable',
      httpStatus: response.status,
      latencyMs: response.latencyMs,
      detail: `HTTP ${response.status}`,
      finalUrl: response.finalUrl,
      evidence: {},
    }
  }
  return {
    status: 'ok',
    httpStatus: response.status,
    latencyMs: response.latencyMs,
    detail: `HTTP ${response.status}${response.redirects > 0 ? ` after ${response.redirects} redirect(s)` : ''}`,
    finalUrl: response.finalUrl,
    evidence: {},
  }
}

/* ------------------------------------------------------------------ */
/* shared                                                              */
/* ------------------------------------------------------------------ */

type FetchAttempt =
  | { response: Awaited<ReturnType<typeof safeFetch>> }
  | { failure: ProbeOutcome }

async function tryFetch(url: string, opts: SafeFetchOptions): Promise<FetchAttempt> {
  const startedAt = Date.now()
  try {
    return { response: await safeFetch(url, opts) }
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      return {
        failure: {
          status: 'refused',
          httpStatus: null,
          latencyMs: Date.now() - startedAt,
          detail: `refused before sending: ${err.reason}`,
          finalUrl: null,
          evidence: { url },
        },
      }
    }
    if (err instanceof TimeoutError) {
      return {
        failure: {
          status: 'unreachable',
          httpStatus: null,
          latencyMs: Date.now() - startedAt,
          detail: `timed out after ${err.timeoutMs}ms`,
          finalUrl: null,
          evidence: { url },
        },
      }
    }
    if (err instanceof HallmarkError) throw err
    return {
      failure: {
        status: 'unreachable',
        httpStatus: null,
        latencyMs: Date.now() - startedAt,
        detail: messageOf(err),
        finalUrl: null,
        evidence: { url },
      },
    }
  }
}

const STATUS_RANK: Record<ProbeStatus, number> = { ok: 0, malformed: 1, unreachable: 2, refused: 3 }

function rank(outcome: ProbeOutcome): number {
  return STATUS_RANK[outcome.status]
}

function describeBody(body: string): string {
  const trimmed = body.trim()
  if (trimmed === '') return 'empty body'
  if (/^<!doctype html|^<html/i.test(trimmed)) return 'looks like an HTML page'
  return `starts with ${JSON.stringify(trimmed.slice(0, 32))}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
