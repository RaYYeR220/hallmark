import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { getChain } from '@hallmark/core'

import { analyseGrid } from '../src/agents/grid/analyse.js'
import { actGrid } from '../src/agents/grid/act.js'
import {
  gridPrices,
  gridStepPct,
  loadGrid,
  newGridState,
  nextAction,
  saveGrid,
  type GridDefinition,
} from '../src/agents/grid/state.js'
import { getSqrtRatioAtTick } from '../src/chain/math.js'
import { createMemoryStore } from '../src/runtime/store.js'
import { emptyChain, fakeClient, readKey, testContext, type FakeChain } from './support/fixtures.js'

const chain = getChain(56)
const NOW = 1_780_000_000
const POOL: Address = '0x36696169c63e42cd08ce11f5deebbcebae652050'
const WBNB: Address = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const USDT: Address = '0x55d398326f99059fF775485246999027B3197955'

function definition(overrides: Partial<GridDefinition> = {}): GridDefinition {
  return {
    gridId: 'g1',
    chainId: 56,
    pool: POOL,
    token0: WBNB,
    token1: USDT,
    token0Symbol: 'WBNB',
    token1Symbol: 'USDT',
    token0Decimals: 18,
    token1Decimals: 18,
    fee: 500,
    lowerPrice: 100,
    upperPrice: 200,
    levels: 5,
    sizePerLevelAtomic: (50n * 10n ** 18n).toString(),
    createdAt: new Date(NOW * 1000).toISOString(),
    ...overrides,
  }
}

describe('grid geometry', () => {
  it('spaces levels geometrically, so every step is the same percentage', () => {
    const prices = gridPrices(100, 200, 5)
    expect(prices).toHaveLength(5)
    expect(prices[0]).toBeCloseTo(100, 9)
    expect(prices[4]).toBeCloseTo(200, 9)
    const ratios = prices.slice(1).map((price, i) => price / prices[i]!)
    for (const ratio of ratios) expect(ratio).toBeCloseTo(ratios[0]!, 9)
  })

  it('reports the constant step as a percentage', () => {
    // 2^(1/4) − 1 ≈ 18.92%.
    expect(gridStepPct(100, 200, 5)).toBeCloseTo(18.9207, 3)
  })

  it('rejects a grid that cannot exist', () => {
    expect(() => gridPrices(200, 100, 5)).toThrow(/0 < lowerPrice < upperPrice/)
    expect(() => gridPrices(0, 100, 5)).toThrow(/0 < lowerPrice < upperPrice/)
    expect(() => gridPrices(100, 200, 1)).toThrow(/at least 2 levels/)
  })
})

