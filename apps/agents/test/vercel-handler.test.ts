import { PassThrough, Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'

import { absoluteUrl, createHandler, readBody } from '../api/index.js'
import { buildApp } from '../src/app.js'
import { createMemoryStore } from '../src/runtime/store.js'
import { providerFor, testConfig } from './support/fixtures.js'

/**
 * The serverless entry point, exercised through the handler `api/index.ts`
 * actually exports.
 *
 * This file exists because of a production failure the whole rest of the suite
 * missed: `POST /mcp/{slug}` never answered on Vercel while passing every
 * local test, because the local tests drove `app.fetch` directly and the
 * deployed adapter built the request body from a stream Vercel had already
 * drained. Testing the app is not testing the deployment.
 *
 * So every case here goes through `createHandler`, and the important ones
 * reproduce the exact shape Vercel's Node runtime hands over: `req.body`
 * already parsed, the stream already consumed.
 */

const config = testConfig()

function handler() {
  return createHandler({
    app: buildApp({ config, store: createMemoryStore(), sessions: providerFor(null) }),
    timeouts: { body: 500, skill: 2_000, request: 3_000 },
  })
}

type MockRequestOptions = {
  method?: string
  url: string
  headers?: Record<string, string>
  payload?: string
  /**
   * Reproduce Vercel: the platform parses the body onto `req.body` and the
   * stream arrives spent. This is the case that broke production.
   */
  platformParsed?: boolean
  /** A stream that never ends, to prove the body read cannot hang. */
  neverEnds?: boolean
}

function mockRequest(opts: MockRequestOptions) {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {
    host: 'agents.test',
    'x-forwarded-proto': 'https',
    ...(opts.payload === undefined ? {} : { 'content-type': 'application/json' }),
    ...opts.headers,
  }

  let stream: Readable
  if (opts.neverEnds) {
    // Open, quiet, and never closing — the shape of the production hang.
    stream = new PassThrough()
  } else if (opts.platformParsed) {
    // Vercel read the bytes already; what is left is an exhausted stream.
    stream = Readable.from([])
    stream.resume()
  } else {
    stream = Readable.from(opts.payload === undefined ? [] : [Buffer.from(opts.payload, 'utf8')])
  }

  const req = stream as unknown as IncomingMessage & { body?: unknown }
  Object.assign(req, {
    method,
    url: opts.url,
    headers,
    rawHeaders: Object.entries(headers).flat(),
    socket: { encrypted: true },
  })
  if (opts.platformParsed && opts.payload !== undefined) {
    req.body = JSON.parse(opts.payload)
  }
  return req
}

type Captured = {
  status: number
  headers: Record<string, string | string[]>
  body: string
  json: () => unknown
}

function mockResponse(): { res: ServerResponse; done: Promise<Captured> } {
  const headers: Record<string, string | string[]> = {}
  const chunks: Buffer[] = []
  let resolve!: (value: Captured) => void
  const done = new Promise<Captured>((r) => (resolve = r))

  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader(key: string, value: string | string[]) {
      headers[key.toLowerCase()] = value
      return res
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString('utf8')
      resolve({
        status: res.statusCode,
        headers,
        body,
        json: () => JSON.parse(body) as unknown,
      })
    },
  } as unknown as ServerResponse

  return { res, done }
}

/** Fail loudly rather than hang, so a regression shows as a failure not a stall. */
async function call(opts: MockRequestOptions, budgetMs = 8_000): Promise<Captured> {
  const { res, done } = mockResponse()
  void handler()(mockRequest(opts) as never, res)
  const outcome = await Promise.race([
    done,
    new Promise<'hung'>((r) => setTimeout(() => r('hung'), budgetMs)),
  ])
  if (outcome === 'hung') {
    throw new Error(`the handler never answered ${opts.method ?? 'GET'} ${opts.url} within ${budgetMs}ms`)
  }
  return outcome
}

const rpc = (method: string, params?: unknown, id: number | null = 1) =>
  JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params === undefined ? {} : { params }) })

