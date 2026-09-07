import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildEvidenceBundle, bundleHash, canonicalBundleJson } from '../src/evidence.ts'
import { createFileStore, createMemoryStore, isEvidenceHash, toRunRecord } from '../src/store.ts'
import type { EvidenceStore } from '../src/store.ts'
import { computeStats, formatStats } from '../src/stats.ts'
import { createServer } from '../src/server.ts'
import { loadConfig } from '../src/config.ts'
import { mulberry32, sampleAgentIds, seedFrom } from '../src/select.ts'
import type { ProbeRun } from '../src/types.ts'
import { endpointProbe } from './helpers.ts'

function makeRun(agentId: number, score: 'good' | 'dead' = 'good'): ProbeRun {
  const probe =
    score === 'good'
      ? [endpointProbe({ endpoint: `https://a${agentId}.test/mcp`, kind: 'mcp', latencyMs: 150 })]
      : [
          endpointProbe({
            endpoint: `https://a${agentId}.test/mcp`,
            kind: 'mcp',
            ok: false,
            protocolOk: false,
            failure: 'http-4xx',
            httpStatus: 404,
            latencyMs: 80,
          }),
        ]
  const capabilities = score === 'good' ? { mcpTools: ['quote'], x402: null } : { x402: null }
  const bundle = buildEvidenceBundle({
    chainId: 97,
    agentId,
    probe,
    capabilities,
    observed: { blockNumber: 1, blockTimestamp: 2 },
    agent: { owner: null, tokenUriKind: 'data-json', name: `agent ${agentId}`, cardError: null, cardWarnings: [] },
    probedAt: '2026-09-07T12:00:00.000Z',
  })
  return {
    chainId: 97,
    agentId,
    probedAt: bundle.probedAt,
    score: bundle.score,
    breakdown: bundle.breakdown,
    evidenceHash: bundleHash(bundle),
    bundle,
    elapsedMs: 10,
  }
}

describe('evidence hash validation', () => {
  it('accepts a well-formed hash and rejects anything that could escape a directory', () => {
    expect(isEvidenceHash(`0x${'a'.repeat(64)}`)).toBe(true)
    expect(isEvidenceHash('0xABC')).toBe(false)
    expect(isEvidenceHash('../../etc/passwd')).toBe(false)
    expect(isEvidenceHash(`0x${'a'.repeat(63)}/..`)).toBe(false)
    expect(isEvidenceHash('')).toBe(false)
  })
})

