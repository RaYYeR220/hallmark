import type { Address } from 'viem'

import type { Store } from '../../runtime/store.js'

/**
 * Grid state, persisted.
 *
 * A grid that forgets is worse than no grid: it re-buys levels it already
 * holds and sells ones it never bought. So the definition and every slot's
 * state live in the store, keyed by a caller-chosen `gridId`, and a restart
 * picks the same grid back up.
 *
 * Slots are geometric, not arithmetic. A constant *ratio* between levels is
 * what a grid actually wants — each step is the same percentage move, so each
 * round trip earns the same percentage — and arithmetic spacing quietly makes
 * the low end of the band far denser than the high end.
 */

export type GridSlotState = 'empty' | 'filled'

export type GridSlot = {
  index: number
  /** Whole token1 per whole token0. */
  price: number
  state: GridSlotState
  /** Token0 bought at this slot, atomic. */
  heldAtomic: string
  filledAt: string | null
  fillIntentId: string | null
  fillTxHash: string | null
  /** Round trips this slot has completed. */
  cycles: number
  realisedToken1Atomic: string
}

export type GridDefinition = {
  gridId: string
  chainId: number
  pool: Address
  token0: Address
  token1: Address
  token0Symbol: string
  token1Symbol: string
  token0Decimals: number
  token1Decimals: number
  fee: number
  lowerPrice: number
  upperPrice: number
  levels: number
  /** Token1 spent per buy, atomic. */
  sizePerLevelAtomic: string
  createdAt: string
}

export type GridState = {
  version: 1
  definition: GridDefinition
  slots: GridSlot[]
  /** Every order this grid has placed, newest last. */
  history: Array<{
    at: string
    intentId: string
    side: 'buy' | 'sell'
    slot: number
    price: number
    amountInAtomic: string
    minOutAtomic: string
    status: string
    txHash?: string
    detail: string
  }>
}

export function gridKey(chainId: number, gridId: string): string {
  return `grid:${chainId}:${gridId}`
}

/**
 * Level prices, geometric between the bounds inclusive.
 *
 * `levels` slots means `levels` prices, the first at `lowerPrice` and the last
 * at `upperPrice`. The ratio between neighbours is constant.
 */
export function gridPrices(lowerPrice: number, upperPrice: number, levels: number): number[] {
  if (!(lowerPrice > 0) || !(upperPrice > lowerPrice)) {
    throw new Error(
      `A grid needs 0 < lowerPrice < upperPrice; got ${lowerPrice} and ${upperPrice}.`,
    )
  }
  if (!Number.isInteger(levels) || levels < 2) {
    throw new Error(`A grid needs at least 2 levels; got ${levels}.`)
  }
  const ratio = Math.pow(upperPrice / lowerPrice, 1 / (levels - 1))
  return Array.from({ length: levels }, (_, i) => lowerPrice * Math.pow(ratio, i))
}

/** The constant percentage step between neighbouring levels. */
export function gridStepPct(lowerPrice: number, upperPrice: number, levels: number): number {
  return (Math.pow(upperPrice / lowerPrice, 1 / (levels - 1)) - 1) * 100
}

export function newGridState(definition: GridDefinition): GridState {
  const prices = gridPrices(definition.lowerPrice, definition.upperPrice, definition.levels)
  return {
    version: 1,
    definition,
    slots: prices.map((price, index) => ({
      index,
      price,
      state: 'empty',
      heldAtomic: '0',
      filledAt: null,
      fillIntentId: null,
      fillTxHash: null,
      cycles: 0,
      realisedToken1Atomic: '0',
    })),
    history: [],
  }
}

export async function loadGrid(
  store: Store,
  chainId: number,
  gridId: string,
): Promise<GridState | null> {
  return store.get<GridState>(gridKey(chainId, gridId))
}

