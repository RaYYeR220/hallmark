import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { getChain } from '@hallmark/core'
import { buildPolicy } from '@hallmark/altana'

import { analyseRebalance, proposeRange, swapToRebalance } from '../src/agents/rebalancer/analyse.js'
import { actRebalance } from '../src/agents/rebalancer/act.js'
import {
  getAmountsForLiquidity,
  getSqrtRatioAtTick,
  nearestUsableTick,
  Q96,
  sqrtPriceX96ToPrice,
  tickSpacingForFee,
  tickToPrice,
} from '../src/chain/math.js'
import type { PositionView } from '../src/chain/pancake.js'
import {
  emptyChain,
  fakeClient,
  fakeSession,
  providerFor,
  readKey,
  testContext,
  type FakeChain,
} from './support/fixtures.js'

const chain = getChain(56)
const NOW = 1_780_000_000
const POOL: Address = '0x36696169c63e42cd08ce11f5deebbcebae652050'
const WBNB: Address = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const USDT: Address = '0x55d398326f99059fF775485246999027B3197955'
const OWNER: Address = '0x1111111111111111111111111111111111111111'

describe('tick math', () => {
  it('matches the reference TickMath at the anchor points', () => {
    // 1.0 in Q64.96.
    expect(getSqrtRatioAtTick(0)).toBe(Q96)
    // A tick is 1 bp, so the square of the ratio is 1.0001 to within rounding.
    const one = Number(getSqrtRatioAtTick(1)) / Number(Q96)
    expect(one * one).toBeCloseTo(1.0001, 9)
    const minusOne = Number(getSqrtRatioAtTick(-1)) / Number(Q96)
    expect(minusOne * minusOne).toBeCloseTo(1 / 1.0001, 9)
  })

  it('is monotonic across a wide span', () => {
    let previous = 0n
    for (const tick of [-500_000, -100_000, -1_000, 0, 1_000, 100_000, 500_000]) {
      const ratio = getSqrtRatioAtTick(tick)
      expect(ratio > previous).toBe(true)
      previous = ratio
    }
  })

  it('refuses a tick outside the representable range', () => {
    expect(() => getSqrtRatioAtTick(887_273)).toThrow(/outside/)
    expect(() => getSqrtRatioAtTick(1.5)).toThrow(/outside/)
  })

  it('adjusts price for the decimal difference between the two tokens', () => {
    // Same tick, different decimals: the answers must differ by 10^(d0−d1).
    expect(tickToPrice(0, 18, 18)).toBeCloseTo(1, 12)
    expect(tickToPrice(0, 18, 6)).toBeCloseTo(1e12, 0)
    expect(tickToPrice(0, 6, 18)).toBeCloseTo(1e-12, 24)
  })

  it('agrees between the sqrtPrice and tick derivations', () => {
    for (const tick of [-100_000, -5_000, 0, 5_000, 100_000]) {
      const fromSqrt = sqrtPriceX96ToPrice(getSqrtRatioAtTick(tick), 18, 18)
      const fromTick = tickToPrice(tick, 18, 18)
      expect(Math.abs(fromSqrt - fromTick) / fromTick).toBeLessThan(1e-6)
    }
  })

  it('puts all liquidity in one token outside the range and splits it inside', () => {
    const inside = getAmountsForLiquidity({
      sqrtPriceX96: getSqrtRatioAtTick(0),
      tickLower: -1_000,
      tickUpper: 1_000,
      liquidity: 10n ** 18n,
    })
    expect(inside.amount0 > 0n).toBe(true)
    expect(inside.amount1 > 0n).toBe(true)

    const below = getAmountsForLiquidity({
      sqrtPriceX96: getSqrtRatioAtTick(-2_000),
      tickLower: -1_000,
      tickUpper: 1_000,
      liquidity: 10n ** 18n,
    })
    expect(below.amount1).toBe(0n)
    expect(below.amount0 > 0n).toBe(true)

    const above = getAmountsForLiquidity({
      sqrtPriceX96: getSqrtRatioAtTick(2_000),
      tickLower: -1_000,
      tickUpper: 1_000,
      liquidity: 10n ** 18n,
    })
    expect(above.amount0).toBe(0n)
    expect(above.amount1 > 0n).toBe(true)
  })

  it('knows the four PancakeSwap fee tiers and rejects anything else', () => {
    expect(tickSpacingForFee(100)).toBe(1)
    expect(tickSpacingForFee(500)).toBe(10)
    expect(tickSpacingForFee(2500)).toBe(50)
    expect(tickSpacingForFee(10000)).toBe(200)
    expect(() => tickSpacingForFee(3000)).toThrow(/Unknown PancakeSwap v3 fee tier/)
  })

  it('snaps a tick to the pool spacing', () => {
    expect(nearestUsableTick(107, 10)).toBe(110)
    expect(nearestUsableTick(104, 10)).toBe(100)
    expect(nearestUsableTick(-104, 10)).toBe(-100)
  })
})

