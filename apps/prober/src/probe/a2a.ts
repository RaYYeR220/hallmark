/**
 * A2A endpoint probe.
 *
 * An agent card is what makes an A2A endpoint useful, and half the agents on
 * chain point `a2a` at a service root rather than at the card itself, so the
 * probe falls back to the well-known path before it calls the endpoint dead.
 * A 200 that returns an HTML landing page is a failure, not a success: that
 * distinction is the whole reason this service exists.
 */

import { httpRequestWithRetry, isJsonContentType, looksLikeHtml } from './http.ts'
import type { HttpOptions } from './http.ts'
import { parseX402Challenge } from './x402.ts'
import type { FailureClass, ProtocolOutcome, RequestTrace } from '../types.ts'

/** The current well-known path, then the one older A2A servers still use. */
export const A2A_WELL_KNOWN = ['/.well-known/agent-card.json', '/.well-known/agent.json'] as const

/** Failures that belong to the host, not the path; trying another path cannot help. */
const HOST_LEVEL_FAILURES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'dns',
  'refused',
  'tls',
  'blocked',
  'unsupported-scheme',
])

export type A2ACard = {
  name: string | null
  description: string | null
  version: string | null
  protocolVersion: string | null
  skills: string[]
  capabilities: string[]
  url: string | null
  /** The card declared `url`/`endpoint` and set it to null. */
  nulledEndpoint: boolean
  /** The card says it is offline or inactive about itself. */
  declaredOffline: boolean
}

/**
 * A plausible A2A agent card has a name plus either skills or capabilities.
 * Anything looser matches every JSON API on the internet.
 *
 * Structural only — this says "the document is shaped like an agent card". Use
 * `a2aCardProblem` to decide whether the agent behind it is actually callable.
 */
export function parseA2ACard(text: string): A2ACard | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const record = parsed as Record<string, unknown>
  const name = readString(record, 'name')
  if (name === null) return null

  const skills = readSkills(record['skills'])
  const capabilities = readCapabilities(record['capabilities'])
  if (skills === null && capabilities === null) return null

  return {
    name,
    description: readString(record, 'description'),
    version: readString(record, 'version'),
    protocolVersion: readString(record, 'protocolVersion') ?? readString(record, 'protocol_version'),
    skills: skills ?? [],
    capabilities: capabilities ?? [],
    url: readString(record, 'url') ?? readString(record, 'endpoint'),
    nulledEndpoint: hasNulledEndpoint(record),
    declaredOffline: declaresOffline(record),
  }
}

/**
 * The strict liveness rule, and the reason this service exists.
 *
 * A census of 6,000 BSC agents found 506 that serve a perfectly well-formed
 * agent card announcing `"skills": []`, `"endpoint": null` and
 * `"presence": "offline"` — a card that says, in its own words, that there is
 * nothing here to hire. A permissive rule scores those 529 alive where the
 * truthful answer is 23, a 23x error, and that error would have gone on chain
 * under our name. So a 200 and a well-formed card are not enough: the card has
 * to describe something callable, and must not disclaim itself.
 *
 * Returns `null` when the card passes, or the reason it does not.
 */
export function a2aCardProblem(card: A2ACard): string | null {
  if (card.declaredOffline) {
    return 'the agent card declares itself offline or inactive'
  }
  if (card.skills.length === 0 && card.capabilities.length === 0) {
    return 'the agent card is well-formed but declares no skills and no enabled capabilities; nothing about it is callable'
  }
  if (card.nulledEndpoint) {
    return 'the agent card declares a null endpoint, so it advertises no address to call'
  }
  return null
}

