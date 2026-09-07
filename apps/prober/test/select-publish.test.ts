/**
 * Publish selection.
 *
 * The failure this guards against is not a crash, it is a bias. Sorting by
 * score and taking the top N selects exactly the agents that make the registry
 * look healthy and never the ones that make it look honest — on the real
 * mainnet store that skim planned 600 `reachable=100` writes and zero
 * `successRate=0`, while the useful fact (1,388 declare a protocol, 19 speak
 * one) stayed off chain. A structurally optimistic publisher is the opposite of
 * what this service claims to be.
 */

import { describe, expect, it } from 'vitest'

import { selectForPublish, shuffle } from '../src/select.ts'
import { planFeedbackTags, verdictOf } from '../src/tags.ts'
import type { RunRecord } from '../src/store.ts'

function record(agentId: number, shape: Partial<RunRecord> = {}): RunRecord {
  return {
    chainId: 56,
    agentId,
    probedAt: '2026-09-07T12:00:00.000Z',
    score: 50,
    breakdown: { reachability: 35, protocol: 0, latency: 15, capabilities: 0, x402: 0 },
    evidenceHash: `0x${'ab'.repeat(32)}`,
    elapsedMs: 100,
    name: null,
    owner: null,
    cardError: null,
    primaryEndpoint: 'https://a.test/a2a',
    endpointCount: 1,
    scoredCount: 1,
    okCount: 1,
    protocolOkCount: 0,
    protocolLive: false,
    protocolLiveKinds: [],
    failures: {},
    kinds: ['a2a'],
    latencies: [120],
    mcpTools: 0,
    a2aSkills: 0,
    x402: false,
    ...shape,
  }
}

const positive = (id: number) =>
  record(id, { protocolLive: true, protocolLiveKinds: ['a2a'], protocolOkCount: 1, score: 85 })
/** Declares a protocol, answers, does not speak it. The informative case. */
const negative = (id: number) => record(id, { kinds: ['a2a'], okCount: 1, protocolLive: false, score: 60 })
const unreachable = (id: number) =>
  record(id, { kinds: ['a2a'], okCount: 0, latencies: [], protocolLive: false, score: 0 })
const webOnly = (id: number) => record(id, { kinds: ['web'], okCount: 1, protocolLive: false, score: 70 })
/** Nothing contactable was declared, so we tried nothing. */
const inapplicable = (id: number) =>
  record(id, { kinds: ['did'], scoredCount: 0, okCount: 0, endpointCount: 1, latencies: [], score: 0 })

describe('verdicts', () => {
  it('classifies the five cases', () => {
    expect(verdictOf(positive(1))).toBe('positive')
    expect(verdictOf(negative(2))).toBe('negative')
    expect(verdictOf(unreachable(3))).toBe('unreachable')
    expect(verdictOf(webOnly(4))).toBe('reachable-only')
    expect(verdictOf(inapplicable(5))).toBe('inapplicable')
  })
})

describe('what each verdict actually writes', () => {
  it('a positive writes reachable=100 and successRate=100', () => {
    expect(planFeedbackTags(positive(1)).map((p) => [p.tag1, p.value])).toEqual([
      ['reachable', 100n],
      ['successRate', 100n],
    ])
  })

  it('a negative writes reachable=100 and successRate=0 — the informative claim', () => {
    expect(planFeedbackTags(negative(2)).map((p) => [p.tag1, p.value])).toEqual([
      ['reachable', 100n],
      ['successRate', 0n],
    ])
  })

  it('an unreachable agent writes reachable=0', () => {
    expect(planFeedbackTags(unreachable(3)).map((p) => [p.tag1, p.value])).toEqual([
      ['reachable', 0n],
      ['successRate', 0n],
    ])
  })

  it('an agent we never tried writes nothing at all', () => {
    // `reachable: 0` here would describe our own inaction as its failure.
    expect(planFeedbackTags(inapplicable(5))).toEqual([])
  })

  it('a web-only agent writes reachable and no successRate', () => {
    expect(planFeedbackTags(webOnly(4)).map((p) => p.tag1)).toEqual(['reachable'])
  })
})

