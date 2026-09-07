import { chainlinkAggregatorAbi, getChain, type SupportedChainId } from '@hallmark/core'
import type { Address, PublicClient } from 'viem'

/**
 * Chainlink reads, written to fail closed.
 *
 * A price feed is the one input where "probably fine" is not good enough: an
 * agent that repays a loan against a stale number can turn a healthy position
 * into a liquidated one. So every read here is checked before it is believed,
 * and a failed check is a *refusal to answer*, never a fallback value.
 *
 * Three checks, each for a failure we can name:
 *
 *   - `decimals() == 8`. Some BNB Chain pairs have a second, 18-decimal "SVR"
 *     aggregator at a different address. Reading one as if it were the
 *     standard feed is a factor of 10^10, and the number still looks like a
 *     number. Asserting the scale is cheaper than discovering it.
 *   - freshness. `updatedAt` older than the heartbeat means the feed stopped,
 *     and the last answer is a historical fact, not a price.
 *   - sanity. A non-positive answer, or `answeredInRound < roundId`, means the
 *     round did not complete.
 */

export type PriceOk = {
  ok: true
  pair: string
  feed: Address
  /** The raw aggregator answer. */
  answer: bigint
  decimals: number
  priceUsd: number
  updatedAt: number
  ageSeconds: number
  roundId: string
}

export type PriceFailure = {
  ok: false
  pair: string
  feed: Address
  reason: 'stale' | 'bad-decimals' | 'non-positive' | 'incomplete-round' | 'read-failed'
  detail: string
  /** Present when the read itself worked and only the checks failed. */
  observed?: { answer: string; decimals: number; updatedAt: number; ageSeconds: number }
}

export type PriceRead = PriceOk | PriceFailure

/** The scale every standard Chainlink USD feed reports in. */
export const EXPECTED_FEED_DECIMALS = 8

/**
 * How old an answer may be before this service stops trusting it.
 *
 * BNB Chain USD feeds update on a deviation threshold with a heartbeat far
 * under an hour, so an hour-old answer is already anomalous rather than
 * merely quiet. Callers that need a tighter bound pass one.
 */
export const DEFAULT_MAX_AGE_SECONDS = 3_600

export type ChainlinkPair = 'bnbUsd' | 'btcUsd' | 'ethUsd' | 'cakeUsd'

const PAIR_LABEL: Record<ChainlinkPair, string> = {
  bnbUsd: 'BNB/USD',
  btcUsd: 'BTC/USD',
  ethUsd: 'ETH/USD',
  cakeUsd: 'CAKE/USD',
}

export function feedAddress(chainId: SupportedChainId, pair: ChainlinkPair): Address {
  return getChain(chainId).chainlink[pair]
}

