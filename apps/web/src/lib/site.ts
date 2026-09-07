/**
 * The canonical origin.
 *
 * Every absolute URL the app emits comes from here — metadata, the evidence
 * URI written into on-chain attestations, the links on /proof. It is a single
 * constant on purpose: a preview deployment that computed its own origin from
 * `VERCEL_URL` would write `hallmark-market-git-abc123.vercel.app` into an
 * ERC-8004 `feedbackURI`, and that URL dies the moment the preview is pruned.
 * On-chain data must only ever point at the production origin.
 *
 * Safe for the client bundle: nothing here is secret, and NEXT_PUBLIC_ is
 * required for the value to survive into the browser at all.
 */

export const DEFAULT_BASE_URL = 'https://hallmark-market.vercel.app'

function normalise(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed === '') return null
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
}

export const BASE_URL: string =
  normalise(process.env['NEXT_PUBLIC_BASE_URL']) ?? DEFAULT_BASE_URL

/** An absolute URL for a path on this site. */
export function absoluteUrl(path: string): string {
  return `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Where an evidence bundle is publicly fetchable.
 *
 * This is the exact string that goes into `feedbackURI` on the Reputation
 * Registry and `responseURI` on the Validation Registry, and the prober
 * derives the same URL from `EVIDENCE_BASE_URL`. Keep the two in step: an
 * attestation whose URI 404s is worse than no attestation.
 */
export function evidenceUrl(hash: string): string {
  return absoluteUrl(`/api/evidence/${hash.toLowerCase()}`)
}

/** The relative form, for links that stay inside the app. */
export function evidencePath(hash: string): string {
  return `/api/evidence/${hash.toLowerCase()}`
}

/**
 * The five first-party agents, deployed alongside this app.
 *
 * They are the live targets for the hire flow: real A2A, MCP and x402 faces
 * that Hallmark probes on the same schedule as everyone else's, so the demo
 * exercises the same code path a stranger's agent would.
 */
export const AGENTS_BASE_URL: string =
  normalise(process.env['NEXT_PUBLIC_AGENTS_BASE_URL']) ?? 'https://hallmark-agents.vercel.app'

export const FIRST_PARTY_AGENT_SLUGS = [
  'rebalancer',
  'grid',
  'yield',
  'health',
  'security',
] as const

export type FirstPartyAgentSlug = (typeof FIRST_PARTY_AGENT_SLUGS)[number]

export function agentFaceUrl(
  slug: FirstPartyAgentSlug,
  face: 'a2a' | 'mcp' | 'x402',
): string {
  return `${AGENTS_BASE_URL}/${face}/${slug}`
}

/** True when an endpoint belongs to our own agent deployment. Labelled as such. */
export function isFirstPartyEndpoint(url: string | null | undefined): boolean {
  if (url === null || url === undefined) return false
  return url.startsWith(AGENTS_BASE_URL)
}