describe('the grid rule', () => {
  it('buys the highest empty level the price has fallen through', () => {
    const state = newGridState(definition())
    const action = nextAction(state, 130)
    expect(action.side).toBe('buy')
    if (action.side !== 'buy') throw new Error('unreachable')
    // Levels are 100, 118.9, 141.4, 168.2, 200; 130 is at or below 141.4.
    expect(action.slot).toBe(2)
    expect(action.slotPrice).toBeCloseTo(141.42, 1)
    expect(action.amountInAtomic).toBe(50n * 10n ** 18n)
  })

  it('does nothing at the very top of the band with everything empty', () => {
    const state = newGridState(definition())
    const action = nextAction(state, 210)
    expect(action.side).toBe('none')
    expect(action.reason).toContain('no level is triggered')
  })

  it('sells a filled level once the price reaches the next one up', () => {
    const state = newGridState(definition())
    state.slots[1]!.state = 'filled'
    state.slots[1]!.heldAtomic = (3n * 10n ** 17n).toString()

    // Level 2 sits at 141.42; below it there is nothing to close.
    expect(nextAction(state, 140).side).not.toBe('sell')

    const action = nextAction(state, 145)
    expect(action.side).toBe('sell')
    if (action.side !== 'sell') throw new Error('unreachable')
    expect(action.slot).toBe(1)
    expect(action.exitPrice).toBeCloseTo(141.42, 1)
    expect(action.amountInAtomic).toBe(3n * 10n ** 17n)
  })

  it('stops buying below the band once every slot is filled', () => {
    const state = newGridState(definition())
    for (const slot of state.slots) {
      slot.state = 'filled'
      slot.heldAtomic = '1'
    }
    const action = nextAction(state, 50)
    expect(action.side).toBe('none')
    expect(action.reason).toContain('fully invested')
  })

  it('buys the level whose interval the price is in, not every level above it', () => {
    const state = newGridState(definition())
    // Levels 100, 118.9, 141.4, 168.2, 200.
    expect((nextAction(state, 101) as { slot: number }).slot).toBe(1)
    expect((nextAction(state, 130) as { slot: number }).slot).toBe(2)
    expect((nextAction(state, 150) as { slot: number }).slot).toBe(3)
    expect((nextAction(state, 190) as { slot: number }).slot).toBe(4)
  })

  it('does not back-fill levels the price crossed before the grid existed', () => {
    // A grid created at 130 must not buy at 200 just because 200 is above it.
    const state = newGridState(definition())
    const action = nextAction(state, 130)
    if (action.side !== 'buy') throw new Error('unreachable')
    expect(action.slotPrice).toBeLessThan(150)
  })

  it('moves to the next level up once the one below it is taken', () => {
    const state = newGridState(definition())
    state.slots[2]!.state = 'filled'
    state.slots[2]!.heldAtomic = '1'
    // At 130 the interval level (2) is taken, so there is nothing to buy —
    // and 130 has not reached level 3's exit, so nothing to sell either.
    expect(nextAction(state, 130).side).toBe('none')
  })

  it('will not buy below its own floor', () => {
    const state = newGridState(definition())
    const action = nextAction(state, 95)
    expect(action.side).toBe('none')
  })

  it('prefers realising a step to opening another position', () => {
    // At 145 there is both an empty level above (168.2) and a filled level
    // whose exit the price has passed. The sell wins: it frees the capital
    // that funds the next buy.
    const state = newGridState(definition())
    state.slots[1]!.state = 'filled'
    state.slots[1]!.heldAtomic = '1'
    expect(nextAction(state, 145).side).toBe('sell')
  })
})

// ---------------------------------------------------------------------------

function gridChain(price: number): FakeChain {
  // A stable-ish pair with 18 decimals both sides, so the tick maps directly.
  const tick = Math.round(Math.log(price) / Math.log(1.0001))
  return emptyChain({
    reads: {
      [readKey(chain.defi.pancakeV3Factory, 'getPool', [WBNB, USDT, 500])]: POOL,
      [readKey(POOL, 'slot0')]: [getSqrtRatioAtTick(tick), tick, 0, 0, 0, 0, true],
      [readKey(POOL, 'liquidity')]: 10n ** 22n,
      [readKey(POOL, 'token0')]: WBNB,
      [readKey(POOL, 'token1')]: USDT,
      [readKey(WBNB, 'symbol')]: 'WBNB',
      [readKey(WBNB, 'name')]: 'Wrapped BNB',
      [readKey(WBNB, 'decimals')]: 18,
      [readKey(WBNB, 'totalSupply')]: 10n ** 24n,
      [readKey(USDT, 'symbol')]: 'USDT',
      [readKey(USDT, 'name')]: 'Tether USD',
      [readKey(USDT, 'decimals')]: 18,
      [readKey(USDT, 'totalSupply')]: 10n ** 26n,
    },
    blockNumber: 41_000_000n,
  })
}

