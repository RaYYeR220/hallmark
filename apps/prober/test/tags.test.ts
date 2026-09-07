/**
 * Tag semantics.
 *
 * These attestations are permanent and public. A wrong tag does not produce a
 * wrong number, it produces a *false claim* — `reachable: 75` asserts something
 * the boolean tag cannot mean, and `successRate: 0` on an agent that never
 * declared a protocol is a slur rather than a measurement. Every rule below
 * exists because the alternative reaches the chain.
 */

import { describe, expect, it } from 'vitest'

import {
  ALL_TAGS,
  BOOL_FALSE,
  BOOL_TRUE,
  DEFAULT_TAGS,
  TAG_VOCABULARY,
  TagValueError,
  assertTagValue,
  declaresMachineProtocol,
  encodeTag,
  hasSuccessRate,
  planFeedbackTags,
  resolveTag,
} from '../src/tags.ts'
import type { RunRecord } from '../src/store.ts'

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    chainId: 56,
    agentId: 1,
    probedAt: '2026-09-07T12:00:00.000Z',
    score: 83,
    breakdown: { reachability: 35, protocol: 25, latency: 15, capabilities: 7.5, x402: 0 },
    evidenceHash: `0x${'ab'.repeat(32)}`,
    elapsedMs: 100,
    name: null,
    owner: null,
    cardError: null,
    primaryEndpoint: 'https://a.test/a2a',
    endpointCount: 1,
    scoredCount: 1,
    okCount: 1,
    protocolOkCount: 1,
    protocolLive: true,
    protocolLiveKinds: ['a2a'],
    failures: {},
    kinds: ['a2a'],
    latencies: [120],
    mcpTools: 0,
    a2aSkills: 3,
    x402: false,
    ...overrides,
  }
}

describe('the vocabulary is the standard', () => {
  it('does not invent tags where ERC-8004 has one', () => {
    expect(ALL_TAGS.sort()).toEqual(
      ['blocktimeFreshness', 'ownerVerified', 'reachable', 'responseTime', 'starred', 'successRate', 'uptime'].sort(),
    )
  })

  it('types reachable as a boolean and successRate as a percent', () => {
    expect(TAG_VOCABULARY.reachable.type).toBe('bool')
    expect(TAG_VOCABULARY.successRate.type).toBe('percent')
    expect(TAG_VOCABULARY.uptime.valueDecimals).toBe(2)
    expect(TAG_VOCABULARY.responseTime.type).toBe('millis')
  })

  it('writes reachable and successRate by default', () => {
    expect(DEFAULT_TAGS).toEqual(['reachable', 'successRate'])
  })

  it('resolves a tag case-insensitively', () => {
    expect(resolveTag('responsetime')).toBe('responseTime')
    expect(resolveTag('  SuccessRate ')).toBe('successRate')
  })

  it('rejects an unknown tag with the vocabulary in the message', () => {
    expect(() => resolveTag('liveness')).toThrow(TagValueError)
    expect(() => resolveTag('liveness')).toThrow(/reachable/)
  })
})

describe('assertTagValue is a hard error, not a warning', () => {
  it('refuses a non-boolean value on a boolean tag', () => {
    expect(() => assertTagValue('reachable', 75n, 0)).toThrow(TagValueError)
    expect(() => assertTagValue('reachable', 75n, 0)).toThrow(/boolean/)
    expect(() => assertTagValue('reachable', 1n, 0)).toThrow(TagValueError)
    expect(() => assertTagValue('ownerVerified', 50n, 0)).toThrow(/boolean/)
  })

  it('accepts exactly 100 and 0 on a boolean tag', () => {
    expect(() => assertTagValue('reachable', BOOL_TRUE, 0)).not.toThrow()
    expect(() => assertTagValue('reachable', BOOL_FALSE, 0)).not.toThrow()
  })

  it('refuses a percent outside 0..100', () => {
    expect(() => assertTagValue('successRate', 101n, 0)).toThrow(/within 0\.\.100/)
    expect(() => assertTagValue('successRate', -1n, 0)).toThrow(/within 0\.\.100/)
  })

  it('refuses the wrong valueDecimals for a tag', () => {
    expect(() => assertTagValue('uptime', 9_900n, 0)).toThrow(/valueDecimals 2/)
    expect(() => assertTagValue('reachable', 100n, 2)).toThrow(/valueDecimals 0/)
  })

  it('refuses a negative response time', () => {
    expect(() => assertTagValue('responseTime', -5n, 0)).toThrow(TagValueError)
  })
})

