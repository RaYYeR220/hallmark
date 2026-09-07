import { getChain, isSupportedChainId, type SupportedChainId } from '@hallmark/core'
import { parseUnits, type Address } from 'viem'

import { quoteExactInputSingle, readPool, type PoolView } from '../../chain/pancake.js'
import { sqrtPriceX96ToPrice, tickToPrice } from '../../chain/math.js'
import {
  allAgree,
  assertion,
  failedAssertions,
  reconcile,
  type Assertion,
  type Reconciliation,
} from '../../chain/reconcile.js'
import { clientFor } from '../../runtime/client.js'
import { narrate } from '../../runtime/narrative.js'
import type { Analysis, SkillContext, Source } from '../../runtime/types.js'
import { GRID_SLUG } from './manifest.js'
import {
  gridPrices,
  gridStepPct,
  loadGrid,
  newGridState,
  nextAction,
  saveGrid,
  type GridAction,
  type GridDefinition,
  type GridState,
} from './state.js'

export type GridInput = {
  chainId?: number
  gridId: string
  token0?: string
  token1?: string
  fee?: number
  lowerPrice?: number
  upperPrice?: number
  levels?: number
  sizePerLevel?: string
}

export type GridDecision = {
  action: GridAction
  price: number
  inBand: boolean
  step: { pct: number; levels: number; lowerPrice: number; upperPrice: number }
  slots: GridState['slots']
  filled: number
  empty: number
  inventory: {
    token0HeldAtomic: string
    token0HeldDisplay: string
    token1DeployedAtomic: string
    realisedToken1Atomic: string
    realisedToken1Display: string
    completedRoundTrips: number
  }
  quote: {
    tokenIn: string
    tokenOut: string
    amountInAtomic: string
    amountOutAtomic: string
    effectivePrice: number
    priceImpactBps: number
    minOutAtomic: string
  } | null
  checks: Reconciliation[]
  assertions: Assertion[]
  checksPass: boolean
}

export type GridAnalysis = Analysis<GridDecision>

/**
 * Read the grid, price the pool, decide the next order.
 *
 * The grid is created on first sight from the parameters supplied and then
 * *never* silently redefined: a later call with different bounds is an error,
 * not an update, because rewriting a live grid's levels under its own fills is
 * how a bot ends up selling what it never bought.
 */
