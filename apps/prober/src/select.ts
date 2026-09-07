/**
 * Choosing which agents to probe.
 *
 * A sample has to be reproducible or the numbers it produces cannot be
 * defended: `--seed hallmark --sample 200` must select the same 200 ids today
 * and next week. The registry keeps growing, so the ceiling the sample was
 * drawn against is returned with the ids and recorded in the sweep manifest;
 * pin it with `--max-id` to reproduce an older run exactly.
 */

import { ScanClient } from '@hallmark/core'
import type { RegistryReader, ScanAgent } from '@hallmark/core'

export type Selection = {
  agentIds: number[]
  /** Highest agent id the sample was drawn against. */
  ceiling: number
  strategy: 'sample' | 'recent' | 'range' | 'explicit'
  seed: string | null
}

/** Deterministic 32-bit seed from an arbitrary string. */
export function seedFrom(text: string): number {
  let h = 1779033703 ^ text.length
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

/** mulberry32 — small, fast, and identical on every platform. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * `count` distinct ids drawn uniformly from `[1, ceiling]`.
 *
 * Rejection sampling while the sample is sparse, then a partial Fisher-Yates
 * over the full range once it is not — so asking for every agent on testnet
 * terminates instead of spinning on collisions.
 */
export function sampleAgentIds(input: { ceiling: number; count: number; seed: string }): number[] {
  const ceiling = Math.max(0, Math.trunc(input.ceiling))
  const count = Math.max(0, Math.trunc(input.count))
  if (ceiling === 0 || count === 0) return []
  if (count >= ceiling) return Array.from({ length: ceiling }, (_, i) => i + 1)

  const random = mulberry32(seedFrom(input.seed))

  if (count * 3 >= ceiling) {
    const pool = Array.from({ length: ceiling }, (_, i) => i + 1)
    for (let i = 0; i < count; i += 1) {
      const j = i + Math.floor(random() * (ceiling - i))
      const a = pool[i] as number
      const b = pool[j] as number
      pool[i] = b
      pool[j] = a
    }
    return pool.slice(0, count).sort((a, b) => a - b)
  }

  const picked = new Set<number>()
  let guard = 0
  while (picked.size < count && guard < count * 64) {
    picked.add(1 + Math.floor(random() * ceiling))
    guard += 1
  }
  return [...picked].sort((a, b) => a - b)
}

export type SelectOptions = {
  reader: RegistryReader
  chainId: number
  scan?: ScanClient
  sample?: number
  recent?: number
  seed?: string
  maxId?: number
  from?: number
  to?: number
  agentIds?: number[]
  /** Hint for the `ownerOf` binary search; saves round trips. */
  hint?: number
}

export async function selectAgents(options: SelectOptions): Promise<Selection> {
  if (options.agentIds !== undefined && options.agentIds.length > 0) {
    const ids = [...new Set(options.agentIds)].sort((a, b) => a - b)
    return { agentIds: ids, ceiling: Math.max(...ids), strategy: 'explicit', seed: null }
  }

  if (options.recent !== undefined && options.recent > 0) {
    const ids = await recentAgentIds(options.scan ?? new ScanClient(), options.chainId, options.recent)
    return { agentIds: ids, ceiling: ids.length === 0 ? 0 : Math.max(...ids), strategy: 'recent', seed: null }
  }

  if (options.from !== undefined) {
    const to = options.to ?? options.from
    const ids: number[] = []
    for (let id = options.from; id <= to; id += 1) ids.push(id)
    return { agentIds: ids, ceiling: to, strategy: 'range', seed: null }
  }

  const ceiling =
    options.maxId ??
    Number(
      await options.reader.highestAgentId(options.hint === undefined ? {} : { hint: BigInt(options.hint) }),
    )
  const seed = options.seed ?? 'hallmark'
  const count = options.sample ?? 100
  return { agentIds: sampleAgentIds({ ceiling, count, seed }), ceiling, strategy: 'sample', seed }
}

/** Newest agents first, straight from the 8004scan index. */
export async function recentAgentIds(scan: ScanClient, chainId: number, count: number): Promise<number[]> {
  const wanted = Math.max(0, Math.trunc(count))
  if (wanted === 0) return []

  const ids: number[] = []
  const seen = new Set<number>()
  const push = (agent: ScanAgent) => {
    const tokenId = Number(agent.token_id)
    if (!Number.isFinite(tokenId) || seen.has(tokenId)) return
    seen.add(tokenId)
    ids.push(tokenId)
  }

  for await (const agent of scan.paginate(
    { chain_id: chainId, sort_by: 'created_at', sort_order: 'desc', limit: Math.min(100, wanted) },
    wanted,
  )) {
    push(agent)
    if (ids.length >= wanted) break
  }

  return ids
}
