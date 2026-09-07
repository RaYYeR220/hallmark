import { getChain, isSupportedChainId, type SupportedChainId } from '@hallmark/core'
import { parseUnits } from 'viem'

import {
  listVenusMarkets,
  measureBlocksPerYear,
  type VenusMarketDepth,
} from '../../chain/venus.js'
import { fetchBscLlamaPools, poolsForAsset, type LlamaPool } from '../../chain/yields.js'
import {
  allAgree,
  assertion,
  failedAssertions,
  reconcile,
  type Assertion,
  type Reconciliation,
} from '../../chain/reconcile.js'
import { priceUsdForSymbol } from '../../chain/usd.js'
import { clientFor } from '../../runtime/client.js'
import { narrate } from '../../runtime/narrative.js'
import type { Analysis, SkillContext, Source } from '../../runtime/types.js'
import { YIELD_SLUG } from './manifest.js'

/**
 * Where an asset should sit, and what it costs to get it there.
 *
 * The interesting part is not ranking APRs — anyone can sort a list. It is the
 * two things that make a ranking actionable:
 *
 *   - *depth read on-chain*. DeFiLlama's `tvlUsd` for a lending pool is the
 *     market's available liquidity, not what depositors have supplied. Venus
 *     reads roughly a third of its real size there. An allocation sized off
 *     that field is sized off the wrong number, so both are reported and the
 *     on-chain figure is the one used;
 *   - *two readings per venue*. A lending market publishes its rate on-chain;
 *     DeFiLlama publishes its own. Where both exist they must agree, and a
 *     venue whose two readings diverge is shown with the discrepancy rather
 *     than recommended.
 */

export type YieldInput = {
  chainId?: number
  asset: string
  amount: string
  minTvlUsd?: number
  includeIlRisk?: boolean
}

export type Venue = {
  name: string
  project: string
  kind: 'lending' | 'lp' | 'other'
  apyPct: number | null
  apyBasePct: number | null
  apyRewardPct: number | null
  /** What depositors have supplied. On-chain where we can read it. */
  depositsUsd: number | null
  /** What could be withdrawn right now. */
  availableLiquidityUsd: number | null
  depthSource: 'onchain' | 'defillama'
  stablecoin: boolean
  ilRisk: string
  /** Share of the market this allocation would become. */
  shareOfDepositsPct: number | null
  caveats: string[]
  onchain: { vToken: string; supplyRatePerBlock: string; blocksPerYear: number } | null
  llamaPoolId: string | null
}

export type YieldDecision = {
  asset: string
  amountUsd: number | null
  amount: string
  best: Venue | null
  current: Venue | null
  allocation: Array<{ venue: string; sharePct: number; amountUsd: number | null; why: string }>
  venues: Venue[]
  moveCost: {
    gas: string
    gasPriceWei: string
    gasCostBnb: number
    gasCostUsd: number | null
    steps: string[]
  }
  breakEven: {
    apyDeltaPct: number | null
    extraPerYearUsd: number | null
    daysToRecoverCost: number | null
    detail: string
  }
  risks: string[]
  checks: Reconciliation[]
  assertions: Assertion[]
  checksPass: boolean
}

export type YieldAnalysis = Analysis<YieldDecision>

/** Gas budget for a venue move: approve, withdraw, deposit. */
const MOVE_GAS = { approve: 55_000n, redeem: 260_000n, mint: 300_000n }

function classify(project: string): Venue['kind'] {
  const lending = ['venus', 'aave', 'radiant', 'compound', 'lista', 'kinza']
  return lending.some((name) => project.toLowerCase().includes(name)) ? 'lending' : 'lp'
}