export async function probeA2A(endpoint: string, opts: HttpOptions = {}): Promise<ProtocolOutcome> {
  const requests: RequestTrace[] = []
  const attempts = candidateUrls(endpoint)

  let firstFailure: ProtocolOutcome | null = null
  let bestNonCard: ProtocolOutcome | null = null

  for (const url of attempts) {
    const res = await httpRequestWithRetry(url, { ...opts, method: 'GET', headers: { accept: 'application/json, */*;q=0.5' } })
    requests.push(res.trace)

    if (!res.ok) {
      // A paid A2A endpoint answers the unpaid GET with a 402 challenge. That
      // is the endpoint working, so it is recorded as such.
      if (res.status === 402 && res.headers !== null) {
        const parsed = parseX402Challenge({ status: res.status, headers: res.headers, body: res.text })
        if (parsed !== null) {
          return {
            ok: true,
            protocolOk: false,
            failure: null,
            detail: `HTTP 402 with an x402 v${parsed.challenge.x402Version} challenge; agent card is behind payment`,
            status: res.status,
            latencyMs: res.latencyMs,
            requests: [...requests],
            capabilities: { x402: parsed.challenge },
          }
        }
      }

      const outcome: ProtocolOutcome = {
        ok: false,
        protocolOk: false,
        failure: res.failure,
        detail: res.detail,
        status: res.status,
        latencyMs: res.latencyMs,
        requests: [...requests],
        capabilities: {},
      }
      firstFailure ??= outcome
      // The well-known fallbacks share the endpoint's host, so a host-level
      // failure is already the final answer. Retrying it three times just
      // multiplies the wait.
      if (HOST_LEVEL_FAILURES.has(res.failure)) break
      continue
    }

    const card = parseA2ACard(res.text)
    if (card !== null) {
      const problem = a2aCardProblem(card)
      if (problem === null) {
        return {
          ok: true,
          protocolOk: true,
          failure: null,
          detail: null,
          status: res.status,
          latencyMs: res.latencyMs,
          requests: [...requests],
          capabilities: { a2aSkills: dedupe([...card.skills, ...card.capabilities]) },
        }
      }

      // A card that disclaims itself is not a live agent. Recorded as a
      // protocol failure so it can never be attested as reachable.
      bestNonCard ??= {
        ok: false,
        protocolOk: false,
        failure: 'bad-protocol',
        detail: problem,
        status: res.status,
        latencyMs: res.latencyMs,
        requests: [...requests],
        capabilities: {},
      }
      continue
    }

    // It answered. It just did not answer with an agent card.
    const html = looksLikeHtml(res.text, res.contentType)
    const failure = html || !isJsonContentType(res.contentType) ? 'not-json' : 'bad-protocol'
    bestNonCard ??= {
      ok: false,
      protocolOk: false,
      failure,
      detail: html
        ? 'returned an HTML page where an A2A agent card was declared'
        : 'answered 200 but the body is not a plausible A2A agent card (needs "name" plus "skills" or "capabilities")',
      status: res.status,
      latencyMs: res.latencyMs,
      requests: [...requests],
      capabilities: {},
    }
  }

  const chosen = bestNonCard ?? firstFailure
  if (chosen !== null) return { ...chosen, requests: [...requests] }

  return {
    ok: false,
    protocolOk: false,
    failure: 'unsupported-scheme',
    detail: `no http(s) URL to probe for "${endpoint}"`,
    status: null,
    latencyMs: 0,
    requests,
    capabilities: {},
  }
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

/** The declared URL first, then the well-known paths if it looked like a service root. */
function candidateUrls(endpoint: string): string[] {
  const out = [endpoint]
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return out
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return out

  const alreadyWellKnown = url.pathname.includes('/.well-known/')
  if (alreadyWellKnown) return out

  for (const path of A2A_WELL_KNOWN) {
    const candidate = new URL(path, url.origin).toString()
    if (!out.includes(candidate)) out.push(candidate)
  }
  return out
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** The key is present and explicitly null: a deliberate "there is no address". */
function hasNulledEndpoint(record: Record<string, unknown>): boolean {
  for (const key of ['url', 'endpoint', 'endpointUrl', 'serviceEndpoint']) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] === null) return true
  }
  return false
}

/** `presence: "offline"`, `active: false`, `status: "inactive"` and friends. */
function declaresOffline(record: Record<string, unknown>): boolean {
  for (const key of ['presence', 'status', 'state', 'availability']) {
    const value = record[key]
    if (typeof value === 'string' && /^(offline|inactive|disabled|down|unavailable)$/i.test(value.trim())) {
      return true
    }
  }
  for (const key of ['active', 'isActive', 'enabled', 'online']) {
    if (record[key] === false) return true
  }
  return false
}

/** A2A `skills` is an array of `{ id, name, ... }`; some servers ship bare strings. */
function readSkills(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      out.push(entry)
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const label = record['name'] ?? record['id'] ?? record['skill']
    if (typeof label === 'string' && label.trim() !== '') out.push(label)
  }
  return out
}

/** A2A `capabilities` is an object of feature flags; only the enabled ones count. */
function readCapabilities(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string')
  }
  if (typeof value !== 'object' || value === null) return null
  const out: string[] = []
  for (const [key, flag] of Object.entries(value as Record<string, unknown>)) {
    if (flag === true) out.push(key)
    else if (typeof flag === 'string' && flag.trim() !== '') out.push(key)
    else if (typeof flag === 'object' && flag !== null) out.push(key)
  }
  return out
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim() !== ''))]
}
