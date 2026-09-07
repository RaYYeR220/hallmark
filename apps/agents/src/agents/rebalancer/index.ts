import { defineSkill } from '../../runtime/types.js'
import type { AgentDefinition } from '../../runtime/types.js'
import { analyseRebalance, type RebalanceInput } from './analyse.js'
import { actRebalance, readCycles, type RebalanceActInput } from './act.js'
import { rebalancerManifest, rebalancerReportPrice } from './manifest.js'

const chainField = {
  kind: 'integer',
  description: 'BNB Chain id: 56 (mainnet) or 97 (testnet). Defaults to the service default.',
  optional: true,
  min: 56,
  max: 97,
} as const

const tokenIdField = {
  kind: 'uint',
  description: 'PancakeSwap v3 position NFT id, as reported by the position manager.',
} as const

const analyse = defineSkill<RebalanceInput>({
  id: 'analyse',
  name: 'Assess a v3 range',
  description:
    'Reads a PancakeSwap v3 position and its pool, decides whether the range still earns, and ' +
    'proposes a recentred range with the reasoning and the gas budget behind it. Read-only.',
  mode: 'read',
  tags: ['analysis', 'liquidity'],
  input: {
    tokenId: tokenIdField,
    chainId: chainField,
    widthBps: {
      kind: 'integer',
      description:
        'Half-width of the proposed range in basis points. Omit to keep the position\'s current width.',
      optional: true,
      min: 1,
      max: 100_000,
    },
    driftToleranceBps: {
      kind: 'integer',
      description:
        'Rebalance proactively once the price comes within this many bps of a range edge. 0 means only act once out of range.',
      optional: true,
      default: 0,
      min: 0,
      max: 10_000,
    },
    wallet: {
      kind: 'address',
      description: 'Wallet whose approvals to check. Defaults to the position owner.',
      optional: true,
    },
  },
  examples: [
    'Is position 2137641 still in range?',
    'Propose a ±150 bps range for position 2137641 and tell me what moving it costs.',
  ],
  run: (input, ctx) => analyseRebalance(input, ctx, { deep: false }),
})

const report = defineSkill<RebalanceInput>({
  id: 'report',
  name: 'Priced rebalance report',
  description:
    'Everything `analyse` returns, plus the parts that cost real work: a live QuoterV2 ' +
    'simulation of the exact ratio swap with its price impact, and the pool\'s trailing 24h APR ' +
    'turned into a payback period for the move. Sold over x402.',
  mode: 'read',
  tags: ['analysis', 'liquidity', 'paid'],
  input: analyse.input,
  price: rebalancerReportPrice(56),
  run: (input, ctx) => analyseRebalance(input, ctx, { deep: true }),
})

const act = defineSkill<RebalanceActInput>({
  id: 'act',
  name: 'Reset the range',
  description:
    'Executes decreaseLiquidity → collect → burn → [swap] → mint under an Altana session key ' +
    'scoped to the PancakeSwap v3 position manager and swap router. Re-running with the same ' +
    'intentId never executes twice. A call outside the key\'s scope comes back as a structured ' +
    'refusal naming the rule that blocked it.',
  mode: 'write',
  tags: ['on-chain', 'liquidity'],
  input: {
    tokenId: tokenIdField,
    intentId: {
      kind: 'string',
      description:
        'Idempotency key. The same id never executes twice; a repeat replays the recorded outcome.',
      minLength: 4,
      maxLength: 128,
    },
    chainId: chainField,
    widthBps: analyse.input['widthBps']!,
    driftToleranceBps: analyse.input['driftToleranceBps']!,
    slippageBps: {
      kind: 'integer',
      description: 'Slippage bound applied to every leg, in basis points.',
      optional: true,
      default: 50,
      min: 1,
      max: 1_000,
    },
    deadlineSeconds: {
      kind: 'integer',
      description: 'Seconds from now before the periphery calls expire.',
      optional: true,
      default: 600,
      min: 30,
      max: 3_600,
    },
  },
  run: (input, ctx) => actRebalance(input, ctx),
})

const cycles = defineSkill<{ tokenId: string; chainId?: number }>({
  id: 'cycles',
  name: 'Rebalance history',
  description:
    'Every rebalance cycle this agent has run for a position: what moved, when, the outcome, ' +
    'and the transaction. Repeated autonomous action is the point, so it is recorded.',
  mode: 'read',
  tags: ['history'],
  input: { tokenId: tokenIdField, chainId: chainField },
  run: async (input, ctx) => {
    const chainId = input.chainId ?? ctx.chainId
    const records = await readCycles(ctx, chainId, input.tokenId)
    return {
      agent: rebalancerManifest.slug,
      chainId,
      tokenId: input.tokenId,
      cycleCount: records.length,
      cycles: records,
    }
  },
})

export const rebalancerAgent: AgentDefinition = {
  manifest: rebalancerManifest,
  skills: [analyse, report, act, cycles],
}

export { rebalancerManifest }