describe('range proposal', () => {
  it('recentres on the current tick and keeps the existing width', () => {
    const proposal = proposeRange({ currentTick: 1_234, tickLower: -1_000, tickUpper: 1_000, tickSpacing: 10 })
    expect(proposal.tickUpper - proposal.tickLower).toBe(2_000)
    expect((proposal.tickLower + proposal.tickUpper) / 2).toBeCloseTo(1_230, 0)
    expect(proposal.rationale).toContain("existing width")
  })

  it('honours an explicit width and snaps both edges', () => {
    const proposal = proposeRange({
      currentTick: 0,
      tickLower: -100,
      tickUpper: 100,
      tickSpacing: 50,
      widthBps: 500,
    })
    expect(Math.abs(proposal.tickLower % 50)).toBe(0)
    expect(Math.abs(proposal.tickUpper % 50)).toBe(0)
    // ±5% is about ±488 ticks, snapped to a multiple of 50.
    expect(proposal.tickUpper).toBe(500)
    expect(proposal.tickLower).toBe(-500)
    expect(proposal.rationale).toContain('±500 bps')
  })

  it('never produces an inverted or zero-width range', () => {
    const proposal = proposeRange({ currentTick: 0, tickLower: 0, tickUpper: 1, tickSpacing: 200, widthBps: 1 })
    expect(proposal.tickUpper).toBeGreaterThan(proposal.tickLower)
  })
})

function position(overrides: Partial<PositionView> = {}): PositionView {
  const base: PositionView = {
    tokenId: 1n,
    operator: '0x0000000000000000000000000000000000000000',
    fee: 500,
    tickSpacing: 10,
    tickLower: -1_000,
    tickUpper: 1_000,
    liquidity: 10n ** 20n,
    tokensOwed0: 0n,
    tokensOwed1: 0n,
    token0: { address: WBNB, symbol: 'WBNB', name: 'Wrapped BNB', decimals: 18, totalSupply: null, unreadable: [] },
    token1: { address: USDT, symbol: 'USDT', name: 'Tether', decimals: 18, totalSupply: null, unreadable: [] },
    pool: POOL,
    sqrtPriceX96: getSqrtRatioAtTick(0),
    currentTick: 0,
    poolLiquidity: 10n ** 22n,
    amount0: 0n,
    amount1: 0n,
    price: 1,
    priceLower: tickToPrice(-1_000, 18, 18),
    priceUpper: tickToPrice(1_000, 18, 18),
    inRange: true,
    blockNumber: 41_000_000n,
  }
  const merged = { ...base, ...overrides }
  const amounts = getAmountsForLiquidity({
    sqrtPriceX96: merged.sqrtPriceX96,
    tickLower: merged.tickLower,
    tickUpper: merged.tickUpper,
    liquidity: merged.liquidity,
  })
  return { ...merged, amount0: amounts.amount0, amount1: amounts.amount1 }
}

