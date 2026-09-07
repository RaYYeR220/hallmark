import { defineSkill } from '../../runtime/types.js'
import type { AgentDefinition, Shape } from '../../runtime/types.js'
import { analyseGrid, type GridInput } from './analyse.js'
import { actGrid, type GridActInput } from './act.js'
import { gridManifest, gridReportPrice, GRID_SLUG } from './manifest.js'
import { loadGrid } from './state.js'

const gridShape: Shape = {
  gridId: {
    kind: 'string',
    description:
      'Stable name for this grid. State is keyed by it, so the same id resumes the same grid across restarts.',
    minLength: 2,
    maxLength: 64,
  },
  chainId: {
    kind: 'integer',
    description: 'BNB Chain id: 56 (mainnet) or 97 (testnet).',
    optional: true,
    min: 56,
    max: 97,
  },
  token0: {
    kind: 'address',
    description: 'First token of the pair. Required only when creating the grid.',
    optional: true,
  },
  token1: {
    kind: 'address',
    description: 'Second token of the pair. Required only when creating the grid.',
    optional: true,
  },
  fee: {
    kind: 'integer',
    description: 'PancakeSwap v3 fee tier: 100, 500, 2500 or 10000.',
    optional: true,
    min: 100,
    max: 10_000,
  },
  lowerPrice: {
    kind: 'number',
    description: 'Bottom of the band, in whole token1 per whole token0.',
    optional: true,
    min: 0,
  },
  upperPrice: {
    kind: 'number',
    description: 'Top of the band, in whole token1 per whole token0.',
    optional: true,
    min: 0,
  },
  levels: {
    kind: 'integer',
    description: 'Number of grid levels, inclusive of both bounds. Spacing is geometric.',
    optional: true,
    min: 2,
    max: 200,
  },
  sizePerLevel: {
    kind: 'string',
    description: 'Token1 to spend per buy, as a decimal string in whole units (e.g. "50").',
    optional: true,
  },
}

const analyse = defineSkill<GridInput>({
  id: 'analyse',
  name: 'Read the grid',
  description:
    'Loads the grid, prices the pool and reports which level triggers next, which slots are ' +
    'filled, and what the grid has realised so far. Creates the grid on first call from the ' +
    'parameters supplied. Read-only.',
  mode: 'read',
  tags: ['analysis', 'grid'],
  input: gridShape,
  examples: [
    'Create a 12-level grid on WBNB/USDT 0.05% between 520 and 720 at 50 USDT a level.',
    'What does grid "bnb-core" do next?',
  ],
  run: (input, ctx) => analyseGrid(input, ctx, { deep: false }),
})

const report = defineSkill<GridInput>({
  id: 'report',
  name: 'Priced grid report',
  description:
    'Everything `analyse` returns, plus a live QuoterV2 simulation of the exact next order — ' +
    'the amount out, the effective price and the impact against the pool mid. Sold over x402.',
  mode: 'read',
  tags: ['analysis', 'grid', 'paid'],
  input: gridShape,
  price: gridReportPrice(56),
  run: (input, ctx) => analyseGrid(input, ctx, { deep: true }),
})

const act = defineSkill<GridActInput>({
  id: 'act',
  name: 'Place the next order',
  description:
    'Places at most one grid order per call, as a single exactInputSingle through the ' +
    'PancakeSwap v3 router under an Altana session key scoped to that router. Grid state only ' +
    'advances on a confirmed order, so a refusal retries the same level rather than skipping it. ' +
    'Re-running with the same intentId never executes twice.',
  mode: 'write',
  tags: ['on-chain', 'grid'],
  input: {
    ...gridShape,
    intentId: {
      kind: 'string',
      description: 'Idempotency key. The same id never executes twice.',
      minLength: 4,
      maxLength: 128,
    },
    slippageBps: {
      kind: 'integer',
      description: 'Slippage bound against the live quote, in basis points.',
      optional: true,
      default: 50,
      min: 1,
      max: 1_000,
    },
  },
  run: (input, ctx) => actGrid(input, ctx),
})

const state = defineSkill<{ gridId: string; chainId?: number }>({
  id: 'state',
  name: 'Grid state and order history',
  description:
    'The stored grid: its definition, every slot with its fill, and every order placed. This is ' +
    'what a restart resumes from.',
  mode: 'read',
  tags: ['history', 'grid'],
  input: {
    gridId: gridShape['gridId']!,
    chainId: gridShape['chainId']!,
  },
  run: async (input, ctx) => {
    const chainId = input.chainId ?? ctx.chainId
    const stored = await loadGrid(ctx.store, chainId, input.gridId)
    if (stored === null) {
      return {
        agent: GRID_SLUG,
        chainId,
        gridId: input.gridId,
        exists: false,
        detail: `No grid "${input.gridId}" is stored for chain ${chainId}.`,
      }
    }
    return {
      agent: GRID_SLUG,
      chainId,
      gridId: input.gridId,
      exists: true,
      definition: stored.definition,
      slots: stored.slots,
      orders: stored.history,
      filled: stored.slots.filter((slot) => slot.state === 'filled').length,
      completedRoundTrips: stored.slots.reduce((sum, slot) => sum + slot.cycles, 0),
    }
  },
})

export const gridAgent: AgentDefinition = {
  manifest: gridManifest,
  skills: [analyse, report, act, state],
}

export { gridManifest }
