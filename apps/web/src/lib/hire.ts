import 'server-only'

import {
  buildPolicy,
  describePolicy,
  validatePolicy,
  type AgentPolicy,
} from '@hallmark/altana'
import { encodeAbiParameters, formatUnits, parseUnits } from 'viem'

import { hallmarkCommerceAbi, hallmarkHookAbi } from './abi'
import { multicallAddressFor, publicClientFor } from './chain'
import { CATEGORY_DEFINITIONS, type CategoryDefinition, type HallmarkCategory } from './categories'
import { getDeployment, type SupportedChainId } from './deployments'

/**
 * Everything the hire flow needs to decide, priced and scoped, before anyone
 * signs anything.
 *
 * The load-bearing idea: the refusal is computed here, from the same contract
 * the escrow will consult, and it is computed *before* the user is offered a
 * button. Nobody should pay gas to be told no, and nobody should be told yes
 * by a frontend that then watches a transaction revert.
 */

/** $U has 18 decimals, like everything else on BNB Chain. */
export const U_DECIMALS = 18

/** Default budget for a demo hire: small enough to be unremarkable. */
export const DEFAULT_BUDGET_U = '2'

/** Escrow requires at least an hour; a day is a sane default for a real job. */
export const DEFAULT_JOB_DURATION_SECONDS = 24 * 60 * 60

export type HirePreflight = {
  chainId: SupportedChainId
  agentId: number
  /** Whether Hallmark's escrow exists on this chain at all. */
  escrowDeployed: boolean
  /** The live answer from the gate. Never cached. */
  hireable: boolean
  lastEvidenceAt: number | null
  score: number | null
  /** Gate parameters, read from the contract rather than assumed. */
  maxEvidenceAge: number
  minValidationScore: number
  /** Why the gate would refuse, phrased for a person. Null when it would not. */
  refusal: {
    error: 'NoFreshEvidence' | 'UnknownAgent' | 'NotDeployed'
    headline: string
    detail: string
    /** The exact revert the contract would produce. */
    revert: string
  } | null
  /** Escrow economics, read from the contract. */
  feeBps: number
  paymentToken: `0x${string}`
  commerce: `0x${string}` | null
  hook: `0x${string}` | null
  readAt: string
}

/**
 * Ask the gate directly.
 *
 * `isHireable` is the same predicate `beforeAction(fund)` evaluates, so a
 * `false` here and a reverted `fund` are the same fact read twice.
 */
export async function preflightHire(
  chainId: SupportedChainId,
  agentId: number,
): Promise<HirePreflight> {
  const deployment = getDeployment(chainId)
  const readAt = new Date().toISOString()

  if (deployment === null) {
    return {
      chainId,
      agentId,
      escrowDeployed: false,
      hireable: false,
      lastEvidenceAt: null,
      score: null,
      maxEvidenceAge: 86_400,
      minValidationScore: 50,
      refusal: {
        error: 'NotDeployed',
        headline: 'Hallmark’s escrow is not deployed on this chain.',
        detail:
          'The evidence gate and the ERC-8183 escrow live on BNB testnet (chain 97). You can ' +
          'review the exact scope a session key would grant, but there is no contract here to ' +
          'fund a job through.',
        revert: '',
      },
      feeBps: 0,
      paymentToken: '0x0000000000000000000000000000000000000000',
      commerce: null,
      hook: null,
      readAt,
    }
  }

  const client = publicClientFor(chainId)
  const results = (await client.multicall({
    contracts: [
      {
        address: deployment.hook,
        abi: hallmarkHookAbi,
        functionName: 'isHireable',
        args: [BigInt(agentId)],
      },
      { address: deployment.hook, abi: hallmarkHookAbi, functionName: 'maxEvidenceAge' },
      { address: deployment.hook, abi: hallmarkHookAbi, functionName: 'minValidationScore' },
      { address: deployment.commerce, abi: hallmarkCommerceAbi, functionName: 'feeBps' },
      { address: deployment.commerce, abi: hallmarkCommerceAbi, functionName: 'paymentToken' },
    ] as never,
    allowFailure: true,
    multicallAddress: multicallAddressFor(chainId),
  })) as unknown as ({ status: 'success'; result: unknown } | { status: 'failure' })[]

  const hireEntry = results[0]
  const ageEntry = results[1]
  const scoreEntry = results[2]
  const feeEntry = results[3]
  const tokenEntry = results[4]

  const maxEvidenceAge =
    ageEntry !== undefined && ageEntry.status === 'success' ? Number(ageEntry.result) : 86_400
  const minValidationScore =
    scoreEntry !== undefined && scoreEntry.status === 'success'
      ? Number(scoreEntry.result)
      : 50
  const feeBps =
    feeEntry !== undefined && feeEntry.status === 'success' ? Number(feeEntry.result) : 0
  const paymentToken =
    tokenEntry !== undefined && tokenEntry.status === 'success'
      ? (tokenEntry.result as `0x${string}`)
      : deployment.paymentToken

  const base = {
    chainId,
    agentId,
    escrowDeployed: true,
    maxEvidenceAge,
    minValidationScore,
    feeBps,
    paymentToken,
    commerce: deployment.commerce,
    hook: deployment.hook,
    readAt,
  }

  if (hireEntry === undefined || hireEntry.status !== 'success') {
    return {
      ...base,
      hireable: false,
      lastEvidenceAt: null,
      score: null,
      refusal: {
        error: 'UnknownAgent',
        headline: 'The evidence gate could not read this agent.',
        detail:
          'The hook reverted while evaluating the agent, which usually means the id was never ' +
          'minted in the Identity Registry. Funding would revert with UnknownAgent(agentId).',
        revert: `UnknownAgent(${agentId})`,
      },
    }
  }

  const [ok, lastEvidenceRaw, score] = hireEntry.result as readonly [boolean, bigint, number]
  const lastEvidenceAt = Number(lastEvidenceRaw)

  if (ok) {
    return {
      ...base,
      hireable: true,
      lastEvidenceAt: lastEvidenceAt > 0 ? lastEvidenceAt : null,
      score,
      refusal: null,
    }
  }

  const hours = Math.round(maxEvidenceAge / 3_600)
  const never = lastEvidenceAt === 0

  return {
    ...base,
    hireable: false,
    lastEvidenceAt: never ? null : lastEvidenceAt,
    score: never ? null : score,
    refusal: {
      error: 'NoFreshEvidence',
      headline: never
        ? 'This agent has never been probed. The escrow will refuse your money.'
        : 'This agent’s evidence is stale. The escrow will refuse your money.',
      detail: never
        ? 'No validation record and no probe exists for this agent, so there is nothing to ' +
          'suggest anything is alive at the other end. `fund` reverts before a single token ' +
          'leaves your wallet. This is the product working, not a bug in it.'
        : `The freshest evidence scored ${score}/100 and was written ` +
          `${new Date(lastEvidenceAt * 1000).toISOString()}. The gate accepts evidence up to ` +
          `${hours} hours old scoring at least ${minValidationScore}. This one does not qualify, ` +
          'so `fund` reverts and your funds stay where they are.',
      revert: `NoFreshEvidence(${agentId}, ${lastEvidenceAt})`,
    },
  }
}