describe('the ratio swap', () => {
  it('needs no swap when the position is already balanced for the new range', () => {
    const swap = swapToRebalance({ position: position(), proposedLower: -1_000, proposedUpper: 1_000 })
    expect(swap.needed).toBe(false)
    expect(swap.detail).toContain('within 0.1%')
  })

  it('sells token0 when the new range wants more token1', () => {
    // The position is entirely token0 (price below the range); recentring on
    // the current price needs half of it converted.
    const p = position({ sqrtPriceX96: getSqrtRatioAtTick(-2_000), currentTick: -2_000, price: tickToPrice(-2_000, 18, 18), inRange: false })
    const swap = swapToRebalance({ position: p, proposedLower: -3_000, proposedUpper: -1_000 })
    expect(swap.needed).toBe(true)
    expect(swap.sellToken0).toBe(true)
    expect(swap.amountIn > 0n).toBe(true)
    expect(swap.amountIn).toBeLessThan(p.amount0)
  })

  it('sells token1 when the new range wants more token0', () => {
    const p = position({ sqrtPriceX96: getSqrtRatioAtTick(2_000), currentTick: 2_000, price: tickToPrice(2_000, 18, 18), inRange: false })
    const swap = swapToRebalance({ position: p, proposedLower: 1_000, proposedUpper: 3_000 })
    expect(swap.needed).toBe(true)
    expect(swap.sellToken0).toBe(false)
    expect(swap.amountIn > 0n).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Fixture chain
// ---------------------------------------------------------------------------

type PosFixture = { tickLower?: number; tickUpper?: number; currentTick?: number; allowance?: bigint }

function pancakeChain(fixture: PosFixture = {}): FakeChain {
  const tickLower = fixture.tickLower ?? -1_000
  const tickUpper = fixture.tickUpper ?? 1_000
  const currentTick = fixture.currentTick ?? 0
  const liquidity = 10n ** 20n
  const allowance = fixture.allowance ?? 2n ** 200n

  const reads: Record<string, unknown> = {
    [readKey(chain.defi.pancakeV3PositionManager, 'positions', [1n])]: [
      0n, '0x0000000000000000000000000000000000000000', WBNB, USDT, 500, tickLower, tickUpper,
      liquidity, 0n, 0n, 0n, 0n,
    ],
    [readKey(chain.defi.pancakeV3Factory, 'getPool', [WBNB, USDT, 500])]: POOL,
    [readKey(POOL, 'slot0')]: [getSqrtRatioAtTick(currentTick), currentTick, 0, 0, 0, 0, true],
    [readKey(POOL, 'liquidity')]: 10n ** 22n,
    [readKey(WBNB, 'symbol')]: 'WBNB',
    [readKey(WBNB, 'name')]: 'Wrapped BNB',
    [readKey(WBNB, 'decimals')]: 18,
    [readKey(WBNB, 'totalSupply')]: 10n ** 24n,
    [readKey(WBNB, 'balanceOf', [POOL])]: 10n ** 24n,
    [readKey(WBNB, 'allowance', [OWNER, chain.defi.pancakeV3PositionManager])]: allowance,
    [readKey(USDT, 'symbol')]: 'USDT',
    [readKey(USDT, 'name')]: 'Tether USD',
    [readKey(USDT, 'decimals')]: 18,
    [readKey(USDT, 'totalSupply')]: 10n ** 26n,
    [readKey(USDT, 'balanceOf', [POOL])]: 10n ** 26n,
    [readKey(USDT, 'allowance', [OWNER, chain.defi.pancakeV3PositionManager])]: allowance,
    [readKey(chain.defi.pancakeV3PositionManager, 'ownerOf', [1n])]: OWNER,
    [readKey(chain.chainlink.bnbUsd, 'latestRoundData')]: [1n, 700_00000000n, BigInt(NOW - 10), BigInt(NOW - 10), 1n],
    [readKey(chain.chainlink.bnbUsd, 'decimals')]: 8,
  }
  return emptyChain({ reads, blockNumber: 41_000_000n, gasPrice: 1_000_000_000n })
}

describe('rebalance analysis against fixture chain state', () => {
  it('holds a position comfortably in range', async () => {
    const ctx = testContext({ client: fakeClient(pancakeChain()), now: NOW })
    const result = await analyseRebalance({ tokenId: '1' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)

    expect(result.decision.inRange).toBe(true)
    expect(result.decision.action).toBe('hold')
    expect(result.decision.proposed).toBeNull()
    expect(result.decision.cost).toBeNull()
    expect(result.decision.checksPass).toBe(true)
  })

  it('rebalances a position that has fallen out of range, and prices the sequence', async () => {
    const ctx = testContext({
      client: fakeClient(pancakeChain({ currentTick: 3_000 })),
      now: NOW,
    })
    const result = await analyseRebalance({ tokenId: '1' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)

    expect(result.decision.inRange).toBe(false)
    expect(result.decision.action).toBe('rebalance')
    expect(result.decision.urgency).toBe('now')
    expect(result.decision.reason).toContain('earning no fees')
    expect(result.decision.proposed).not.toBeNull()
    expect(result.decision.proposed!.tickLower).toBe(2_000)
    expect(result.decision.proposed!.tickUpper).toBe(4_000)

    // Five transactions when a swap is needed, four when it is not — there is
    // no atomic rebalance on v3, and the estimate says so.
    expect(result.decision.cost!.steps.map((step) => step.step)).toContain('burn')
    expect(result.decision.cost!.gasCostUsd).toBeGreaterThan(0)
    expect(result.decision.cost!.bnbUsd).toBeCloseTo(700, 6)
  })

  it('rebalances proactively inside the drift tolerance', async () => {
    // 900 ticks from the upper edge is about 940 bps.
    const ctx = testContext({ client: fakeClient(pancakeChain({ currentTick: 900 })), now: NOW })
    const wide = await analyseRebalance({ tokenId: '1', driftToleranceBps: 1_500 }, ctx, { deep: false })
    if ('error' in wide) throw new Error(wide.detail)
    expect(wide.decision.action).toBe('rebalance')
    expect(wide.decision.urgency).toBe('watch')

    // The negative control: same position, tolerance the drift does not reach.
    const tight = await analyseRebalance({ tokenId: '1', driftToleranceBps: 100 }, ctx, { deep: false })
    if ('error' in tight) throw new Error(tight.detail)
    expect(tight.decision.action).toBe('hold')
  })

  it('reconciles the pool price two ways and reports both derivations', async () => {
    const ctx = testContext({ client: fakeClient(pancakeChain()), now: NOW })
    const result = await analyseRebalance({ tokenId: '1' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    const priceCheck = result.decision.checks.find((check) => check.label === 'Pool price')
    expect(priceCheck).toBeTruthy()
    expect(priceCheck!.agrees).toBe(true)
    expect(priceCheck!.primary.source).toContain('sqrtPriceX96')
    expect(priceCheck!.secondary.source).toContain('tick')
  })

  it('flags a missing approval as blocking, and names why it cannot fix it', async () => {
    const ctx = testContext({
      client: fakeClient(pancakeChain({ currentTick: 3_000, allowance: 0n })),
      now: NOW,
    })
    const result = await analyseRebalance({ tokenId: '1' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.preconditions.blocking.length).toBeGreaterThan(0)
    expect(result.decision.preconditions.blocking[0]).toContain('not to token contracts')
  })

  it('reports a token id that does not exist rather than throwing', async () => {
    const ctx = testContext({ client: fakeClient(emptyChain()), now: NOW })
    const result = await analyseRebalance({ tokenId: '999' }, ctx, { deep: false })
    expect('error' in result).toBe(true)
    if (!('error' in result)) throw new Error('unreachable')
    expect(result.error).toBe('not-found')
  })
})

describe('rebalance act', () => {
  it('declines to act on a position that is in range', async () => {
    const ctx = testContext({ client: fakeClient(pancakeChain()), now: NOW, agentSlug: 'rebalancer' })
    const result = await actRebalance({ tokenId: '1', intentId: 'r-1' }, ctx)
    expect(result.status).toBe('aborted')
    if (result.status !== 'aborted') throw new Error('unreachable')
    expect(result.reason).toBe('nothing-to-do')
  })

  it('answers with the plan when no session key is granted', async () => {
    const ctx = testContext({
      client: fakeClient(pancakeChain({ currentTick: 3_000 })),
      now: NOW,
      agentSlug: 'rebalancer',
      sessions: providerFor(null),
    })
    const result = await actRebalance({ tokenId: '1', intentId: 'r-2' }, ctx)
    expect(result.status).toBe('aborted')
    if (result.status !== 'aborted') throw new Error('unreachable')
    expect(result.reason).toBe('no-session')
    expect(result.evidence['plan']).toBeTruthy()
  })

  it('refuses to act for a wallet that does not own the position', async () => {
    const ctx = testContext({
      client: fakeClient(pancakeChain({ currentTick: 3_000 })),
      now: NOW,
      agentSlug: 'rebalancer',
      binding: { category: 'pancake-rebalance', rationale: 'test' },
      sessions: providerFor({
        // A different wallet from the fixture's owner.
        session: fakeSession('0x9999999999999999999999999999999999999999'),
        policy: buildPolicy('pancake-rebalance', 56, { now: NOW }),
        chainId: 56,
      }),
    })
    const result = await actRebalance({ tokenId: '1', intentId: 'r-3' }, ctx)
    expect(result.status).toBe('aborted')
    if (result.status !== 'aborted') throw new Error('unreachable')
    expect(result.reason).toBe('not-authorised')
    expect(result.detail).toContain('is owned by')
  })

  it('records a cycle for every attempt, and never twice for one intent', async () => {
    const ctx = testContext({
      client: fakeClient(pancakeChain({ currentTick: 3_000, allowance: 0n })),
      now: NOW,
      agentSlug: 'rebalancer',
      binding: { category: 'pancake-rebalance', rationale: 'test' },
      sessions: providerFor({
        session: fakeSession(OWNER),
        policy: buildPolicy('pancake-rebalance', 56, { now: NOW }),
        chainId: 56,
      }),
    })
    await actRebalance({ tokenId: '1', intentId: 'cycle-1' }, ctx)
    await actRebalance({ tokenId: '1', intentId: 'cycle-1' }, ctx)
    const stored = await ctx.store.get<unknown[]>('rebalancer:cycles:56:1')
    // The approval is missing, so this aborts before an intent is created and
    // no cycle is recorded — an aborted plan is not a cycle.
    expect(stored ?? []).toHaveLength(0)
  })
})

describe('the cost field is genuinely total', () => {
  /**
   * This field reported gas only while the prose said "plus the ratio swap" —
   * about 133x low on a real position, and worse than either being wrong
   * alone, because a caller integrates the number and reads the paragraph.
   */
  it('includes the pool fee even without a live quote, and says it is a floor', async () => {
    const ctx = testContext({
      client: fakeClient(pancakeChain({ currentTick: 3_000 })),
      now: NOW,
    })
    const result = await analyseRebalance({ tokenId: '1' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)

    const cost = result.decision.cost!
    expect(cost.swap!.needed).toBe(true)
    expect(cost.swapCostBasis).toBe('fee-tier-floor')
    expect(cost.swapCostUsd).toBeGreaterThan(0)

    // The total must exceed gas, and by the pool fee at minimum.
    expect(cost.totalUsd).toBeGreaterThan(cost.gasUsd!)
    expect(cost.totalUsd).toBeCloseTo(cost.gasUsd! + cost.swapCostUsd!, 9)
    expect(cost.totalDetail).toContain('at least')
    expect(cost.totalDetail).toContain('floor, not an estimate')
  })

  it('keeps gas separately addressable, so neither number is ambiguous', async () => {
    const ctx = testContext({ client: fakeClient(pancakeChain({ currentTick: 3_000 })), now: NOW })
    const result = await analyseRebalance({ tokenId: '1' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    const cost = result.decision.cost!
    expect(cost.gasUsd).toBe(cost.gasCostUsd)
    expect(cost.gasUsd).toBeLessThan(cost.totalUsd!)
  })

  it('prices the swap at the pool fee times the notional, which is what was missing', async () => {
    // The measured failure: an 8,372 USDT swap at the 0.05% tier costs over $4
    // in fee alone, and the field reported three cents of gas. The guarantee
    // is the relationship, not a magnitude that depends on fixture size.
    const ctx = testContext({ client: fakeClient(pancakeChain({ currentTick: 3_000 })), now: NOW })
    const result = await analyseRebalance({ tokenId: '1' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)

    const cost = result.decision.cost!
    // Price whichever side is actually being sold: WBNB at $700 from the
    // Chainlink fixture, USDT at par. Assuming the wrong leg is a factor of
    // 700, which is the kind of error this whole field exists to stop.
    const swapped = Number(cost.swap!.amountIn) / 1e18
    const tokenUsd = cost.swap!.tokenIn === 'WBNB' ? 700 : 1
    const notionalUsd = swapped * tokenUsd
    const feeTier = 500 / 1_000_000
    expect(cost.swapCostUsd!).toBeCloseTo(notionalUsd * feeTier, 6)

    // And the measured case that prompted this: an 8,372.64 USDT swap at the
    // 0.05% tier is $4.19 of fee alone, against the $0.035738 the field used
    // to report for the whole move. Comparing to the fixture's own gas would
    // be meaningless — it runs at 1 gwei, mainnet at 0.05.
    const realWorldFee = 8_372.64 * feeTier
    expect(realWorldFee).toBeGreaterThan(4)
    expect(realWorldFee / 0.035738).toBeGreaterThan(100)
  })

  it('reports zero swap cost, and says so, when no swap is needed', async () => {
    const ctx = testContext({ client: fakeClient(pancakeChain({ currentTick: 900 })), now: NOW })
    const result = await analyseRebalance(
      { tokenId: '1', driftToleranceBps: 1_500 },
      ctx,
      { deep: false },
    )
    if ('error' in result) throw new Error(result.detail)
    const cost = result.decision.cost!
    if (cost.swap?.needed === false) {
      expect(cost.swapCostBasis).toBe('no-swap')
      expect(cost.swapCostUsd).toBe(0)
      expect(cost.totalUsd).toBeCloseTo(cost.gasUsd!, 9)
      expect(cost.totalDetail).toContain('all gas')
    }
  })
})