describe('the MCP face through the deployed handler', () => {
  // The regression. Both of these hung in production.
  it('answers initialize when the platform has already parsed the body', async () => {
    const res = await call({
      method: 'POST',
      url: '/mcp/security',
      payload: rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} }),
      platformParsed: true,
    })
    expect(res.status).toBe(200)
    const body = res.json() as Record<string, any>
    expect(body['error']).toBeUndefined()
    expect(body['result'].protocolVersion).toBe('2025-06-18')
    expect(body['result'].serverInfo.name).toBe('hallmark-security')
  })

  it('answers tools/list when the platform has already parsed the body', async () => {
    const res = await call({
      method: 'POST',
      url: '/mcp/security',
      payload: rpc('tools/list', undefined, 2),
      platformParsed: true,
    })
    expect(res.status).toBe(200)
    const body = res.json() as Record<string, any>
    expect(body['result'].tools.map((tool: { name: string }) => tool.name)).toEqual(['analyse', 'report'])
  })

  it('answers a notification with 202 and an empty body, not a hang', async () => {
    const res = await call({
      method: 'POST',
      url: '/mcp/security',
      payload: rpc('notifications/initialized', {}, null),
      platformParsed: true,
    })
    expect(res.status).toBe(202)
    expect(res.body).toBe('')
    expect(res.headers['content-length']).toBe('0')
  })

  it('serves the GET descriptor promptly', async () => {
    const started = Date.now()
    const res = await call({ url: '/mcp/health' })
    expect(res.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(2_000)
    const body = res.json() as Record<string, any>
    expect(body['protocolVersion']).toBe('2025-06-18')
    expect(body['endpoint']).toBe(`${config.baseUrl}/mcp/health`)
  })

  it('answers every agent, not just the one that was reported broken', async () => {
    for (const slug of ['rebalancer', 'grid', 'yield', 'health', 'security']) {
      const res = await call({
        method: 'POST',
        url: `/mcp/${slug}`,
        payload: rpc('initialize', {}),
        platformParsed: true,
      })
      expect(res.status, slug).toBe(200)
      expect((res.json() as Record<string, any>)['result'].serverInfo.name).toBe(`hallmark-${slug}`)
    }
  })

  it('works with an unread stream too — the plain-Node shape', async () => {
    const res = await call({
      method: 'POST',
      url: '/mcp/grid',
      payload: rpc('tools/list', undefined, 5),
      platformParsed: false,
    })
    expect(res.status).toBe(200)
    expect((res.json() as Record<string, any>)['result'].tools.length).toBeGreaterThan(0)
  })
})

describe('the other faces through the deployed handler', () => {
  it('serves an agent card', async () => {
    const res = await call({ url: '/security/.well-known/agent-card.json' })
    expect(res.status).toBe(200)
    const card = res.json() as Record<string, any>
    expect(card['type']).toBe('AgentCard')
    expect((card['skills'] as unknown[]).length).toBeGreaterThan(0)
  })

  it('answers a GET on the A2A endpoint with the card', async () => {
    const res = await call({ url: '/a2a/health' })
    expect(res.status).toBe(200)
    expect((res.json() as Record<string, any>)['type']).toBe('AgentCard')
  })

  it('answers an A2A POST — the same body path the MCP face uses', async () => {
    const res = await call({
      method: 'POST',
      url: '/a2a/security',
      payload: rpc('agent/card', {}, 4),
      platformParsed: true,
    })
    expect(res.status).toBe(200)
    expect((res.json() as Record<string, any>)['result'].name).toBe('BNB Chain Token Safety')
  })

  it('answers an unpaid x402 request with a 402 and the challenge header', async () => {
    const res = await call({
      method: 'POST',
      url: '/x402/security/report',
      payload: '{}',
      platformParsed: true,
    })
    expect(res.status).toBe(402)
    expect(res.body).toBe('{}')
    const header = res.headers['payment-required']
    expect(typeof header).toBe('string')
    const challenge = JSON.parse(Buffer.from(header as string, 'base64').toString('utf8'))
    expect(challenge.x402Version).toBe(2)
    expect(challenge.accepts[0].network).toBe('eip155:56')
    expect(challenge.accepts[0].amount).toBe('500000000000000000')
  })

  it('reads the payment header through the adapter, so a paid retry is seen', async () => {
    // Proves the request headers survive the Node-to-Web conversion: without
    // them the paid path would look identical to the unpaid one.
    const res = await call({
      method: 'POST',
      url: '/x402/security/report',
      headers: { 'payment-signature': Buffer.from('{"scheme":"exact"}').toString('base64') },
      payload: '{}',
      platformParsed: true,
    })
    expect(res.status).toBe(402)
    const challenge = JSON.parse(
      Buffer.from(res.headers['payment-required'] as string, 'base64').toString('utf8'),
    )
    expect(challenge.error).toContain('No x402 facilitator is configured')
  })

  it('preserves the query string through the adapter', async () => {
    const res = await call({ url: '/security/.well-known/agent-card.json?chainId=97' })
    expect(res.status).toBe(200)
    expect((res.json() as Record<string, any>)['x-hallmark'].chainId).toBe(97)
  })
})

