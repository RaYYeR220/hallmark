import {
  erc20Abi,
  getChain,
  venusComptrollerAbi,
  venusVTokenAbi,
  type SupportedChainId,
} from '@hallmark/core'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import {
  vBnbAbi,
  vTokenDepthAbi,
  vTokenErc20Abi,
  vTokenExtraAbi,
  venusComptrollerExtraAbi,
  venusOracleAbi,
} from './abis.js'
import type { ChainClient } from './clients.js'

/**
 * Venus reads and the calls that unwind a position.
 *
 * Two things here are load-bearing.
 *
 * First, prices come from Venus's *own* oracle, because that is the oracle a
 * liquidator will be measured against. Using a different one would produce a
 * health factor that is defensible and irrelevant. Chainlink shows up
 * separately, as an independent freshness check — see `prices.ts`.
 *
 * Second, vBNB is not like the other markets. `repayBorrow()` on vBNB is
 * payable and takes no arguments; every ERC-20 market takes
 * `repayBorrow(uint256)`. Same name, different selector, different money path.
 * `buildRepayCall` is the only place that choice is made.
 */

export type VenusMarket = {
  vToken: Address
  vTokenSymbol: string
  /** True for vBNB: underlying is the chain's native coin. */
  isNative: boolean
  underlying: Address | null
  underlyingSymbol: string
  underlyingDecimals: number
  /** 0…1. */
  collateralFactor: number
  supplyUnderlying: bigint
  borrowUnderlying: bigint
  /** Venus oracle mantissa, scaled 1e(36 − underlyingDecimals). */
  priceMantissa: bigint
  priceUsd: number
  supplyUsd: number
  borrowUsd: number
  supplyRatePerBlock: bigint
}

export type VenusAccount = {
  borrower: Address
  chainId: SupportedChainId
  comptroller: Address
  oracle: Address
  markets: VenusMarket[]
  totalSupplyUsd: number
  totalBorrowUsd: number
  /** Σ supplyUsd × collateralFactor — the number a liquidation is judged on. */
  adjustedCollateralUsd: number
  /** adjustedCollateral ÷ borrows. `null` when there is no debt. */
  healthFactor: number | null
  /** Straight from `getAccountLiquidity`, 1e18-scaled USD. */
  liquidityUsd: number
  shortfallUsd: number
  liquidatable: boolean
  blockNumber: bigint
}

export type VenusReadFailure = { ok: false; reason: 'read-failed' | 'no-markets'; detail: string }
export type VenusReadResult = ({ ok: true } & VenusAccount) | VenusReadFailure

const ZERO: Address = '0x0000000000000000000000000000000000000000'

function mantissaToUsd(mantissa: bigint, underlyingDecimals: number): number {
  return Number(mantissa) / 10 ** (36 - underlyingDecimals)
}

function toUnits(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals
}

