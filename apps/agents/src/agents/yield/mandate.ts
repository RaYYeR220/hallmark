/**
 * The constraint the allocator is actually working under.
 *
 * This module exists because of a measured failure. Asked for "100,000 USDT,
 * withdrawable, no directional exposure", the agent returned 100% into a
 * single venue at the top of an APR sort with `risks: []` — an empty array —
 * and, with LP venues enabled, picked a pool DeFiLlama itself flags as an
 * outlier with impermanent-loss risk and multi-asset exposure. The mandate was
 * stated in the request and the allocator had nowhere to put it.
 *
 * So the constraint is a first-class input, evaluated per venue, and a venue
 * that violates it is *excluded* rather than ranked-and-caveated. Prose is not
 * a safety mechanism: a caller integrates the allocation, not the paragraph
 * underneath it.
 *
 * Two rules follow from that and are enforced here rather than left to taste.
 *
 * **Never report `risks: []`.** An empty list reads as "we checked and there
 * are none", which is the most dangerous sentence this agent can produce. The
 * decision carries `risks: string[] | null`, and `null` — with a reason — is
 * what "we could not determine" looks like.
 *
 * **Default conservatively, and say so.** A caller who supplies no mandate
 * gets the cautious one, and the output names which default was applied rather
 * than silently maximising APR.
 */

export type Mandate = {
  /**
   * Highest impermanent-loss risk tolerated, as DeFiLlama grades it.
   * `no` excludes anything with divergence risk — the honest reading of
   * "no directional exposure".
   */
  maxIlRisk: 'no' | 'yes'
  /** Only venues DeFiLlama marks as stablecoin. */
  stablecoinOnly: boolean
  /** Allow pools carrying DeFiLlama's own APY outlier flag. */
  allowOutliers: boolean
  /** Ignore venues shallower than this. */
  minTvlUsd: number
  /** Never put more than this share of the allocation in one venue. */
  maxSingleVenuePct: number
  /**
   * Only venues whose rate this service can read on-chain itself.
   *
   * The strongest filter available: it excludes anything whose APR we would be
   * repeating from a third party without a second source. Off by default —
   * it would exclude every venue but Venus — but the right switch for a
   * mandate that says "verifiable".
   */
  requireOnchainVerifiable: boolean
}

/**
 * What a caller gets when they say nothing.
 *
 * Conservative on purpose: no divergence risk, no outliers, no more than half
 * in one venue, and a depth floor that keeps an allocation from being most of
 * a pool. A user who wants the aggressive version has to ask for it.
 */
export const CONSERVATIVE_MANDATE: Mandate = {
  maxIlRisk: 'no',
  stablecoinOnly: false,
  allowOutliers: false,
  minTvlUsd: 1_000_000,
  maxSingleVenuePct: 50,
  requireOnchainVerifiable: false,
}

export type MandateInput = Partial<Mandate>

export type ResolvedMandate = {
  applied: Mandate
  /** Which fields the caller set, and which fell back to the default. */
  source: Record<keyof Mandate, 'caller' | 'default'>
  specified: boolean
  note: string
}

export function resolveMandate(input: MandateInput = {}): ResolvedMandate {
  const keys = Object.keys(CONSERVATIVE_MANDATE) as Array<keyof Mandate>
  const applied = { ...CONSERVATIVE_MANDATE }
  const source = {} as Record<keyof Mandate, 'caller' | 'default'>

  for (const key of keys) {
    const supplied = input[key]
    if (supplied === undefined) {
      source[key] = 'default'
    } else {
      source[key] = 'caller'
      // Each field is assigned individually so the union stays sound.
      ;(applied as Record<string, unknown>)[key] = supplied
    }
  }

  const fromCaller = keys.filter((key) => source[key] === 'caller')
  const defaulted = keys.filter((key) => source[key] === 'default')

  return {
    applied,
    source,
    specified: fromCaller.length > 0,
    note:
      fromCaller.length === 0
        ? 'No mandate was supplied, so the conservative default was applied: no ' +
          'impermanent-loss risk, no DeFiLlama outliers, at least $1,000,000 of depth, and no ' +
          'more than 50% in any one venue. Ranking on APR alone is not a default this agent ' +
          'will fall back to.'
        : `Mandate set by the caller for ${fromCaller.join(', ')}` +
          (defaulted.length === 0
            ? '.'
            : `; ${defaulted.join(', ')} fell back to the conservative default.`),
  }
}

