/**
 * The audit path is the script a judge runs against us, so its verdicts have
 * to be blunt and its exit codes have to mean something.
 */

import { describe, expect, it } from 'vitest'

import { buildEvidenceBundle, bundleHash, canonicalBundleJson } from '../src/evidence.ts'
import { exitCodeFor, formatVerifyReport, verifyEvidence } from '../src/verify.ts'
import { createMemoryStore } from '../src/store.ts'
import type { RegistryReader } from '@hallmark/core'
import { endpointProbe } from './helpers.ts'

const EVIDENCE_BASE = 'https://hallmark-market.vercel.app/api/evidence'

function bundleFor(agentId: number) {
  return buildEvidenceBundle({
    chainId: 97,
    agentId,
    probedAt: '2026-09-07T12:00:00.000Z',
    observed: { blockNumber: 129_600_000, blockTimestamp: 1_757_246_193 },
    agent: { owner: '0x1', tokenUriKind: 'data-json', name: 'Agent', cardError: null, cardWarnings: [] },
    probe: [endpointProbe({ latencyMs: 120 })],
    capabilities: { a2aSkills: ['quote'], x402: null },
  })
}

function reader(validations: Array<{ hash: `0x${string}`; responseHash: `0x${string}` }>): RegistryReader {
  return {
    client: {
      getBlockNumber: async () => 1_000n,
      getContractEvents: async () => [],
    },
    agentValidations: async () => validations.map((v) => v.hash),
    validationStatus: async (hash: `0x${string}`) => {
      const found = validations.find((v) => v.hash === hash)
      if (found === undefined) return null
      return {
        validator: '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab' as `0x${string}`,
        agentId: 2210n,
        response: 92,
        responseHash: found.responseHash,
        tag: 'reachable',
        lastUpdate: 1_757_000_000n,
      }
    },
  } as unknown as RegistryReader
}

/** A scan client that always fails, so the fallback path is what runs. */
const deadScan = {
  listFeedbacks: async () => {
    throw new Error('indexer unavailable')
  },
} as never

describe('verifyEvidence', () => {
  it('reports ok when the document hashes correctly and a validation carries the hash', async () => {
    const bundle = bundleFor(2210)
    const hash = bundleHash(bundle)
    const store = createMemoryStore()
    await store.putRun({
      chainId: 97,
      agentId: 2210,
      probedAt: bundle.probedAt,
      score: bundle.score,
      breakdown: bundle.breakdown,
      evidenceHash: hash,
      bundle,
      elapsedMs: 1,
    })

    const report = await verifyEvidence(hash, {
      chainId: 97,
      reader: reader([{ hash: `0x${'1'.repeat(64)}`, responseHash: hash }]),
      store,
      scan: deadScan,
      evidenceBaseUrl: EVIDENCE_BASE,
    })

    expect(report.verdict).toBe('ok')
    expect(report.computedHash).toBe(hash)
    expect(report.canonical).toBe(true)
    expect(report.validation.some((v) => v.match)).toBe(true)
    expect(exitCodeFor(report.verdict)).toBe(0)
    expect(formatVerifyReport(report)).toContain('VERDICT       OK')
  })

  it('reports no-onchain-record when the document is sound but unreferenced', async () => {
    const bundle = bundleFor(2000)
    const hash = bundleHash(bundle)
    const store = createMemoryStore()
    await store.putRun({
      chainId: 97,
      agentId: 2000,
      probedAt: bundle.probedAt,
      score: bundle.score,
      breakdown: bundle.breakdown,
      evidenceHash: hash,
      bundle,
      elapsedMs: 1,
    })

    const report = await verifyEvidence(hash, {
      chainId: 97,
      reader: reader([]),
      store,
      scan: deadScan,
      evidenceBaseUrl: EVIDENCE_BASE,
    })

    expect(report.verdict).toBe('no-onchain-record')
    expect(exitCodeFor(report.verdict)).toBe(3)
    expect(report.problems.join(' ')).toMatch(/no ERC-8004 record/)
  })

  it('reports hash-mismatch when the served bytes are not what the name claims', async () => {
    const bundle = bundleFor(2210)
    const realHash = bundleHash(bundle)
    const wrongHash = `0x${'9'.repeat(64)}` as const

    const store = {
      getBundleText: async () => canonicalBundleJson(bundle),
    } as never

    const report = await verifyEvidence(wrongHash, {
      chainId: 97,
      reader: reader([]),
      store,
      scan: deadScan,
      evidenceBaseUrl: EVIDENCE_BASE,
    })

    expect(report.verdict).toBe('hash-mismatch')
    expect(report.computedHash).toBe(realHash)
    expect(exitCodeFor(report.verdict)).toBe(1)
  })

  it('reports not-canonical when the document was re-serialised on the way out', async () => {
    const bundle = bundleFor(2210)
    const hash = bundleHash(bundle)
    const store = {
      getBundleText: async () => JSON.stringify(bundle, null, 2),
    } as never

    const report = await verifyEvidence(hash, {
      chainId: 97,
      reader: reader([{ hash: `0x${'1'.repeat(64)}`, responseHash: hash }]),
      store,
      scan: deadScan,
      evidenceBaseUrl: EVIDENCE_BASE,
    })

    expect(report.verdict).toBe('not-canonical')
    expect(report.computedHash).toBe(hash)
    expect(exitCodeFor(report.verdict)).toBe(1)
  })

  it('reports unfetchable rather than pretending, when nothing answers', async () => {
    const report = await verifyEvidence('0x' + 'f'.repeat(64), {
      chainId: 97,
      reader: reader([]),
      scan: deadScan,
      evidenceBaseUrl: 'http://127.0.0.1:9/api/evidence',
      timeoutMs: 200,
    })

    expect(report.verdict).toBe('unfetchable')
    expect(exitCodeFor(report.verdict)).toBe(2)
  })

  it('refuses a target that is neither a hash nor an http URL', async () => {
    const report = await verifyEvidence('file:///etc/passwd', {
      chainId: 97,
      reader: reader([]),
      scan: deadScan,
      evidenceBaseUrl: EVIDENCE_BASE,
    })
    expect(report.verdict).toBe('unfetchable')
  })
})