export async function saveGrid(store: Store, state: GridState): Promise<void> {
  await store.set(gridKey(state.definition.chainId, state.definition.gridId), state)
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

export type GridAction =
  | {
      side: 'buy'
      slot: number
      slotPrice: number
      /** Token1 to spend, atomic. */
      amountInAtomic: bigint
      reason: string
    }
  | {
      side: 'sell'
      slot: number
      slotPrice: number
      exitPrice: number
      /** Token0 to sell, atomic. */
      amountInAtomic: bigint
      reason: string
    }
  | { side: 'none'; reason: string }

/**
 * What the grid does next at this price.
 *
 * Sells are checked first. A filled slot whose exit level the price has
 * reached is a realised step waiting to be taken, and taking it frees the
 * capital that funds the next buy; opening another position while a profitable
 * one sits closable is how a grid ends up fully invested at the top of a
 * range.
 *
 * Sell: the lowest filled slot whose *exit* level — the next level up — the
 * price has reached. One grid step per round trip, which is the whole
 * mechanism.
 *
 * Buy: the one empty slot whose interval the price currently sits in — the
 * level immediately above it, with the next level down immediately below. That
 * is the level the price has just crossed, and it is deliberately *not* "every
 * level above the price": a grid created at 130 with levels at 141, 168 and
 * 200 must not immediately buy at 200. Those orders would only ever have
 * filled on the way down, and a grid that back-fills them is buying its own
 * history at prices that never happened.
 *
 * The consequence is that at most one slot is ever a buy candidate, which is
 * also why nothing here needs a rate limit: a wick through five levels still
 * produces one order.
 */
export function nextAction(state: GridState, price: number): GridAction {
  const { slots, definition } = state

  if (price < definition.lowerPrice) {
    // Every slot has filled and the price left the band underneath. Buying
    // more would be averaging into a move the grid was not sized for.
    const empty = slots.filter((slot) => slot.state === 'empty').length
    if (empty === 0) {
      return {
        side: 'none',
        reason:
          `The price (${price.toPrecision(6)}) is below the grid's lower bound ` +
          `(${definition.lowerPrice.toPrecision(6)}) and every slot is already filled. The grid ` +
          'is fully invested and waits for a recovery rather than buying outside its own band.',
      }
    }
  }

  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i]!
    if (slot.state !== 'filled') continue
    const exit = slots[i + 1]
    if (exit === undefined) continue
    if (price >= exit.price) {
      return {
        side: 'sell',
        slot: i,
        slotPrice: slot.price,
        exitPrice: exit.price,
        amountInAtomic: BigInt(slot.heldAtomic),
        reason:
          `Level ${i} was filled at ${slot.price.toPrecision(6)} and the price has reached ` +
          `${exit.price.toPrecision(6)}, one grid step above it. Closing that unit realises the step.`,
      }
    }
  }

  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i]!
    if (price > slot.price) continue
    // The first slot at or above the price is the one whose interval we are
    // in; anything higher is a level the price crossed before this grid
    // existed, or on a leg it has already been paid for.
    if (price < definition.lowerPrice) break
    if (slot.state !== 'empty') break
    return {
      side: 'buy',
      slot: i,
      slotPrice: slot.price,
      amountInAtomic: BigInt(definition.sizePerLevelAtomic),
      reason:
        `The price ${price.toPrecision(6)} sits between level ${i - 1 < 0 ? 'the floor' : i - 1} and ` +
        `level ${i} (${slot.price.toPrecision(6)}), which is empty. That is the level the price ` +
        'has crossed, so the grid takes its unit there.',
    }
  }

  const filled = slots.filter((slot) => slot.state === 'filled').length
  return {
    side: 'none',
    reason:
      `At ${price.toPrecision(6)} no level is triggered: ${filled} of ${slots.length} slots are ` +
      'filled, none is one step below the price, and no empty slot sits at or above it inside ' +
      `the band (${definition.lowerPrice.toPrecision(6)}–${definition.upperPrice.toPrecision(6)}).`,
  }
}
