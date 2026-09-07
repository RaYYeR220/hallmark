/**
 * The strict metric.
 *
 * "Reachable" and "protocol-live" are different questions and the gap between
 * them is where a marketplace gets lied to. An agent whose only working
 * endpoint is a web page that returns HTML is reachable and is not an agent.
 * Every case below pins one edge of that line.
 */

import { describe, expect, it } from 'vitest'

import { probeA2A } from '../src/probe/a2a.ts'
import { probeMcp } from '../src/probe/mcp.ts'
import { probeWeb } from '../src/probe/web.ts'
import { probeX402 } from '../src/probe/x402.ts'
import { computeStats, formatStats } from '../src/stats.ts'
import { toRunRecord } from '../src/store.ts'
import { buildEvidenceBundle, bundleHash } from '../src/evidence.ts'
import type { EndpointProbe, ProbeCapabilities, ProbeRun } from '../src/types.ts'
import { endpointProbe, stubFetch, stubResolver } from './helpers.ts'

const base = { checkDns: true, resolver: stubResolver(), timeoutMs: 500 }

function runWith(agentId: number, probe: EndpointProbe[], capabilities: ProbeCapabilities = {}): ProbeRun {
  const bundle = buildEvidenceBundle({
    chainId: 56,
    agentId,
    probe,
    capabilities,
    observed: { blockNumber: 1, blockTimestamp: 2 },
    agent: { owner: null, tokenUriKind: 'data-json', name: null, cardError: null, cardWarnings: [] },
    probedAt: '2026-09-07T12:00:00.000Z',
  })
  return {
    chainId: 56,
    agentId,
    probedAt: bundle.probedAt,
    score: bundle.score,
    breakdown: bundle.breakdown,
    evidenceHash: bundleHash(bundle),
    bundle,
    elapsedMs: 1,
  }
}

describe('a web face is never protocol-live', () => {
  it('a healthy HTML page is reachable, conformant, and not an agent', async () => {
    const stub = stubFetch({}, {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html><html><body>Our AI agent is coming soon</body></html>',
    })
    const outcome = await probeWeb('https://landing.test/', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(true)
    expect(outcome.protocolOk).toBe(true)
    expect(outcome.protocolLive).toBe(false)
  })

  it('a healthy JSON API that is not an agent protocol is still not protocol-live', async () => {
    const stub = stubFetch({}, { status: 200, body: '{"status":"ok","uptime":123}' })
    const outcome = await probeWeb('https://api.test/health', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(true)
    expect(outcome.protocolLive).toBe(false)
  })

  it('but a web endpoint serving a real 402 challenge is protocol-live', async () => {
    const document = {
      x402Version: 2,
      accepts: [{ scheme: 'exact', network: 'eip155:56', amount: '1', asset: '0xa', payTo: '0xb' }],
    }
    const stub = stubFetch({}, {
      status: 402,
      headers: { 'payment-required': Buffer.from(JSON.stringify(document)).toString('base64') },
      body: '{}',
    })
    const outcome = await probeWeb('https://paid.test/', { ...base, fetchImpl: stub.fetch })
    expect(outcome.protocolLive).toBe(true)
  })
})

describe('A2A: skills, not capabilities, decide protocol-live', () => {
  it('a card with real skills is protocol-live', async () => {
    const card = JSON.stringify({ name: 'Live', skills: [{ id: 'quote', name: 'quote' }] })
    const stub = stubFetch({ 'https://a.test/a2a': { body: card } })
    const outcome = await probeA2A('https://a.test/a2a', { ...base, fetchImpl: stub.fetch })
    expect(outcome.protocolOk).toBe(true)
    expect(outcome.protocolLive).toBe(true)
  })

  it('a card with only enabled capabilities is valid but not protocol-live', async () => {
    // Valid enough to parse and pass `a2aCardProblem`, but it declares nothing
    // to actually call. The census counts skills.
    const card = JSON.stringify({ name: 'Streamer', capabilities: { streaming: true }, skills: [] })
    const stub = stubFetch({ 'https://b.test/a2a': { body: card } })
    const outcome = await probeA2A('https://b.test/a2a', { ...base, fetchImpl: stub.fetch })
    expect(outcome.protocolOk).toBe(true)
    expect(outcome.protocolLive).toBe(false)
  })

  it('the hollow card is neither', async () => {
    const card = JSON.stringify({ name: 'Ghost', skills: [], endpoint: null, presence: 'offline' })
    const stub = stubFetch({}, { body: card })
    const outcome = await probeA2A('https://c.test/a2a', { ...base, fetchImpl: stub.fetch })
    expect(outcome.protocolOk).toBe(false)
    expect(outcome.protocolLive).toBe(false)
  })
})

describe('MCP: a greeting is not an inventory', () => {
  const initResult = {
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-06-18', serverInfo: { name: 'demo', version: '1' } },
  }

  function server(tools: unknown) {
    return stubFetch({}, (_url, init) => {
      const body = String(init?.body ?? '')
      if (body.includes('initialize')) return { body: JSON.stringify(initResult) }
      if (body.includes('tools/list')) return { body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools } }) }
      return { status: 202, body: '' }
    })
  }

  it('is protocol-live when it enumerates at least one tool', async () => {
    const outcome = await probeMcp('https://m.test/mcp', { ...base, fetchImpl: server([{ name: 'search' }]).fetch })
    expect(outcome.protocolLive).toBe(true)
  })

  it('is conformant but not protocol-live when the tool list is empty', async () => {
    const outcome = await probeMcp('https://m.test/mcp', { ...base, fetchImpl: server([]).fetch })
    expect(outcome.ok).toBe(true)
    expect(outcome.protocolOk).toBe(true)
    expect(outcome.protocolLive).toBe(false)
  })

  it('is not protocol-live when tools/list fails after a good handshake', async () => {
    const stub = stubFetch({}, (_url, init) => {
      const body = String(init?.body ?? '')
      if (body.includes('initialize')) return { body: JSON.stringify(initResult) }
      if (body.includes('tools/list')) return { status: 500, body: 'boom' }
      return { status: 202, body: '' }
    })
    const outcome = await probeMcp('https://m.test/mcp', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(true)
    expect(outcome.protocolLive).toBe(false)
  })
})

