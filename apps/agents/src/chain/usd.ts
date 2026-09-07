import type { PublicClient } from 'viem'
import type { SupportedChainId } from '@hallmark/core'

import { readChainlinkPrice, type ChainlinkPair, type PriceRead } from './prices.js'
import type { TokenMeta } from './tokens.js'

/**
 * Turning token amounts into dollars, without inventing any.
 *
 * Four assets have a Chainlink feed on BNB Chain; the major stablecoins are
 * taken at par with a stated caveat; and a pair's own pool price bridges the
 * gap when exactly one side is known. Anything left over comes back `null`,
 * and every caller here renders `null` as "unknown" rather than zero — a
 * missing price that reads as $0 turns "we could not value this" into "this is
 * worthless", which is a far worse thing to show someone.
 */

const FEED_BY_SYMBOL: Readonly<Record<string, ChainlinkPair>> = Object.freeze({
  BNB: 'bnbUsd',
  WBNB: 'bnbUsd',
  BTC: 'btcUsd',
  BTCB: 'btcUsd',
  WBTC: 'btcUsd',
  ETH: 'ethUsd',
  WETH: 'ethUsd',
  CAKE: 'cakeUsd',
})

/** Taken at $1, and said so. A depeg is exactly when that is wrong. */
const PAR_STABLES = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD', 'DAI', 'TUSD', 'USD1'])

export type UsdPrice = {
  symbol: string
  usd: number | null
  source: 'chainlink' | 'par' | 'pool-derived' | 'unknown'
  detail: string
  /** The underlying feed read, when there was one, so staleness is visible. */
  feed?: PriceRead
}

export async function priceUsdForSymbol(args: {
  client: PublicClient
  chainId: SupportedChainId
  symbol: string
  now: number
}): Promise<UsdPrice> {
  const symbol = args.symbol.toUpperCase()

  const pair = FEED_BY_SYMBOL[symbol]
  if (pair) {
    const feed = await readChainlinkPrice({
      client: args.client,
      chainId: args.chainId,
      pair,
      now: args.now,
    })
    if (feed.ok) {
      return {
        symbol,
        usd: feed.priceUsd,
        source: 'chainlink',
        detail: `Chainlink ${feed.pair} at ${feed.feed}, ${feed.ageSeconds}s old`,
        feed,
      }
    }
    return {
      symbol,
      usd: null,
      source: 'unknown',
      detail: `Chainlink ${feed.pair} rejected: ${feed.detail}`,
      feed,
    }
  }

  if (PAR_STABLES.has(symbol)) {
    return {
      symbol,
      usd: 1,
      source: 'par',
      detail: `${symbol} taken at $1.00. There is no Chainlink feed for it on this chain, so a depeg would not be visible here.`,
    }
  }

  return {
    symbol,
    usd: null,
    source: 'unknown',
    detail: `No USD price source for ${symbol}: no Chainlink feed on BNB Chain and not a recognised stablecoin.`,
  }
}

export type PairUsd = {
  token0: UsdPrice
  token1: UsdPrice
  /** Notes about how a price was reached, for the analysis' `warnings`. */
  notes: string[]
}

/**
 * Price both sides of a pool.
 *
 * When one side has no source but the other does, the pool's own price fills
 * it in: `price` is whole token1 per whole token0, so token0 in dollars is
 * `price × token1Usd`. That is a market price from one venue, not an oracle,
 * and it is labelled as such.
 */
export async function priceBothSides(args: {
  client: PublicClient
  chainId: SupportedChainId
  token0: TokenMeta
  token1: TokenMeta
  /** Whole token1 per whole token0. */
  poolPrice: number
  now: number
}): Promise<PairUsd> {
  const notes: string[] = []
  let token0 = await priceUsdForSymbol({ ...args, symbol: args.token0.symbol })
  let token1 = await priceUsdForSymbol({ ...args, symbol: args.token1.symbol })

  if (token0.usd === null && token1.usd !== null && args.poolPrice > 0) {
    token0 = {
      symbol: args.token0.symbol,
      usd: args.poolPrice * token1.usd,
      source: 'pool-derived',
      detail: `Derived from this pool's own price (${args.poolPrice} ${args.token1.symbol} per ${args.token0.symbol}) and ${token1.detail}. A single venue's mid, not an oracle.`,
    }
    notes.push(
      `${args.token0.symbol} has no price feed; its USD value comes from this pool's own price.`,
    )
  } else if (token1.usd === null && token0.usd !== null && args.poolPrice > 0) {
    token1 = {
      symbol: args.token1.symbol,
      usd: token0.usd / args.poolPrice,
      source: 'pool-derived',
      detail: `Derived from this pool's own price and ${token0.detail}. A single venue's mid, not an oracle.`,
    }
    notes.push(
      `${args.token1.symbol} has no price feed; its USD value comes from this pool's own price.`,
    )
  }

  if (token0.usd === null && token1.usd === null) {
    notes.push(
      'Neither side of this pair has a USD price source, so every dollar figure below is null rather than estimated.',
    )
  }
  for (const price of [token0, token1]) {
    if (price.source === 'par') notes.push(price.detail)
    if (price.source === 'unknown' && price.feed && !price.feed.ok) notes.push(price.detail)
  }

  return { token0, token1, notes }
}

export function valueUsd(
  amount: bigint,
  decimals: number,
  priceUsd: number | null,
): number | null {
  if (priceUsd === null) return null
  return (Number(amount) / 10 ** decimals) * priceUsd
}