export async function readVenusAccount(args: {
  client: ChainClient
  chainId: SupportedChainId
  borrower: Address
}): Promise<VenusReadResult> {
  const { client, chainId, borrower } = args
  const chain = getChain(chainId)
  const comptroller = chain.defi.venusComptroller
  const vBnb = chain.defi.venusVBnb.toLowerCase()

  let assetsIn: readonly Address[]
  let oracle: Address
  let liquidityTuple: readonly [bigint, bigint, bigint]
  let blockNumber: bigint
  try {
    ;[assetsIn, oracle, liquidityTuple, blockNumber] = await Promise.all([
      client.readContract({
        address: comptroller,
        abi: venusComptrollerAbi,
        functionName: 'getAssetsIn',
        args: [borrower],
      }) as Promise<readonly Address[]>,
      client.readContract({
        address: comptroller,
        abi: venusComptrollerExtraAbi,
        functionName: 'oracle',
      }) as Promise<Address>,
      client.readContract({
        address: comptroller,
        abi: venusComptrollerAbi,
        functionName: 'getAccountLiquidity',
        args: [borrower],
      }) as Promise<readonly [bigint, bigint, bigint]>,
      client.getBlockNumber(),
    ])
  } catch (error) {
    return {
      ok: false,
      reason: 'read-failed',
      detail: `Venus comptroller reads failed for ${borrower}: ${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }`,
    }
  }

  if (assetsIn.length === 0) {
    return {
      ok: false,
      reason: 'no-markets',
      detail: `${borrower} has entered no Venus markets on chain ${chainId}: there is no position to watch.`,
    }
  }

  const markets: VenusMarket[] = []
  for (const vToken of assetsIn) {
    const isNative = vToken.toLowerCase() === vBnb

    const [vBalance, borrowBalance, exchangeRate, marketInfo, price, supplyRate, vSymbol] =
      await Promise.all([
        client.readContract({ address: vToken, abi: vTokenExtraAbi, functionName: 'balanceOf', args: [borrower] }) as Promise<bigint>,
        client.readContract({ address: vToken, abi: venusVTokenAbi, functionName: 'borrowBalanceStored', args: [borrower] }) as Promise<bigint>,
        client.readContract({ address: vToken, abi: venusVTokenAbi, functionName: 'exchangeRateStored' }) as Promise<bigint>,
        client.readContract({ address: comptroller, abi: venusComptrollerAbi, functionName: 'markets', args: [vToken] }) as Promise<readonly [boolean, bigint, boolean]>,
        client.readContract({ address: oracle, abi: venusOracleAbi, functionName: 'getUnderlyingPrice', args: [vToken] }).catch(() => 0n) as Promise<bigint>,
        client.readContract({ address: vToken, abi: venusVTokenAbi, functionName: 'supplyRatePerBlock' }).catch(() => 0n) as Promise<bigint>,
        client.readContract({ address: vToken, abi: vTokenExtraAbi, functionName: 'symbol' }).catch(() => 'vToken') as Promise<string>,
      ])

    let underlying: Address | null = null
    let underlyingSymbol = 'BNB'
    let underlyingDecimals = 18
    if (!isNative) {
      underlying = (await client
        .readContract({ address: vToken, abi: venusVTokenAbi, functionName: 'underlying' })
        .catch(() => ZERO)) as Address
      if (underlying !== ZERO) {
        const [symbol, decimals] = await Promise.all([
          client.readContract({ address: underlying, abi: erc20Abi, functionName: 'symbol' }).then(String).catch(() => 'token'),
          client.readContract({ address: underlying, abi: erc20Abi, functionName: 'decimals' }).then(Number).catch(() => 18),
        ])
        underlyingSymbol = symbol
        underlyingDecimals = decimals
      }
    }

    // vBalance is in vToken units (8 decimals); the exchange rate carries the
    // rest of the scale, so the /1e18 is correct for any underlying.
    const supplyUnderlying = (vBalance * exchangeRate) / 10n ** 18n
    const priceUsd = mantissaToUsd(price, underlyingDecimals)
    const collateralFactor = Number(marketInfo[1]) / 1e18

    markets.push({
      vToken,
      vTokenSymbol: vSymbol,
      isNative,
      underlying,
      underlyingSymbol,
      underlyingDecimals,
      collateralFactor,
      supplyUnderlying,
      borrowUnderlying: borrowBalance,
      priceMantissa: price,
      priceUsd,
      supplyUsd: toUnits(supplyUnderlying, underlyingDecimals) * priceUsd,
      borrowUsd: toUnits(borrowBalance, underlyingDecimals) * priceUsd,
      supplyRatePerBlock: supplyRate,
    })
  }

  const totalSupplyUsd = markets.reduce((sum, m) => sum + m.supplyUsd, 0)
  const totalBorrowUsd = markets.reduce((sum, m) => sum + m.borrowUsd, 0)
  const adjustedCollateralUsd = markets.reduce((sum, m) => sum + m.supplyUsd * m.collateralFactor, 0)

  return {
    ok: true,
    borrower,
    chainId,
    comptroller,
    oracle,
    markets,
    totalSupplyUsd,
    totalBorrowUsd,
    adjustedCollateralUsd,
    healthFactor: totalBorrowUsd > 0 ? adjustedCollateralUsd / totalBorrowUsd : null,
    liquidityUsd: Number(liquidityTuple[1]) / 1e18,
    shortfallUsd: Number(liquidityTuple[2]) / 1e18,
    liquidatable: liquidityTuple[2] > 0n,
    blockNumber,
  }
}

// ---------------------------------------------------------------------------
// Liquidation price
// ---------------------------------------------------------------------------

export type LiquidationPrice =
  | {
      ok: true
      asset: string
      currentPriceUsd: number
      liquidationPriceUsd: number
      /** Negative when the position liquidates on a fall, positive on a rise. */
      moveToLiquidationPct: number
      direction: 'fall' | 'rise'
    }
  | { ok: false; detail: string }

