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

import { DEFAULT_PUBLISH_VERDICTS, VERDICTS, verdictOf, verdictSide } from './tags.ts'
import type { Verdict } from './tags.ts'
import type { RunRecord } from './store.ts'

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

/* ------------------------------------------------------------------ */
/* choosing what to publish                                            */
/* ------------------------------------------------------------------ */

/**
 * Choosing which probed agents to attest to.
 *
 * Sorting by score and taking the top N is structurally optimistic: it selects
 * exactly the agents that make the registry look healthy and never the ones
 * that make it look honest. On the mainnet store that skim produced 600
 * planned `reachable=100` writes and not one `successRate=0`, while the
 * interesting fact — 1,388 agents declare a protocol and 19 speak it — stayed
 * off chain entirely.
 *
 * So the default draws round-robin across the verdict classes, and within a
 * class it draws with a seeded shuffle rather than by agent id, because low ids
 * are old agents and that is its own bias.
 */

export type PublishSelection = {
  records: RunRecord[]
  /** How many of each verdict were available before the cap. */
  available: Record<Verdict, number>
  /** How many of each verdict were chosen. */
  chosen: Record<Verdict, number>
  seed: string
}

export type PublishSelectOptions = {
  /** `positive`, `negative`, or `both` (the default, round-robin balanced). */
  side?: 'positive' | 'negative' | 'both'
  /** Overall cap on agents. */
  limit?: number
  /** Cap on negative-side agents specifically, so a run cannot be all-negative either. */
  maxNegatives?: number
  /** Include agents that answered but declare no protocol. Off by default. */
  allowWebOnly?: boolean
  seed?: string
  /** Restrict to these agent ids, ignoring the balancing. */
  agentIds?: number[]
}

export function selectForPublish(all: RunRecord[], options: PublishSelectOptions = {}): PublishSelection {
  const seed = options.seed ?? 'hallmark-publish'
  const side = options.side ?? 'both'
  const limit = Math.max(0, options.limit ?? 50)
  const maxNegatives = Math.max(0, options.maxNegatives ?? 100)

  const buckets = emptyTally()
  const byVerdict = new Map<Verdict, RunRecord[]>()
  for (const verdict of VERDICTS) byVerdict.set(verdict, [])

  for (const record of all) {
    const verdict = verdictOf(record)
    buckets[verdict] += 1
    byVerdict.get(verdict)?.push(record)
  }

  if (options.agentIds !== undefined && options.agentIds.length > 0) {
    const wanted = new Set(options.agentIds)
    const records = all.filter((record) => wanted.has(record.agentId))
    return { records, available: buckets, chosen: tallyOf(records), seed }
  }

  const wantedVerdicts = DEFAULT_PUBLISH_VERDICTS.filter((verdict) => {
    if (side === 'both') return true
    return verdictSide(verdict) === side
  })
  if (options.allowWebOnly === true && side !== 'negative') wantedVerdicts.push('reachable-only')

  // Shuffle inside each class so the draw is representative of the class rather
  // than of whoever registered first.
  const queues = wantedVerdicts.map((verdict) => ({
    verdict,
    items: shuffle(byVerdict.get(verdict) ?? [], `${seed}:${verdict}`),
  }))

  const records: RunRecord[] = []
  let negatives = 0
  let progressed = true

  while (records.length < limit && progressed) {
    progressed = false
    for (const queue of queues) {
      if (records.length >= limit) break
      const next = queue.items.shift()
      if (next === undefined) continue
      if (verdictSide(queue.verdict) === 'negative') {
        if (negatives >= maxNegatives) continue
        negatives += 1
      }
      records.push(next)
      progressed = true
    }
  }

  return { records, available: buckets, chosen: tallyOf(records), seed }
}

/** Deterministic Fisher-Yates driven by the shared seeded PRNG. */
export function shuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items]
  const random = mulberry32(seedFrom(seed))
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const a = out[i] as T
    const b = out[j] as T
    out[i] = b
    out[j] = a
  }
  return out
}

function emptyTally(): Record<Verdict, number> {
  return Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>
}

function tallyOf(records: RunRecord[]): Record<Verdict, number> {
  const tally = emptyTally()
  for (const record of records) tally[verdictOf(record)] += 1
  return tally
}