export async function analyseGrid(
  input: GridInput,
  ctx: SkillContext,
  opts: { deep: boolean },
): Promise<GridAnalysis | { error: string; detail: string }> {
  const chainId: SupportedChainId =
    input.chainId !== undefined && isSupportedChainId(input.chainId) ? input.chainId : ctx.chainId
  const chain = getChain(chainId)
  const client = clientFor(ctx, chainId)
  const now = ctx.now()
  const sources: Source[] = []
  const warnings: string[] = []

  let state = await loadGrid(ctx.store, chainId, input.gridId)

  if (state === null) {
    const missing = (['token0', 'token1', 'fee', 'lowerPrice', 'upperPrice', 'levels', 'sizePerLevel'] as const).filter(
      (field) => input[field] === undefined,
    )
    if (missing.length > 0) {
      return {
        error: 'grid-not-defined',
        detail:
          `No grid "${input.gridId}" exists on chain ${chainId}, and defining one needs ` +
          `${missing.join(', ')}. Supply them once; after that the grid is loaded from state ` +
          'and only the id is needed.',
      }
    }

    const pool = await readPool({
      client,
      chainId,
      token0: input.token0 as Address,
      token1: input.token1 as Address,
      fee: input.fee!,
    })
    if ('ok' in pool) {
      return { error: 'no-pool', detail: pool.detail }
    }

    const definition: GridDefinition = {
      gridId: input.gridId,
      chainId,
      pool: pool.pool,
      token0: pool.token0.address,
      token1: pool.token1.address,
      token0Symbol: pool.token0.symbol,
      token1Symbol: pool.token1.symbol,
      token0Decimals: pool.token0.decimals,
      token1Decimals: pool.token1.decimals,
      fee: pool.fee,
      lowerPrice: input.lowerPrice!,
      upperPrice: input.upperPrice!,
      levels: input.levels!,
      sizePerLevelAtomic: parseUnits(input.sizePerLevel!, pool.token1.decimals).toString(),
      createdAt: new Date(now * 1000).toISOString(),
    }

    try {
      gridPrices(definition.lowerPrice, definition.upperPrice, definition.levels)
    } catch (error) {
      return {
        error: 'invalid-grid',
        detail: error instanceof Error ? error.message : String(error),
      }
    }

    state = newGridState(definition)
    await saveGrid(ctx.store, state)
    warnings.push(
      `Grid "${input.gridId}" did not exist and was created from the parameters supplied. ` +
        'Later calls only need the id.',
    )
  } else {
    // Guard against a redefinition that would strand fills.
    const drift: string[] = []
    if (input.lowerPrice !== undefined && input.lowerPrice !== state.definition.lowerPrice) {
      drift.push(`lowerPrice ${state.definition.lowerPrice} → ${input.lowerPrice}`)
    }
    if (input.upperPrice !== undefined && input.upperPrice !== state.definition.upperPrice) {
      drift.push(`upperPrice ${state.definition.upperPrice} → ${input.upperPrice}`)
    }
    if (input.levels !== undefined && input.levels !== state.definition.levels) {
      drift.push(`levels ${state.definition.levels} → ${input.levels}`)
    }
    if (drift.length > 0) {
      return {
        error: 'grid-redefinition',
        detail:
          `Grid "${input.gridId}" already exists with ${state.slots.filter((s) => s.state === 'filled').length} ` +
          `filled slot(s), and this call asks to change ${drift.join('; ')}. A live grid is not ` +
          'redefined in place — the existing fills would no longer correspond to any level. ' +
          'Use a new gridId, or close the existing one first.',
      }
    }
  }

  const definition = state.definition
  const pool = await readPool({
    client,
    chainId,
    token0: definition.token0,
    token1: definition.token1,
    fee: definition.fee,
  })
  if ('ok' in pool) {
    return { error: 'no-pool', detail: pool.detail }
  }

  sources.push({
    kind: 'onchain',
    label: `Pool ${definition.token0Symbol}/${definition.token1Symbol} ${definition.fee / 10_000}%`,
    detail: `slot0() on ${pool.pool}`,
    url: `${chain.explorer}/address/${pool.pool}`,
  })
  sources.push({
    kind: 'config',
    label: 'Grid state',
    detail: `Loaded grid "${definition.gridId}" with ${state.slots.length} levels and ${state.history.length} recorded order(s).`,
  })

  const price = pool.price
  const action = nextAction(state, price)

  // Two derivations of the same price out of one struct. They agree to within
  // a tick, or the token order or decimals are wrong somewhere.
  const checks: Reconciliation[] = [
    reconcile({
      label: 'Pool price',
      primary: { source: 'slot0().sqrtPriceX96', value: sqrtPriceX96ToPrice(pool.sqrtPriceX96, pool.token0.decimals, pool.token1.decimals) },
      secondary: { source: 'slot0().tick', value: tickToPrice(pool.tick, pool.token0.decimals, pool.token1.decimals) },
      toleranceBps: 10,
    }),
  ]

  // A grid whose band is nowhere near the pair's price is almost always a band
  // written for the inverse orientation: the pool decides which token is
  // token0, and "600–900" for BNB/USDT is "0.0011–0.0017" once the pool sorts
  // USDT first. Accepting it silently produces a grid that will never trigger
  // and looks like it is simply waiting.
  const inverted = price > 0 && (price * 100 < definition.lowerPrice || price / 100 > definition.upperPrice)
  const assertions: Assertion[] = [
    assertion(
      'Band matches how the pool quotes this pair',
      !inverted,
      inverted
        ? `The pool quotes ${definition.token1Symbol} per ${definition.token0Symbol} at ` +
          `${price.toPrecision(6)}, but the band is ${definition.lowerPrice}–${definition.upperPrice} — ` +
          'more than a hundredfold away. This pair is almost certainly quoted the other way round ' +
          `from what the band assumes; inverted, the band would be ` +
          `${(1 / definition.upperPrice).toPrecision(6)}–${(1 / definition.lowerPrice).toPrecision(6)}. ` +
          'A grid this far from the price never triggers and looks like it is merely waiting.'
        : `Price ${price.toPrecision(6)} sits within a hundredfold of the band ` +
          `${definition.lowerPrice}–${definition.upperPrice}.`,
    ),
    assertion(
      'Levels are strictly increasing',
      state.slots.every((slot, i) => i === 0 || slot.price > state!.slots[i - 1]!.price),
      `${state.slots.length} levels from ${definition.lowerPrice} to ${definition.upperPrice}.`,
    ),
    assertion(
      'Grid state matches its definition',
      state.slots.length === definition.levels,
      `Stored state has ${state.slots.length} slots against a definition of ${definition.levels}.`,
    ),
    assertion(
      'Filled slots hold something',
      state.slots.every((slot) => slot.state !== 'filled' || BigInt(slot.heldAtomic) > 0n),
      'A slot marked filled with a zero balance would sell nothing and mark a phantom round trip.',
    ),
  ]

  // --- live quote (paid path only) -----------------------------------------
  let quote: GridDecision['quote'] = null
  if (opts.deep && action.side !== 'none' && action.amountInAtomic > 0n) {
    const buying = action.side === 'buy'
    const tokenIn = buying ? pool.token1 : pool.token0
    const tokenOut = buying ? pool.token0 : pool.token1
    const result = await quoteExactInputSingle({
      client,
      chainId,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      fee: definition.fee,
      amountIn: action.amountInAtomic,
    })
    if (result.ok) {
      const inUnits = Number(action.amountInAtomic) / 10 ** tokenIn.decimals
      const outUnits = Number(result.amountOut) / 10 ** tokenOut.decimals
      const effectivePrice = buying ? inUnits / outUnits : outUnits / inUnits
      const impact = ((effectivePrice - price) / price) * 10_000 * (buying ? 1 : -1)
      quote = {
        tokenIn: tokenIn.symbol,
        tokenOut: tokenOut.symbol,
        amountInAtomic: action.amountInAtomic.toString(),
        amountOutAtomic: result.amountOut.toString(),
        effectivePrice,
        priceImpactBps: impact,
        minOutAtomic: ((result.amountOut * 9_950n) / 10_000n).toString(),
      }
      sources.push({
        kind: 'onchain',
        label: 'PancakeSwap QuoterV2',
        detail: `quoteExactInputSingle simulated on ${chain.defi.pancakeQuoterV2}`,
      })
      // A single-hop swap pays the fee tier, so its effective price is always
      // worse than the mid. Better means the mid is stale.
      assertions.push(
        assertion(
          'Quote is worse than the pool mid',
          impact >= -1,
          `Effective ${effectivePrice.toPrecision(8)} against a mid of ${price.toPrecision(8)} ` +
            `(${impact.toFixed(1)} bps). The ${definition.fee / 10_000}% fee makes anything better ` +
            'than the mid impossible.',
        ),
      )
    } else {
      warnings.push(`Live quote unavailable: ${result.detail}`)
    }
  }

  const failed = failedAssertions(assertions)
  const checksPass = allAgree(checks) && failed.length === 0
  if (!checksPass) {
    warnings.push(
      ...checks.filter((check) => !check.agrees).map((check) => check.detail),
      ...failed.map((check) => `${check.label} failed: ${check.detail}`),
    )
  }

  const held = state.slots.reduce((sum, slot) => sum + BigInt(slot.heldAtomic), 0n)
  const realised = state.slots.reduce((sum, slot) => sum + BigInt(slot.realisedToken1Atomic), 0n)
  const filled = state.slots.filter((slot) => slot.state === 'filled').length

  const decision: GridDecision = {
    action,
    price,
    inBand: price >= definition.lowerPrice && price <= definition.upperPrice,
    step: {
      pct: gridStepPct(definition.lowerPrice, definition.upperPrice, definition.levels),
      levels: definition.levels,
      lowerPrice: definition.lowerPrice,
      upperPrice: definition.upperPrice,
    },
    slots: state.slots,
    filled,
    empty: state.slots.length - filled,
    inventory: {
      token0HeldAtomic: held.toString(),
      token0HeldDisplay: `${Number(held) / 10 ** definition.token0Decimals} ${definition.token0Symbol}`,
      token1DeployedAtomic: (BigInt(definition.sizePerLevelAtomic) * BigInt(filled)).toString(),
      realisedToken1Atomic: realised.toString(),
      realisedToken1Display: `${Number(realised) / 10 ** definition.token1Decimals} ${definition.token1Symbol}`,
      completedRoundTrips: state.slots.reduce((sum, slot) => sum + slot.cycles, 0),
    },
    quote,
    checks,
    assertions,
    checksPass,
  }

  const lines = [
    `Grid "${definition.gridId}" on ${definition.token0Symbol}/${definition.token1Symbol} ` +
      `${definition.fee / 10_000}%: ${filled}/${definition.levels} slots filled, ` +
      `${decision.inventory.completedRoundTrips} completed round trip(s).`,
    `Price ${price.toPrecision(8)} ${definition.token1Symbol} per ${definition.token0Symbol}; ` +
      `band ${definition.lowerPrice.toPrecision(6)}–${definition.upperPrice.toPrecision(6)}, ` +
      `${decision.step.pct.toFixed(2)}% per step.`,
    action.reason,
    ...(quote
      ? [
          `Live quote: ${quote.amountInAtomic} ${quote.tokenIn} → ${quote.amountOutAtomic} ` +
            `${quote.tokenOut}, effective ${quote.effectivePrice.toPrecision(8)} ` +
            `(${quote.priceImpactBps.toFixed(1)} bps against the mid).`,
        ]
      : []),
  ]

  return {
    agent: GRID_SLUG,
    skill: opts.deep ? 'report' : 'analyse',
    chainId,
    subject: {
      gridId: definition.gridId,
      pool: definition.pool,
      pair: `${definition.token0Symbol}/${definition.token1Symbol}`,
    },
    observedAt: new Date(now * 1000).toISOString(),
    decision,
    facts: { definition, pool: poolFacts(pool), history: state.history.slice(-20) },
    sources,
    warnings,
    narrative: await narrate({ agent: GRID_SLUG, skill: opts.deep ? 'report' : 'analyse', decision, lines }),
  }
}

function poolFacts(pool: PoolView) {
  return {
    pool: pool.pool,
    tick: pool.tick,
    sqrtPriceX96: pool.sqrtPriceX96.toString(),
    liquidity: pool.liquidity.toString(),
    price: pool.price,
  }
}
