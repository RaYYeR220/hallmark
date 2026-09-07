import { describe, expect, it } from 'vitest'

import { a2aCardProblem, parseA2ACard, probeA2A } from '../src/probe/a2a.ts'
import type { A2ACard } from '../src/probe/a2a.ts'
import { extractToolNames, isInitializeResult, parseJsonRpcBody, probeMcp, sseFrames } from '../src/probe/mcp.ts'
import { parseX402Challenge, probeX402 } from '../src/probe/x402.ts'
import { probeWeb } from '../src/probe/web.ts'
import { stubFetch, stubResolver, transportError } from './helpers.ts'

const base = { checkDns: true, resolver: stubResolver(), timeoutMs: 500 }

const AGENT_CARD = JSON.stringify({
  name: 'Rebalancer',
  description: 'Keeps an LP position in range',
  protocolVersion: '0.3.0',
  url: 'https://agent.test/a2a',
  capabilities: { streaming: true, pushNotifications: false },
  skills: [
    { id: 'rebalance', name: 'rebalance', description: 'move the range' },
    { id: 'quote', name: 'quote' },
  ],
})

describe('A2A', () => {
  it('accepts a card with a name and skills', () => {
    const card = parseA2ACard(AGENT_CARD)
    expect(card?.name).toBe('Rebalancer')
    expect(card?.skills).toEqual(['rebalance', 'quote'])
    expect(card?.capabilities).toEqual(['streaming'])
  })

  /**
   * The 23x error. A census of 6,000 BSC agents found 506 serving a
   * well-formed card that announces it has nothing to offer. These must never
   * read as alive.
   */
  describe('strict liveness rule', () => {
    const hollow = JSON.stringify({
      name: 'Ghost Agent',
      description: 'coming soon',
      skills: [],
      endpoint: null,
      presence: 'offline',
    })

    it('parses the hollow card structurally but refuses to call it live', () => {
      const card = parseA2ACard(hollow)
      expect(card).not.toBe(null)
      expect(a2aCardProblem(card as A2ACard)).toMatch(/offline|inactive/)
    })

    it('refuses a card with an empty skills array and no capabilities', () => {
      const card = parseA2ACard(JSON.stringify({ name: 'Empty', skills: [] }))
      expect(a2aCardProblem(card as A2ACard)).toMatch(/no skills and no enabled capabilities/)
    })

    it('refuses a card whose capabilities are all switched off', () => {
      const card = parseA2ACard(JSON.stringify({ name: 'Off', capabilities: { streaming: false } }))
      expect(a2aCardProblem(card as A2ACard)).toMatch(/no skills and no enabled capabilities/)
    })

    it('refuses a card that declares a null endpoint', () => {
      const card = parseA2ACard(JSON.stringify({ name: 'Nulled', skills: [{ name: 'quote' }], url: null }))
      expect(a2aCardProblem(card as A2ACard)).toMatch(/null endpoint/)
    })

    it('refuses a card that says active: false', () => {
      const card = parseA2ACard(JSON.stringify({ name: 'Off', skills: [{ name: 'quote' }], active: false }))
      expect(a2aCardProblem(card as A2ACard)).toMatch(/offline or inactive/)
    })

    it('accepts a card that actually declares something callable', () => {
      expect(a2aCardProblem(parseA2ACard(AGENT_CARD) as A2ACard)).toBe(null)
    })

    it('scores the hollow card as bad-protocol end to end, not as reachable', async () => {
      const stub = stubFetch({}, { status: 200, body: hollow })
      const outcome = await probeA2A('https://ghost.test/a2a', { ...base, fetchImpl: stub.fetch })
      expect(outcome.ok).toBe(false)
      expect(outcome.failure).toBe('bad-protocol')
      expect(outcome.capabilities.a2aSkills).toBeUndefined()
    })
  })

  it('rejects JSON that is not an agent card', () => {
    expect(parseA2ACard('{"status":"ok"}')).toBe(null)
    expect(parseA2ACard('{"skills":["x"]}')).toBe(null)
    expect(parseA2ACard('[]')).toBe(null)
    expect(parseA2ACard('not json')).toBe(null)
  })

  it('captures the declared skill names from a direct hit', async () => {
    const stub = stubFetch({ 'https://agent.test/a2a': { body: AGENT_CARD } })
    const outcome = await probeA2A('https://agent.test/a2a', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(true)
    expect(outcome.protocolOk).toBe(true)
    expect(outcome.capabilities.a2aSkills).toContain('rebalance')
  })

  it('falls back to the well-known path when the endpoint is a service root', async () => {
    const stub = stubFetch({
      'https://agent.test/': { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><body>hi</body></html>' },
      'https://agent.test/.well-known/agent-card.json': { body: AGENT_CARD },
    })
    const outcome = await probeA2A('https://agent.test/', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(true)
    expect(outcome.requests.length).toBe(2)
    expect(outcome.requests[1]?.url).toBe('https://agent.test/.well-known/agent-card.json')
  })

  it('classifies an HTML page served where a card was declared as not-json', async () => {
    const stub = stubFetch({}, { status: 200, headers: { 'content-type': 'text/html' }, body: '<!doctype html><html></html>' })
    const outcome = await probeA2A('https://agent.test/a2a', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(false)
    expect(outcome.failure).toBe('not-json')
    expect(outcome.detail).toMatch(/HTML/)
  })

  it('classifies a 200 JSON body that is not a card as bad-protocol', async () => {
    const stub = stubFetch({}, { status: 200, body: '{"status":"ok"}' })
    const outcome = await probeA2A('https://agent.test/a2a', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(false)
    expect(outcome.failure).toBe('bad-protocol')
  })

  it('does not retry the well-known paths after a host-level failure', async () => {
    const stub = stubFetch({}, { throws: transportError('ENOTFOUND') })
    const outcome = await probeA2A('https://agent.test/', { ...base, fetchImpl: stub.fetch })
    expect(outcome.failure).toBe('dns')
    // One attempt, retried once by httpRequestWithRetry, and then it stops.
    expect(outcome.requests.length).toBe(1)
  })
})

describe('MCP', () => {
  const initResult = {
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } },
  }
  const toolsResult = {
    jsonrpc: '2.0',
    id: 2,
    result: { tools: [{ name: 'search' }, { name: 'fetch' }] },
  }

  it('splits an SSE body into frames', () => {
    const body = 'event: message\ndata: {"a":1}\n\nevent: message\ndata: {"b":\ndata: 2}\n\n'
    expect(sseFrames(body)).toEqual(['{"a":1}', '{"b":\n2}'])
  })

  it('parses a JSON-RPC response out of an SSE frame', () => {
    const body = `event: message\ndata: ${JSON.stringify(initResult)}\n\n`
    const parsed = parseJsonRpcBody(body, 'text/event-stream', 1)
    expect(parsed?.result).toBeDefined()
  })

  it('ignores SSE frames whose id does not match', () => {
    const body = `data: ${JSON.stringify({ jsonrpc: '2.0', id: 9, result: {} })}\n\ndata: ${JSON.stringify(toolsResult)}\n\n`
    const parsed = parseJsonRpcBody(body, 'text/event-stream', 2)
    expect(extractToolNames(parsed?.result)).toEqual(['search', 'fetch'])
  })

  it('completes the handshake over plain JSON and captures tool names', async () => {
    const stub = stubFetch({}, (_url, init) => {
      const body = String(init?.body ?? '')
      if (body.includes('initialize')) {
        return { body: JSON.stringify(initResult), headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } }
      }
      if (body.includes('tools/list')) return { body: JSON.stringify(toolsResult) }
      return { status: 202, body: '' }
    })

    const outcome = await probeMcp('https://mcp.test/mcp', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(true)
    expect(outcome.protocolOk).toBe(true)
    expect(outcome.capabilities.mcpTools).toEqual(['search', 'fetch'])
    expect(stub.calls[2]?.headers['mcp-session-id']).toBe('sess-1')
    expect(stub.calls[0]?.body).toContain('2025-06-18')
    expect(stub.calls[0]?.body).toContain('hallmark-prober')
  })

  it('completes the handshake over SSE framing', async () => {
    const stub = stubFetch({}, (_url, init) => {
      const body = String(init?.body ?? '')
      const headers = { 'content-type': 'text/event-stream' }
      if (body.includes('initialize')) return { headers, body: `event: message\ndata: ${JSON.stringify(initResult)}\n\n` }
      if (body.includes('tools/list')) return { headers, body: `event: message\ndata: ${JSON.stringify(toolsResult)}\n\n` }
      return { status: 202, body: '' }
    })

    const outcome = await probeMcp('https://mcp.test/sse', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(true)
    expect(outcome.capabilities.mcpTools).toEqual(['search', 'fetch'])
  })

  it('classifies a 200 that is not JSON-RPC as bad-protocol', async () => {
    const stub = stubFetch({}, { body: '{"hello":"world"}' })
    const outcome = await probeMcp('https://mcp.test/mcp', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(false)
    expect(outcome.failure).toBe('bad-protocol')
  })

  it('refuses an empty JSON-RPC result, which any endpoint could echo', async () => {
    const stub = stubFetch({}, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
    const outcome = await probeMcp('https://echo.test/mcp', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(false)
    expect(outcome.failure).toBe('bad-protocol')
    expect(outcome.detail).toMatch(/not an MCP server/)
  })

  it('accepts a result that names only serverInfo', () => {
    expect(isInitializeResult({ serverInfo: { name: 'x', version: '1' } })).toBe(true)
    expect(isInitializeResult({ capabilities: {} })).toBe(false)
    expect(isInitializeResult({})).toBe(false)
    expect(isInitializeResult(null)).toBe(false)
  })

  it('classifies an HTML page served where MCP was declared as not-json', async () => {
    const stub = stubFetch({}, { headers: { 'content-type': 'text/html' }, body: '<html>nope</html>' })
    const outcome = await probeMcp('https://mcp.test/mcp', { ...base, fetchImpl: stub.fetch })
    expect(outcome.failure).toBe('not-json')
  })

  it('reports a JSON-RPC error on initialize as bad-protocol', async () => {
    const stub = stubFetch({}, { body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'nope' } }) })
    const outcome = await probeMcp('https://mcp.test/mcp', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toMatch(/-32600/)
  })

  it('stays reachable when initialize works but tools/list refuses', async () => {
    const stub = stubFetch({}, (_url, init) => {
      const body = String(init?.body ?? '')
      if (body.includes('initialize')) return { body: JSON.stringify(initResult) }
      if (body.includes('tools/list')) return { status: 403, body: 'no' }
      return { status: 202, body: '' }
    })
    const outcome = await probeMcp('https://mcp.test/mcp', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(true)
    expect(outcome.capabilities.mcpTools).toBeUndefined()
    expect(outcome.detail).toMatch(/tools\/list failed/)
  })
})

describe('x402', () => {
  const v1Body = JSON.stringify({
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    accepts: [
      {
        scheme: 'exact',
        network: 'bsc',
        maxAmountRequired: '10000',
        resource: 'https://pay.test/quote',
        description: 'one quote',
        mimeType: 'application/json',
        payTo: '0x1111111111111111111111111111111111111111',
        maxTimeoutSeconds: 60,
        asset: '0x55d398326f99059fF775485246999027B3197955',
      },
    ],
  })

  const v2Document = {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:56',
        maxAmountRequired: '2500',
        payTo: '0x2222222222222222222222222222222222222222',
        asset: '0x55d398326f99059fF775485246999027B3197955',
        maxTimeoutSeconds: 120,
        resource: 'https://pay.test/v2',
      },
    ],
  }

  it('parses a v1 challenge from the 402 body', () => {
    const parsed = parseX402Challenge({ status: 402, headers: { 'content-type': 'application/json' }, body: v1Body })
    expect(parsed?.source).toBe('body')
    expect(parsed?.challenge).toMatchObject({
      x402Version: 1,
      scheme: 'exact',
      network: 'bsc',
      priceAtomic: '10000',
      payTo: '0x1111111111111111111111111111111111111111',
      maxTimeoutSeconds: 60,
    })
  })

  it('parses a v2 challenge from the base64 PAYMENT-REQUIRED header', () => {
    const encoded = Buffer.from(JSON.stringify(v2Document)).toString('base64')
    const parsed = parseX402Challenge({ status: 402, headers: { 'payment-required': encoded }, body: '' })
    expect(parsed?.source).toBe('header:payment-required')
    expect(parsed?.challenge.x402Version).toBe(2)
    expect(parsed?.challenge.priceAtomic).toBe('2500')
    expect(parsed?.challenge.network).toBe('eip155:56')
  })

  it('parses a base64url PAYMENT-REQUIRED header', () => {
    const encoded = Buffer.from(JSON.stringify(v2Document)).toString('base64url')
    const parsed = parseX402Challenge({ status: 402, headers: { 'PAYMENT-REQUIRED': encoded }, body: '' })
    expect(parsed?.challenge.payTo).toBe('0x2222222222222222222222222222222222222222')
  })

  it('parses an X-PAYMENT-shaped header', () => {
    const encoded = Buffer.from(v1Body).toString('base64')
    const parsed = parseX402Challenge({ status: 402, headers: { 'x-payment': encoded }, body: '' })
    expect(parsed?.source).toBe('header:x-payment')
    expect(parsed?.challenge.priceAtomic).toBe('10000')
  })

  it('parses a WWW-Authenticate payment challenge', () => {
    const encoded = Buffer.from(v1Body).toString('base64')
    const parsed = parseX402Challenge({
      status: 402,
      headers: { 'www-authenticate': `Payment challenge="${encoded}"` },
      body: '',
    })
    expect(parsed?.source).toBe('header:www-authenticate')
  })

  it('returns null for a 402 that carries unrelated JSON', () => {
    const parsed = parseX402Challenge({ status: 402, headers: {}, body: '{"error":"pay up"}' })
    expect(parsed).toBe(null)
  })

  it('treats a well-formed 402 as reachable and records the price', async () => {
    const stub = stubFetch({}, { status: 402, headers: { 'content-type': 'application/json' }, body: v1Body })
    const outcome = await probeX402('https://pay.test/quote', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(true)
    expect(outcome.protocolOk).toBe(true)
    expect(outcome.capabilities.x402?.priceAtomic).toBe('10000')
  })

  it('flags a 402 with no parseable challenge as bad-protocol', async () => {
    const stub = stubFetch({}, { status: 402, body: 'pay me' })
    const outcome = await probeX402('https://pay.test/quote', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(false)
    expect(outcome.failure).toBe('bad-protocol')
  })

  /**
   * `https://x402.org/protected`, the reference endpoint, answers 402 with an
   * empty `{}` body and puts the whole challenge in a base64 `payment-required`
   * header. A parser that only reads the body calls every current x402 agent
   * broken.
   */
  describe('the v2 reference shape: empty body, challenge in the header', () => {
    const referenceDocument = {
      x402Version: 2,
      error: 'payment required',
      resource: { url: 'https://x402.org/protected', description: 'protected resource', mimeType: 'application/json' },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:56',
          amount: '10000',
          asset: '0x55d398326f99059fF775485246999027B3197955',
          payTo: '0x3333333333333333333333333333333333333333',
          maxTimeoutSeconds: 300,
        },
      ],
    }

    it('reads the challenge out of the header when the body is {}', () => {
      const parsed = parseX402Challenge({
        status: 402,
        headers: { 'content-type': 'application/json', 'payment-required': Buffer.from(JSON.stringify(referenceDocument)).toString('base64') },
        body: '{}',
      })
      expect(parsed?.source).toBe('header:payment-required')
      expect(parsed?.challenge).toMatchObject({
        x402Version: 2,
        scheme: 'exact',
        network: 'eip155:56',
        priceAtomic: '10000',
        asset: '0x55d398326f99059fF775485246999027B3197955',
        payTo: '0x3333333333333333333333333333333333333333',
        maxTimeoutSeconds: 300,
        resource: 'https://x402.org/protected',
      })
    })

    it('reads the challenge out of the header when the body is empty', () => {
      const parsed = parseX402Challenge({
        status: 402,
        headers: { 'Payment-Required': Buffer.from(JSON.stringify(referenceDocument)).toString('base64') },
        body: '',
      })
      expect(parsed?.challenge.priceAtomic).toBe('10000')
    })

    it('defaults an unversioned header document to v2, since that is the v2 wire form', () => {
      const { x402Version: _dropped, ...unversioned } = referenceDocument
      const parsed = parseX402Challenge({
        status: 402,
        headers: { 'payment-required': Buffer.from(JSON.stringify(unversioned)).toString('base64') },
        body: '{}',
      })
      expect(parsed?.challenge.x402Version).toBe(2)
    })

    it('scores the reference shape as a positive capability, not as broken', async () => {
      const stub = stubFetch({}, {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'payment-required': Buffer.from(JSON.stringify(referenceDocument)).toString('base64'),
        },
        body: '{}',
      })
      const outcome = await probeX402('https://x402.test/protected', { ...base, fetchImpl: stub.fetch })
      expect(outcome.ok).toBe(true)
      expect(outcome.protocolOk).toBe(true)
      expect(outcome.capabilities.x402?.network).toBe('eip155:56')
    })

    it('still refuses a 402 with an empty body and no header, so x402 cannot pass vacuously', async () => {
      const stub = stubFetch({}, { status: 402, headers: { 'content-type': 'application/json' }, body: '{}' })
      const outcome = await probeX402('https://empty.test/protected', { ...base, fetchImpl: stub.fetch })
      expect(outcome.ok).toBe(false)
      expect(outcome.failure).toBe('bad-protocol')
      expect(outcome.capabilities.x402).toBeUndefined()
    })

    it('follows the www -> apex redirect with the guard applied on the second hop', async () => {
      const stub = stubFetch({
        'https://www.x402.test/protected': { status: 301, headers: { location: 'https://x402.test/protected' } },
        'https://x402.test/protected': {
          status: 402,
          headers: { 'payment-required': Buffer.from(JSON.stringify(referenceDocument)).toString('base64') },
          body: '{}',
        },
      })
      const outcome = await probeX402('https://www.x402.test/protected', { ...base, fetchImpl: stub.fetch })
      expect(outcome.ok).toBe(true)
      expect(outcome.requests[0]?.redirects).toBe(1)
    })

    it('refuses a redirect that lands on a private host, even mid-chain', async () => {
      const stub = stubFetch({
        'https://www.x402.test/protected': { status: 301, headers: { location: 'http://169.254.169.254/' } },
      })
      const outcome = await probeX402('https://www.x402.test/protected', { ...base, fetchImpl: stub.fetch })
      expect(outcome.failure).toBe('blocked')
      expect(stub.calls).toHaveLength(1)
    })
  })

  it('flags an x402 endpoint that just returns 200 as bad-protocol', async () => {
    const stub = stubFetch({}, { status: 200, body: '{"data":1}' })
    const outcome = await probeX402('https://pay.test/quote', { ...base, fetchImpl: stub.fetch })
    expect(outcome.failure).toBe('bad-protocol')
  })

  it('picks up a 402 challenge on a plain web endpoint', async () => {
    const stub = stubFetch({}, { status: 402, headers: { 'content-type': 'application/json' }, body: v1Body })
    const outcome = await probeWeb('https://site.test/', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(true)
    expect(outcome.capabilities.x402?.payTo).toBe('0x1111111111111111111111111111111111111111')
  })
})

describe('web', () => {
  it('passes a 200 with a body', async () => {
    const stub = stubFetch({}, { headers: { 'content-type': 'text/html' }, body: '<html><body>hi</body></html>' })
    const outcome = await probeWeb('https://site.test/', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(true)
    expect(outcome.protocolOk).toBe(true)
    expect(outcome.detail).toMatch(/^html/)
  })

  it('marks an empty 200 as reachable but not conformant', async () => {
    const stub = stubFetch({}, { status: 204, body: '' })
    const outcome = await probeWeb('https://site.test/', { ...base, fetchImpl: stub.fetch })
    expect(outcome.ok).toBe(true)
    expect(outcome.protocolOk).toBe(false)
  })
})
