import 'server-only'

import {
  ScanApiError,
  ScanClient,
  type ListAgentsParams,
  type ScanAgent,
  type ScanAgentDetail,
  type ScanFeedback,
  type ScanGlobalStats,
  type ScanPage,
  type ScanSemanticAgent,
} from '@hallmark/core'

import { env } from './env'

/**
 * The 8004scan indexer, server-side only.
 *
 * The key never reaches the browser: every page and route handler that needs
 * index data calls through here, and the browser talks to our own `/api`
 * instead. `ScanClient` already handles pacing, retry, and the cross-over to
 * the second base when one of them answers DATABASE_ERROR.
 */

let client: ScanClient | null = null

export function scan(): ScanClient {
  if (client === null) {
    client = new ScanClient({
      ...(env.scanBaseUrl === null ? {} : { baseUrl: env.scanBaseUrl }),
      ...(env.scanApiKey === null ? {} : { apiKey: env.scanApiKey }),
      // Tuned against measured upstream behaviour, and the numbers are not
      // obvious. Some filters are genuinely slow on their side —
      // `has_mcp=true` over 300,000 rows measures at ten seconds and then
      // succeeds. An eight-second timeout turned that single slow-but-working
      // query into four failed ones and a thirty-three-second page, because
      // each attempt timed out and the client dutifully retried and then
      // crossed over. So: a timeout long enough for the slow queries to
      // finish, and no same-base retry, because a query that has already had
      // fourteen seconds is not going to be fixed by asking again. A real
      // failure still crosses over to the second base, which is what that
      // mechanism is for.
      timeoutMs: 14_000,
      maxRetries: 0,
    })
  }
  return client
}

/**
 * What the index actually returns, as opposed to what its published shape
 * says. Two fields drift and both matter:
 *
 *  - `services` is documented as an array. Live, it is an object keyed by
 *    protocol: `{"a2a": {endpoint, skills}, "web": {...}}`.
 *  - `health_status` is documented as a string. Live, it is a nested object
 *    with a per-service breakdown, timestamps and latency.
 *
 * Reading either one as documented produces an empty render rather than an
 * error, which is exactly the failure mode that survives to production. So
 * both are normalised here, defensively, and the normalisers accept both
 * shapes.
 */

export type ScanServiceEntry = {
  protocol: string
  endpoint: string | null
  version: string | null
  skills: string[]
  domains: string[]
}

export function normaliseScanServices(raw: unknown): ScanServiceEntry[] {
  if (raw === null || raw === undefined) return []

  const entries: [string, unknown][] = Array.isArray(raw)
    ? raw.map((value, index) => [String(index), value])
    : isRecord(raw)
      ? Object.entries(raw)
      : []

  const out: ScanServiceEntry[] = []
  for (const [key, value] of entries) {
    if (!isRecord(value)) {
      if (typeof value === 'string') {
        out.push({ protocol: key, endpoint: value, version: null, skills: [], domains: [] })
      }
      continue
    }
    const protocol = readString(value, 'name') ?? readString(value, 'type') ?? key
    out.push({
      protocol,
      endpoint:
        readString(value, 'endpoint') ?? readString(value, 'url') ?? readString(value, 'uri'),
      version: readString(value, 'version'),
      skills: readStringArray(value, 'skills'),
      domains: readStringArray(value, 'domains'),
    })
  }
  return out
}

export type ScanHealthService = {
  service: string
  status: string
  message: string | null
  latencyMs: number | null
  checkedAt: string | null
  domain: string | null
  domainVerified: boolean | null
  verificationError: string | null
}

export type ScanHealth = {
  overallStatus: string | null
  score: number | null
  checkedAt: string | null
  services: ScanHealthService[]
}

export function normaliseScanHealth(raw: unknown, fallbackScore: number | null): ScanHealth | null {
  if (typeof raw === 'string') {
    return { overallStatus: raw, score: fallbackScore, checkedAt: null, services: [] }
  }
  if (!isRecord(raw)) {
    return fallbackScore === null
      ? null
      : { overallStatus: null, score: fallbackScore, checkedAt: null, services: [] }
  }

  const servicesRaw = raw['services']
  const services: ScanHealthService[] = []
  if (isRecord(servicesRaw)) {
    for (const [name, value] of Object.entries(servicesRaw)) {
      if (!isRecord(value)) continue
      services.push({
        service: name,
        status: readString(value, 'status') ?? 'unknown',
        message: readString(value, 'message'),
        latencyMs: readNumber(value, 'latency_ms'),
        checkedAt: readString(value, 'checked_at'),
        domain: readString(value, 'domain'),
        domainVerified: readBoolean(value, 'domain_verified'),
        verificationError: readString(value, 'verification_error'),
      })
    }
  }

  return {
    overallStatus: readString(raw, 'overall_status'),
    score: readNumber(raw, 'health_score') ?? fallbackScore,
    checkedAt: readString(raw, 'checked_at'),
    services: services.sort((a, b) => a.service.localeCompare(b.service)),
  }
}

/**
 * Give up on an index call after `ms` and carry on with what we have.
 *
 * A page that renders in four seconds with one of its four discovery
 * queries missing beats a page that renders in forty with all of them. The
 * caller decides what a missing result means and says so on screen — this
 * only ever returns the fallback, never a wrong answer.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ */
/* thin typed wrappers                                                 */
/* ------------------------------------------------------------------ */

export async function fetchGlobalStats(): Promise<ScanGlobalStats> {
  return scan().globalStats()
}

export async function fetchAgentPage(params: ListAgentsParams): Promise<ScanPage<ScanAgent>> {
  return scan().listAgents(params)
}

export async function fetchAgentDetail(
  chainId: number,
  agentId: number | string,
): Promise<ScanAgentDetail | null> {
  try {
    return await scan().getAgent(chainId, agentId)
  } catch (error) {
    // A 404 here is ordinary: the chain is the source of truth and the index
    // lags behind it by minutes on a fresh registration.
    if (error instanceof ScanApiError && error.status === 404) return null
    throw error
  }
}

export async function fetchSemantic(
  query: string,
  chainId: number,
  limit = 25,
  similarityThreshold?: number,
): Promise<ScanPage<ScanSemanticAgent>> {
  return scan().semanticSearch(query, {
    chain_id: chainId,
    limit,
    ...(similarityThreshold === undefined ? {} : { similarity_threshold: similarityThreshold }),
  })
}

export async function fetchFeedbacks(
  chainId: number,
  agentTokenId: string,
  limit = 50,
): Promise<ScanPage<ScanFeedback> | null> {
  try {
    return await scan().listFeedbacks({
      chain_id: chainId,
      agent_token_id: agentTokenId,
      include_revoked: true,
      limit,
      sort_by: 'submitted_at',
      sort_order: 'desc',
    })
  } catch {
    // Feedback is a nice-to-have on the detail page; the authoritative copy is
    // read from the Reputation Registry a few lines below it. A failure here
    // must not take the page down.
    return null
  }
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key]
  return typeof value === 'boolean' ? value : null
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export { ScanApiError }
export type { ScanAgent, ScanAgentDetail, ScanFeedback, ScanGlobalStats, ScanSemanticAgent }