describe('x402: a decodable challenge is the whole test', () => {
  it('is protocol-live on a decodable 402', async () => {
    const document = { x402Version: 1, accepts: [{ scheme: 'exact', network: 'bsc', maxAmountRequired: '5', payTo: '0xa', asset: '0xb' }] }
    const stub = stubFetch({}, { status: 402, body: JSON.stringify(document) })
    const outcome = await probeX402('https://p.test/x', { ...base, fetchImpl: stub.fetch })
    expect(outcome.protocolLive).toBe(true)
  })

  it('is not protocol-live on a 402 with nothing decodable', async () => {
    const stub = stubFetch({}, { status: 402, body: '{}' })
    const outcome = await probeX402('https://p.test/x', { ...base, fetchImpl: stub.fetch })
    expect(outcome.protocolLive).toBe(false)
  })
})

describe('the funnel', () => {
  it('counts reachable and protocol-live separately', () => {
    const records = [
      // reachable via a web page only — the false-alive case
      toRunRecord(runWith(1, [endpointProbe({ kind: 'web', protocolLive: false })])),
      // reachable and genuinely live
      toRunRecord(runWith(2, [endpointProbe({ kind: 'mcp', protocolLive: true })], { mcpTools: ['a'] })),
      // declares a2a, does not answer
      toRunRecord(
        runWith(3, [endpointProbe({ kind: 'a2a', ok: false, protocolOk: false, protocolLive: false, failure: 'dns' })]),
      ),
    ]

    const stats = computeStats(records)
    expect(stats.agents).toBe(3)
    expect(stats.reachable).toBe(2)
    expect(stats.protocolLiveAgents).toBe(1)
    // a2a and mcp declare a machine-callable protocol; a bare web face does not.
    expect(stats.declaringAgents).toBe(2)
    expect(stats.protocolLiveByKind).toEqual({ mcp: 1 })
  })

  it('reports the hosts behind the live agents', () => {
    const records = [
      toRunRecord(runWith(1, [endpointProbe({ endpoint: 'https://app.example.org/mcp', kind: 'mcp', protocolLive: true })])),
      toRunRecord(runWith(2, [endpointProbe({ endpoint: 'https://app.example.org/a2a', kind: 'a2a', protocolLive: true })])),
      toRunRecord(runWith(3, [endpointProbe({ endpoint: 'https://other.example/mcp', kind: 'mcp', protocolLive: true })])),
    ]
    const stats = computeStats(records)
    expect(stats.protocolLiveAgents).toBe(3)
    // Three live agents behind two hosts: concentration the raw count hides.
    expect(stats.protocolLiveHosts).toEqual(['app.example.org', 'other.example'])
  })

  it('prints the strict number first, because that is the one we quote', () => {
    const stats = computeStats([toRunRecord(runWith(1, [endpointProbe({ kind: 'web', protocolLive: false })]))])
    expect(formatStats(stats)).toContain('PROTOCOL-LIVE (strict)')
  })

  it('never reports more protocol-live than reachable', () => {
    const records = [
      toRunRecord(runWith(1, [endpointProbe({ kind: 'web', protocolLive: false })])),
      toRunRecord(runWith(2, [endpointProbe({ kind: 'mcp', protocolLive: true })])),
    ]
    const stats = computeStats(records)
    expect(stats.protocolLiveAgents).toBeLessThanOrEqual(stats.reachable)
  })
})

