import { custom } from 'viem'
import { describe, expect, it } from 'vitest'

import { probeA2A, probeMCP, probeX402 } from '../src/probes.js'
import { verifyAgent } from '../src/verify.js'
import {
  A2A_CARD,
  fakeFetch,
  jsonResponse,
  mcpInitializeResult,
  mcpToolsResult,
  publicLookup,
  sseResponse,
  validConfig,
  x402Challenge,
} from './fixtures.js'

const lookup = publicLookup

describe('probeA2A', () => {
  it('accepts a well-formed agent card served at the declared URL', async () => {
    const outcome = await probeA2A('https://example.com/.well-known/agent-card.json', {
      lookup,
      fetchImpl: fakeFetch({ 'https://example.com/.well-known/agent-card.json': () => jsonResponse(A2A_CARD) }),
    })
    expect(outcome.status).toBe('ok')
    expect(outcome.evidence['skills']).toEqual(['health-check', 'guard-position'])
  })

  it('falls back to /.well-known when the declared URL is a JSON-RPC root', async () => {
    const outcome = await probeA2A('https://example.com/a2a', {
      lookup,
      fetchImpl: fakeFetch({
        'https://example.com/a2a': () => new Response('method not allowed', { status: 405 }),
        'https://example.com/.well-known/agent-card.json': () => jsonResponse(A2A_CARD),
      }),
    })
    expect(outcome.status).toBe('ok')
    expect(outcome.finalUrl).toBe('https://example.com/.well-known/agent-card.json')
  })

  it('reports unreachable when nothing answers', async () => {
    const outcome = await probeA2A('https://example.com/a2a', { lookup, fetchImpl: fakeFetch({}) })
    expect(outcome.status).toBe('unreachable')
  })

  it('reports malformed when a page answers 200 with HTML', async () => {
    const outcome = await probeA2A('https://example.com/.well-known/agent-card.json', {
      lookup,
      fetchImpl: fakeFetch({
        'https://example.com/.well-known/agent-card.json': () =>
          new Response('<!doctype html><html><body>hi</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      }),
    })
    expect(outcome.status).toBe('malformed')
    expect(outcome.detail).toMatch(/HTML page/)
  })

  it('reports malformed when the JSON is not an agent card — the negative control', async () => {
    const outcome = await probeA2A('https://example.com/.well-known/agent-card.json', {
      lookup,
      fetchImpl: fakeFetch({
        'https://example.com/.well-known/agent-card.json': () => jsonResponse({ status: 'ok' }),
      }),
    })
    expect(outcome.status).toBe('malformed')
    expect(outcome.detail).toMatch(/no "name"/)
  })

  it('refuses a private host without sending a request', async () => {
    const outcome = await probeA2A('https://10.0.0.5/a2a', { lookup, fetchImpl: fakeFetch({}) })
    expect(outcome.status).toBe('refused')
    expect(outcome.detail).toMatch(/private/)
  })
})

describe('probeMCP', () => {
  function mcpRoutes(tools: string[], opts: { sse?: boolean } = {}) {
    const wrap = opts.sse === true ? sseResponse : jsonResponse
    return {
      'https://example.com/mcp': ({ body }: { body: string | null }) => {
        const method = body === null ? '' : (JSON.parse(body) as { method: string }).method
        if (method === 'initialize') return wrap(mcpInitializeResult())
        if (method === 'notifications/initialized') return new Response(null, { status: 202 })
        if (method === 'tools/list') return wrap(mcpToolsResult(tools))
        return jsonResponse({ jsonrpc: '2.0', error: { code: -32601, message: 'unknown method' } })
      },
    }
  }

  it('accepts a server that completes initialize and lists tools', async () => {
    const outcome = await probeMCP('https://example.com/mcp', {
      lookup,
      fetchImpl: fakeFetch(mcpRoutes(['health_check', 'guard_position'])),
    })
    expect(outcome.status).toBe('ok')
    expect(outcome.evidence['tools']).toEqual(['health_check', 'guard_position'])
  })

  it('reads an SSE-framed response, which is what real streamable-HTTP servers send', async () => {
    const outcome = await probeMCP('https://example.com/mcp', {
      lookup,
      fetchImpl: fakeFetch(mcpRoutes(['ask_question'], { sse: true })),
    })
    expect(outcome.status).toBe('ok')
    expect(outcome.evidence['tools']).toEqual(['ask_question'])
  })

  it('calls a server that exposes no tools malformed, not ok — the negative control', async () => {
    const outcome = await probeMCP('https://example.com/mcp', { lookup, fetchImpl: fakeFetch(mcpRoutes([])) })
    expect(outcome.status).toBe('malformed')
    expect(outcome.detail).toMatch(/no tools/)
  })

  it('reports the server-side JSON-RPC error rather than a generic failure', async () => {
    const outcome = await probeMCP('https://example.com/mcp', {
      lookup,
      fetchImpl: fakeFetch({
        'https://example.com/mcp': () =>
          jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'unsupported protocol version' } }),
      }),
    })
    expect(outcome.status).toBe('malformed')
    expect(outcome.detail).toMatch(/unsupported protocol version/)
  })

  it('reports unreachable when the endpoint is not there', async () => {
    const outcome = await probeMCP('https://example.com/mcp', { lookup, fetchImpl: fakeFetch({}) })
    expect(outcome.status).toBe('unreachable')
  })

  it('echoes the session id back on later calls', async () => {
    const seen: Array<string | undefined> = []
    const fetchImpl = (async (_input: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push(headers['mcp-session-id'])
      const method = typeof init?.body === 'string' ? (JSON.parse(init.body) as { method: string }).method : ''
      if (method === 'initialize') {
        return new Response(JSON.stringify(mcpInitializeResult()), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
        })
      }
      if (method === 'tools/list') return jsonResponse(mcpToolsResult(['t']))
      return new Response(null, { status: 202 })
    }) as unknown as typeof fetch

    const outcome = await probeMCP('https://example.com/mcp', { lookup, fetchImpl })
    expect(outcome.status).toBe('ok')
    expect(seen).toEqual([undefined, 'sess-1', 'sess-1'])
  })
})