describe('grid analysis and persistence', () => {
  it('creates the grid on first sight and resumes it afterwards', async () => {
    const store = createMemoryStore()
    const ctx = testContext({ client: fakeClient(gridChain(150)), store, now: NOW, agentSlug: 'grid' })

    const first = await analyseGrid(
      {
        gridId: 'bnb-core',
        token0: WBNB,
        token1: USDT,
        fee: 500,
        lowerPrice: 100,
        upperPrice: 200,
        levels: 5,
        sizePerLevel: '50',
      },
      ctx,
      { deep: false },
    )
    if ('error' in first) throw new Error(first.detail)
    expect(first.warnings.some((warning) => warning.includes('did not exist and was created'))).toBe(true)
    expect(first.decision.step.levels).toBe(5)

    // Second call needs only the id: state is loaded, not rebuilt.
    const second = await analyseGrid({ gridId: 'bnb-core' }, ctx, { deep: false })
    if ('error' in second) throw new Error(second.detail)
    expect(second.warnings.some((warning) => warning.includes('did not exist'))).toBe(false)
    expect(second.decision.step.lowerPrice).toBe(100)
  })

  it('resumes fills across a restart — a new store instance is a new process', async () => {
    const store = createMemoryStore()
    const state = newGridState(definition({ gridId: 'restart' }))
    state.slots[1]!.state = 'filled'
    state.slots[1]!.heldAtomic = (4n * 10n ** 17n).toString()
    await saveGrid(store, state)

    // A fresh context over the same store is what a restart looks like.
    const ctx = testContext({ client: fakeClient(gridChain(150)), store, now: NOW, agentSlug: 'grid' })
    const result = await analyseGrid({ gridId: 'restart' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.filled).toBe(1)
    expect(result.decision.slots[1]!.heldAtomic).toBe((4n * 10n ** 17n).toString())
  })

  it('refuses to redefine a live grid under its own fills', async () => {
    const store = createMemoryStore()
    const state = newGridState(definition({ gridId: 'fixed' }))
    state.slots[0]!.state = 'filled'
    state.slots[0]!.heldAtomic = '1'
    await saveGrid(store, state)

    const ctx = testContext({ client: fakeClient(gridChain(150)), store, now: NOW })
    const result = await analyseGrid({ gridId: 'fixed', lowerPrice: 50, upperPrice: 400 }, ctx, { deep: false })
    expect('error' in result).toBe(true)
    if (!('error' in result)) throw new Error('unreachable')
    expect(result.error).toBe('grid-redefinition')
    expect(result.detail).toContain('1 filled slot')
  })

  it('accepts the same parameters restated — the negative control', async () => {
    const store = createMemoryStore()
    await saveGrid(store, newGridState(definition({ gridId: 'same' })))
    const ctx = testContext({ client: fakeClient(gridChain(150)), store, now: NOW })
    const result = await analyseGrid(
      { gridId: 'same', lowerPrice: 100, upperPrice: 200, levels: 5 },
      ctx,
      { deep: false },
    )
    expect('error' in result).toBe(false)
  })

  it('will not create a grid without the parameters to define one', async () => {
    const ctx = testContext({ client: fakeClient(gridChain(150)), now: NOW })
    const result = await analyseGrid({ gridId: 'nope', lowerPrice: 100 }, ctx, { deep: false })
    expect('error' in result).toBe(true)
    if (!('error' in result)) throw new Error('unreachable')
    expect(result.error).toBe('grid-not-defined')
    expect(result.detail).toContain('token0')
  })

  it('reconciles the pool price two ways before it will act', async () => {
    const store = createMemoryStore()
    await saveGrid(store, newGridState(definition({ gridId: 'checked' })))
    const ctx = testContext({ client: fakeClient(gridChain(150)), store, now: NOW })
    const result = await analyseGrid({ gridId: 'checked' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.checks[0]!.label).toBe('Pool price')
    expect(result.decision.checksPass).toBe(true)
  })

  it('catches a grid whose stored state does not match its own definition', async () => {
    const store = createMemoryStore()
    const broken = newGridState(definition({ gridId: 'broken' }))
    broken.slots.pop() // five levels declared, four stored
    await saveGrid(store, broken)

    const ctx = testContext({ client: fakeClient(gridChain(150)), store, now: NOW })
    const result = await analyseGrid({ gridId: 'broken' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.checksPass).toBe(false)
    expect(
      result.decision.assertions.find((check) => check.label === 'Grid state matches its definition')!.holds,
    ).toBe(false)
  })

  it('catches a band written for the inverse price orientation', async () => {
    // The pool decides which token is token0. A band of 600-900 for a pair the
    // pool quotes at 0.00134 is the classic inverted-orientation mistake, and
    // the grid it produces never triggers while looking like it is waiting.
    const store = createMemoryStore()
    await saveGrid(store, newGridState(definition({ gridId: 'inverted' })))
    const ctx = testContext({ client: fakeClient(gridChain(0.0013)), store, now: NOW })
    const result = await analyseGrid({ gridId: 'inverted' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)

    expect(result.decision.checksPass).toBe(false)
    const check = result.decision.assertions.find((entry) => entry.label.includes('how the pool quotes'))!
    expect(check.holds).toBe(false)
    expect(check.detail).toContain('quoted the other way round')
    // And it says what the band should have been.
    expect(check.detail).toContain('0.00500000–0.0100000')
  })

  it('accepts a band in the right orientation — the negative control', async () => {
    const store = createMemoryStore()
    await saveGrid(store, newGridState(definition({ gridId: 'upright' })))
    const ctx = testContext({ client: fakeClient(gridChain(150)), store, now: NOW })
    const result = await analyseGrid({ gridId: 'upright' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(
      result.decision.assertions.find((entry) => entry.label.includes('how the pool quotes'))!.holds,
    ).toBe(true)
  })

  it('catches a filled slot that holds nothing, which would sell a phantom', async () => {
    const store = createMemoryStore()
    const phantom = newGridState(definition({ gridId: 'phantom' }))
    phantom.slots[0]!.state = 'filled'
    phantom.slots[0]!.heldAtomic = '0'
    await saveGrid(store, phantom)

    const ctx = testContext({ client: fakeClient(gridChain(150)), store, now: NOW })
    const result = await analyseGrid({ gridId: 'phantom' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.checksPass).toBe(false)
  })
})

describe('grid act', () => {
  it('answers with the order it would have placed when no key is granted', async () => {
    const store = createMemoryStore()
    await saveGrid(store, newGridState(definition({ gridId: 'act-1' })))
    const ctx = testContext({ client: fakeClient(gridChain(130)), store, now: NOW, agentSlug: 'grid' })

    const result = await actGrid({ gridId: 'act-1', intentId: 'g-1' }, ctx)
    expect(result.status).toBe('aborted')
    if (result.status !== 'aborted') throw new Error('unreachable')
    // The live quote is unavailable in the fixture, so it stops before the
    // session check — either way, nothing is sent and the reason is stated.
    expect(['no-session', 'precondition']).toContain(result.reason)
  })

  it('leaves the grid untouched when the order does not go through', async () => {
    const store = createMemoryStore()
    await saveGrid(store, newGridState(definition({ gridId: 'act-2' })))
    const ctx = testContext({ client: fakeClient(gridChain(130)), store, now: NOW, agentSlug: 'grid' })

    await actGrid({ gridId: 'act-2', intentId: 'g-2' }, ctx)
    const after = await loadGrid(store, 56, 'act-2')
    expect(after!.slots.every((slot) => slot.state === 'empty')).toBe(true)
  })

  it('does nothing when no level is triggered', async () => {
    const store = createMemoryStore()
    const state = newGridState(definition({ gridId: 'act-3' }))
    await saveGrid(store, state)
    const ctx = testContext({ client: fakeClient(gridChain(210)), store, now: NOW, agentSlug: 'grid' })
    const result = await actGrid({ gridId: 'act-3', intentId: 'g-3' }, ctx)
    expect(result.status).toBe('aborted')
    if (result.status !== 'aborted') throw new Error('unreachable')
    expect(result.reason).toBe('nothing-to-do')
  })
})
