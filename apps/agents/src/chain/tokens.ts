import { erc20Abi } from '@hallmark/core'
import { formatUnits, type Address, type PublicClient } from 'viem'

/**
 * ERC-20 metadata, read defensively.
 *
 * On BNB Chain a "token" is whatever answers at an address. Plenty return
 * bytes32 for `symbol`, revert on `name`, or implement nothing at all. Every
 * field here is optional in practice, so a read that fails degrades to a
 * marker the caller can see rather than an exception three layers up.
 */

export type TokenMeta = {
  address: Address
  symbol: string
  name: string
  decimals: number
  totalSupply: bigint | null
  /** Fields that could not be read, so a report can say so instead of guessing. */
  unreadable: string[]
}

const cache = new Map<string, TokenMeta>()

export async function readTokenMeta(
  client: PublicClient,
  address: Address,
  opts: { cache?: boolean } = {},
): Promise<TokenMeta> {
  const key = `${client.chain?.id ?? 0}:${address.toLowerCase()}`
  if (opts.cache !== false) {
    const hit = cache.get(key)
    if (hit) return hit
  }

  const [symbol, name, decimals, totalSupply] = await Promise.all([
    client
      .readContract({ address, abi: erc20Abi, functionName: 'symbol' })
      .then((value) => String(value))
      .catch(() => null),
    client
      .readContract({ address, abi: erc20Abi, functionName: 'name' })
      .then((value) => String(value))
      .catch(() => null),
    client
      .readContract({ address, abi: erc20Abi, functionName: 'decimals' })
      .then((value) => Number(value))
      .catch(() => null),
    client
      .readContract({ address, abi: erc20Abi, functionName: 'totalSupply' })
      .then((value) => value as bigint)
      .catch(() => null),
  ])

  const unreadable: string[] = []
  if (symbol === null) unreadable.push('symbol')
  if (name === null) unreadable.push('name')
  if (decimals === null) unreadable.push('decimals')
  if (totalSupply === null) unreadable.push('totalSupply')

  const meta: TokenMeta = {
    address,
    symbol: symbol ?? `${address.slice(0, 6)}…${address.slice(-4)}`,
    name: name ?? 'unknown',
    // 18 is BNB Chain's near-universal default. Recorded in `unreadable` so a
    // caller can refuse rather than compute against an assumption.
    decimals: decimals ?? 18,
    totalSupply,
    unreadable,
  }

  if (opts.cache !== false) cache.set(key, meta)
  return meta
}

export function formatToken(amount: bigint, meta: Pick<TokenMeta, 'decimals' | 'symbol'>): string {
  return `${trimZeros(formatUnits(amount, meta.decimals))} ${meta.symbol}`
}

function trimZeros(value: string): string {
  if (!value.includes('.')) return value
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '')
  return trimmed === '' ? '0' : trimmed
}

/** Round a formatted amount to a sane number of significant places for copy. */
export function formatTokenShort(
  amount: bigint,
  meta: Pick<TokenMeta, 'decimals' | 'symbol'>,
  places = 6,
): string {
  const value = Number(formatUnits(amount, meta.decimals))
  if (!Number.isFinite(value)) return formatToken(amount, meta)
  const rounded =
    Math.abs(value) >= 1 ? value.toFixed(Math.min(places, 4)) : value.toPrecision(places)
  return `${trimZeros(rounded)} ${meta.symbol}`
}

export function resetTokenCache(): void {
  cache.clear()
}
