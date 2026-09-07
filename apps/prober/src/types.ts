import type { EndpointKind, EvidenceBundle, TokenUriKind, X402Capability } from '@hallmark/core'

/**
 * Why an endpoint did not answer.
 *
 * The first eight are the ERC-8004 liveness vocabulary's own failure surface:
 * they are what the marketplace shows a buyer, so they are part of the product
 * rather than an internal detail. The rest are the prober's own refusals — it
 * declined to make the request, or made it and then stopped reading.
 *
 *  dns                  the hostname does not resolve
 *  refused              the host resolved but rejected or is unroutable
 *  tls                  the TLS handshake or certificate check failed
 *  timeout              nothing arrived inside the per-request budget
 *  http-4xx             the server answered, with a client error
 *  http-5xx             the server answered, with a server error
 *  bad-protocol         answered 2xx but did not speak the protocol it declared
 *  not-json             promised JSON, returned something else (usually an HTML error page)
 *  blocked              a private, loopback or link-local host; never contacted
 *  unsupported-scheme   not http(s) — `did:`, `mailto:`, a bare ENS name
 *  too-large            the body blew past the size cap before it finished
 *  too-many-redirects   the redirect chain exceeded the hop cap
 *  network              a transport error that is none of the above
 */
export const FAILURE_CLASSES = [
  'dns',
  'refused',
  'tls',
  'timeout',
  'http-4xx',
  'http-5xx',
  'bad-protocol',
  'not-json',
  'blocked',
  'unsupported-scheme',
  'too-large',
  'too-many-redirects',
  'network',
] as const

export type FailureClass = (typeof FAILURE_CLASSES)[number]

export function isFailureClass(value: string): value is FailureClass {
  return (FAILURE_CLASSES as readonly string[]).includes(value)
}

/** One HTTP round trip actually made, including redirect hops and fallback URLs. */
export type RequestTrace = {
  url: string
  method: 'GET' | 'POST'
  status: number | null
  latencyMs: number
  contentType: string | null
  bytes: number
  redirects: number
  failure: FailureClass | null
  detail: string | null
}

/**
 * One declared endpoint, poked once.
 *
 * Structurally a superset of `@hallmark/core`'s `ProbeResult`, so it drops
 * straight into an `EvidenceBundle` and carries the classification with it.
 */
export type EndpointProbe = {
  endpoint: string
  kind: EndpointKind
  ok: boolean
  httpStatus?: number
  latencyMs: number
  error?: string
  /** `null` exactly when `ok` is true. */
  failure: FailureClass | null
  /** Answered 2xx *and* spoke the protocol it declared. */
  protocolOk: boolean
  /** False for endpoints that cannot be contacted over HTTP; excluded from the score. */
  scored: boolean
  /** Every URL contacted on this endpoint's behalf, in order. */
  requests: RequestTrace[]
}

export type X402Challenge = X402Capability & {
  x402Version: number
  scheme: string
  payTo: string
  maxTimeoutSeconds: number | null
  resource: string | null
}

export type ProbeCapabilities = {
  mcpTools?: string[]
  a2aSkills?: string[]
  x402?: X402Challenge | null
}

/** What one protocol handler reports back about a single endpoint. */
export type ProtocolOutcome = {
  /** The endpoint answered in a way its protocol considers success. */
  ok: boolean
  /** It answered *and* the answer was well-formed for the protocol it declared. */
  protocolOk: boolean
  failure: FailureClass | null
  detail: string | null
  status: number | null
  latencyMs: number
  requests: RequestTrace[]
  capabilities: ProbeCapabilities
}

/** Where the chain was when the run happened. Pins the evidence to a block. */
export type ChainObservation = {
  blockNumber: number
  blockTimestamp: number
}

export type AgentProvenance = {
  owner: string | null
  tokenUriKind: TokenUriKind
  name: string | null
  cardError: string | null
  cardWarnings: string[]
}

/**
 * The content-addressed record of one probe run.
 *
 * Extends `@hallmark/core`'s `EvidenceBundle` rather than replacing it, so
 * `canonicalize` and `evidenceHash` cover the extra fields too — the block
 * height, the per-request trace and the agent provenance are all inside the
 * hash that goes on-chain.
 */
export type ProbeEvidenceBundle = Omit<EvidenceBundle, 'probe' | 'capabilities'> & {
  probe: EndpointProbe[]
  capabilities: ProbeCapabilities
  breakdown: ScoreBreakdown
  observed: ChainObservation
  agent: AgentProvenance
}

export type ScoreBreakdown = {
  reachability: number
  protocol: number
  latency: number
  capabilities: number
  x402: number
}

/** A probe run plus everything the operator surfaces need that is not in the hash. */
export type ProbeRun = {
  chainId: number
  agentId: number
  probedAt: string
  score: number
  breakdown: ScoreBreakdown
  evidenceHash: `0x${string}`
  bundle: ProbeEvidenceBundle
  /** Wall-clock cost of the whole run, including the card resolve. */
  elapsedMs: number
}

export type PublishKind = 'reputation' | 'validation' | 'hook'

/** One intended on-chain write, costed before anything is signed. */
export type PublishPlan = {
  kind: PublishKind
  chainId: number
  agentId: number
  to: string
  from: string
  functionName: string
  args: string[]
  gasLimit: string
  gasPriceWei: string
  costWei: string
  evidenceHash: `0x${string}`
  evidenceUri: string
  score: number
}

export type PublishOutcome =
  | { plan: PublishPlan; status: 'dry-run' }
  | { plan: PublishPlan; status: 'skipped'; reason: string }
  | { plan: PublishPlan; status: 'sent'; txHash: `0x${string}`; gasUsed: string; verified: boolean; verification: string }
  | { plan: PublishPlan; status: 'failed'; reason: string; txHash?: `0x${string}` }
