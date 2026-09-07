import { getChain, isSupportedChainId, type SupportedChainId } from '@hallmark/core'
import type { Address } from 'viem'
import {
  liquidationPriceFor,
  planRepay,
  readVenusAccount,
  type LiquidationPrice,
  type RepayPlan,
  type VenusAccount,
} from '../../chain/venus.js'
import { crossCheck, readChainlinkPrice, type ChainlinkPair, type PriceRead } from '../../chain/prices.js'
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
import { HEALTH_SLUG } from './manifest.js'

/**
 * Watching a Venus position, and refusing to guess.
 *
 * Health is computed against Venus's *own* oracle, because that is the oracle
 * a liquidator is measured by. Chainlink is the independent second opinion:
 * it has to be fresh, it has to report eight decimals, and it has to agree
 * with the Venus oracle. Any of those failing is a refusal to act — not a
 * warning, not a fallback price.
 *
 * Health is also computed twice from two different chain reads: once from the
 * per-market balances and collateral factors, and once from the comptroller's
 * own `getAccountLiquidity`. Those are independent derivations of the same
 * quantity, and if they disagree the position is not understood well enough to
 * act on.
 */

export type HealthInput = {
  chainId?: number
  borrower: string
  targetHealthFactor?: number
  triggerHealthFactor?: number
  maxPriceAgeSeconds?: number
  /** How far Chainlink may sit from the protocol oracle before we stop. */
  oracleToleranceBps?: number
}

export type HealthDecision = {
  action: 'hold' | 'repay' | 'refuse'
  urgency: 'none' | 'watch' | 'now' | 'liquidatable'
  reason: string
  healthFactor: number | null
  triggerHealthFactor: number
  targetHealthFactor: number
  liquidatable: boolean
  totals: {
    suppliedUsd: number
    borrowedUsd: number
    adjustedCollateralUsd: number
    liquidityUsd: number
    shortfallUsd: number
  }
  markets: Array<{
    vToken: string
    symbol: string
    isNative: boolean
    suppliedUsd: number
    borrowedUsd: number
    collateralFactor: number
    priceUsd: number
    /** Which repay signature this market takes. The vBNB split, made explicit. */
    repaySignature: 'repayBorrow()' | 'repayBorrow(uint256)'
  }>
  liquidation: LiquidationPrice
  repay: RepayPlan | null
  feeds: Array<{ pair: string; ok: boolean; detail: string; ageSeconds: number | null; decimals: number | null }>
  checks: Reconciliation[]
  assertions: Assertion[]
  checksPass: boolean
  /** Set when the agent refuses to act, with the reason a UI should show. */
  failClosed: { reason: 'stale-price' | 'read-failed' | 'precondition'; detail: string } | null
}

export type HealthAnalysis = Analysis<HealthDecision>

const FEED_FOR_SYMBOL: Readonly<Record<string, ChainlinkPair>> = Object.freeze({
  BNB: 'bnbUsd',
  WBNB: 'bnbUsd',
  BTC: 'btcUsd',
  BTCB: 'btcUsd',
  ETH: 'ethUsd',
  CAKE: 'cakeUsd',
})

