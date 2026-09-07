import { describe, expect, it } from 'vitest'
import { keccak256, toBytes } from 'viem'

import {
  SCORE_WEIGHTS,
  canonicalize,
  createEvidenceBundle,
  evidenceHash,
  scoreEvidence,
  scoreProbe,
} from '../src/evidence.js'
import type { EvidenceBundle, ProbeResult } from '../src/types.js'

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  endpoint: 'https://agent.example/a2a',
  kind: 'a2a',
  ok: true,
  latencyMs: 120,
  ...over,
})

const FIXTURE: EvidenceBundle = {
  version: 1,
  chainId: 56,
  agentId: 1,
  probedAt: '2026-09-07T00:00:00.000Z',
  probe: [
    { endpoint: 'https://clawnews.io', kind: 'web', ok: true, httpStatus: 200, latencyMs: 143 },
    { endpoint: 'https://clawnews.io/mcp', kind: 'mcp', ok: false, latencyMs: 5000, error: 'ECONNREFUSED' },
  ],
  capabilities: { mcpTools: [], a2aSkills: [], x402: null },
  score: 38,
  scorer: {
    name: 'hallmark',
    version: '1.0.0',
    weights: { reachability: 45, latency: 15, mcpTools: 15, a2aSkills: 15, x402: 10 },
  },
}

describe('canonicalize', () => {
  it('is stable under key reordering, at every depth', () => {
    const a = {
      b: 1,
      a: { z: [1, 2, { q: true, p: null }], y: 'x' },
      c: [{ n: 1, m: 2 }],
    }
    const b = {
      c: [{ m: 2, n: 1 }],
      a: { y: 'x', z: [1, 2, { p: null, q: true }] },
      b: 1,
    }
    expect(canonicalize(a)).toBe(canonicalize(b))
    expect(canonicalize(a)).toBe('{"a":{"y":"x","z":[1,2,{"p":null,"q":true}]},"b":1,"c":[{"m":2,"n":1}]}')
  })

  it('reorders a whole evidence bundle to the same bytes', () => {
    const shuffled = {
      scorer: {
        weights: { x402: 10, a2aSkills: 15, mcpTools: 15, latency: 15, reachability: 45 },
        version: '1.0.0',
        name: 'hallmark' as const,
      },
      score: FIXTURE.score,
      capabilities: { x402: null, a2aSkills: [], mcpTools: [] },
      probe: FIXTURE.probe,
      probedAt: FIXTURE.probedAt,
      agentId: FIXTURE.agentId,
      chainId: FIXTURE.chainId,
      version: 1 as const,
    }
    expect(canonicalize(shuffled)).toBe(canonicalize(FIXTURE))
  })

  it('emits no insignificant whitespace', () => {
    expect(canonicalize({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}')
  })

  it('escapes control characters and everything non-ASCII', () => {
    expect(canonicalize('héllo')).toBe('"h\\u00e9llo"')
    expect(canonicalize('a\nb\t"c"\\d')).toBe('"a\\nb\\t\\"c\\"\\\\d"')
    expect(canonicalize('\u0001')).toBe('"\\u0001"')
    // Surrogate pairs are escaped as the code units they are.
    expect(canonicalize('\u{1f512}')).toBe('"\\ud83d\\udd12"')
  })

  it('sorts by UTF-16 code unit, so uppercase sorts before lowercase', () => {
    expect(canonicalize({ b: 1, A: 2, a: 3, B: 4 })).toBe('{"A":2,"B":4,"a":3,"b":1}')
  })

  it('drops undefined properties and nulls undefined array slots', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}')
    expect(canonicalize([undefined, 1])).toBe('[null,1]')
  })

  it('normalises negative zero', () => {
    expect(canonicalize(-0)).toBe('0')
  })

  it('refuses values JSON cannot represent', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(/non-finite/)
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(/non-finite/)
    expect(() => canonicalize(1n)).toThrow(/bigint/)
  })
})

describe('evidenceHash', () => {
  it('matches the known fixture', () => {
    expect(evidenceHash(FIXTURE)).toBe('0x3ec34a744572e861bbf7d5591d58589f6582e9328739c21bf90cbd99ac543b8d')
  })

  it('is keccak256 over the canonical bytes', () => {
    expect(evidenceHash(FIXTURE)).toBe(keccak256(toBytes(canonicalize(FIXTURE))))
  })

  it('ignores key order but not content', () => {
    const reordered: EvidenceBundle = { ...FIXTURE }
    expect(evidenceHash(reordered)).toBe(evidenceHash(FIXTURE))

    const changed: EvidenceBundle = { ...FIXTURE, agentId: 2 }
    expect(evidenceHash(changed)).not.toBe(evidenceHash(FIXTURE))
  })
})

describe('scoreProbe', () => {
  it('gives nothing to an endpoint that did not answer', () => {
    expect(scoreProbe(probe({ ok: false, latencyMs: 12 }))).toBe(0)
  })

  it('gives full marks to a fast answer and 60 to a very slow one', () => {
    expect(scoreProbe(probe({ latencyMs: 10 }))).toBe(100)
    expect(scoreProbe(probe({ latencyMs: 200 }))).toBe(100)
    expect(scoreProbe(probe({ latencyMs: 5000 }))).toBe(60)
    expect(scoreProbe(probe({ latencyMs: 60_000 }))).toBe(60)
  })

  it('decreases monotonically with latency', () => {
    const scores = [200, 1000, 2000, 3000, 4000, 5000].map((ms) => scoreProbe(probe({ latencyMs: ms })))
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1] as number)
    }
  })
})

describe('scoreEvidence', () => {
  it('has weights that sum to 100', () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0)
    expect(total).toBe(100)
  })

  it('scores an agent with nothing at all as zero', () => {
    expect(scoreEvidence({ probe: [], capabilities: {} })).toBe(0)
  })

  it('scores a fully alive agent as 100', () => {
    expect(
      scoreEvidence({
        probe: [probe({ latencyMs: 50 }), probe({ kind: 'mcp', latencyMs: 80 })],
        capabilities: {
          mcpTools: ['rebalance'],
          a2aSkills: ['grid'],
          x402: { priceAtomic: '1000', asset: '0xu', network: 'eip155:56' },
        },
      }),
    ).toBe(100)
  })

  it('is deterministic', () => {
    const input = {
      probe: [probe(), probe({ ok: false, latencyMs: 3000 })],
      capabilities: { mcpTools: ['a'] },
    }
    const first = scoreEvidence(input)
    expect(scoreEvidence(input)).toBe(first)
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(100)
  })
})

describe('createEvidenceBundle', () => {
  it('fills in the score and the scorer that produced it', () => {
    const bundle = createEvidenceBundle({
      chainId: 56,
      agentId: 1,
      probe: FIXTURE.probe,
      capabilities: FIXTURE.capabilities,
      probedAt: FIXTURE.probedAt,
    })
    expect(bundle).toEqual(FIXTURE)
    expect(evidenceHash(bundle)).toBe(evidenceHash(FIXTURE))
  })

  it('accepts a Date and normalises it to ISO-8601', () => {
    const bundle = createEvidenceBundle({
      chainId: 97,
      agentId: 3,
      probe: [],
      probedAt: new Date(Date.UTC(2026, 8, 7, 12, 0, 0)),
    })
    expect(bundle.probedAt).toBe('2026-09-07T12:00:00.000Z')
    expect(bundle.score).toBe(0)
  })
})
