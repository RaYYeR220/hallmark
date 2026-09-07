/**
 * The declarative surface: what a developer writes in `hallmark.config.ts`,
 * and the ERC-8004 registration file it compiles down to.
 */

export type Address = `0x${string}`
export type Hex = `0x${string}`

/**
 * What the agent is hired to do. The first four are the categories Hallmark's
 * own marketplace routes jobs to; `security`, `research` and `other` are listed
 * so third-party agents are not forced to misfile themselves.
 */
export const AGENT_CATEGORIES = [
  'rebalancing',
  'grid',
  'yield',
  'health-factor',
  'security',
  'research',
  'other',
] as const

export type AgentCategory = (typeof AGENT_CATEGORIES)[number]

export const CHAIN_NAMES = ['bsc', 'bsc-testnet'] as const
export type ChainName = (typeof CHAIN_NAMES)[number]

/** `bsc` is chain id 56, `bsc-testnet` is 97. */
export const CHAIN_IDS: Record<ChainName, 56 | 97> = { bsc: 56, 'bsc-testnet': 97 }

export const PRICING_MODELS = ['x402', 'erc8183', 'free'] as const
export type PricingModel = (typeof PRICING_MODELS)[number]

/**
 * Trust models an agent claims to support, written into `supportedTrust`.
 * These are claims, not proofs — see "What validation means" in the README.
 */
export const TRUST_MODELS = ['reputation', 'crypto-economic', 'tee-attestation'] as const
export type TrustModel = (typeof TRUST_MODELS)[number]

export type ServiceKind = 'a2a' | 'mcp' | 'x402' | 'web'

/** Every service an agent can declare. At least one of `a2a` / `mcp` is required. */
export type ServiceEndpoints = {
  /** Agent-to-Agent card endpoint. Usually `https://host/.well-known/agent-card.json` or an A2A JSON-RPC root. */
  a2a?: string
  /** Streamable-HTTP MCP endpoint that answers `initialize` and `tools/list`. */
  mcp?: string
  /** HTTP resource that answers `402` with an x402 payment challenge. */
  x402?: string
  /** Human-facing page. Optional, and never enough on its own. */
  web?: string
}

/** A JSON Schema fragment. Not validated as a schema, only checked for being usable. */
export type JsonSchema = Record<string, unknown>

export type Pricing = {
  model: PricingModel
  /** Human decimal amount, e.g. `"0.25"`. Required unless `model` is `free`. */
  amount?: string
  /** Token symbol or `0x` address the price is denominated in. */
  asset?: string
}

export type AgentSkill = {
  /** Stable identifier, `[a-z0-9][a-z0-9._-]*`. This is what a caller invokes. */
  id: string
  name: string
  description: string
  inputSchema: JsonSchema
  outputSchema: JsonSchema
  /** Overrides the agent-level `pricing` for this one skill. */
  pricing?: Pricing
}

/**
 * Opting into on-chain validation. `requestFrom: 'hallmark'` resolves to
 * Hallmark's validator address on the target chain; any other address lets the
 * agent point at a validator of its own choosing.
 */
export type ValidationConfig = {
  requestFrom: 'hallmark' | Address
  /**
   * Where the validator should look for evidence about this agent. Defaults to
   * the agent's own A2A or web endpoint.
   */
  evidenceUrl?: string
  /**
   * Bump to create a second, distinct request for the same agent. The request
   * hash is a pure function of the request, so the same inputs always produce
   * the same hash — see `computeValidationRequestHash`.
   */
  nonce?: number
}

export type AgentConfig = {
  name: string
  description: string
  /** https URL of a square image. Shown in listings. */
  image?: string
  category: AgentCategory
  chain: ChainName
  services: ServiceEndpoints
  skills: AgentSkill[]
  pricing?: Pricing
  trust?: TrustModel[]
  validation?: ValidationConfig
  /** Set `false` to list the agent as retired without burning it. Defaults to `true`. */
  active?: boolean
}

/* ------------------------------------------------------------------ */
/* the registration file                                               */
/* ------------------------------------------------------------------ */

/** The `type` every ERC-8004 registration file must carry. */
export const REGISTRATION_TYPE = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1'

export type RegistrationService = {
  name: string
  endpoint: string
  version?: string
  skills?: string[]
  domains?: string[]
}

export type RegistrationEntry = {
  agentId: number
  /** CAIP-10, e.g. `eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`. */
  agentRegistry: string
}

/**
 * Everything the EIP does not have a field for lives under one namespaced key,
 * so it can never collide with a field a future revision of ERC-8004 adds.
 * Generic ERC-8004 readers ignore it; Hallmark reads it.
 */
export type HallmarkExtension = {
  version: 1
  category: AgentCategory
  skills: AgentSkill[]
  pricing?: Pricing
  validation?: { requestFrom: string }
}

export type RegistrationFile = {
  type: string
  name: string
  description: string
  image?: string
  services: RegistrationService[]
  x402Support: boolean
  active: boolean
  registrations: RegistrationEntry[]
  supportedTrust: string[]
  hallmark: HallmarkExtension
}