/**
 * The price at which health reaches 1, for one designated volatile asset.
 *
 * Everything else in the position is held fixed, which is the honest framing:
 * this answers "how far can BNB move before this is liquidated", not "what
 * happens if the whole market moves". Both sides are handled — a position that
 * *borrows* the volatile asset liquidates on a rise, not a fall — because
 * assuming the collateral case silently inverts the answer for the other one.
 *
 * adjColl(P) = A + a·P and borrows(P) = B + b·P, so HF = 1 at P = (B − A)/(a − b).
 */
export function liquidationPriceFor(
  account: VenusAccount,
  volatileVToken: Address,
): LiquidationPrice {
  const target = account.markets.find(
    (m) => m.vToken.toLowerCase() === volatileVToken.toLowerCase(),
  )
  if (!target) {
    return { ok: false, detail: `${volatileVToken} is not a market this account has entered.` }
  }
  if (target.priceUsd <= 0) {
    return { ok: false, detail: `Venus reports no price for ${target.underlyingSymbol}.` }
  }

  const a = toUnits(target.supplyUnderlying, target.underlyingDecimals) * target.collateralFactor
  const b = toUnits(target.borrowUnderlying, target.underlyingDecimals)

  const A = account.markets
    .filter((m) => m !== target)
    .reduce((sum, m) => sum + m.supplyUsd * m.collateralFactor, 0)
  const B = account.markets.filter((m) => m !== target).reduce((sum, m) => sum + m.borrowUsd, 0)

  if (Math.abs(a - b) < 1e-12) {
    return {
      ok: false,
      detail:
        `The position's exposure to ${target.underlyingSymbol} nets to zero (supplied × ` +
        'collateral factor equals borrowed), so its health does not depend on that price.',
    }
  }

  const price = (B - A) / (a - b)
  if (!Number.isFinite(price) || price <= 0) {
    return {
      ok: false,
      detail:
        `Solving for health = 1 gives ${price.toFixed(4)}, which is not a reachable price. ` +
        'The position cannot be liquidated by this asset alone at any positive price.',
    }
  }

  const movePct = ((price - target.priceUsd) / target.priceUsd) * 100
  return {
    ok: true,
    asset: target.underlyingSymbol,
    currentPriceUsd: target.priceUsd,
    liquidationPriceUsd: price,
    moveToLiquidationPct: movePct,
    direction: movePct < 0 ? 'fall' : 'rise',
  }
}

// ---------------------------------------------------------------------------
// Repay sizing
// ---------------------------------------------------------------------------

export type RepayPlan =
  | {
      ok: true
      market: VenusMarket
      repayUsd: number
      repayUnderlying: bigint
      /** Health the position lands at if the repay confirms. */
      projectedHealthFactor: number
      cappedBy: 'target' | 'outstanding-debt' | 'wallet-balance'
    }
  | { ok: false; reason: 'no-debt' | 'already-healthy' | 'nothing-repayable'; detail: string }

/**
 * How much to repay to restore a target health factor.
 *
 * Repaying reduces debt without touching collateral, so
 * `HF' = adjColl / (borrows − repay)` and `repay = borrows − adjColl / target`.
 * The result is capped twice — by what is actually owed in that market, and by
 * what the wallet holds — because a plan that cannot execute is not a plan.
 */
