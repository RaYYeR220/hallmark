import { describe, expect, it } from 'vitest'
import { keccak256, toBytes } from 'viem'

import { buildEvidenceBundle, bundleHash, canonicalBundleJson, evidenceUri, verifyBundleText } from '../src/evidence.ts'
import type { ProbeEvidenceBundle } from '../src/types.ts'
import { endpointProbe } from './helpers.ts'

function sampleBundle(): ProbeEvidenceBundle {
  return buildEvidenceBundle({
    chainId: 97,
    agentId: 2210,
    probedAt: '2026-09-07T12:00:00.000Z',
    observed: { blockNumber: 129_600_000, blockTimestamp: 1_757_246_193 },
    agent: {
      owner: '0x38c6Fc4a5525B37f9545423A7132157f69ce08dA',
      tokenUriKind: 'data-json',
      name: 'Hallmark Validator',
      cardError: null,
      cardWarnings: ['used "x402support" as "x402Support"'],
    },
    probe: [
      endpointProbe({
        endpoint: 'https://agent.test/mcp',
        kind: 'mcp',
        latencyMs: 143,
        httpStatus: 200,
        requests: [
          {
            url: 'https://agent.test/mcp',
            method: 'POST',
            status: 200,
            latencyMs: 143,
            contentType: 'application/json',
            bytes: 812,
            redirects: 0,
            failure: null,
            detail: null,
          },
        ],
      }),
      endpointProbe({
        endpoint: 'https://agent.test/a2a',
        kind: 'a2a',
        ok: false,
        protocolOk: false,
        failure: 'not-json',
        error: 'returned an HTML page where an A2A agent card was declared',
        httpStatus: 200,
        latencyMs: 210,
      }),
    ],
    capabilities: { mcpTools: ['quote', 'rebalance'], a2aSkills: [], x402: null },
  })
}

/** Rebuild every object in the tree with its keys in a different order. */
function shuffleKeys(value: unknown, seed = 7): unknown {
  if (Array.isArray(value)) return value.map((entry, i) => shuffleKeys(entry, seed + i))
  if (typeof value !== 'object' || value === null) return value

  const entries = Object.entries(value as Record<string, unknown>)
  // Deterministic reversal plus a rotation: order changes, content does not.
  const rotated = [...entries].reverse()
  const pivot = seed % Math.max(1, rotated.length)
  const reordered = [...rotated.slice(pivot), ...rotated.slice(0, pivot)]
  const out: Record<string, unknown> = {}
  for (const [key, entry] of reordered) out[key] = shuffleKeys(entry, seed + 1)
  return out
}

describe('canonicalisation', () => {
  it('produces the same hash regardless of key order', () => {
    const bundle = sampleBundle()
    const shuffled = shuffleKeys(bundle) as ProbeEvidenceBundle

    expect(Object.keys(shuffled)).not.toEqual(Object.keys(bundle))
    expect(canonicalBundleJson(shuffled)).toBe(canonicalBundleJson(bundle))
    expect(bundleHash(shuffled)).toBe(bundleHash(bundle))
  })

  it('changes the hash when a single latency changes', () => {
    const bundle = sampleBundle()
    const before = bundleHash(bundle)
    const mutated = structuredClone(bundle)
    const first = mutated.probe[0]
    if (first === undefined) throw new Error('fixture lost its first probe')
    first.latencyMs += 1
    expect(bundleHash(mutated)).not.toBe(before)
  })

  it('changes the hash when a scorer weight changes', () => {
    const bundle = sampleBundle()
    const mutated = structuredClone(bundle)
    mutated.scorer.weights['reachability'] = 99
    expect(bundleHash(mutated)).not.toBe(bundleHash(bundle))
  })

  it('is keccak256 over the canonical UTF-8 bytes, and nothing else', () => {
    const bundle = sampleBundle()
    expect(bundleHash(bundle)).toBe(keccak256(toBytes(canonicalBundleJson(bundle))))
  })

  it('is stable across repeated builds of identical input', () => {
    expect(bundleHash(sampleBundle())).toBe(bundleHash(sampleBundle()))
  })
})

describe('verifyBundleText', () => {
  it('accepts the canonical bytes under their own hash', () => {
    const bundle = sampleBundle()
    const text = canonicalBundleJson(bundle)
    const result = verifyBundleText(text, bundleHash(bundle))
    expect(result.ok).toBe(true)
  })

  it('rejects a document served under the wrong hash', () => {
    const bundle = sampleBundle()
    const result = verifyBundleText(canonicalBundleJson(bundle), `0x${'0'.repeat(64)}`)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/hash mismatch/)
  })

  it('rejects a re-serialised document even when it hashes correctly', () => {
    const bundle = sampleBundle()
    const pretty = JSON.stringify(bundle, null, 2)
    const result = verifyBundleText(pretty, bundleHash(bundle))
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/canonical/)
  })

  it('rejects a document that is not JSON', () => {
    const result = verifyBundleText('<html>oops</html>', `0x${'0'.repeat(64)}`)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/not JSON/)
  })
})

describe('evidenceUri', () => {
  it('appends the hash when the base already names the route', () => {
    expect(evidenceUri('https://hallmark-market.vercel.app/api/evidence', '0xabc')).toBe(
      'https://hallmark-market.vercel.app/api/evidence/0xabc',
    )
  })

  it('adds the route to a bare origin', () => {
    expect(evidenceUri('http://localhost:8787', '0xabc')).toBe('http://localhost:8787/api/evidence/0xabc')
  })

  it('tolerates a trailing slash', () => {
    expect(evidenceUri('https://hallmark-market.vercel.app/api/evidence/', '0xabc')).toBe(
      'https://hallmark-market.vercel.app/api/evidence/0xabc',
    )
  })
})

describe('bundle shape', () => {
  it('carries the scorer version and weights so the score can be re-derived', () => {
    const bundle = sampleBundle()
    expect(bundle.scorer.version).toMatch(/^prober\//)
    expect(bundle.scorer.weights).toMatchObject({ reachability: 35, protocol: 25, latency: 15 })
  })

  it('pins the run to a block', () => {
    expect(sampleBundle().observed.blockNumber).toBe(129_600_000)
  })

  it('records the per-endpoint request trace', () => {
    expect(sampleBundle().probe[0]?.requests[0]?.url).toBe('https://agent.test/mcp')
  })
})
