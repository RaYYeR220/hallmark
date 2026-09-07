import type { Address, Hex, PublicClient } from 'viem'
import type { SupportedChainId } from '@hallmark/core'
import type { AgentPolicy, ExecuteOutcome, Session } from '@hallmark/altana'

import type { Shape } from './schema.js'

export type { Shape, FieldSpec } from './schema.js'
import type { Store } from './store.js'

/**
 * The shapes every agent in this service speaks.
 *
 * One rule runs through all of it: an agent produces *decisions* and
 * *intents*, never authority. Reading is unconstrained; writing goes through
 * `ActIntent` → an Altana session key → the chain, and a refusal at any step
 * comes back as a value with the rule that blocked it.
 */

/** Where a number came from. Every analysis carries these; none is optional. */
export type Source = {
  kind: 'onchain' | 'http' | 'derived' | 'config'
  /** Short label for the UI, e.g. "PancakeSwap v3 position manager". */
  label: string
  /** Exactly what was read, e.g. "positions(2137641) @ block 66,001,234". */
  detail: string
  url?: string
}

/** The envelope every read-only skill returns. */
export type Analysis<TDecision> = {
  agent: string
  skill: string
  chainId: SupportedChainId
  /** What was analysed: a position id, a borrower, a token. */
  subject: Record<string, string>
  /** ISO-8601 UTC, stamped when the reads completed. */
  observedAt: string
  /** Block the on-chain half was read at, when there was one. */
  blockNumber?: string
  /** The decision-shaped answer. Deterministic, machine-readable. */
  decision: TDecision
  /** The data the decision was computed from, verbatim. */
  facts: Record<string, unknown>
  sources: Source[]
  /** Anything the caller should know that did not change the decision. */
  warnings: string[]
  /**
   * Prose, derived from `decision` after the fact. Explanatory only — nothing
   * downstream reads it, and `act` cannot see it. See README, "Where an LLM
   * is allowed to be".
   */
  narrative: string[]
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

/** One call in an intent, with the copy that explains it. */
export type IntentCall = {
  to: Address
  data: Hex
  value: bigint
  /** Human sentence: "Repay 12.4 USDT of Venus debt". */
  label: string
  /** The signature this call encodes, e.g. `repayBorrow(uint256)`. */
  signature: string
}

/** A batch the agent wants executed under the session key. */
export type ActIntent = {
  /**
   * Caller-supplied idempotency key. Re-running the same id never executes
   * twice; it replays the recorded outcome.
   */
  intentId: string
  /** One-line summary of the whole batch. */
  summary: string
  calls: IntentCall[]
  /**
   * Token movement the agent knows it is asking for, declared explicitly.
   *
   * The native leg is visible in `calls[].value`, but an ERC-20 transfer is
   * just calldata — nothing generic can read an amount out of it. Declaring it
   * is what lets the spend ledger report real headroom instead of guessing.
   */
  spend?: Array<{ token: Address; amountAtomic: bigint }>
}

export type RefusalRule =
  | 'contract-allowlist'
  | 'selector-allowlist'
  | 'spend-cap'
  | 'session-expired'
  | 'session-revoked'
  | 'relay-fee'
  | 'unknown'

/** What the session key blocked, why, and what headroom was left. */
export type RefusalReport = {
  attempted: {
    intentId: string
    summary: string
    calls: Array<{ to: Address; selector: Hex | null; signature: string; valueWei: string; label: string }>
  }
  blockedBy: {
    rule: RefusalRule
    /** The policy line that did the blocking, when we can name it. */
    ruleLabel: string
    detail: string
  }
  /** Present when the block was a spending limit. */
  cap: {
    token: Address
    symbol: string
    limitAtomic: string
    limitDisplay: string
    period: 'day' | 'hour'
    attemptedAtomic: string
    attemptedDisplay: string
    /**
     * Locally observed headroom: the cap minus what this service has seen
     * confirmed in the current window. The relay is the authority; this is
     * what we can prove from our own ledger.
     */
    remainingAtomic: string
    remainingDisplay: string
    observedSpendAtomic: string
  } | null
  policy: {
    label: string
    expiresAt: number
    expiresAtIso: string
    allowlist: Array<{ to: Address | null; signature: string | null; label: string }>
    caps: Array<{ token: Address; symbol: string; limitDisplay: string; period: 'day' | 'hour' }>
  }
  /** `preflight` means nothing was sent; `relay` means the relay said no. */
  source: 'preflight' | 'relay'
  statusCode: number
}

/**
 * The result of an `act`.
 *
 * `refused` and `aborted` are ordinary answers, not errors. `refused` is the
 * session key saying no. `aborted` is the agent refusing to propose anything
 * because its own safety preconditions were not met — a stale price feed, a
 * read that failed, no session configured. Neither ever throws.
 */
export type ActResult =
  | {
      status: 'executed'
      intentId: string
      replayed: boolean
      summary: string
      txHash: Hex
      explorerUrl: string
      calls: RefusalReport['attempted']['calls']
      observedAt: string
    }
  | {
      status: 'pending'
      intentId: string
      replayed: boolean
      summary: string
      callsId: Hex
      detail: string
      observedAt: string
    }
  | { status: 'refused'; intentId: string; replayed: boolean; refusal: RefusalReport; observedAt: string }
  | {
      status: 'reverted'
      intentId: string
      replayed: boolean
      summary: string
      detail: string
      statusCode: number
      txHash?: Hex
      observedAt: string
    }
  | {
      status: 'unfunded'
      intentId: string
      replayed: boolean
      detail: string
      requiredWei: string
      address?: Address
      observedAt: string
    }
  | {
      status: 'aborted'
      intentId: string
      replayed: false
      /** Why the agent declined to act. Fail-closed by design. */
      reason:
        | 'no-session'
        | 'stale-price'
        | 'read-failed'
        | 'precondition'
        | 'nothing-to-do'
        | 'not-authorised'
      detail: string
      /** The checks that produced the refusal, so a UI can show the evidence. */
      evidence: Record<string, unknown>
      observedAt: string
    }

// ---------------------------------------------------------------------------
// Skills and agents
// ---------------------------------------------------------------------------

export type SkillMode = 'read' | 'write'

/** What an x402 endpoint charges for a skill. */
export type SkillPrice = {
  /** Smallest unit of `asset`. */
  amountAtomic: string
  asset: Address
  decimals: number
  symbol: string
  /** "0.25 USDT". */
  display: string
}

export type SkillContext = {
  chainId: SupportedChainId
  /** Read-only chain access. Nothing here can sign. */
  client: PublicClient
  fetch: typeof fetch
  store: Store
  /** Unix seconds. Injectable so tests are not wall-clock dependent. */
  now: () => number
  /** Resolves the session key for a chain, or null when none is configured. */
  session: SessionProvider
  config: RuntimeConfig
  /** Executes an intent under the session key. Never throws for a refusal. */
  execute: (intent: ActIntent, ctx: SkillContext) => Promise<ActResult>
}

export type AgentSkill<TInput = Record<string, unknown>, TOutput = unknown> = {
  id: string
  name: string
  description: string
  mode: SkillMode
  tags: string[]
  input: Shape
  examples?: string[]
  /** Omit for a free skill. Present ⇒ the x402 face charges for it. */
  price?: SkillPrice
  run: (input: TInput, ctx: SkillContext) => Promise<TOutput>
}

export type AgentManifest = {
  /** URL path segment and MCP tool prefix. Lowercase, hyphenated. */
  slug: string
  name: string
  /** The contest category this agent competes in. */
  category: 'rebalancing' | 'grid' | 'yield' | 'health-factor' | 'security'
  categoryLabel: string
  description: string
  version: string
  tags: string[]
  /** The Altana policy builder that bounds this agent's `act`, if it has one. */
  policy: PolicyBinding | null
  /** Which chains this agent is meaningful on. */
  chains: SupportedChainId[]
}

export type PolicyBinding = {
  /** Key into `@hallmark/altana`'s POLICY_BUILDERS. */
  category: 'pancake-rebalance' | 'pancake-grid' | 'yield-routing' | 'venus-health-factor'
  /** One line the UI shows when asking for the grant. */
  rationale: string
}

/**
 * Erase a skill's input type at the registry boundary.
 *
 * A skill is written against its own input type, which is what makes the
 * handlers readable. The registry holds a heterogeneous list, and TypeScript's
 * function parameters are contravariant, so the two cannot both be true
 * without a cast. This is that cast, in one place, and it is sound: nothing
 * calls `run` except `invokeSkill`, which validates against the same `input`
 * shape first and hands over exactly what the shape describes.
 */
export function defineSkill<TInput, TOutput = unknown>(
  skill: AgentSkill<TInput, TOutput>,
): AgentSkill {
  return skill as unknown as AgentSkill
}

export type AgentDefinition = {
  manifest: AgentManifest
  skills: AgentSkill[]
}

// ---------------------------------------------------------------------------
// Runtime wiring
// ---------------------------------------------------------------------------

export type SessionHandle = {
  session: Session
  policy: AgentPolicy
  chainId: SupportedChainId
}

export type SessionProvider = {
  /**
   * The session key for a policy category on a chain, or null when the
   * operator has not granted one. Null is a normal state: a marketplace demo
   * runs read-only until a user grants.
   */
  get: (chainId: SupportedChainId, policy: PolicyBinding) => Promise<SessionHandle | null>
}

/** The one function that can move value. Injected so tests drive every branch. */
export type Executor = (args: {
  chainId: SupportedChainId
  session: Session
  calls: Array<{ to: Address; data: Hex; value: bigint }>
}) => Promise<ExecuteOutcome>

export type RuntimeConfig = {
  /**
   * Public origin every absolute URL in this service is built from. One
   * variable, so a preview deployment never registers cards pointing at
   * production.
   */
  baseUrl: string
  /** The Hallmark marketplace, which each card names as its `web` service. */
  marketplaceUrl: string
  defaultChainId: SupportedChainId
  /** Where x402 payments settle. */
  payTo: Address
  /** Token x402 prices are quoted in, per chain. */
  x402Asset: Record<SupportedChainId, { address: Address; decimals: number; symbol: string }>
  /** Shared secret for the cron endpoints. Absent ⇒ the endpoints refuse. */
  cronSecret: string | null
  rpcUrl: Partial<Record<SupportedChainId, string>>
  /** Optional BscScan key. Absent ⇒ source-verification is reported unknown. */
  bscscanApiKey: string | null
  /** Service version, echoed in cards and MCP `initialize`. */
  version: string
}