/** Enough of a venue to judge it against a mandate. */
export type MandateSubject = {
  name: string
  ilRisk: string
  stablecoin: boolean
  outlier: boolean
  /** Depth in dollars — deposits where we know them, available liquidity otherwise. */
  depthUsd: number | null
  onchainVerifiable: boolean
  apyPct: number | null
}

export type Violation = {
  rule: keyof Mandate | 'implausible-apy'
  detail: string
}

/**
 * Judge one venue. An empty list means it passed every rule, which is a
 * different and much safer statement than "we found no risks".
 */
export function violations(venue: MandateSubject, mandate: Mandate): Violation[] {
  const found: Violation[] = []

  if (mandate.maxIlRisk === 'no' && venue.ilRisk === 'yes') {
    found.push({
      rule: 'maxIlRisk',
      detail:
        `${venue.name} carries impermanent-loss risk, which the mandate forbids. Its quoted APR ` +
        'is fee income, not a return: a divergent pair can lose more than it earns.',
    })
  }

  if (mandate.stablecoinOnly && !venue.stablecoin) {
    found.push({
      rule: 'stablecoinOnly',
      detail: `${venue.name} is not a stablecoin venue, and the mandate is stablecoin-only.`,
    })
  }

  if (!mandate.allowOutliers && venue.outlier) {
    found.push({
      rule: 'allowOutliers',
      detail:
        `DeFiLlama flags ${venue.name}'s own APY as an outlier. Its own data provider does not ` +
        'stand behind the number, so neither does this agent.',
    })
  }

  if (venue.depthUsd === null) {
    found.push({
      rule: 'minTvlUsd',
      detail:
        `${venue.name} reports no depth this agent could read, so it cannot be shown to clear ` +
        `the $${mandate.minTvlUsd.toLocaleString('en-US')} floor. Unknown depth is not depth.`,
    })
  } else if (venue.depthUsd < mandate.minTvlUsd) {
    found.push({
      rule: 'minTvlUsd',
      detail:
        `${venue.name} holds $${venue.depthUsd.toLocaleString('en-US')}, below the ` +
        `$${mandate.minTvlUsd.toLocaleString('en-US')} the mandate requires.`,
    })
  }

  if (mandate.requireOnchainVerifiable && !venue.onchainVerifiable) {
    found.push({
      rule: 'requireOnchainVerifiable',
      detail:
        `${venue.name}'s rate cannot be read on-chain by this agent, so it would be repeated ` +
        'from a single third party with no second source. The mandate requires verifiable rates.',
    })
  }

  if (venue.apyPct === null || venue.apyPct < 0 || venue.apyPct >= 1_000) {
    found.push({
      rule: 'implausible-apy',
      detail:
        `${venue.name} quotes ${venue.apyPct === null ? 'no APY' : `${venue.apyPct}%`}, which is ` +
        'a data error rather than an opportunity.',
    })
  }

  return found
}

/**
 * Split an allocation so no venue exceeds the mandate's concentration limit.
 *
 * Venues come in ranked order. Each takes up to the cap until the allocation
 * is spent; if the eligible set is too small to absorb it within the limit,
 * the shortfall is reported rather than quietly over-concentrated.
 */
export function spreadAllocation(
  ranked: readonly { name: string; apyPct: number | null }[],
  maxSingleVenuePct: number,
): { splits: Array<{ venue: string; sharePct: number }>; unplacedPct: number } {
  const cap = Math.max(1, Math.min(100, maxSingleVenuePct))
  const splits: Array<{ venue: string; sharePct: number }> = []
  let remaining = 100

  for (const venue of ranked) {
    if (remaining <= 0) break
    const share = Math.min(cap, remaining)
    splits.push({ venue: venue.name, sharePct: share })
    remaining -= share
  }

  return { splits, unplacedPct: Math.max(0, remaining) }
}