describe('reachable means the socket answered, and nothing more', () => {
  it('is 100 when at least one endpoint answered', () => {
    expect(encodeTag(record({ okCount: 1, scoredCount: 3 }), 'reachable')).toMatchObject({
      tag1: 'reachable',
      value: 100n,
      valueDecimals: 0,
    })
  })

  it('is 0 when nothing answered', () => {
    expect(encodeTag(record({ okCount: 0, scoredCount: 3 }), 'reachable')?.value).toBe(0n)
  })

  it('is never the graded score, however good that score is', () => {
    for (const score of [1, 42, 75, 83, 99]) {
      const encoded = encodeTag(record({ score, okCount: 1 }), 'reachable')
      expect(encoded?.value).toBe(100n)
    }
  })

  it('carries a reason a human can read in the plan', () => {
    expect(encodeTag(record({ okCount: 2, scoredCount: 3 }), 'reachable')?.reason).toBe(
      '2/3 declared endpoints answered',
    )
  })
})

describe('successRate is only written where there is a rate to report', () => {
  it('is 100 for an agent whose declared protocol works', () => {
    expect(encodeTag(record({ kinds: ['a2a'], protocolLive: true }), 'successRate')).toMatchObject({
      value: 100n,
      valueDecimals: 0,
    })
  })

  it('is 0 for an agent that declares a protocol and does not speak it', () => {
    const encoded = encodeTag(record({ kinds: ['mcp'], protocolLive: false, protocolLiveKinds: [] }), 'successRate')
    expect(encoded?.value).toBe(0n)
    expect(encoded?.reason).toMatch(/none of those endpoints spoke it/)
  })

  it('is NOT WRITTEN AT ALL for an agent that neither declares nor proves a protocol', () => {
    // A 0 here would be a slur, not a measurement.
    const webOnly = { kinds: ['web'], protocolLive: false, protocolLiveKinds: [] }
    expect(encodeTag(record(webOnly), 'successRate')).toBe(null)
    expect(encodeTag(record({ kinds: [], protocolLive: false, protocolLiveKinds: [] }), 'successRate')).toBe(null)
  })

  it('recognises every machine-callable kind', () => {
    for (const kind of ['a2a', 'mcp', 'x402', 'oasf']) {
      expect(declaresMachineProtocol({ kinds: [kind] })).toBe(true)
    }
    for (const kind of ['web', 'email', 'ens', 'did', 'other']) {
      expect(declaresMachineProtocol({ kinds: [kind] })).toBe(false)
    }
  })
})

describe('the optional tags', () => {
  it('encodes responseTime as the median in milliseconds', () => {
    expect(encodeTag(record({ latencies: [100, 200, 900] }), 'responseTime')?.value).toBe(200n)
  })

  it('does not write responseTime when nothing answered', () => {
    expect(encodeTag(record({ latencies: [] }), 'responseTime')).toBe(null)
  })

  it('encodes uptime as a percent scaled by 100', () => {
    expect(encodeTag(record({ okCount: 3, scoredCount: 4 }), 'uptime')).toMatchObject({
      value: 7_500n,
      valueDecimals: 2,
    })
  })

  it('puts the graded score under starred, which is the tag that means that', () => {
    expect(encodeTag(record({ score: 83 }), 'starred')?.value).toBe(83n)
  })
})