describe('file store', () => {
  let dir: string
  let store: EvidenceStore

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hallmark-prober-'))
    store = createFileStore(dir)
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the canonical bytes under the hash, verbatim', async () => {
    const run = makeRun(2210)
    await store.putRun(run)

    const onDisk = await readFile(join(dir, 'evidence', `${run.evidenceHash}.json`), 'utf8')
    expect(onDisk).toBe(canonicalBundleJson(run.bundle))
    expect(await store.getBundleText(run.evidenceHash)).toBe(onDisk)
  })

  it('keeps the newest run per agent addressable by id', async () => {
    await store.putRun(makeRun(2211))
    const record = await store.getLatest(97, 2211)
    expect(record?.agentId).toBe(2211)
    expect(record?.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('refuses to read a hash that is not a hash', async () => {
    expect(await store.getBundleText('../../../etc/passwd')).toBe(null)
  })

  it('sums only committed spend', async () => {
    await store.recordPublication({
      chainId: 97,
      agentId: 1,
      kind: 'reputation',
      evidenceHash: `0x${'0'.repeat(64)}`,
      txHash: '0xdead',
      costWei: '1000',
      gasUsed: '100',
      status: 'sent',
      reason: null,
      at: new Date().toISOString(),
    })
    await store.recordPublication({
      chainId: 97,
      agentId: 2,
      kind: 'hook',
      evidenceHash: `0x${'0'.repeat(64)}`,
      txHash: null,
      costWei: '999999',
      gasUsed: null,
      status: 'skipped',
      reason: 'score below floor',
      at: new Date().toISOString(),
    })
    expect(await store.totalSpentWei()).toBe(1000n)
  })

  it('records the reason for every write that did not happen', async () => {
    const entries = await store.listPublications(97)
    const skipped = entries.find((e) => e.status === 'skipped')
    expect(skipped?.reason).toBe('score below floor')
  })
})

describe('run records', () => {
  it('names the endpoint the on-chain feedback will reference', () => {
    const record = toRunRecord(makeRun(3000))
    expect(record.primaryEndpoint).toBe('https://a3000.test/mcp')
  })

  it('counts failures by class', () => {
    expect(toRunRecord(makeRun(3001, 'dead')).failures).toEqual({ 'http-4xx': 1 })
  })
})

describe('stats', () => {
  it('separates reachable from dead and never rounds a dead agent up', () => {
    const records = [makeRun(1), makeRun(2), makeRun(3, 'dead')].map(toRunRecord)
    const stats = computeStats(records)
    expect(stats.agents).toBe(3)
    expect(stats.reachable).toBe(2)
    expect(stats.failures['http-4xx']).toBe(1)
    expect(stats.score.buckets['0']).toBe(1)
    expect(formatStats(stats)).toContain('failure breakdown')
  })

  it('handles an empty store without dividing by zero', () => {
    const stats = computeStats([])
    expect(stats.agents).toBe(0)
    expect(stats.latencyMs.p50).toBe(0)
    expect(formatStats(stats)).toContain('agents probed            0')
  })
})

describe('sampling', () => {
  it('is reproducible for a given seed and ceiling', () => {
    const a = sampleAgentIds({ ceiling: 338_305, count: 50, seed: 'hallmark' })
    const b = sampleAgentIds({ ceiling: 338_305, count: 50, seed: 'hallmark' })
    expect(a).toEqual(b)
    expect(a).toHaveLength(50)
    expect(new Set(a).size).toBe(50)
  })

  it('changes with the seed', () => {
    const a = sampleAgentIds({ ceiling: 1_000, count: 20, seed: 'one' })
    const b = sampleAgentIds({ ceiling: 1_000, count: 20, seed: 'two' })
    expect(a).not.toEqual(b)
  })

  it('returns the whole range when asked for more than exists', () => {
    expect(sampleAgentIds({ ceiling: 5, count: 99, seed: 's' })).toEqual([1, 2, 3, 4, 5])
  })

  it('stays inside 1..ceiling', () => {
    const ids = sampleAgentIds({ ceiling: 2_218, count: 300, seed: 'full-testnet' })
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(1)
    expect(Math.max(...ids)).toBeLessThanOrEqual(2_218)
  })

  it('has a stable PRNG', () => {
    const rng = mulberry32(seedFrom('hallmark'))
    const first = [rng(), rng(), rng()]
    const again = mulberry32(seedFrom('hallmark'))
    expect([again(), again(), again()]).toEqual(first)
  })
})

describe('http surface', () => {
  const config = loadConfig({ env: {}, evidenceBaseUrl: 'https://hallmark-market.vercel.app/api/evidence', cronSecret: 'topsecret' })

  async function seeded() {
    const store = createMemoryStore()
    const run = makeRun(2210)
    await store.putRun(run)
    return { store, run, app: createServer({ config, store }) }
  }

  it('answers /health', async () => {
    const { app } = await seeded()
    const res = await app.request('/health')
    expect(res.status).toBe(200)
    expect((await res.json()).service).toBe('hallmark-prober')
  })

  it('serves a bundle byte-identically to what was hashed', async () => {
    const { app, run } = await seeded()
    const res = await app.request(`/api/evidence/${run.evidenceHash}`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(canonicalBundleJson(run.bundle))
    expect(res.headers.get('x-evidence-hash')).toBe(run.evidenceHash)
  })

  it('404s an unknown hash and 400s a malformed one', async () => {
    const { app } = await seeded()
    expect((await app.request(`/api/evidence/0x${'0'.repeat(64)}`)).status).toBe(404)
    expect((await app.request('/api/evidence/not-a-hash')).status).toBe(400)
  })

  it('refuses to serve a bundle that no longer matches its own hash', async () => {
    const store = createMemoryStore()
    const run = makeRun(2210)
    await store.putRun(run)
    // Corrupt the stored document behind the store's back.
    const tampered = createMemoryStore()
    await tampered.putRun(run)
    const corrupt: typeof store = {
      ...tampered,
      getBundleText: async () => '{"version":1}',
    }
    const app = createServer({ config, store: corrupt })
    const res = await app.request(`/api/evidence/${run.evidenceHash}`)
    expect(res.status).toBe(500)
  })

  it('returns the latest evidence for an agent', async () => {
    const { app } = await seeded()
    const res = await app.request('/api/agents/97/2210/evidence')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.record.agentId).toBe(2210)
    expect(body.evidenceUri).toMatch(/^https:\/\/hallmark-market\.vercel\.app\/api\/evidence\/0x/)
  })

  it('rejects an unsupported chain', async () => {
    const { app } = await seeded()
    expect((await app.request('/api/agents/1/2210/evidence')).status).toBe(400)
  })

  it('aggregates /api/stats', async () => {
    const { app } = await seeded()
    const body = await (await app.request('/api/stats')).json()
    expect(body.agents).toBe(1)
  })

  it('guards the cron route with a bearer token', async () => {
    const { app } = await seeded()
    expect((await app.request('/api/cron/sweep', { method: 'POST' })).status).toBe(401)
    expect(
      (await app.request('/api/cron/sweep', { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401)
  })

  it('disables the cron route entirely when no secret is configured', async () => {
    const store = createMemoryStore()
    const app = createServer({ config: loadConfig({ env: {}, cronSecret: null }), store })
    const res = await app.request('/api/cron/sweep', {
      method: 'POST',
      headers: { authorization: 'Bearer anything' },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/not configured/)
  })
})