export function planRepay(args: {
  account: VenusAccount
  vToken: Address
  targetHealthFactor: number
  /** Underlying the wallet can actually spend. Omit for "no constraint". */
  walletBalance?: bigint
}): RepayPlan {
  const market = args.account.markets.find(
    (m) => m.vToken.toLowerCase() === args.vToken.toLowerCase(),
  )
  if (!market) {
    return {
      ok: false,
      reason: 'no-debt',
      detail: `${args.vToken} is not a market this account has entered.`,
    }
  }
  if (market.borrowUnderlying === 0n) {
    return {
      ok: false,
      reason: 'no-debt',
      detail: `No ${market.underlyingSymbol} debt outstanding in this market; nothing to repay.`,
    }
  }
  const borrows = args.account.totalBorrowUsd
  if (borrows <= 0) {
    return { ok: false, reason: 'no-debt', detail: 'The account has no borrows.' }
  }

  const needed = borrows - args.account.adjustedCollateralUsd / args.targetHealthFactor
  if (needed <= 0) {
    return {
      ok: false,
      reason: 'already-healthy',
      detail:
        `Health is ${(args.account.adjustedCollateralUsd / borrows).toFixed(3)}, already at or ` +
        `above the ${args.targetHealthFactor} target. Repaying now would only cost gas.`,
    }
  }

  let cappedBy: 'target' | 'outstanding-debt' | 'wallet-balance' = 'target'
  let repayUsd = needed

  if (repayUsd > market.borrowUsd) {
    repayUsd = market.borrowUsd
    cappedBy = 'outstanding-debt'
  }

  const scale = 10n ** BigInt(market.underlyingDecimals)
  let repayUnderlying =
    market.priceUsd > 0
      ? BigInt(Math.floor((repayUsd / market.priceUsd) * Number(scale)))
      : 0n

  if (repayUnderlying > market.borrowUnderlying) {
    repayUnderlying = market.borrowUnderlying
    cappedBy = 'outstanding-debt'
  }
  if (args.walletBalance !== undefined && repayUnderlying > args.walletBalance) {
    repayUnderlying = args.walletBalance
    cappedBy = 'wallet-balance'
  }
  if (repayUnderlying <= 0n) {
    return {
      ok: false,
      reason: 'nothing-repayable',
      detail:
        `The repay this position needs is ${needed.toFixed(2)} USD, which rounds to zero ` +
        `${market.underlyingSymbol} at the current price, or the wallet holds none.`,
    }
  }

  const actualUsd = toUnits(repayUnderlying, market.underlyingDecimals) * market.priceUsd
  const projected =
    borrows - actualUsd > 0
      ? args.account.adjustedCollateralUsd / (borrows - actualUsd)
      : Number.POSITIVE_INFINITY

  return {
    ok: true,
    market,
    repayUsd: actualUsd,
    repayUnderlying,
    projectedHealthFactor: projected,
    cappedBy,
  }
}

// ---------------------------------------------------------------------------
// Calldata
// ---------------------------------------------------------------------------

export type VenusCall = { to: Address; data: Hex; value: bigint; signature: string; label: string }

/**
 * The vBNB-vs-ERC-20 split, in one function so it cannot be got wrong twice.
 *
 * vBNB: `repayBorrow()` payable, amount in `msg.value`.
 * Everything else: `repayBorrow(uint256)`, amount as the argument, value zero.
 */
export function buildRepayCall(args: {
  vToken: Address
  isNative: boolean
  amount: bigint
  symbol: string
}): VenusCall {
  if (args.isNative) {
    return {
      to: args.vToken,
      data: encodeFunctionData({ abi: vBnbAbi, functionName: 'repayBorrow', args: [] }),
      value: args.amount,
      signature: 'repayBorrow()',
      label: `Repay ${args.symbol} debt on vBNB (amount travels as msg.value)`,
    }
  }
  return {
    to: args.vToken,
    data: encodeFunctionData({
      abi: vTokenErc20Abi,
      functionName: 'repayBorrow',
      args: [args.amount],
    }),
    value: 0n,
    signature: 'repayBorrow(uint256)',
    label: `Repay ${args.symbol} debt`,
  }
}

/** The ERC-20 approval a non-native repay needs before it can move tokens. */
export function buildApproveCall(args: {
  token: Address
  spender: Address
  amount: bigint
  symbol: string
}): VenusCall {
  return {
    to: args.token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [args.spender, args.amount],
    }),
    value: 0n,
    signature: 'approve(address,uint256)',
    label: `Approve the Venus market to pull ${args.symbol}`,
  }
}

export function buildSupplyCall(args: {
  vToken: Address
  isNative: boolean
  amount: bigint
  symbol: string
}): VenusCall {
  if (args.isNative) {
    return {
      to: args.vToken,
      data: encodeFunctionData({ abi: vBnbAbi, functionName: 'mint', args: [] }),
      value: args.amount,
      signature: 'mint()',
      label: `Supply ${args.symbol} as collateral (amount travels as msg.value)`,
    }
  }
  return {
    to: args.vToken,
    data: encodeFunctionData({ abi: vTokenErc20Abi, functionName: 'mint', args: [args.amount] }),
    value: 0n,
    signature: 'mint(uint256)',
    label: `Supply ${args.symbol} as collateral`,
  }
}

