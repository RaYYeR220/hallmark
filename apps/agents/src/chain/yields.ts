/**
 * Keyless yield data.
 *
 * Two public sources, both free and neither requiring a key:
 *
 *   - DeFiLlama `/pools` — every tracked pool on every chain, ~700 of them on
 *     BSC, with `apy`, `apyBase`, `apyReward`, `tvlUsd`, `ilRisk` and
 *     `stablecoin`. Large (several MB), so it is fetched once and cached.
 *   - PancakeSwap's explorer pool list — `apr24h` for v3 pools, as a *decimal*.
 *     0.0412 is 4.12%, and treating it as a percentage understates every
 *     PancakeSwap venue by a hundredfold, which quietly makes the router never
 *     choose one.
 *
 * Etherscan's V2 API is not used anywhere in this service: it answers
 * "Free API access is not supported for this chain" for BNB Chain, so anything
 * built on it would work in development and fail in the demo.
 */

export type LlamaPool = {
  chain: string
  project: string
  symbol: string
  pool: string
  tvlUsd: number
  apy: number | null
  apyBase: number | null
  apyReward: number | null
  stablecoin: boolean
  ilRisk: string
  exposure: string
  poolMeta: string | null
  underlyingTokens: string[] | null
  /** Llama's own outlier flag. Worth surfacing rather than filtering silently. */
  outlier?: boolean
}

export const LLAMA_POOLS_URL = 'https://yields.llama.fi/pools'
export const PANCAKE_EXPLORER_POOLS_URL =
  'https://explorer.pancakeswap.com/api/cached/pools/list?chains=bsc&protocols=v3'

type CacheEntry<T> = { at: number; value: T }
const CACHE_TTL_MS = 5 * 60 * 1000
let llamaCache: CacheEntry<LlamaPool[]> | null = null
let pancakeCache: CacheEntry<PancakePool[]> | null = null

export type FetchOptions = {
  fetchImpl?: typeof fetch
  now?: number
  /** Skip the cache. Tests, and any caller that needs a fresh read. */
  fresh?: boolean
  timeoutMs?: number
}

async function getJson(url: string, opts: FetchOptions): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000)
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function fetchBscLlamaPools(opts: FetchOptions = {}): Promise<LlamaPool[]> {
  const now = opts.now ?? Date.now()
  if (!opts.fresh && llamaCache && now - llamaCache.at < CACHE_TTL_MS) return llamaCache.value

  const payload = await getJson(LLAMA_POOLS_URL, opts)
  const rows = (payload as { data?: unknown }).data
  if (!Array.isArray(rows)) throw new Error('DeFiLlama /pools did not return a data array')

  const pools: LlamaPool[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const entry = row as Record<string, unknown>
    if (entry['chain'] !== 'BSC') continue
    pools.push({
      chain: 'BSC',
      project: String(entry['project'] ?? 'unknown'),
      symbol: String(entry['symbol'] ?? ''),
      pool: String(entry['pool'] ?? ''),
      tvlUsd: num(entry['tvlUsd']) ?? 0,
      apy: num(entry['apy']),
      apyBase: num(entry['apyBase']),
      apyReward: num(entry['apyReward']),
      stablecoin: entry['stablecoin'] === true,
      ilRisk: String(entry['ilRisk'] ?? 'unknown'),
      exposure: String(entry['exposure'] ?? 'unknown'),
      poolMeta: typeof entry['poolMeta'] === 'string' ? entry['poolMeta'] : null,
      underlyingTokens: Array.isArray(entry['underlyingTokens'])
        ? (entry['underlyingTokens'] as unknown[]).map(String)
        : null,
      ...(entry['outlier'] === true ? { outlier: true } : {}),
    })
  }

  llamaCache = { at: now, value: pools }
  return pools
}

export type PancakePool = {
  id: string
  token0Symbol: string
  token1Symbol: string
  feeTier: number | null
  tvlUsd: number
  /** Already converted to a percentage. */
  apr24hPct: number | null
  volumeUsd24h: number | null
}

/**
 * PancakeSwap's own pool list.
 *
 * `apr24h` arrives as a decimal fraction. It is multiplied by 100 here, once,
 * so nothing downstream has to remember.
 */
export async function fetchPancakeV3Pools(opts: FetchOptions = {}): Promise<PancakePool[]> {
  const now = opts.now ?? Date.now()
  if (!opts.fresh && pancakeCache && now - pancakeCache.at < CACHE_TTL_MS) return pancakeCache.value

  const payload = await getJson(PANCAKE_EXPLORER_POOLS_URL, opts)
  const rows = Array.isArray(payload) ? payload : (payload as { data?: unknown }).data
  if (!Array.isArray(rows)) throw new Error('PancakeSwap explorer did not return an array')

  const pools: PancakePool[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const entry = row as Record<string, unknown>
    const token0 = entry['token0'] as Record<string, unknown> | undefined
    const token1 = entry['token1'] as Record<string, unknown> | undefined
    const apr = num(entry['apr24h'])
    pools.push({
      id: String(entry['id'] ?? ''),
      token0Symbol: String(token0?.['symbol'] ?? '?'),
      token1Symbol: String(token1?.['symbol'] ?? '?'),
      feeTier: num(entry['feeTier']),
      tvlUsd: num(entry['tvlUSD']) ?? num(entry['tvlUsd']) ?? 0,
      apr24hPct: apr === null ? null : apr * 100,
      volumeUsd24h: num(entry['volumeUSD24h']) ?? num(entry['volumeUsd24h']),
    })
  }

  pancakeCache = { at: now, value: pools }
  return pools
}

export function resetYieldCaches(): void {
  llamaCache = null
  pancakeCache = null
}

/**
 * Pools that hold a given asset, ranked.
 *
 * Symbol matching, because that is what both sources agree on — Llama's
 * `underlyingTokens` is often null for lending markets. A caller gets the
 * matched symbol back so it can see what was actually compared.
 */
export function poolsForAsset(pools: LlamaPool[], asset: string): LlamaPool[] {
  const wanted = asset.toUpperCase()
  return pools.filter((pool) => {
    const parts = pool.symbol.toUpperCase().split(/[-/]/)
    return parts.includes(wanted)
  })
}
