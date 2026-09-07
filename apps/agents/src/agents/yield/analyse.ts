import { getChain, isSupportedChainId, type SupportedChainId } from '@hallmark/core'
import { parseUnits } from 'viem'

import {
  listVenusMarkets,
  measureBlocksPerYear,
  type VenusMarketDepth,
} from '../../chain/venus.js'
import {
  fetchBscLlamaPools,
  fetchPancakePools,
  pancakePoolsForAsset,
  poolsForAsset,
  type LlamaPool,
  type PancakePool,
} from '../../chain/yields.js'
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
import {
  resolveMandate,
  spreadAllocation,
  violations,
  type Mandate,
  type MandateInput,
  type ResolvedMandate,
  type Violation,
} from './mandate.js'

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
  /**
   * The constraint the allocation must satisfy. Absent means the conservative
   * default, and the output says which default was applied — ranking on APR
   * alone is not something this agent falls back to silently.
   */
  mandate?: MandateInput
  /** @deprecated Use `mandate.minTvlUsd`. Kept so existing callers still work. */
  minTvlUsd?: number
  /** @deprecated Use `mandate.maxIlRisk`. Kept so existing callers still work. */
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
  depthSource: 'onchain' | 'defillama' | 'pancake-explorer'
  stablecoin: boolean
  ilRisk: string
  /** DeFiLlama's own flag that it does not stand behind this APY. */
  outlier: boolean
  exposure: string
  /** Empty when the venue passed every mandate rule. */
  violations: Violation[]
  eligible: boolean
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
  /** `allocate` when something eligible exists; `refuse` when nothing does. */
  action: 'allocate' | 'refuse'
  reason: string
  mandate: { applied: Mandate; specified: boolean; note: string }
  /** Best venue that satisfies the mandate. */
  best: Venue | null
  /**
   * Highest APR overall, mandate or not. Present so an excluded top venue is
   * visible rather than quietly dropped — the caller can see what was passed
   * over and why.
   */
  topRankedOverall: Venue | null
  excludedTop: { venue: string; apyPct: number | null; violations: Violation[] } | null
  current: Venue | null
  allocation: Array<{ venue: string; sharePct: number; amountUsd: number | null; why: string }>
  /** Eligible venues only. Everything considered is in `excluded`. */
  venues: Venue[]
  excluded: Array<{ venue: string; apyPct: number | null; violations: Violation[] }>
  /**
   * Venues that could not be sourced at all, and why.
   *
   * A comparison that silently lacks a venue is indistinguishable from one
   * where the venue scored badly. This makes the hole a stated limit.
   */
  unreachableVenues: Array<{ venue: string; reason: string }>
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
  /**
   * Never `[]`. An empty list reads as "we checked and found none", which is
   * the most dangerous thing this agent could say; `null` plus a reason is
   * what "we could not determine" looks like.
   */
  risks: string[] | null
  risksUnknownReason: string | null
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
  const unreachableVenues: Array<{ venue: string; reason: string }> = []

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
    const reason = `DeFiLlama unavailable: ${error instanceof Error ? error.message : String(error)}.`
    warnings.push(`${reason} The comparison below is on-chain only.`)
    unreachableVenues.push({ venue: 'every DeFiLlama-sourced venue', reason })
  }

  // --- first-party: the PancakeSwap Explorer -------------------------------
  // DeFiLlama does carry PancakeSwap BSC pools, but only v2 — the deepest
  // stable venue on the chain is a v3 pool at roughly $41M and Llama has no
  // record of it. A Llama-only comparison omits it without saying so, which
  // is the failure this source exists to close.
  let pancakePools: PancakePool[] = []
  try {
    const all = await fetchPancakePools({ fetchImpl: ctx.fetch })
    pancakePools = pancakePoolsForAsset(all, asset)
    sources.push({
      kind: 'http',
      label: 'PancakeSwap Explorer',
      detail:
        `${all.length} BSC pools across v3, v2 and stable, ${pancakePools.length} of them ` +
        'holding ' + asset + '. First-party and keyless. `apr24h` is a decimal fraction ' +
        'upstream and is converted to a percentage here, once.',
      url: 'https://explorer.pancakeswap.com/api/cached/pools/list?chains=bsc&protocols=v3',
    })
  } catch (error) {
    const reason = `The PancakeSwap Explorer could not be reached: ${
      error instanceof Error ? error.message : String(error)
    }. PancakeSwap venues are missing from this comparison, not absent from the chain.`
    warnings.push(reason)
    unreachableVenues.push({ venue: 'pancakeswap', reason })
  }

  // --- price ---------------------------------------------------------------
  const price = await priceUsdForSymbol({ client, chainId, symbol: asset, now })
  const venusMarket = venusMarkets[0]
  const decimals = venusMarket?.underlyingDecimals ?? 18
  const amountAtomic = parseUnits(input.amount, decimals)
  const amountUnits = Number(amountAtomic) / 10 ** decimals
  const amountUsd = price.usd === null ? (venusMarket ? amountUnits * venusMarket.priceUsd : null) : amountUnits * price.usd

  // --- the mandate ---------------------------------------------------------
  // The older `minTvlUsd` / `includeIlRisk` flags map onto the mandate so
  // existing callers keep working, but the mandate is what the allocator
  // actually consults.
  const legacy: MandateInput = {
    ...(input.minTvlUsd === undefined ? {} : { minTvlUsd: input.minTvlUsd }),
    ...(input.includeIlRisk === true ? { maxIlRisk: 'yes' as const } : {}),
  }
  const mandate: ResolvedMandate = resolveMandate({ ...legacy, ...(input.mandate ?? {}) })
  sources.push({ kind: 'config', label: 'Mandate', detail: mandate.note })

  const checks: Reconciliation[] = []
  const venues: Venue[] = []


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
            // Stated as it is actually computed. It used to say "x N blocks"
            // beside a compounded figure, so a reviewer checking the
            // arithmetic found 2.7954% where the output said 2.8349% — the
            // value was defensible and the derivation printed next to it was
            // not, which is worse than either alone.
            source:
              `(1 + supplyRatePerBlock/1e18)^${blockRate.blocksPerYear} - 1, compounded per block`,
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
      outlier: llamaVenus?.outlier === true,
      exposure: llamaVenus?.exposure ?? 'single',
      violations: [],
      eligible: true,
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
    const kind = classify(pool.project)
    // Nothing is dropped here any more. Every candidate is built, then judged
    // against the mandate, so an excluded venue can be reported with the rule
    // that excluded it rather than vanishing from the comparison.

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
      outlier: pool.outlier === true,
      exposure: pool.exposure,
      violations: [],
      eligible: true,
      shareOfDepositsPct:
        amountUsd === null || pool.tvlUsd <= 0 ? null : (amountUsd / pool.tvlUsd) * 100,
      caveats,
      onchain: null,
      llamaPoolId: pool.pool,
    })
  }

  // --- PancakeSwap, from its own Explorer ----------------------------------
  // Deduped against DeFiLlama by pair: where both describe the same pool the
  // first-party figure wins, and a material disagreement between the two is
  // carried as a caveat rather than resolved silently.
  const STABLES = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI', 'TUSD', 'USD1'])
  const pancakeByTvl = [...pancakePools].sort((a, b) => b.tvlUsd - a.tvlUsd).slice(0, 10)

  for (const pool of pancakeByTvl) {
    const pair = `${pool.token0Symbol}-${pool.token1Symbol}`
    const bothStable =
      STABLES.has(pool.token0Symbol.toUpperCase()) && STABLES.has(pool.token1Symbol.toUpperCase())

    const caveats: string[] = []
    if (!bothStable) {
      caveats.push(
        `${pair} pairs ${asset} against a volatile asset, so its quoted APR is fee income ` +
          'against divergence risk, not a return.',
      )
    }
    caveats.push(
      `APR is the Explorer's trailing 24h figure for pool ${pool.id}, annualised from one day of ` +
        'volume. A quiet day and a busy day give very different numbers.',
    )

    // The same pair, as DeFiLlama sees it. A large gap is worth stating.
    const llamaTwin = llamaPools.find(
      (entry) =>
        entry.project.toLowerCase().includes('pancake') &&
        entry.symbol.toUpperCase().split(/[-/]/).sort().join('-') ===
          [pool.token0Symbol.toUpperCase(), pool.token1Symbol.toUpperCase()].sort().join('-'),
    )
    if (llamaTwin && llamaTwin.tvlUsd > 0 && pool.tvlUsd > 0) {
      const ratio = Math.max(llamaTwin.tvlUsd, pool.tvlUsd) / Math.min(llamaTwin.tvlUsd, pool.tvlUsd)
      if (ratio > 1.5) {
        caveats.push(
          `DeFiLlama puts this pair's TVL at $${Math.round(llamaTwin.tvlUsd).toLocaleString('en-US')} ` +
            `against the Explorer's $${Math.round(pool.tvlUsd).toLocaleString('en-US')}. The two ` +
            'do not agree; the first-party figure is used and the gap is reported rather than ' +
            'averaged away.',
        )
      }
    }

    venues.push({
      name: `pancakeswap-${pool.protocol} ${pair}`,
      project: `pancakeswap-${pool.protocol}`,
      kind: 'lp',
      apyPct: pool.apr24hPct,
      apyBasePct: pool.apr24hPct,
      apyRewardPct: null,
      depositsUsd: pool.tvlUsd,
      availableLiquidityUsd: pool.tvlUsd,
      depthSource: 'pancake-explorer',
      stablecoin: bothStable,
      // A stable-stable pool still has divergence risk on a depeg, but not the
      // directional exposure a volatile pair carries. Graded the way
      // DeFiLlama grades the equivalent pools, so the mandate rule means the
      // same thing across sources.
      ilRisk: bothStable ? 'no' : 'yes',
      outlier: false,
      exposure: 'multi',
      violations: [],
      eligible: true,
      shareOfDepositsPct:
        amountUsd === null || pool.tvlUsd <= 0 ? null : (amountUsd / pool.tvlUsd) * 100,
      caveats,
      onchain: null,
      llamaPoolId: llamaTwin?.pool ?? null,
    })
  }

  // Llama's PancakeSwap rows are superseded by the first-party ones above.
  const supersededPancake = venues.filter(
    (venue) => venue.depthSource === 'defillama' && venue.project.toLowerCase().includes('pancake'),
  )
  if (supersededPancake.length > 0 && pancakeByTvl.length > 0) {
    for (const venue of supersededPancake) venues.splice(venues.indexOf(venue), 1)
    warnings.push(
      `${supersededPancake.length} PancakeSwap venue(s) from DeFiLlama were replaced by the ` +
        "Explorer's own figures, which cover v3 as well as v2 and are first-party.",
    )
  }

  venues.sort((a, b) => (b.apyPct ?? -1) - (a.apyPct ?? -1))

  // --- judge every candidate against the mandate ---------------------------
  for (const venue of venues) {
    venue.violations = violations(
      {
        name: venue.name,
        ilRisk: venue.ilRisk,
        stablecoin: venue.stablecoin,
        outlier: venue.outlier,
        depthUsd: venue.depositsUsd ?? venue.availableLiquidityUsd,
        onchainVerifiable: venue.onchain !== null,
        apyPct: venue.apyPct,
      },
      mandate.applied,
    )
    venue.eligible = venue.violations.length === 0
  }

  // A venue the mandate names but nothing could source is a stated hole, not
  // an absence. Checked against everything considered, eligible or not.
  for (const named of mandate.applied.venues) {
    const needle = named.toLowerCase()
    const found = venues.some(
      (venue) =>
        venue.name.toLowerCase().includes(needle) || venue.project.toLowerCase().includes(needle),
    )
    if (!found && !unreachableVenues.some((entry) => entry.venue === named)) {
      unreachableVenues.push({
        venue: named,
        reason:
          `The mandate names "${named}", but no source this agent reads lists it holding ` +
          `${asset} on BNB Chain. It is absent from this comparison, which is not the same as ` +
          'having scored badly in it.',
      })
    }
  }

  const topRankedOverall = venues[0] ?? null
  const eligible = venues.filter((venue) => venue.eligible)
  const excluded = venues
    .filter((venue) => !venue.eligible)
    .map((venue) => ({ venue: venue.name, apyPct: venue.apyPct, violations: venue.violations }))

  // The venue an APR sort would have chosen, when the mandate forbids it.
  // Reported prominently: silently substituting second place is how a caller
  // ends up believing the top of the list was safe.
  const excludedTop =
    topRankedOverall !== null && !topRankedOverall.eligible
      ? {
          venue: topRankedOverall.name,
          apyPct: topRankedOverall.apyPct,
          violations: topRankedOverall.violations,
        }
      : null

  const assertions: Assertion[] = [
    assertion(
      'At least one venue satisfies the mandate',
      eligible.length > 0,
      `${eligible.length} of ${venues.length} venue(s) holding ${asset} satisfy the mandate.`,
    ),
    assertion(
      'Every quoted APY is plausible',
      venues.every((venue) => venue.apyPct === null || (venue.apyPct >= 0 && venue.apyPct < 1_000)),
      'An APY below zero or above 1000% is a data error, not an opportunity.',
    ),
    assertion(
      'Nothing ineligible reached the allocation',
      eligible.every((venue) => venue.violations.length === 0),
      'A venue in the allocation with an unmet mandate rule would make the mandate decorative.',
    ),
  ]

  const best = eligible[0] ?? null
  const current = venues.find((venue) => venue.project === 'venus-core-pool') ?? null

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

  // --- risks: never an empty list -----------------------------------------
  // An empty array reads as "we checked and there are none". If there is no
  // allocation to carry risk, or no data to judge it from, that is `null` with
  // a reason — a different and far safer statement.
  let risks: string[] | null = null
  let risksUnknownReason: string | null = null

  if (best === null) {
    risksUnknownReason =
      eligible.length === 0
        ? 'No venue satisfied the mandate, so there is no allocation whose risks could be ' +
          'enumerated. The rule that excluded each candidate is listed under `excluded`.'
        : 'No venue was selected, so there is nothing to enumerate risks for.'
  } else {
    const found: string[] = [...best.caveats]

    if (best.shareOfDepositsPct != null && best.shareOfDepositsPct > 5) {
      found.push(
        `This allocation would be ${best.shareOfDepositsPct.toFixed(1)}% of the venue. Entering ` +
          'and leaving at that size moves the rate you are entering for.',
      )
    }
    if (price.usd === null) found.push(price.detail)
    if (excludedTop !== null) {
      found.push(
        `${excludedTop.venue} quotes a higher ${excludedTop.apyPct?.toFixed(2) ?? '-'}% but was ` +
          `excluded: ${excludedTop.violations.map((entry) => entry.detail).join(' ')} The ` +
          'allocation below is the best venue that satisfies the mandate, not the best rate ' +
          'available.',
      )
    }

    // Provenance always applies, so the list is never empty by construction.
    found.push(
      best.depthSource === 'onchain'
        ? `Depth for ${best.name} is read on-chain, and its APR comes from the market's own ` +
          'per-block rate cross-checked against DeFiLlama.'
        : `Depth and APR for ${best.name} come from DeFiLlama alone — this agent cannot read ` +
          'that venue on-chain, so there is no second source for either number.',
    )
    if (!mandate.specified) {
      found.push(
        'No mandate was supplied, so the conservative default was applied. A different ' +
          'constraint would very likely produce a different allocation.',
      )
    }

    risks = found
  }

  // --- the allocation, spread to the mandate's concentration limit ---------
  const spread = spreadAllocation(eligible, mandate.applied.maxSingleVenuePct)
  const allocation =
    best === null
      ? []
      : spread.splits.map((split) => {
          const venue = eligible.find((entry) => entry.name === split.venue)!
          return {
            venue: split.venue,
            sharePct: split.sharePct,
            amountUsd: amountUsd === null ? null : (amountUsd * split.sharePct) / 100,
            why:
              `${venue.apyPct?.toFixed(2) ?? '-'}% APY, satisfies every mandate rule, and ` +
              `${split.sharePct}% respects the ${mandate.applied.maxSingleVenuePct}% ` +
              'single-venue limit.',
          }
        })

  if (spread.unplacedPct > 0 && best !== null) {
    warnings.push(
      `${spread.unplacedPct}% of the allocation has nowhere to go: only ${eligible.length} ` +
        'venue(s) satisfy the mandate and none may hold more than ' +
        `${mandate.applied.maxSingleVenuePct}%. Widen the mandate or leave the remainder where ` +
        'it is — it is not being quietly concentrated.',
    )
  }

  const action: 'allocate' | 'refuse' = best === null ? 'refuse' : 'allocate'
  const reason =
    best === null
      ? `No venue holding ${asset} satisfies the mandate. ${venues.length} were considered and ` +
        `all ${excluded.length} were excluded, each with the rule that excluded it. Refusing to ` +
        'allocate is the answer here; the alternative is recommending something the mandate ' +
        'forbids.'
      : `${best.name} at ${best.apyPct?.toFixed(2) ?? '-'}% is the highest-yielding venue that ` +
        'satisfies the mandate' +
        (excludedTop === null
          ? ', and the highest-yielding overall.'
          : `. ${excludedTop.venue} yields more at ${excludedTop.apyPct?.toFixed(2) ?? '-'}% but ` +
            'breaks the mandate, so it was excluded rather than recommended with a caveat.')

  const decision: YieldDecision = {
    asset,
    amount: input.amount,
    amountUsd,
    action,
    reason,
    mandate: { applied: mandate.applied, specified: mandate.specified, note: mandate.note },
    best,
    topRankedOverall,
    excludedTop,
    current,
    allocation,
    venues: eligible,
    excluded,
    unreachableVenues,
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
    risksUnknownReason,
    checks,
    assertions,
    checksPass,
  }

  const lines = [
    `${asset} on BNB Chain: ${venues.length} venue(s) considered, ${eligible.length} satisfy the mandate.`,
    mandate.note,
    reason,
    ...(best === null
      ? []
      : [
          `Allocation: ${allocation.map((entry) => `${entry.sharePct}% ${entry.venue}`).join(', ')}.`,
          `${best.depositsUsd === null ? 'Depth unknown' : `$${(best.depositsUsd / 1e6).toFixed(1)}M deposited`}` +
            `${best.availableLiquidityUsd === null ? '' : `, $${(best.availableLiquidityUsd / 1e6).toFixed(1)}M withdrawable right now`}.`,
          decision.breakEven.detail,
        ]),
    ...unreachableVenues.map((entry) => `Unreachable: ${entry.venue} — ${entry.reason}`),
    ...excluded.map(
      (entry) =>
        `Excluded ${entry.venue} (${entry.apyPct?.toFixed(2) ?? '-'}%): ` +
        entry.violations.map((violation) => violation.rule).join(', '),
    ),
    ...(risks === null
      ? [`Risks: not determined - ${risksUnknownReason}`]
      : risks.map((risk) => `Risk: ${risk}`)),
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