describe('probeX402', () => {
  it('accepts a 402 with a payable challenge in the body', async () => {
    const outcome = await probeX402('https://example.com/x402', {
      lookup,
      fetchImpl: fakeFetch({
        'https://example.com/x402': () => jsonResponse(x402Challenge(), { status: 402 }),
      }),
    })
    expect(outcome.status).toBe('ok')
    expect(outcome.evidence['network']).toBe('eip155:56')
  })

  it('accepts the v2 form, where the challenge rides in a base64 payment-required header', async () => {
    const challenge = {
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '10000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        },
      ],
    }
    const encoded = Buffer.from(JSON.stringify(challenge), 'utf8').toString('base64')
    const outcome = await probeX402('https://example.com/x402', {
      lookup,
      fetchImpl: fakeFetch({
        'https://example.com/x402': () =>
          new Response('{}', { status: 402, headers: { 'payment-required': encoded } }),
      }),
    })
    expect(outcome.status).toBe('ok')
    expect(outcome.evidence['priceAtomic']).toBe('10000')
  })

  it('calls a 200 malformed: a paid endpoint that serves anonymous traffic is not charging', async () => {
    const outcome = await probeX402('https://example.com/x402', {
      lookup,
      fetchImpl: fakeFetch({ 'https://example.com/x402': () => jsonResponse({ data: 'free!' }) }),
    })
    expect(outcome.status).toBe('malformed')
    expect(outcome.detail).toMatch(/must answer 402/)
  })

  it('calls a 402 with no accepts array malformed', async () => {
    const outcome = await probeX402('https://example.com/x402', {
      lookup,
      fetchImpl: fakeFetch({
        'https://example.com/x402': () => jsonResponse({ error: 'pay me' }, { status: 402 }),
      }),
    })
    expect(outcome.status).toBe('malformed')
    expect(outcome.detail).toMatch(/no "accepts"/)
  })

  it('calls a 402 with an unpayable accepts entry malformed — the negative control', async () => {
    const outcome = await probeX402('https://example.com/x402', {
      lookup,
      fetchImpl: fakeFetch({
        'https://example.com/x402': () =>
          jsonResponse({ x402Version: 1, accepts: [{ scheme: 'exact' }] }, { status: 402 }),
      }),
    })
    expect(outcome.status).toBe('malformed')
    expect(outcome.detail).toMatch(/none of which names/)
  })
})