/**
 * Annualising `ratePerBlock`.
 *
 * Compound forks publish a per-block rate and leave the annualisation to you,
 * and the constant everyone copies — 10,512,000, a three-second block — has
 * not described BNB Chain for some time. Venus's BSC core-pool vTokens expose
 * neither `blocksPerYear()` nor `blocksOrSecondsPerYear()` (both revert,
 * measured), so there is nothing on-chain to read the intended figure from.
 *
 * `measureBlocksPerYear` reads the figure off the chain rather than assuming
 * it, and the yield agent uses the measurement. That is not fastidiousness:
 * measured live, BNB Chain runs at about 0.45 seconds a block — roughly
 * 70,000,000 a year — and at that multiplier vUSDT's on-chain supply rate and
 * DeFiLlama's independently published APY agree to 33 basis points. The legacy
 * constant puts them 570% apart. The default below is that measurement; the
 * measurement itself is what the agent actually uses, and the figure is always
 * reported alongside the APY so nobody has to guess which one it was.
 */
export const BSC_BLOCKS_PER_YEAR = 70_080_000

/** The constant Compound forks historically used. Kept for comparison only. */
export const LEGACY_COMPOUND_BLOCKS_PER_YEAR = 10_512_000

/**
 * Blocks per year, measured from two block timestamps rather than assumed.
 *
 * A failed read returns the default rather than throwing: an APY that is
 * slightly off is still worth reporting, and the figure used travels with it.
 */
export async function measureBlocksPerYear(
  client: ChainClient,
  opts: { span?: bigint } = {},
): Promise<{ blocksPerYear: number; measured: boolean; detail: string }> {
  const span = opts.span ?? 100_000n
  try {
    const latest = await client.getBlock()
    if (latest.number === null || latest.number <= span) throw new Error('chain too short to measure')
    const earlier = await client.getBlock({ blockNumber: latest.number - span })
    const seconds = Number(latest.timestamp - earlier.timestamp)
    if (!(seconds > 0)) throw new Error('block timestamps did not advance')
    const blockSeconds = seconds / Number(span)
    const blocksPerYear = Math.round(31_536_000 / blockSeconds)
    return {
      blocksPerYear,
      measured: true,
      detail:
        `Measured over ${span} blocks: ${blockSeconds.toFixed(3)}s per block, ` +
        `${blocksPerYear.toLocaleString('en-US')} blocks a year.`,
    }
  } catch (error) {
    return {
      blocksPerYear: BSC_BLOCKS_PER_YEAR,
      measured: false,
      detail:
        `Could not measure block time (${error instanceof Error ? error.message : String(error)}); ` +
        `falling back to ${BSC_BLOCKS_PER_YEAR.toLocaleString('en-US')} blocks a year, the last ` +
        'measured BNB Chain rate of about 0.45 seconds a block.',
    }
  }
}

export function supplyApyFromRatePerBlock(
  ratePerBlock: bigint,
  blocksPerYear: number = BSC_BLOCKS_PER_YEAR,
): number {
  const perBlock = Number(ratePerBlock) / 1e18
  return (Math.pow(1 + perBlock, blocksPerYear) - 1) * 100
}

// ---------------------------------------------------------------------------
// Market depth
// ---------------------------------------------------------------------------

export type VenusMarketDepth = {
  vToken: Address
  vTokenSymbol: string
  isNative: boolean
  underlying: Address | null
  underlyingSymbol: string
  underlyingDecimals: number
  /** Everything depositors have supplied, in underlying. */
  totalSuppliedUnderlying: bigint
  totalSuppliedUsd: number
  /** Underlying still idle in the market — what a withdrawal draws on. */
  cashUnderlying: bigint
  cashUsd: number
  totalBorrowsUnderlying: bigint
  utilisation: number
  supplyRatePerBlock: bigint
  supplyApyPct: number
  priceUsd: number
  collateralFactor: number
}

/**
 * Every Venus core-pool market, with its real depth.
 *
 * This exists because DeFiLlama's `tvlUsd` for a lending pool is *available
 * liquidity*, not total deposits — measured today, Venus reads $61.6M there
 * against $195.0M actually supplied, and Aave $10.5M against $58.9M. Sizing an
 * allocation off that field misjudges depth by three to six times. So both
 * numbers are read on-chain and reported separately: `totalSuppliedUsd` is the
 * pool, `cashUsd` is what you could withdraw right now.
 */