describe('planFeedbackTags produces one coherent record per agent', () => {
  it('writes reachable and successRate for a live agent', () => {
    const plan = planFeedbackTags(record())
    expect(plan.map((p) => [p.tag1, p.value])).toEqual([
      ['reachable', 100n],
      ['successRate', 100n],
    ])
  })

  it('writes reachable=100 and successRate=0 for a declaring agent that does not work', () => {
    const plan = planFeedbackTags(
      record({ kinds: ['a2a', 'web'], protocolLive: false, protocolLiveKinds: [], okCount: 1, scoredCount: 2 }),
    )
    expect(plan.map((p) => [p.tag1, p.value])).toEqual([
      ['reachable', 100n],
      ['successRate', 0n],
    ])
  })

  it('writes only reachable for an agent with no declared protocol', () => {
    const plan = planFeedbackTags(record({ kinds: ['web'], protocolLive: false, protocolLiveKinds: [] }))
    expect(plan.map((p) => p.tag1)).toEqual(['reachable'])
  })

  it('writes reachable=0 for a dead agent, which is true and typed', () => {
    const plan = planFeedbackTags(record({ kinds: ['a2a'], okCount: 0, protocolLive: false, protocolLiveKinds: [] }))
    expect(plan.map((p) => [p.tag1, p.value])).toEqual([
      ['reachable', 0n],
      ['successRate', 0n],
    ])
  })

  it('honours an explicit tag list', () => {
    const plan = planFeedbackTags(record(), ['responseTime', 'starred'])
    expect(plan.map((p) => p.tag1)).toEqual(['responseTime', 'starred'])
  })

  it('every value it produces passes its own type check', () => {
    const cases = [
      record(),
      record({ okCount: 0, protocolLive: false, protocolLiveKinds: [] }),
      record({ kinds: ['web'], protocolLive: false, protocolLiveKinds: [] }),
      record({ okCount: 5, scoredCount: 7, latencies: [1, 2, 3, 4, 5] }),
      record({ score: 0 }),
      record({ score: 100 }),
    ]
    for (const candidate of cases) {
      for (const entry of planFeedbackTags(candidate, ALL_TAGS.filter((t) => t !== 'ownerVerified' && t !== 'blocktimeFreshness'))) {
        expect(() => assertTagValue(entry.tag1, entry.value, entry.valueDecimals)).not.toThrow()
      }
    }
  })

  it('refuses a vocabulary tag it has no measurement for', () => {
    expect(() => encodeTag(record(), 'ownerVerified')).toThrow(/measures nothing/)
    expect(() => encodeTag(record(), 'blocktimeFreshness')).toThrow(/measures nothing/)
  })
})

describe('evidence beats the label', () => {
  it('writes successRate for an agent that proved a protocol its card did not declare', () => {
    // Seen live on mainnet: an endpoint listed as `web`/`other` that answers an
    // unpaid GET with a valid x402 challenge. It works; the card just said so badly.
    const proven = record({ kinds: ['web', 'other'], protocolLive: true, protocolLiveKinds: ['other'] })
    expect(declaresMachineProtocol(proven)).toBe(false)
    expect(hasSuccessRate(proven)).toBe(true)
    expect(encodeTag(proven, 'successRate')?.value).toBe(100n)
  })

  it('still writes nothing for an agent that neither declares nor proves one', () => {
    const nothing = record({ kinds: ['web'], protocolLive: false, protocolLiveKinds: [] })
    expect(hasSuccessRate(nothing)).toBe(false)
    expect(encodeTag(nothing, 'successRate')).toBe(null)
  })

  it('never lets a label alone manufacture a positive claim', () => {
    const declaredOnly = record({ kinds: ['a2a'], protocolLive: false, protocolLiveKinds: [] })
    expect(encodeTag(declaredOnly, 'successRate')?.value).toBe(0n)
  })
})