describe('verifyAgent from a config', () => {
  const config = validConfig({
    services: {
      a2a: 'https://example.com/.well-known/agent-card.json',
      mcp: 'https://example.com/mcp',
      x402: 'https://example.com/x402',
      web: 'https://example.com',
    },
    pricing: { model: 'x402', amount: '0.5', asset: '$U' },
  })

  const allGood = fakeFetch({
    'https://example.com/.well-known/agent-card.json': () => jsonResponse(A2A_CARD),
    'https://example.com/mcp': ({ body }) => {
      const method = body === null ? '' : (JSON.parse(body) as { method: string }).method
      if (method === 'initialize') return jsonResponse(mcpInitializeResult())
      if (method === 'tools/list') return jsonResponse(mcpToolsResult(['health_check']))
      return new Response(null, { status: 202 })
    },
    'https://example.com/x402': () => jsonResponse(x402Challenge(), { status: 402 }),
    'https://example.com/': () => new Response('<html></html>', { status: 200 }),
  })

  it('reports ready when everything answers', async () => {
    const report = await verifyAgent({ config, lookup, fetchImpl: allGood })
    expect(report.verdict).toBe('ready')
    expect(report.endpoints.map((check) => check.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(report.findings.filter((finding) => finding.severity === 'error')).toHaveLength(0)
  })

  it('reports degraded when one endpoint is wrong', async () => {
    const report = await verifyAgent({
      config,
      lookup,
      fetchImpl: fakeFetch({
        'https://example.com/.well-known/agent-card.json': () => jsonResponse(A2A_CARD),
        'https://example.com/mcp': ({ body }) => {
          const method = body === null ? '' : (JSON.parse(body) as { method: string }).method
          if (method === 'initialize') return jsonResponse(mcpInitializeResult())
          if (method === 'tools/list') return jsonResponse(mcpToolsResult([]))
          return new Response(null, { status: 202 })
        },
        'https://example.com/x402': () => jsonResponse(x402Challenge(), { status: 402 }),
        'https://example.com/': () => new Response('ok', { status: 200 }),
      }),
    })
    expect(report.verdict).toBe('degraded')
    expect(report.findings.some((finding) => finding.code === 'mcp_malformed')).toBe(true)
  })

  it('reports unhireable when no machine endpoint answers', async () => {
    const report = await verifyAgent({
      config,
      lookup,
      fetchImpl: fakeFetch({ 'https://example.com/': () => new Response('ok', { status: 200 }) }),
    })
    expect(report.verdict).toBe('unhireable')
  })

  it('reports unhireable when only a web page is declared', async () => {
    const report = await verifyAgent({
      endpoints: { web: 'https://example.com' },
      lookup,
      fetchImpl: fakeFetch({ 'https://example.com/': () => new Response('ok', { status: 200 }) }),
    })
    expect(report.verdict).toBe('unhireable')
    expect(report.findings.some((finding) => finding.code === 'no_machine_endpoint')).toBe(true)
  })

  it('does not fabricate a verdict when the registry cannot be read', async () => {
    const report = await verifyAgent({
      agentId: 1n,
      chainId: 97,
      lookup,
      fetchImpl: allGood,
      transport: custom({
        request: async () => {
          throw new Error('no network in tests')
        },
      }),
    })
    expect(report.verdict).toBe('unhireable')
    expect(report.findings.some((finding) => finding.code === 'not_registered')).toBe(true)
    expect(report.endpoints).toHaveLength(0)
  })

  it('has no content-addressed bundle without an agent id, and says so by returning null', async () => {
    const report = await verifyAgent({ endpoints: config.services, chainId: 97, lookup, fetchImpl: allGood })
    expect(report.evidence).toBeNull()
    expect(report.verdict).toBe('ready')
  })
})
