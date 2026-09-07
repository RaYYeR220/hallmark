import { defineSkill } from '../../runtime/types.js'
import type { AgentDefinition, Shape } from '../../runtime/types.js'
import { analyseYield, type YieldInput } from './analyse.js'
import { actYield, type YieldActInput } from './act.js'
import { yieldManifest, yieldReportPrice } from './manifest.js'

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
  minTvlUsd: {
    kind: 'number',
    description: 'Ignore venues shallower than this. Defaults to $1,000,000.',
    optional: true,
    min: 0,
  },
  includeIlRisk: {
    kind: 'boolean',
    description:
      'Include LP venues DeFiLlama flags for impermanent loss. Off by default: their quoted APR is fee income, not a return.',
    optional: true,
    default: false,
  },
}

const analyse = defineSkill<YieldInput>({
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
  run: (input, ctx) => analyseYield(input, ctx, { deep: false }),
})

const report = defineSkill<YieldInput>({
  id: 'report',
  name: 'Priced yield report',
  description:
    'Everything `analyse` returns, with the full DeFiLlama pool set for the asset rather than a ' +
    'sample, so the ranking can be audited rather than taken on trust. Sold over x402.',
  mode: 'read',
  tags: ['analysis', 'yield', 'paid'],
  input: shape,
  price: yieldReportPrice(56),
  run: (input, ctx) => analyseYield(input, ctx, { deep: true }),
})

const act = defineSkill<YieldActInput>({
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
  run: (input, ctx) => actYield(input, ctx),
})

export const yieldAgent: AgentDefinition = {
  manifest: yieldManifest,
  skills: [analyse, report, act],
}

export { yieldManifest }