export async function listVenusMarkets(args: {
  client: ChainClient
  chainId: SupportedChainId
  /** Restrict to these underlying symbols, uppercase. Omit for all markets. */
  symbols?: string[]
  /** Blocks a year for annualising the per-block rate. Measured by the caller. */
  blocksPerYear?: number
}): Promise<VenusMarketDepth[]> {
  const { client, chainId } = args
  const chain = getChain(chainId)
  const comptroller = chain.defi.venusComptroller
  const vBnb = chain.defi.venusVBnb.toLowerCase()

  const [vTokens, oracle] = await Promise.all([
    client.readContract({
      address: comptroller,
      abi: venusComptrollerExtraAbi,
      functionName: 'getAllMarkets',
    }) as Promise<readonly Address[]>,
    client.readContract({
      address: comptroller,
      abi: venusComptrollerExtraAbi,
      functionName: 'oracle',
    }) as Promise<Address>,
  ])

  const wanted = args.symbols?.map((symbol) => symbol.toUpperCase())
  const out: VenusMarketDepth[] = []

  for (const vToken of vTokens) {
    const isNative = vToken.toLowerCase() === vBnb

    let underlying: Address | null = null
    let underlyingSymbol = 'BNB'
    let underlyingDecimals = 18
    if (!isNative) {
      underlying = (await client
        .readContract({ address: vToken, abi: venusVTokenAbi, functionName: 'underlying' })
        .catch(() => null)) as Address | null
      if (underlying === null) continue
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: underlying, abi: erc20Abi, functionName: 'symbol' }).then(String).catch(() => null),
        client.readContract({ address: underlying, abi: erc20Abi, functionName: 'decimals' }).then(Number).catch(() => null),
      ])
      if (symbol === null || decimals === null) continue
      underlyingSymbol = symbol
      underlyingDecimals = decimals
    }

    if (wanted && !wanted.includes(underlyingSymbol.toUpperCase())) continue

    const [vSupply, exchangeRate, cash, borrows, rate, price, marketInfo, vSymbol] = await Promise.all([
      client.readContract({ address: vToken, abi: vTokenDepthAbi, functionName: 'totalSupply' }).catch(() => 0n) as Promise<bigint>,
      client.readContract({ address: vToken, abi: venusVTokenAbi, functionName: 'exchangeRateStored' }).catch(() => 0n) as Promise<bigint>,
      client.readContract({ address: vToken, abi: vTokenDepthAbi, functionName: 'getCash' }).catch(() => 0n) as Promise<bigint>,
      client.readContract({ address: vToken, abi: vTokenDepthAbi, functionName: 'totalBorrows' }).catch(() => 0n) as Promise<bigint>,
      client.readContract({ address: vToken, abi: venusVTokenAbi, functionName: 'supplyRatePerBlock' }).catch(() => 0n) as Promise<bigint>,
      client.readContract({ address: oracle, abi: venusOracleAbi, functionName: 'getUnderlyingPrice', args: [vToken] }).catch(() => 0n) as Promise<bigint>,
      client.readContract({ address: comptroller, abi: venusComptrollerAbi, functionName: 'markets', args: [vToken] }).catch(() => [false, 0n, false] as const) as Promise<readonly [boolean, bigint, boolean]>,
      client.readContract({ address: vToken, abi: vTokenExtraAbi, functionName: 'symbol' }).catch(() => 'vToken') as Promise<string>,
    ])

    const totalSupplied = (vSupply * exchangeRate) / 10n ** 18n
    const priceUsd = mantissaToUsd(price, underlyingDecimals)

    out.push({
      vToken,
      vTokenSymbol: vSymbol,
      isNative,
      underlying,
      underlyingSymbol,
      underlyingDecimals,
      totalSuppliedUnderlying: totalSupplied,
      totalSuppliedUsd: toUnits(totalSupplied, underlyingDecimals) * priceUsd,
      cashUnderlying: cash,
      cashUsd: toUnits(cash, underlyingDecimals) * priceUsd,
      totalBorrowsUnderlying: borrows,
      utilisation: totalSupplied > 0n ? Number(borrows) / Number(totalSupplied) : 0,
      supplyRatePerBlock: rate,
      supplyApyPct: supplyApyFromRatePerBlock(rate, args.blocksPerYear),
      priceUsd,
      collateralFactor: Number(marketInfo[1]) / 1e18,
    })
  }

  return out
}