export async function analyseHealth(
  input: HealthInput,
  ctx: SkillContext,
  opts: { deep: boolean },
): Promise<HealthAnalysis | { error: string; detail: string }> {
  const chainId: SupportedChainId =
    input.chainId !== undefined && isSupportedChainId(input.chainId) ? input.chainId : ctx.chainId
  const chain = getChain(chainId)
  const client = clientFor(ctx, chainId)
  const now = ctx.now()
  const sources: Source[] = []
  const warnings: string[] = []

  const trigger = input.triggerHealthFactor ?? 1.25
  const target = input.targetHealthFactor ?? 1.6
  const tolerance = input.oracleToleranceBps ?? 200

  if (target <= trigger) {
    return {
      error: 'invalid-thresholds',
      detail:
        `targetHealthFactor (${target}) must be above triggerHealthFactor (${trigger}), or ` +
        'every repay would leave the position still triggering and the agent would loop.',
    }
  }

  const account = await readVenusAccount({
    client,
    chainId,
    borrower: input.borrower as Address,
  })
  if (!account.ok) {
    return { error: account.reason, detail: account.detail }
  }

  sources.push({
    kind: 'onchain',
    label: 'Venus comptroller',
    detail:
      `getAssetsIn(${input.borrower}), getAccountLiquidity(${input.borrower}) and markets() ` +
      `on ${chain.defi.venusComptroller} at block ${account.blockNumber}`,
    url: `${chain.explorer}/address/${chain.defi.venusComptroller}`,
  })
  sources.push({
    kind: 'onchain',
    label: 'Venus price oracle',
    detail: `getUnderlyingPrice() per market on ${account.oracle} — the oracle a liquidation is judged against`,
    url: `${chain.explorer}/address/${account.oracle}`,
  })

  // --- feeds: the fail-closed gate ----------------------------------------
  const feeds: HealthDecision['feeds'] = []
  const checks: Reconciliation[] = []
  let failClosed: HealthDecision['failClosed'] = null

  for (const market of account.markets) {
    const pair = FEED_FOR_SYMBOL[market.underlyingSymbol.toUpperCase()]
    if (pair === undefined) continue
    if (market.supplyUsd === 0 && market.borrowUsd === 0) continue

    const read: PriceRead = await readChainlinkPrice({
      client,
      chainId,
      pair,
      now,
      ...(input.maxPriceAgeSeconds === undefined ? {} : { maxAgeSeconds: input.maxPriceAgeSeconds }),
    })
    feeds.push({
      pair: read.pair,
      ok: read.ok,
      detail: read.ok ? `$${read.priceUsd} from ${read.feed}, ${read.ageSeconds}s old` : read.detail,
      ageSeconds: read.ok ? read.ageSeconds : (read.observed?.ageSeconds ?? null),
      decimals: read.ok ? read.decimals : (read.observed?.decimals ?? null),
    })
    sources.push({
      kind: 'onchain',
      label: `Chainlink ${read.pair}`,
      detail: read.ok
        ? `latestRoundData() and decimals() on ${read.feed}; ${read.ageSeconds}s old, ${read.decimals} decimals`
        : `latestRoundData() on ${read.feed} — rejected: ${read.detail}`,
      url: `${chain.explorer}/address/${read.feed}`,
    })

    if (!read.ok) {
      failClosed = { reason: read.reason === 'read-failed' ? 'read-failed' : 'stale-price', detail: read.detail }
      continue
    }

    const agreement = crossCheck({
      label: `${market.underlyingSymbol} price`,
      independentUsd: read.priceUsd,
      protocolUsd: market.priceUsd,
      toleranceBps: tolerance,
    })
    checks.push(
      reconcile({
        label: `${market.underlyingSymbol} price`,
        primary: { source: 'Venus oracle getUnderlyingPrice()', value: market.priceUsd },
        secondary: { source: `Chainlink ${read.pair}`, value: read.priceUsd },
        toleranceBps: tolerance,
      }),
    )
    if (!agreement.agrees) {
      failClosed = failClosed ?? { reason: 'precondition', detail: agreement.detail }
    }
  }

  // --- health, derived twice ----------------------------------------------
  // The comptroller reports (liquidity, shortfall) = adjustedCollateral −
  // borrows. Our per-market sum should reproduce that number. Two reads, two
  // routes, one answer — or we do not act.
  const impliedNet = account.adjustedCollateralUsd - account.totalBorrowUsd
  const reportedNet = account.liquidityUsd - account.shortfallUsd
  checks.push(
    reconcile({
      label: 'Account net liquidity',
      primary: { source: 'Σ(supply × collateralFactor) − Σ borrows, per market', value: impliedNet },
      secondary: { source: 'comptroller getAccountLiquidity()', value: reportedNet },
      // Venus accrues interest per block, and the two reads land in different
      // multicall batches, so a few basis points of drift is arithmetic rather
      // than a discrepancy.
      toleranceBps: 100,
    }),
  )

  const assertions: Assertion[] = [
    assertion(
      'Every market carries a price',
      account.markets.every((market) => market.priceUsd > 0 || (market.supplyUsd === 0 && market.borrowUsd === 0)),
      account.markets
        .filter((market) => market.priceUsd <= 0)
        .map((market) => `${market.underlyingSymbol} priced at ${market.priceUsd}`)
        .join('; ') || 'All markets with a balance are priced.',
    ),
    assertion(
      'Collateral factors are in range',
      account.markets.every((market) => market.collateralFactor >= 0 && market.collateralFactor <= 1),
      'A collateral factor outside [0, 1] means the mantissa was scaled wrong.',
    ),
    assertion(
      'Shortfall and liquidity are not both positive',
      !(account.liquidityUsd > 0 && account.shortfallUsd > 0),
      `getAccountLiquidity returned liquidity ${account.liquidityUsd} and shortfall ${account.shortfallUsd}; ` +
        'Venus returns at most one of them non-zero.',
    ),
  ]

  const failed = failedAssertions(assertions)
  const checksPass = allAgree(checks) && failed.length === 0
  if (!checksPass && failClosed === null) {
    failClosed = {
      reason: 'precondition',
      detail: [
        ...checks.filter((check) => !check.agrees).map((check) => check.detail),
        ...failed.map((check) => `${check.label}: ${check.detail}`),
      ].join(' '),
    }
  }
  if (failClosed) warnings.push(failClosed.detail)

  // --- decision ------------------------------------------------------------
  const hf = account.healthFactor
  const volatile = pickVolatileMarket(account, chainId)
  const liquidation = volatile
    ? liquidationPriceFor(account, volatile)
    : { ok: false as const, detail: 'No volatile market in this position to solve a liquidation price for.' }

  const repayMarket = account.markets.find((market) => market.borrowUnderlying > 0n)
  const repay =
    hf !== null && hf < target && repayMarket
      ? planRepay({ account, vToken: repayMarket.vToken, targetHealthFactor: target })
      : null

  let action: HealthDecision['action']
  let urgency: HealthDecision['urgency']
  let reason: string

  if (failClosed) {
    action = 'refuse'
    urgency = account.liquidatable ? 'liquidatable' : 'watch'
    reason =
      'This agent will not act on the numbers it has. ' +
      failClosed.detail +
      ' Refusing is the safe answer: repaying against a price that may be wrong can turn a ' +
      'healthy position into a liquidated one.'
  } else if (hf === null) {
    action = 'hold'
    urgency = 'none'
    reason = 'The account has no borrows, so it has no health factor and cannot be liquidated.'
  } else if (account.liquidatable) {
    action = 'repay'
    urgency = 'liquidatable'
    reason =
      `The position is already liquidatable: the comptroller reports a shortfall of ` +
      `$${account.shortfallUsd.toFixed(2)}. Repaying now reduces what a liquidator can take, ` +
      'but a liquidator may get there first.'
  } else if (hf <= trigger) {
    action = 'repay'
    urgency = 'now'
    reason =
      `Health is ${hf.toFixed(3)}, at or below the ${trigger} trigger. Repaying ` +
      `${repay?.ok ? `${repay.repayUsd.toFixed(2)} USD of ${repay.market.underlyingSymbol}` : 'debt'} ` +
      `restores it to ${target}.`
  } else {
    action = 'hold'
    urgency = hf < trigger * 1.15 ? 'watch' : 'none'
    reason =
      `Health is ${hf.toFixed(3)}, above the ${trigger} trigger. Nothing to do; ` +
      `${liquidation.ok ? `liquidation is at $${liquidation.liquidationPriceUsd.toFixed(2)} ${liquidation.asset}, a ${Math.abs(liquidation.moveToLiquidationPct).toFixed(1)}% ${liquidation.direction} away.` : 'no single-asset liquidation price could be solved.'}`
  }

  const decision: HealthDecision = {
    action,
    urgency,
    reason,
    healthFactor: hf,
    triggerHealthFactor: trigger,
    targetHealthFactor: target,
    liquidatable: account.liquidatable,
    totals: {
      suppliedUsd: account.totalSupplyUsd,
      borrowedUsd: account.totalBorrowUsd,
      adjustedCollateralUsd: account.adjustedCollateralUsd,
      liquidityUsd: account.liquidityUsd,
      shortfallUsd: account.shortfallUsd,
    },
    markets: account.markets.map((market) => ({
      vToken: market.vToken,
      symbol: market.underlyingSymbol,
      isNative: market.isNative,
      suppliedUsd: market.supplyUsd,
      borrowedUsd: market.borrowUsd,
      collateralFactor: market.collateralFactor,
      priceUsd: market.priceUsd,
      repaySignature: market.isNative ? 'repayBorrow()' : 'repayBorrow(uint256)',
    })),
    liquidation,
    repay,
    feeds,
    checks,
    assertions,
    checksPass,
    failClosed,
  }

  const lines = [
    `Venus position ${input.borrower}: health ${hf === null ? 'n/a (no debt)' : hf.toFixed(3)}, ` +
      `$${account.totalSupplyUsd.toFixed(2)} supplied against $${account.totalBorrowUsd.toFixed(2)} borrowed.`,
    reason,
    ...(liquidation.ok
      ? [
          `Liquidation at $${liquidation.liquidationPriceUsd.toFixed(2)} ${liquidation.asset} ` +
            `(now $${liquidation.currentPriceUsd.toFixed(2)}), a ` +
            `${Math.abs(liquidation.moveToLiquidationPct).toFixed(1)}% ${liquidation.direction}.`,
        ]
      : [`Liquidation price: ${liquidation.detail}`]),
    ...(repay?.ok
      ? [
          `Precise repay: ${repay.repayUnderlying} ${repay.market.underlyingSymbol} ` +
            `($${repay.repayUsd.toFixed(2)}) via \`${repay.market.isNative ? 'repayBorrow()' : 'repayBorrow(uint256)'}\`, ` +
            `landing health at ${repay.projectedHealthFactor.toFixed(3)} (capped by ${repay.cappedBy}).`,
        ]
      : []),
    ...feeds.map((feed) => `Feed ${feed.pair}: ${feed.ok ? 'fresh' : 'REJECTED'} — ${feed.detail}`),
  ]

  return {
    agent: HEALTH_SLUG,
    skill: opts.deep ? 'report' : 'analyse',
    chainId,
    subject: { borrower: input.borrower, comptroller: account.comptroller },
    observedAt: new Date(now * 1000).toISOString(),
    blockNumber: account.blockNumber.toString(),
    decision,
    facts: {
      account: {
        markets: account.markets.map((market) => ({
          ...market,
          supplyUnderlying: market.supplyUnderlying.toString(),
          borrowUnderlying: market.borrowUnderlying.toString(),
          priceMantissa: market.priceMantissa.toString(),
          supplyRatePerBlock: market.supplyRatePerBlock.toString(),
        })),
        oracle: account.oracle,
      },
      thresholds: { trigger, target, oracleToleranceBps: tolerance },
    },
    sources,
    warnings,
    narrative: await narrate({ agent: HEALTH_SLUG, skill: opts.deep ? 'report' : 'analyse', decision, lines }),
  }
}

/**
 * The asset to solve a liquidation price for.
 *
 * The one with the largest exposure that is not a stablecoin — a liquidation
 * price for USDT is a number, but not an interesting one.
 */
function pickVolatileMarket(account: VenusAccount, chainId: SupportedChainId): Address | null {
  const stables = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI', 'TUSD', 'USD1', 'VAI'])
  const candidates = account.markets
    .filter((market) => !stables.has(market.underlyingSymbol.toUpperCase()))
    .filter((market) => market.supplyUsd > 0 || market.borrowUsd > 0)
    .sort((a, b) => b.supplyUsd + b.borrowUsd - (a.supplyUsd + a.borrowUsd))
  if (candidates[0]) return candidates[0].vToken
  // A stables-only position still has a liquidation price; use vBNB if it is
  // in the set, otherwise the largest market.
  const vBnb = getChain(chainId).defi.venusVBnb.toLowerCase()
  return (
    account.markets.find((market) => market.vToken.toLowerCase() === vBnb)?.vToken ??
    account.markets[0]?.vToken ??
    null
  )
}