describe('nothing can hang', () => {
  it('gives up on a body that never arrives instead of waiting forever', async () => {
    const res = await call({ method: 'POST', url: '/mcp/security', neverEnds: true })
    expect(res.status).toBe(400)
    const body = res.json() as Record<string, any>
    expect(body['error']).toBe('bad-request')
    expect(body['message']).toContain('did not arrive within')
  })

  it('answers 504 with an explanation when the app outruns the request deadline', async () => {
    const slow = createHandler({
      app: {
        fetch: () => new Promise<Response>(() => {}),
      } as never,
      timeouts: { body: 200, skill: 200, request: 300 },
    })
    const { res, done } = mockResponse()
    void slow(mockRequest({ url: '/mcp/security' }) as never, res)
    const captured = await Promise.race([
      done,
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 5_000)),
    ])
    expect(captured).not.toBe('hung')
    if (captured === 'hung') throw new Error('unreachable')
    expect(captured.status).toBe(504)
    const body = captured.json() as Record<string, any>
    expect(body['error']).toBe('timeout')
    expect(body['message']).toContain('stopped waiting rather than hold the connection open')
  })

  it('reports a skill that outruns its deadline rather than holding the face open', async () => {
    // A read that stalls must not become a hang. `analyse` here is pointed at
    // a chain the fixture never answers for, with a 500ms skill budget.
    const stalling = createHandler({
      app: buildApp({ config, store: createMemoryStore(), sessions: providerFor(null) }),
      timeouts: { body: 500, skill: 400, request: 5_000 },
    })
    const { res, done } = mockResponse()
    void stalling(
      mockRequest({
        method: 'POST',
        url: '/mcp/security',
        payload: rpc('tools/call', {
          name: 'analyse',
          arguments: { token: '0x0000000000000000000000000000000000000001' },
        }, 8),
        platformParsed: true,
      }) as never,
      res,
    )
    const captured = await Promise.race([
      done,
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 10_000)),
    ])
    expect(captured).not.toBe('hung')
  }, 20_000)
})

describe('body and URL reconstruction', () => {
  it('prefers the platform-parsed body over the spent stream', async () => {
    const req = mockRequest({
      method: 'POST',
      url: '/mcp/security',
      payload: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
      platformParsed: true,
    })
    const read = await readBody(req as never, 500)
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect(read.source).toBe('parsed')
    expect(JSON.parse(read.bytes.toString('utf8')).method).toBe('ping')
  })

  it('reads an untouched stream', async () => {
    const req = mockRequest({ method: 'POST', url: '/x', payload: 'hello' })
    const read = await readBody(req as never, 500)
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect(read.source).toBe('stream')
    expect(read.bytes.toString('utf8')).toBe('hello')
  })

  it('treats a fully ended stream with no kept bytes as empty rather than waiting', async () => {
    // Vercel hands over a stream that has already emitted 'end'. Wait for that
    // to actually have happened, or the mock tests a different branch.
    const req = mockRequest({ method: 'POST', url: '/x', platformParsed: true })
    await new Promise((resolve) => (req as unknown as Readable).once('end', resolve))
    expect((req as unknown as Readable).readableEnded).toBe(true)

    const read = await readBody(req as never, 500)
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect(read.source).toBe('empty')
  })

  it('never reads a body for GET or HEAD', async () => {
    for (const method of ['GET', 'HEAD']) {
      const read = await readBody(mockRequest({ method, url: '/x', neverEnds: true }) as never, 500)
      expect(read.ok, method).toBe(true)
    }
  })

  it('builds an https URL from the proxy headers Vercel sets', () => {
    expect(
      absoluteUrl(mockRequest({ url: '/mcp/security?chainId=56' }) as never),
    ).toBe('https://agents.test/mcp/security?chainId=56')
  })

  it('honours x-forwarded-host over host', () => {
    expect(
      absoluteUrl(
        mockRequest({
          url: '/a',
          headers: { 'x-forwarded-host': 'hallmark-agents.vercel.app' },
        }) as never,
      ),
    ).toBe('https://hallmark-agents.vercel.app/a')
  })
})