/* ------------------------------------------------------------------ */
/* scope                                                               */
/* ------------------------------------------------------------------ */

export type ScopePreview = {
  category: HallmarkCategory
  label: string
  /** `describePolicy` output — one plain sentence per line. */
  sentences: string[]
  /** Every allowlisted call, as address + optional signature. */
  calls: { label: string; to: string | null; signature: string | null }[]
  /** Every spend cap, formatted. */
  caps: { token: string; amount: string; period: string; isNative: boolean }[]
  expiresAt: number
  /** Problems `validatePolicy` found. Empty on a policy we would actually grant. */
  problems: string[]
  scopeSummary: string
  scopeExclusion: string
}

/**
 * Build the session-key policy for a category and render it as sentences.
 *
 * Runs on the server because `@hallmark/altana` pulls the Altana SDK, which
 * has no business in a browser bundle. The client receives plain strings — the
 * scope a user reads and the scope the chain enforces come from the same
 * object, which is the only way to keep them honest.
 */
export function buildScopePreview(
  category: HallmarkCategory,
  chainId: SupportedChainId,
  opts: { ttlSeconds?: number; stableCapAtomic?: bigint; now?: number } = {},
): ScopePreview {
  const definition = CATEGORY_DEFINITIONS[category]
  const now = opts.now ?? Math.floor(Date.now() / 1000)

  const policy: AgentPolicy = buildPolicy(definition.policy, chainId, {
    now,
    ttlSeconds: opts.ttlSeconds ?? 7 * 24 * 60 * 60,
    ...(opts.stableCapAtomic === undefined ? {} : { stableCapAtomic: opts.stableCapAtomic }),
  })

  const validation = validatePolicy(policy, { now })

  return {
    category,
    label: policy.label,
    sentences: describePolicy(policy, { now }),
    calls: policy.calls.map((rule) => ({
      label: rule.label,
      to: rule.to ?? null,
      signature: rule.signature ?? null,
    })),
    caps: policy.spend.map((cap) => ({
      token: cap.token,
      amount: formatUnits(cap.limitAtomic, cap.decimals),
      period: cap.period,
      isNative: cap.token.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    })),
    expiresAt: policy.expiresAt,
    problems: validation.ok ? [] : validation.problems,
    scopeSummary: definition.scopeSummary,
    scopeExclusion: definition.scopeExclusion,
  }
}

/* ------------------------------------------------------------------ */
/* pricing                                                             */
/* ------------------------------------------------------------------ */

export type Quote = {
  budgetU: string
  budgetAtomic: string
  feeBps: number
  feeU: string
  providerReceivesU: string
}

export function quote(budgetU: string, feeBps: number): Quote | null {
  let atomic: bigint
  try {
    atomic = parseUnits(budgetU, U_DECIMALS)
  } catch {
    return null
  }
  if (atomic <= 0n) return null

  const fee = (atomic * BigInt(feeBps)) / 10_000n
  return {
    budgetU: formatUnits(atomic, U_DECIMALS),
    budgetAtomic: atomic.toString(),
    feeBps,
    feeU: formatUnits(fee, U_DECIMALS),
    providerReceivesU: formatUnits(atomic - fee, U_DECIMALS),
  }
}

/**
 * The `optParams` blob `fund` reads the agent id out of.
 *
 * This one value is what binds an escrow job to an ERC-8004 identity, and
 * therefore what the evidence gate keys off. Get it wrong and the hook reverts
 * with `AgentNotDeclared()`.
 */
export function encodeAgentId(agentId: number): `0x${string}` {
  return encodeAbiParameters([{ type: 'uint256' }], [BigInt(agentId)])
}

export type { AgentPolicy, CategoryDefinition }
