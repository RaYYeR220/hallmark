/**
 * Concentrated-liquidity arithmetic.
 *
 * `getSqrtRatioAtTick` is the exact on-chain TickMath, magic constants and
 * all, because the rebalancer's cost estimate is only worth reading if the
 * token amounts it starts from match what the pool would actually return. The
 * float helpers below it are for display and for choosing a range — never for
 * an amount that goes into calldata.
 */

export const Q96 = 2n ** 96n
export const MAX_UINT256 = 2n ** 256n - 1n
export const MIN_TICK = -887272
export const MAX_TICK = 887272

/** PancakeSwap v3's four fee tiers and the tick spacing each one enforces. */
export const TICK_SPACING_BY_FEE: Readonly<Record<number, number>> = Object.freeze({
  100: 1,
  500: 10,
  2500: 50,
  10000: 200,
})

export function tickSpacingForFee(fee: number): number {
  const spacing = TICK_SPACING_BY_FEE[fee]
  if (spacing === undefined) {
    throw new Error(
      `Unknown PancakeSwap v3 fee tier ${fee}. Known tiers: ${Object.keys(TICK_SPACING_BY_FEE).join(', ')}.`,
    )
  }
  return spacing
}

const RATIO_FACTORS: ReadonlyArray<[bigint, bigint]> = [
  [0x1n, 0xfffcb933bd6fad37aa2d162d1a594001n],
  [0x2n, 0xfff97272373d413259a46990580e213an],
  [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000n, 0x48a170391f7dc42444e8fa2n],
]

/** Uniswap/PancakeSwap v3 `TickMath.getSqrtRatioAtTick`, exact. */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`tick ${tick} is outside [${MIN_TICK}, ${MAX_TICK}]`)
  }
  const absTick = BigInt(Math.abs(tick))
  let ratio = (absTick & 0x1n) !== 0n ? RATIO_FACTORS[0]![1] : 1n << 128n

  for (const [bit, factor] of RATIO_FACTORS.slice(1)) {
    if ((absTick & bit) !== 0n) ratio = (ratio * factor) >> 128n
  }

  if (tick > 0) ratio = MAX_UINT256 / ratio

  // Q128.128 down to Q64.96, rounding up as the reference does.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n)
}

/** The two token amounts a position of `liquidity` holds at the current price. */
export function getAmountsForLiquidity(args: {
  sqrtPriceX96: bigint
  tickLower: number
  tickUpper: number
  liquidity: bigint
}): { amount0: bigint; amount1: bigint } {
  const { sqrtPriceX96, liquidity } = args
  const lower = getSqrtRatioAtTick(args.tickLower)
  const upper = getSqrtRatioAtTick(args.tickUpper)
  const [sqrtA, sqrtB] = lower <= upper ? [lower, upper] : [upper, lower]

  if (liquidity === 0n) return { amount0: 0n, amount1: 0n }

  if (sqrtPriceX96 <= sqrtA) {
    return { amount0: (liquidity * Q96 * (sqrtB - sqrtA)) / (sqrtB * sqrtA), amount1: 0n }
  }
  if (sqrtPriceX96 < sqrtB) {
    return {
      amount0: (liquidity * Q96 * (sqrtB - sqrtPriceX96)) / (sqrtB * sqrtPriceX96),
      amount1: (liquidity * (sqrtPriceX96 - sqrtA)) / Q96,
    }
  }
  return { amount0: 0n, amount1: (liquidity * (sqrtB - sqrtA)) / Q96 }
}

/** Round a tick to the nearest multiple of the pool's spacing, clamped. */
export function nearestUsableTick(tick: number, spacing: number): number {
  if (spacing <= 0) throw new Error(`tick spacing must be positive, got ${spacing}`)
  const rounded = Math.round(tick / spacing) * spacing
  if (rounded < MIN_TICK) return rounded + spacing
  if (rounded > MAX_TICK) return rounded - spacing
  return rounded
}

/**
 * Price of one whole token0 in whole token1.
 *
 * The decimal shift is the part people drop, and dropping it on a WBNB/USDT
 * pool gives an answer off by 1 — which looks plausible and is wrong for every
 * pair where the decimals differ.
 */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1)
}

export function priceToTick(price: number, decimals0: number, decimals1: number): number {
  const raw = price / Math.pow(10, decimals0 - decimals1)
  if (!(raw > 0)) throw new Error(`price must be positive, got ${price}`)
  return Math.round(Math.log(raw) / Math.log(1.0001))
}

/** Float price from the pool's own `slot0().sqrtPriceX96`. */
export function sqrtPriceX96ToPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  const ratio = Number(sqrtPriceX96) / Number(Q96)
  return ratio * ratio * Math.pow(10, decimals0 - decimals1)
}

/** How far, in basis points, the current tick sits from a range edge. */
export function tickDistanceBps(tick: number, edge: number): number {
  // 1.0001^Δtick − 1, in bps. Exact enough for copy; never used for calldata.
  return (Math.pow(1.0001, tick - edge) - 1) * 10_000
}

/** Clamp a float into [min, max] without pretending NaN is a number. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) throw new Error(`expected a finite number, got ${value}`)
  return Math.min(Math.max(value, min), max)
}
