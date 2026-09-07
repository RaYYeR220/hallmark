import { describe, expect, it } from 'vitest'

import { PROBE_WEIGHTS, PROBER_SCORER_VERSION, latencyFactor, percentile, scoreRun } from '../src/score.ts'
import { endpointProbe } from './helpers.ts'

describe('weights', () => {
  it('sum to 100, so a perfect agent scores exactly 100', () => {
    const total = Object.values(PROBE_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(total).toBe(100)
  })

  it('is versioned, so an old bundle can always be re-derived', () => {
    expect(PROBER_SCORER_VERSION).toMatch(/^prober\/\d+\.\d+\.\d+$/)
  })
})

describe('scoreRun', () => {
  it('scores a perfect agent 100', () => {
    const result = scoreRun({
      probe: [endpointProbe({ kind: 'mcp', latencyMs: 50 }), endpointProbe({ kind: 'a2a', latencyMs: 120 })],
      capabilities: {
        mcpTools: ['search'],
        a2aSkills: ['rebalance'],
        x402: {
          x402Version: 1,
          scheme: 'exact',
          network: 'bsc',
          priceAtomic: '1',
          asset: '0x0',
          payTo: '0x0',
          maxTimeoutSeconds: 60,
          resource: null,
        },
      },
    })
    expect(result.score).toBe(100)
  })

  it('scores an agent with no contactable endpoint 0, not "unknown"', () => {
    const result = scoreRun({
      probe: [endpointProbe({ kind: 'did', ok: false, scored: false, failure: 'unsupported-scheme', protocolOk: false })],
      capabilities: {},
    })
    expect(result.score).toBe(0)
    expect(result.breakdown).toEqual({ reachability: 0, protocol: 0, latency: 0, capabilities: 0, x402: 0 })
  })

  it('scores an agent whose endpoints all failed 0', () => {
    const result = scoreRun({
      probe: [endpointProbe({ ok: false, protocolOk: false, failure: 'dns' })],
      capabilities: {},
    })
    expect(result.score).toBe(0)
  })

  it('gives partial credit for partial reachability', () => {
    const result = scoreRun({
      probe: [endpointProbe({ latencyMs: 100 }), endpointProbe({ ok: false, protocolOk: false, failure: 'timeout' })],
      capabilities: {},
    })
    expect(result.breakdown.reachability).toBe(PROBE_WEIGHTS.reachability / 2)
    expect(result.breakdown.protocol).toBe(PROBE_WEIGHTS.protocol / 2)
  })

  it('separates reachable from protocol-conformant', () => {
    const result = scoreRun({
      probe: [endpointProbe({ ok: true, protocolOk: false })],
      capabilities: {},
    })
    expect(result.breakdown.reachability).toBe(PROBE_WEIGHTS.reachability)
    expect(result.breakdown.protocol).toBe(0)
  })

  it('is deterministic across repeated calls and input order', () => {
    const probes = [
      endpointProbe({ endpoint: 'https://a.test', latencyMs: 90 }),
      endpointProbe({ endpoint: 'https://b.test', latencyMs: 400, protocolOk: false }),
      endpointProbe({ endpoint: 'https://c.test', ok: false, protocolOk: false, failure: 'http-4xx' }),
    ]
    const caps = { mcpTools: ['a', 'b'] }
    const first = scoreRun({ probe: probes, capabilities: caps })
    const second = scoreRun({ probe: [...probes].reverse(), capabilities: caps })
    expect(first).toEqual(second)
    expect(scoreRun({ probe: probes, capabilities: caps })).toEqual(first)
  })

  it('halves the capability weight when only one family is enumerated', () => {
    const withOne = scoreRun({ probe: [endpointProbe()], capabilities: { mcpTools: ['t'] } })
    const withBoth = scoreRun({ probe: [endpointProbe()], capabilities: { mcpTools: ['t'], a2aSkills: ['s'] } })
    expect(withOne.breakdown.capabilities).toBe(PROBE_WEIGHTS.capabilities / 2)
    expect(withBoth.breakdown.capabilities).toBe(PROBE_WEIGHTS.capabilities)
  })

  it('does not award capability credit for an empty enumeration', () => {
    const result = scoreRun({ probe: [endpointProbe()], capabilities: { mcpTools: [], a2aSkills: [] } })
    expect(result.breakdown.capabilities).toBe(0)
  })
})

describe('latencyFactor', () => {
  it('is 1 up to the ceiling and 0 past the floor', () => {
    expect(latencyFactor(0)).toBe(1)
    expect(latencyFactor(200)).toBe(1)
    expect(latencyFactor(5_000)).toBe(0)
    expect(latencyFactor(60_000)).toBe(0)
  })

  it('decreases monotonically in between', () => {
    let previous = 1
    for (let ms = 200; ms <= 5_000; ms += 400) {
      const value = latencyFactor(ms)
      expect(value).toBeLessThanOrEqual(previous)
      previous = value
    }
  })
})

describe('percentile', () => {
  it('interpolates between samples', () => {
    expect(percentile([10, 20, 30, 40], 50)).toBe(25)
    expect(percentile([10], 99)).toBe(10)
    expect(percentile([], 50)).toBe(0)
  })
})