export async function readChainlinkPrice(args: {
  client: PublicClient
  chainId: SupportedChainId
  pair: ChainlinkPair
  now: number
  maxAgeSeconds?: number
}): Promise<PriceRead> {
  const feed = feedAddress(args.chainId, args.pair)
  const pair = PAIR_LABEL[args.pair]
  const maxAge = args.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS

  let round: readonly [bigint, bigint, bigint, bigint, bigint]
  let decimals: number
  try {
    const [roundResult, decimalsResult] = await Promise.all([
      args.client.readContract({
        address: feed,
        abi: chainlinkAggregatorAbi,
        functionName: 'latestRoundData',
      }),
      args.client.readContract({
        address: feed,
        abi: chainlinkAggregatorAbi,
        functionName: 'decimals',
      }),
    ])
    round = roundResult as readonly [bigint, bigint, bigint, bigint, bigint]
    decimals = Number(decimalsResult)
  } catch (error) {
    return {
      ok: false,
      pair,
      feed,
      reason: 'read-failed',
      detail: `Could not read ${pair} at ${feed}: ${
        error instanceof Error ? error.message : String(error)
      }. Refusing to act on a price we could not fetch.`,
    }
  }

  const [roundId, answer, , updatedAtRaw, answeredInRound] = round
  const updatedAt = Number(updatedAtRaw)
  const ageSeconds = args.now - updatedAt
  const observed = { answer: answer.toString(), decimals, updatedAt, ageSeconds }

  if (decimals !== EXPECTED_FEED_DECIMALS) {
    return {
      ok: false,
      pair,
      feed,
      reason: 'bad-decimals',
      detail:
        `${pair} at ${feed} reports ${decimals} decimals, not ${EXPECTED_FEED_DECIMALS}. ` +
        'Some BNB Chain pairs publish a second 18-decimal SVR aggregator at a different ' +
        'address; reading one as the standard feed is off by ten orders of magnitude. ' +
        'Refusing to use it.',
      observed,
    }
  }

  if (answer <= 0n) {
    return {
      ok: false,
      pair,
      feed,
      reason: 'non-positive',
      detail: `${pair} answered ${answer}, which is not a price. Refusing to act on it.`,
      observed,
    }
  }

  if (answeredInRound < roundId) {
    return {
      ok: false,
      pair,
      feed,
      reason: 'incomplete-round',
      detail:
        `${pair} round ${roundId} was answered in round ${answeredInRound}: the round did ` +
        'not complete, so the answer is carried over rather than fresh.',
      observed,
    }
  }

  if (ageSeconds > maxAge) {
    return {
      ok: false,
      pair,
      feed,
      reason: 'stale',
      detail:
        `${pair} was last updated ${new Date(updatedAt * 1000).toISOString()}, ` +
        `${Math.round(ageSeconds / 60)} minutes ago, past the ${Math.round(maxAge / 60)}-minute ` +
        'bound this service will act on. The feed is not reporting; refusing to act rather ' +
        'than guessing a price.',
      observed,
    }
  }

  // Negative ages happen when the node's clock is behind the block timestamp.
  // Small ones are noise; large ones mean the clock is wrong, and acting on a
  // price from the future is no better than acting on a stale one.
  if (ageSeconds < -300) {
    return {
      ok: false,
      pair,
      feed,
      reason: 'stale',
      detail:
        `${pair} reports an update ${Math.abs(Math.round(ageSeconds))} seconds in the future. ` +
        'The clock this service is using disagrees with the chain; refusing to act until ' +
        'they agree.',
      observed,
    }
  }

  return {
    ok: true,
    pair,
    feed,
    answer,
    decimals,
    priceUsd: Number(answer) / 10 ** decimals,
    updatedAt,
    ageSeconds,
    roundId: roundId.toString(),
  }
}

/**
 * Compare an independent feed against a protocol's own oracle.
 *
 * Venus liquidates against its own oracle, so that is the number the health
 * agent computes with. Chainlink is the second opinion: if the two disagree
 * by more than `toleranceBps`, something is wrong with one of them and this
 * is not the moment to move money.
 */
export function crossCheck(args: {
  label: string
  independentUsd: number
  protocolUsd: number
  toleranceBps: number
}): { agrees: true; deviationBps: number } | { agrees: false; deviationBps: number; detail: string } {
  const { independentUsd, protocolUsd, toleranceBps } = args
  if (!(protocolUsd > 0) || !(independentUsd > 0)) {
    return {
      agrees: false,
      deviationBps: Number.POSITIVE_INFINITY,
      detail: `${args.label}: one of the two prices is not positive (independent ${independentUsd}, protocol ${protocolUsd}).`,
    }
  }
  const deviationBps = (Math.abs(independentUsd - protocolUsd) / protocolUsd) * 10_000
  if (deviationBps <= toleranceBps) return { agrees: true, deviationBps }
  return {
    agrees: false,
    deviationBps,
    detail:
      `${args.label}: Chainlink says $${independentUsd.toFixed(4)}, the protocol oracle says ` +
      `$${protocolUsd.toFixed(4)} — ${deviationBps.toFixed(0)} bps apart, past the ` +
      `${toleranceBps} bps this service will act across. One of the two is wrong and we ` +
      'cannot tell which, so nothing is sent.',
  }
}