describe('balanced selection', () => {
  // Roughly the real mainnet shape: a few positives, many negatives.
  const store = [
    ...Array.from({ length: 5 }, (_, i) => positive(1_000 + i)),
    ...Array.from({ length: 400 }, (_, i) => negative(2_000 + i)),
    ...Array.from({ length: 300 }, (_, i) => unreachable(3_000 + i)),
    ...Array.from({ length: 900 }, (_, i) => webOnly(4_000 + i)),
    ...Array.from({ length: 600 }, (_, i) => inapplicable(5_000 + i)),
  ]

  it('reports what is available before capping', () => {
    const selection = selectForPublish(store, { limit: 10 })
    expect(selection.available).toMatchObject({
      positive: 5,
      negative: 400,
      unreachable: 300,
      'reachable-only': 900,
      inapplicable: 600,
    })
  })

  it('does not skim the top by score', () => {
    const selection = selectForPublish(store, { limit: 30 })
    // A score-sorted skim would be all positives then all web-only (score 70).
    expect(selection.chosen.negative).toBeGreaterThan(0)
    expect(selection.chosen.unreachable).toBeGreaterThan(0)
  })

  it('draws round-robin, so a rare class is not drowned by a common one', () => {
    const selection = selectForPublish(store, { limit: 12 })
    expect(selection.records).toHaveLength(12)

    // Proportional sampling would give the 5 positives 12 x 5/705 = 0.09 slots,
    // i.e. almost certainly none. Round-robin gives them an equal share.
    const shares = [selection.chosen.positive, selection.chosen.negative, selection.chosen.unreachable]
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1)
    expect(selection.chosen.positive).toBeGreaterThanOrEqual(4)
  })

  it('exhausts a small class rather than padding it, once the run is big enough', () => {
    const selection = selectForPublish(store, { limit: 60 })
    expect(selection.chosen.positive).toBe(5)
    expect(selection.records).toHaveLength(60)
  })

  it('never selects an agent we tried nothing on', () => {
    const selection = selectForPublish(store, { limit: 500 })
    expect(selection.chosen.inapplicable).toBe(0)
  })

  it('excludes web-only agents unless asked', () => {
    expect(selectForPublish(store, { limit: 500 }).chosen['reachable-only']).toBe(0)
    expect(selectForPublish(store, { limit: 500, allowWebOnly: true }).chosen['reachable-only']).toBeGreaterThan(0)
  })

  it('honours --verdict negative', () => {
    const selection = selectForPublish(store, { side: 'negative', limit: 40 })
    expect(selection.chosen.positive).toBe(0)
    expect(selection.chosen.negative + selection.chosen.unreachable).toBe(40)
  })

  it('honours --verdict positive', () => {
    const selection = selectForPublish(store, { side: 'positive', limit: 40 })
    expect(selection.chosen.negative).toBe(0)
    expect(selection.chosen.unreachable).toBe(0)
    expect(selection.chosen.positive).toBe(5)
  })

  it('caps the negative side so a run cannot become all-negative either', () => {
    const selection = selectForPublish(store, { limit: 500, maxNegatives: 20 })
    expect(selection.chosen.negative + selection.chosen.unreachable).toBe(20)
    expect(selection.chosen.positive).toBe(5)
  })

  it('is reproducible for a seed and changes with it', () => {
    const a = selectForPublish(store, { limit: 40, seed: 'one' }).records.map((r) => r.agentId)
    const b = selectForPublish(store, { limit: 40, seed: 'one' }).records.map((r) => r.agentId)
    const c = selectForPublish(store, { limit: 40, seed: 'two' }).records.map((r) => r.agentId)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('does not just take the lowest agent ids, which are the oldest agents', () => {
    const ids = selectForPublish(store, { side: 'negative', limit: 20, seed: 's' }).records.map((r) => r.agentId)
    const sortedHead = store
      .filter((r) => verdictOf(r) === 'negative')
      .map((r) => r.agentId)
      .sort((x, y) => x - y)
      .slice(0, 20)
    expect(ids).not.toEqual(sortedHead)
  })

  it('respects an explicit agent list over any balancing', () => {
    const selection = selectForPublish(store, { agentIds: [1000, 2000, 5000] })
    expect(selection.records.map((r) => r.agentId).sort((a, b) => a - b)).toEqual([1000, 2000, 5000])
  })

  it('returns nothing rather than something wrong when the store is empty', () => {
    const selection = selectForPublish([], { limit: 50 })
    expect(selection.records).toEqual([])
  })
})

describe('shuffle', () => {
  it('is a permutation, deterministic per seed', () => {
    const input = Array.from({ length: 50 }, (_, i) => i)
    const a = shuffle(input, 'x')
    expect([...a].sort((p, q) => p - q)).toEqual(input)
    expect(shuffle(input, 'x')).toEqual(a)
    expect(shuffle(input, 'y')).not.toEqual(a)
  })
})