export async function analyseYield(
  input: YieldInput,
  ctx: SkillContext,
  opts: { deep: boolean },
): Promise<YieldAnalysis | { error: string; detail: string }> {
  const chainId: SupportedChainId =
    input.chainId !== undefined && isSupportedChainId(input.chainId) ? input.chainId : ctx.chainId
  const chain = getChain(chainId)
  const client = clientFor(ctx, chainId)
  const now = ctx.now()
  const asset = input.asset.toUpperCase()
  const sources: Source[] = []
  const warnings: string[] = []

  // --- on-chain: Venus -----------------------------------------------------
  // A per-block rate needs a blocks-per-year figure, and the constant everyone
  // copies describes a three-second block BNB Chain no longer has. Measure it.
  const blockRate = await measureBlocksPerYear(client)
  sources.push({ kind: 'onchain', label: 'Block time', detail: blockRate.detail })

  let venusMarkets: VenusMarketDepth[] = []
  try {
    venusMarkets = await listVenusMarkets({
      client,
      chainId,
      symbols: [asset],
      blocksPerYear: blockRate.blocksPerYear,
    })
    sources.push({
      kind: 'onchain',
      label: 'Venus core pool',
      detail:
        `getAllMarkets() on ${chain.defi.venusComptroller}, then supplyRatePerBlock(), ` +
        'totalSupply() × exchangeRateStored() for deposits and getCash() for available liquidity',
      url: `${chain.explorer}/address/${chain.defi.venusComptroller}`,
    })
  } catch (error) {
    warnings.push(
      `Venus on-chain reads failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    )
  }

  // --- off-chain: DeFiLlama ------------------------------------------------
  let llamaPools: LlamaPool[] = []
  try {
    const all = await fetchBscLlamaPools({ fetchImpl: ctx.fetch })
    llamaPools = poolsForAsset(all, asset)
    sources.push({
      kind: 'http',
      label: 'DeFiLlama yields',
      detail: `${all.length} BSC pools, ${llamaPools.length} of them holding ${asset}`,
      url: 'https://yields.llama.fi/pools',
    })
  } catch (error) {
    warnings.push(
      `DeFiLlama unavailable: ${error instanceof Error ? error.message : String(error)}. ` +
        'The comparison below is on-chain only.',
    )
  }

  // --- price ---------------------------------------------------------------
  const price = await priceUsdForSymbol({ client, chainId, symbol: asset, now })
  const venusMarket = venusMarkets[0]
  const decimals = venusMarket?.underlyingDecimals ?? 18
  const amountAtomic = parseUnits(input.amount, decimals)
  const amountUnits = Number(amountAtomic) / 10 ** decimals
  const amountUsd = price.usd === null ? (venusMarket ? amountUnits * venusMarket.priceUsd : null) : amountUnits * price.usd

  // --- venues --------------------------------------------------------------
  const checks: Reconciliation[] = []
  const venues: Venue[] = []
  const minTvl = input.minTvlUsd ?? 1_000_000

  if (venusMarket) {
    const llamaVenus = llamaPools.find(
      (pool) => pool.project.toLowerCase().includes('venus') && pool.symbol.toUpperCase() === asset,
    )
    if (llamaVenus?.apyBase != null) {
      // The same rate, two ways. On-chain is authoritative; a large gap means
      // one of the two is describing a different market.
      checks.push(
        reconcile({
          label: `Venus ${asset} supply APY`,
          primary: {
            source: `supplyRatePerBlock() × ${blockRate.blocksPerYear} blocks/yr`,
            value: venusMarket.supplyApyPct,
          },
          secondary: { source: 'DeFiLlama apyBase', value: llamaVenus.apyBase },
          toleranceBps: 5_000,
        }),
      )
    }

    const caveats: string[] = []
    if (venusMarket.utilisation > 0.9) {
      caveats.push(
        `Utilisation is ${(venusMarket.utilisation * 100).toFixed(1)}%: a withdrawal larger than ` +
          `$${venusMarket.cashUsd.toFixed(0)} would have to wait for a repayment.`,
      )
    }
    if (llamaVenus) {
      caveats.push(
        `DeFiLlama lists this market's TVL as $${llamaVenus.tvlUsd.toFixed(0)}, which is its ` +
          `available liquidity. Depositors have actually supplied ` +
          `$${venusMarket.totalSuppliedUsd.toFixed(0)} — the figure used here.`,
      )
    }

    venues.push({
      name: `Venus ${asset}`,
      project: 'venus-core-pool',
      kind: 'lending',
      apyPct: venusMarket.supplyApyPct,
      apyBasePct: venusMarket.supplyApyPct,
      apyRewardPct: llamaVenus?.apyReward ?? null,
      depositsUsd: venusMarket.totalSuppliedUsd,
      availableLiquidityUsd: venusMarket.cashUsd,
      depthSource: 'onchain',
      stablecoin: llamaVenus?.stablecoin ?? false,
      ilRisk: 'no',
      shareOfDepositsPct:
        amountUsd === null || venusMarket.totalSuppliedUsd <= 0
          ? null
          : (amountUsd / venusMarket.totalSuppliedUsd) * 100,
      caveats,
      onchain: {
        vToken: venusMarket.vToken,
        supplyRatePerBlock: venusMarket.supplyRatePerBlock.toString(),
        blocksPerYear: blockRate.blocksPerYear,
      },
      llamaPoolId: llamaVenus?.pool ?? null,
    })
  }

  for (const pool of llamaPools) {
    if (pool.project.toLowerCase().includes('venus')) continue
    if (pool.tvlUsd < minTvl) continue
    if (pool.apy === null) continue
    const kind = classify(pool.project)
    if (kind !== 'lending' && input.includeIlRisk !== true && pool.ilRisk === 'yes') continue

    const caveats: string[] = []
    if (pool.ilRisk === 'yes') {
      caveats.push(
        'DeFiLlama flags impermanent-loss risk on this pool: the quoted APR is fee income, not ' +
          'a return, and a divergent pair can lose more than it earns.',
      )
    }
    if ((pool.apyReward ?? 0) > (pool.apyBase ?? 0)) {
      caveats.push(
        `Most of this APR is incentives (${(pool.apyReward ?? 0).toFixed(2)}% reward against ` +
          `${(pool.apyBase ?? 0).toFixed(2)}% base), which end.`,
      )
    }
    if (kind === 'lending') {
      caveats.push(
        `Depth is DeFiLlama's TVL field. For a lending market that is available liquidity, not ` +
          'total deposits, so the real market is larger than shown.',
      )
    }
    if (pool.outlier) {
      caveats.push("DeFiLlama's own outlier flag is set on this pool's APY.")
    }

    venues.push({
      name: `${pool.project} ${pool.symbol}`,
      project: pool.project,
      kind,
      apyPct: pool.apy,
      apyBasePct: pool.apyBase,
      apyRewardPct: pool.apyReward,
      depositsUsd: kind === 'lending' ? null : pool.tvlUsd,
      availableLiquidityUsd: pool.tvlUsd,
      depthSource: 'defillama',
      stablecoin: pool.stablecoin,
      ilRisk: pool.ilRisk,
      shareOfDepositsPct:
        amountUsd === null || pool.tvlUsd <= 0 ? null : (amountUsd / pool.tvlUsd) * 100,
      caveats,
      onchain: null,
      llamaPoolId: pool.pool,
    })
  }

  venues.sort((a, b) => (b.apyPct ?? -1) - (a.apyPct ?? -1))

  const assertions: Assertion[] = [
    assertion(
      'At least one venue was found',
      venues.length > 0,
      `${venues.length} venue(s) hold ${asset} on BNB Chain above the $${minTvl} depth floor.`,
    ),
    assertion(
      'Every quoted APY is plausible',
      venues.every((venue) => venue.apyPct === null || (venue.apyPct >= 0 && venue.apyPct < 1_000)),
      'An APY below zero or above 1000% is a data error, not an opportunity.',
    ),
  ]

  const best = venues[0] ?? null
  const current =
    venues.find((venue) => venue.project === 'venus-core-pool') ?? null

  // --- move cost -----------------------------------------------------------
  const gasPrice = await client.getGasPrice().catch(() => 1_000_000_000n)
  const gasTotal = MOVE_GAS.approve + MOVE_GAS.redeem + MOVE_GAS.mint
  const bnb = await priceUsdForSymbol({ client, chainId, symbol: 'BNB', now })
  const gasCostBnb = Number(gasTotal * gasPrice) / 1e18
  const gasCostUsd = bnb.usd === null ? null : gasCostBnb * bnb.usd
  if (bnb.usd === null) warnings.push(bnb.detail)

  const apyDelta =
    best?.apyPct != null && current?.apyPct != null ? best.apyPct - current.apyPct : null
  const extraPerYear =
    apyDelta === null || amountUsd === null ? null : (amountUsd * apyDelta) / 100
  const daysToRecover =
    extraPerYear === null || gasCostUsd === null || extraPerYear <= 0
      ? null
      : (gasCostUsd / extraPerYear) * 365

  const failed = failedAssertions(assertions)
  const checksPass = allAgree(checks) && failed.length === 0
  if (!checksPass) {
    warnings.push(
      ...checks.filter((check) => !check.agrees).map((check) => check.detail),
      ...failed.map((check) => `${check.label} failed: ${check.detail}`),
    )
  }

  const risks: string[] = []
  if (best) risks.push(...best.caveats)
  if (best && best.shareOfDepositsPct != null && best.shareOfDepositsPct > 5) {
    risks.push(
      `This allocation would be ${best.shareOfDepositsPct.toFixed(1)}% of the venue. Entering and ` +
        'leaving at that size moves the rate you are entering for.',
    )
  }
  if (price.usd === null) {
    risks.push(price.detail)
  }

  const decision: YieldDecision = {
    asset,
    amount: input.amount,
    amountUsd,
    best,
    current,
    allocation:
      best === null
        ? []
        : [
            {
              venue: best.name,
              sharePct: 100,
              amountUsd,
              why:
                `Highest APR of the ${venues.length} venue(s) that clear the depth floor: ` +
                `${best.apyPct?.toFixed(2) ?? '—'}%` +
                (apyDelta !== null ? `, ${apyDelta.toFixed(2)} points above where it sits now.` : '.'),
            },
          ],
    venues,
    moveCost: {
      gas: gasTotal.toString(),
      gasPriceWei: gasPrice.toString(),
      gasCostBnb,
      gasCostUsd,
      steps: ['approve the destination market', 'redeemUnderlying from the source', 'mint into the destination'],
    },
    breakEven: {
      apyDeltaPct: apyDelta,
      extraPerYearUsd: extraPerYear,
      daysToRecoverCost: daysToRecover,
      detail:
        apyDelta === null
          ? 'No comparable current venue, so there is no delta to break even on.'
          : apyDelta <= 0
            ? `The best venue is not better than the current one (${apyDelta.toFixed(2)} points). Moving would cost gas to earn less.`
            : `Moving costs ${gasCostUsd === null ? 'an unpriced amount of' : `$${gasCostUsd.toFixed(4)} of`} gas ` +
              `to gain ${apyDelta.toFixed(2)} points, which on ` +
              `${amountUsd === null ? 'this position' : `$${amountUsd.toFixed(2)}`} is ` +
              `${extraPerYear === null ? 'an unknown amount' : `$${extraPerYear.toFixed(2)}`} a year — ` +
              `paid back in ${daysToRecover === null ? 'an unknown number of' : daysToRecover.toFixed(2)} days, ` +
              'if the rate holds, which is the assumption to be sceptical of.',
    },
    risks,
    checks,
    assertions,
    checksPass,
  }

  const lines = [
    `${asset} on BNB Chain: ${venues.length} venue(s) compared.`,
    best === null
      ? 'No venue cleared the filters, so there is nothing to recommend.'
      : `Best: ${best.name} at ${best.apyPct?.toFixed(2) ?? '—'}% APY, ` +
        `${best.depositsUsd === null ? 'depth unknown' : `$${(best.depositsUsd / 1e6).toFixed(1)}M deposited`}` +
        `${best.availableLiquidityUsd === null ? '' : `, $${(best.availableLiquidityUsd / 1e6).toFixed(1)}M withdrawable right now`}.`,
    decision.breakEven.detail,
    ...risks.map((risk) => `Risk: ${risk}`),
  ]

  return {
    agent: YIELD_SLUG,
    skill: opts.deep ? 'report' : 'analyse',
    chainId,
    subject: { asset, amount: input.amount },
    observedAt: new Date(now * 1000).toISOString(),
    decision,
    facts: {
      venus: venusMarkets.map((market) => ({
        vToken: market.vToken,
        symbol: market.underlyingSymbol,
        supplyRatePerBlock: market.supplyRatePerBlock.toString(),
        supplyApyPct: market.supplyApyPct,
        totalSuppliedUsd: market.totalSuppliedUsd,
        cashUsd: market.cashUsd,
        utilisation: market.utilisation,
        priceUsd: market.priceUsd,
      })),
      defillama: opts.deep ? llamaPools : llamaPools.slice(0, 10),
      price,
      bnbPrice: bnb,
    },
    sources,
    warnings,
    narrative: await narrate({ agent: YIELD_SLUG, skill: opts.deep ? 'report' : 'analyse', decision, lines }),
  }
}
