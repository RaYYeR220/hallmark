import type { Address, SupportedChainId } from './chains.js'
import type { AgentCard, EndpointKind, ResolvedEndpoint, TokenUriKind } from './agentCard.js'
import type { ScanAgent } from './scan.js'

/** The four things Hallmark agents are hired to do. */
export const HALLMARK_CATEGORIES = ['rebalancing', 'grid', 'yield', 'health-factor'] as const

export type HallmarkCategory = (typeof HALLMARK_CATEGORIES)[number]

export function isHallmarkCategory(value: string): value is HallmarkCategory {
  return (HALLMARK_CATEGORIES as readonly string[]).includes(value)
}

/** One endpoint, poked once. */
export type ProbeResult = {
  endpoint: string
  kind: EndpointKind
  ok: boolean
  httpStatus?: number
  latencyMs: number
  error?: string
}

export type X402Capability = {
  priceAtomic: string
  asset: string
  network: string
}

export type EvidenceCapabilities = {
  mcpTools?: string[]
  a2aSkills?: string[]
  x402?: X402Capability | null
}

export type EvidenceScorer = {
  name: 'hallmark'
  version: string
  weights: Record<string, number>
}

/** Content-addressed record of one probe run. Canonicalised and hashed in `evidence.ts`. */
export type EvidenceBundle = {
  version: 1
  chainId: number
  agentId: number
  /** ISO-8601, UTC. */
  probedAt: string
  probe: ProbeResult[]
  capabilities: EvidenceCapabilities
  /** 0-100. */
  score: number
  scorer: EvidenceScorer
}

/**
 * The reputation registry reports `(value, valueDecimals)` rather than a
 * plain score, so `score` is the scaled convenience view.
 */
export type ReputationSummary = {
  count: number
  value: number
  valueDecimals: number
  score: number
}

export type ValidationSummary = {
  count: number
  averageResponse: number
}

/** The on-chain read, the indexer row and our own probe, merged into one view. */
export type AgentSummary = {
  chainId: SupportedChainId
  agentId: number
  owner: Address | null
  tokenUri: string | null
  cardKind: TokenUriKind
  card: AgentCard | null
  cardWarnings: string[]
  cardError: string | null
  name: string | null
  description: string | null
  image: string | null
  endpoints: ResolvedEndpoint[]
  x402Support: boolean
  category: HallmarkCategory | null
  scan: ScanAgent | null
  reputation: ReputationSummary | null
  validation: ValidationSummary | null
  evidence: EvidenceBundle | null
  /** Fresh evidence exists and the hook would let a job bind to this agent. */
  hireable: boolean
}
