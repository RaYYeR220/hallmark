import { defineSkill } from '../../runtime/types.js'
import type { AgentDefinition, Shape } from '../../runtime/types.js'
import { analyseYield, type YieldInput } from './analyse.js'
import type { MandateInput } from './mandate.js'
import { actYield } from './act.js'
import { yieldManifest, yieldReportPrice } from './manifest.js'

/**
 * Fold the flat mandate fields into the object the allocator takes.
 *
 * The wire format is flat because a JSON Schema of nested optionals is
 * miserable to write against by hand and worse for an MCP client to render.
 * The allocator wants one object, so the translation happens here rather than
 * being smeared through the analysis.
 */
type FlatYieldInput = {
  asset: string
  amount: string
  chainId?: number
  maxIlRisk?: 'no' | 'yes'
  stablecoinOnly?: boolean
  allowOutliers?: boolean
  minTvlUsd?: number
  maxSingleVenuePct?: number
  requireOnchainVerifiable?: boolean
  includeIlRisk?: boolean
  intentId?: string
  venue?: string
}

function toYieldInput(input: FlatYieldInput): YieldInput {
  const mandate: MandateInput = {
    ...(input.maxIlRisk === undefined ? {} : { maxIlRisk: input.maxIlRisk }),
    ...(input.stablecoinOnly === undefined ? {} : { stablecoinOnly: input.stablecoinOnly }),
    ...(input.allowOutliers === undefined ? {} : { allowOutliers: input.allowOutliers }),
    ...(input.minTvlUsd === undefined ? {} : { minTvlUsd: input.minTvlUsd }),
    ...(input.maxSingleVenuePct === undefined ? {} : { maxSingleVenuePct: input.maxSingleVenuePct }),
    ...(input.requireOnchainVerifiable === undefined
      ? {}
      : { requireOnchainVerifiable: input.requireOnchainVerifiable }),
    // The deprecated flag maps on, but never overrides an explicit maxIlRisk.
    ...(input.includeIlRisk === true && input.maxIlRisk === undefined
      ? { maxIlRisk: 'yes' as const }
      : {}),
  }
  return {
    asset: input.asset,
    amount: input.amount,
    ...(input.chainId === undefined ? {} : { chainId: input.chainId }),
    ...(Object.keys(mandate).length === 0 ? {} : { mandate }),
  }
}

const shape: Shape = {
  asset: {
    kind: 'string',
    description: 'Asset symbol to route, e.g. USDT, BNB, BTCB.',
    minLength: 2,
    maxLength: 16,
  },
  amount: {
    kind: 'string',
    description: 'Amount in whole units, as a decimal string (e.g. "5000").',
    minLength: 1,
    maxLength: 40,
  },
  chainId: {
    kind: 'integer',
    description: 'BNB Chain id: 56 (mainnet) or 97 (testnet).',
    optional: true,
    min: 56,
    max: 97,
  },
  maxIlRisk: {
    kind: 'string',
    description:
      "Highest impermanent-loss risk tolerated, as DeFiLlama grades it. 'no' is the honest reading of \"no directional exposure\" and is the default.",
    optional: true,
    choices: ['no', 'yes'],
  },
  stablecoinOnly: {
    kind: 'boolean',
    description: 'Only venues DeFiLlama marks as stablecoin.',
    optional: true,
  },
  allowOutliers: {
    kind: 'boolean',
    description:
      "Allow pools carrying DeFiLlama's own APY outlier flag. Off by default: if its own data provider will not stand behind the number, neither does this agent.",
    optional: true,
  },
  minTvlUsd: {
    kind: 'number',
    description: 'Ignore venues shallower than this. Defaults to $1,000,000.',
    optional: true,
    min: 0,
  },
  maxSingleVenuePct: {
    kind: 'number',
    description:
      'Never put more than this share of the allocation in one venue. Defaults to 50; the allocation is split across eligible venues to respect it.',
    optional: true,
    min: 1,
    max: 100,
  },
  requireOnchainVerifiable: {
    kind: 'boolean',
    description:
      'Only venues whose rate this agent can read on-chain itself, so no APR is repeated from a single third party. Excludes everything but Venus today.',
    optional: true,
  },
  includeIlRisk: {
    kind: 'boolean',
    description:
      "Deprecated alias for maxIlRisk: 'yes'. Kept so existing callers keep working.",
    optional: true,
  },
}

const analyse = defineSkill<FlatYieldInput>({
  id: 'analyse',
  name: 'Compare venues',
  description:
    'Ranks BNB Chain venues for an asset, using the lending market\'s own on-chain rate and ' +
    'DeFiLlama side by side, with depth read on-chain rather than taken from DeFiLlama\'s TVL ' +
    'field. Returns a specific allocation, the risks attached to it, and what the move costs. ' +
    'Read-only.',
  mode: 'read',
  tags: ['analysis', 'yield'],
  input: shape,
  examples: [
    'Where should 5000 USDT sit on BNB Chain right now?',
    'Compare BNB lending venues including LP pools with IL risk.',
  ],
  run: (input, ctx) => analyseYield(toYieldInput(input), ctx, { deep: false }),
})

const report = defineSkill<FlatYieldInput>({
  id: 'report',
  name: 'Priced yield report',
  description:
    'Everything `analyse` returns, with the full DeFiLlama pool set for the asset rather than a ' +
    'sample, so the ranking can be audited rather than taken on trust. Sold over x402.',
  mode: 'read',
  tags: ['analysis', 'yield', 'paid'],
  input: shape,
  price: yieldReportPrice(56),
  run: (input, ctx) => analyseYield(toYieldInput(input), ctx, { deep: true }),
})

const act = defineSkill<FlatYieldInput & { intentId: string }>({
  id: 'act',
  name: 'Route the capital',
  description:
    'Supplies the asset into the chosen Venus market under an Altana session key scoped to the ' +
    'Venus comptroller and its markets. Refuses when the two rate sources disagree, when the ' +
    'move does not pay for its own gas, or when the best venue is outside the key\'s scope — in ' +
    'that last case it says so rather than routing somewhere else.',
  mode: 'write',
  tags: ['on-chain', 'yield'],
  input: {
    ...shape,
    intentId: {
      kind: 'string',
      description: 'Idempotency key. The same id never executes twice.',
      minLength: 4,
      maxLength: 128,
    },
    venue: {
      kind: 'string',
      description: 'Destination venue name from `analyse`. Defaults to the highest-yielding one.',
      optional: true,
    },
  },
  run: (input, ctx) => actYield({ ...toYieldInput(input), intentId: input.intentId, ...(input.venue === undefined ? {} : { venue: input.venue }) }, ctx),
})

export const yieldAgent: AgentDefinition = {
  manifest: yieldManifest,
  skills: [analyse, report, act],
}

export { yieldManifest }