describe('publishing refuses the permissive verdict by default', () => {
  async function publisherFor(record: ReturnType<typeof toRunRecord>) {
    const { createPublisher } = await import('../src/publish.ts')
    const { createMemoryStore } = await import('../src/store.ts')
    const { loadConfig } = await import('../src/config.ts')
    return {
      strict: createPublisher({
        chainId: 56,
        config: loadConfig({ env: {} }),
        store: createMemoryStore(),
        reader: { client: {}, getAgent: async () => ({ owner: '0x1', agentId: 1n, tokenUri: '', card: null }) } as never,
        dryRun: true,
        gasPriceWei: 50_000_000n,
        plannerAddress: '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab',
      }),
      loose: createPublisher({
        chainId: 56,
        config: loadConfig({ env: {} }),
        store: createMemoryStore(),
        reader: { client: {}, getAgent: async () => ({ owner: '0x1', agentId: 1n, tokenUri: '', card: null }) } as never,
        dryRun: true,
        gasPriceWei: 50_000_000n,
        requireDeclaredProtocol: false,
        plannerAddress: '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab',
      }),
      record,
    }
  }

  it('skips an agent that declares no machine-callable protocol', async () => {
    const record = toRunRecord(runWith(1, [endpointProbe({ kind: 'web', protocolLive: false, latencyMs: 50 })]))
    const { strict } = await publisherFor(record)
    const outcomes = await strict.publishReputation(record)
    const first = outcomes[0]
    expect(first?.status).toBe('skipped')
    if (first?.status === 'skipped') expect(first.reason).toMatch(/declares no machine-callable protocol/)
  })

  it('publishes a web-only agent only when explicitly told to, and only the reachable tag', async () => {
    const record = toRunRecord(runWith(1, [endpointProbe({ kind: 'web', protocolLive: false, latencyMs: 50 })]))
    const { loose } = await publisherFor(record)
    const outcomes = await loose.publishReputation(record)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.status).toBe('dry-run')
    // No successRate: there is no rate to report for an agent that declares nothing.
    expect(outcomes[0]?.plan.args[3]).toBe('reachable')
  })
})

/**
 * Regression: `resolveAgentCard` used to be handed the endpoint timeout. That
 * is a scoring boundary, not a fetch budget — it is deliberately equal to
 * `LATENCY_ZERO_MS` — and sharing it starved card resolution badly enough to
 * hide 45% of mainnet registration files, which cost 448 agents a `reachable`
 * verdict they had earned. The two deadlines must stay separate.
 */
describe('the card fetch has its own deadline', () => {
  it('defaults to something longer than the endpoint budget', async () => {
    const { DEFAULT_PROBE } = await import('../src/config.ts')
    expect(DEFAULT_PROBE.cardTimeoutMs).toBeGreaterThan(DEFAULT_PROBE.timeoutMs)
  })

  it('is read from its own environment variable', async () => {
    const { loadConfig } = await import('../src/config.ts')
    const config = loadConfig({ env: { PROBE_TIMEOUT_MS: '5000', PROBE_CARD_TIMEOUT_MS: '30000' } })
    expect(config.probe.timeoutMs).toBe(5_000)
    expect(config.probe.cardTimeoutMs).toBe(30_000)
  })

  it('resolves a slow off-chain card that the endpoint budget would have dropped', async () => {
    const { createProbeContext, probeAgent } = await import('../src/probe/index.ts')
    const { loadConfig } = await import('../src/config.ts')

    const card = JSON.stringify({
      type: 'agent',
      name: 'Slow Card',
      services: [{ name: 'a2a', endpoint: 'https://slow.test/a2a' }],
    })
    const agentCard = JSON.stringify({ name: 'Slow Card', skills: [{ name: 'quote' }] })

    // The card host takes 120ms; the endpoint budget here is 40ms. Only the
    // separate, longer card deadline lets this agent be measured at all.
    const stub = stubFetch({
      'https://cards.test/agent.json': async () => card,
      'https://slow.test/a2a': { body: agentCard },
    } as never)

    const slowFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('cards.test')) {
        await new Promise((resolve) => setTimeout(resolve, 120))
        return new Response(card, { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return stub.fetch(input, init)
    }) as typeof fetch

    const ctx = createProbeContext({
      config: loadConfig({ env: {}, probe: { timeoutMs: 40, cardTimeoutMs: 3_000, concurrency: 2 } }),
      chainId: 56,
      reader: {
        getAgent: async (agentId: bigint | number, opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }) => {
          const { resolveAgentCard } = await import('@hallmark/core')
          return {
            agentId: BigInt(agentId),
            owner: '0x1',
            tokenUri: 'https://cards.test/agent.json',
            card: await resolveAgentCard('https://cards.test/agent.json', {
              ...(opts?.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
              ...(opts?.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
            }),
          }
        },
      } as never,
      fetchImpl: slowFetch,
      resolver: stubResolver(),
      observe: async () => ({ blockNumber: 1, blockTimestamp: 2 }),
    })

    const run = await probeAgent(ctx, 1)
    expect(run.bundle.agent.cardError).toBe(null)
    expect(run.bundle.probe).toHaveLength(1)
  })
})
