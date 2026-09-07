import { describe, expect, it } from 'vitest'
import { parsePaymentRequired } from '@hallmark/altana'

import { buildApp } from '../src/app.js'
import { AGENTS } from '../src/registry.js'
import { MCP_PROTOCOL_VERSION } from '../src/runtime/mcp.js'
import { A2A_PROTOCOL_VERSION } from '../src/runtime/a2a.js'
import { createMemoryStore } from '../src/runtime/store.js'
import { providerFor, testConfig } from './support/fixtures.js'

/**
 * The three faces, as contracts.
 *
 * A census of 6,000 registered BNB Chain agents found 46% publishing a valid
 * registration file with no `services` key at all, and another 506 serving a
 * card with an empty `skills` array — unhireable by construction, and green in
 * every naive check. These tests exist so ours cannot join them: a card with
 * no skills, no services, or a landing page where a card should be fails here
 * rather than in a prober's report.
 */

const config = testConfig()
const app = buildApp({ config, store: createMemoryStore(), sessions: providerFor(null) })
const BASE = 'https://agents.test'

async function get(path: string): Promise<Response> {
  return app.fetch(new Request(`${BASE}${path}`))
}

async function rpc(path: string, method: string, params: unknown, id: number | null = 1) {
  const res = await app.fetch(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }),
    }),
  )
  return { res, body: res.status === 202 ? null : ((await res.json()) as Record<string, any>) }
}

describe('agent cards', () => {
  it('serves a card for every one of the five agents', async () => {
    expect(AGENTS).toHaveLength(5)
    for (const agent of AGENTS) {
      const res = await get(`/${agent.manifest.slug}/.well-known/agent-card.json`)
      expect(res.status, agent.manifest.slug).toBe(200)
      const card = (await res.json()) as Record<string, any>
      expect(card['protocolVersion']).toBe(A2A_PROTOCOL_VERSION)
      expect(card['name']).toBe(agent.manifest.name)
      expect(card['url']).toBe(`${BASE}/a2a/${agent.manifest.slug}`)
    }
  })

  it('never publishes an empty skills array — the commonest false positive in the wild', async () => {
    for (const agent of AGENTS) {
      const card = (await (await get(`/${agent.manifest.slug}/.well-known/agent-card.json`)).json()) as Record<string, any>
      const skills = card['skills'] as Array<{ id: string; inputSchema: unknown }>
      expect(skills.length, `${agent.manifest.slug} skills`).toBeGreaterThan(0)
      for (const skill of skills) {
        expect(typeof skill.id).toBe('string')
        expect(skill.id.length).toBeGreaterThan(0)
        expect(skill.inputSchema).toBeTruthy()
      }
    }
  })

  it('always declares services[] with reachable, absolute endpoints', async () => {
    for (const agent of AGENTS) {
      const card = (await (await get(`/${agent.manifest.slug}/.well-known/agent-card.json`)).json()) as Record<string, any>
      const services = card['services'] as Array<{ name: string; endpoint: string }>
      expect(services.length, agent.manifest.slug).toBeGreaterThan(0)
      const names = services.map((service) => service.name)
      expect(names).toContain('A2A')
      expect(names).toContain('MCP')
      for (const service of services) {
        expect(service.endpoint, `${agent.manifest.slug}/${service.name}`).toMatch(/^https?:\/\//)
        expect(service.endpoint).not.toContain('undefined')
        expect(service.endpoint).not.toContain('null')
      }
    }
  })

  it('every declared A2A and MCP endpoint actually answers', async () => {
    for (const agent of AGENTS) {
      const card = (await (await get(`/${agent.manifest.slug}/.well-known/agent-card.json`)).json()) as Record<string, any>
      for (const service of card['services'] as Array<{ name: string; endpoint: string }>) {
        if (service.name !== 'A2A' && service.name !== 'MCP') continue
        const path = new URL(service.endpoint).pathname
        const { res } = await rpc(path, service.name === 'MCP' ? 'ping' : 'agent/card', {})
        expect(res.status, `${service.name} ${path}`).toBe(200)
      }
    }
  })

  it('answers a plain GET on the A2A endpoint with the card, not a landing page', async () => {
    // A prober tries the endpoint itself before it tries any well-known path.
    for (const agent of AGENTS) {
      const res = await get(`/a2a/${agent.manifest.slug}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
      const card = (await res.json()) as Record<string, any>
      expect(card['type']).toBe('AgentCard')
      expect((card['skills'] as unknown[]).length).toBeGreaterThan(0)
    }
  })

  it('marks x402Support exactly when a priced skill exists', async () => {
    for (const agent of AGENTS) {
      const card = (await (await get(`/${agent.manifest.slug}/.well-known/agent-card.json`)).json()) as Record<string, any>
      const priced = agent.skills.some((skill) => skill.price !== undefined)
      expect(card['x402Support'], agent.manifest.slug).toBe(priced)
      const services = card['services'] as Array<{ name: string }>
      expect(services.some((service) => service.name === 'x402')).toBe(priced)
    }
  })

  it('serves a directory at the origin well-known path, since one origin hosts five agents', async () => {
    const res = await get('/.well-known/agent-card.json')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body['type']).toBe('AgentDirectory')
    expect((body['agents'] as unknown[]).length).toBe(5)
  })

  it('names an unknown agent rather than 404ing blankly', async () => {
    const res = await get('/nope/.well-known/agent-card.json')
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, any>
    expect(body['agents']).toEqual(['rebalancer', 'grid', 'yield', 'health', 'security'])
  })
})

describe('MCP face', () => {
  it('completes an initialize + tools/list round trip', async () => {
    const init = await rpc('/mcp/rebalancer', 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(init.res.status).toBe(200)
    expect(init.body?.['result'].protocolVersion).toBe(MCP_PROTOCOL_VERSION)
    expect(init.body?.['result'].capabilities.tools).toBeTruthy()
    expect(init.body?.['result'].serverInfo.name).toBe('hallmark-rebalancer')

    const list = await rpc('/mcp/rebalancer', 'tools/list', {}, 2)
    const tools = list.body?.['result'].tools as Array<{ name: string; inputSchema: any; annotations: any }>
    expect(tools.map((tool) => tool.name)).toEqual(['analyse', 'report', 'act', 'cycles'])
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.additionalProperties).toBe(false)
    }
    expect(tools.find((tool) => tool.name === 'act')?.annotations.readOnlyHint).toBe(false)
    expect(tools.find((tool) => tool.name === 'analyse')?.annotations.readOnlyHint).toBe(true)
  })

  it('answers a notification with 202 and no body, per JSON-RPC', async () => {
    const { res, body } = await rpc('/mcp/grid', 'notifications/initialized', {}, null)
    expect(res.status).toBe(202)
    expect(body).toBeNull()
  })

  it('reports an unknown method as a JSON-RPC error, not a 500', async () => {
    const { res, body } = await rpc('/mcp/grid', 'tools/execute', {}, 7)
    expect(res.status).toBe(200)
    expect(body?.['error'].code).toBe(-32601)
    expect(body?.['error'].data.supported).toContain('tools/call')
  })

  it('rejects a malformed envelope', async () => {
    const res = await app.fetch(
      new Request(`${BASE}/mcp/grid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' }),
      }),
    )
    const body = (await res.json()) as Record<string, any>
    expect(body['error'].code).toBe(-32600)
  })

  it('reports a tool-level failure as isError, not as a transport error', async () => {
    const { res, body } = await rpc('/mcp/health', 'tools/call', {
      name: 'analyse',
      arguments: { borrower: 'not-an-address' },
    }, 9)
    expect(res.status).toBe(200)
    expect(body?.['error']).toBeUndefined()
    expect(body?.['result'].isError).toBe(true)
    expect(body?.['result'].structuredContent.errors[0]).toContain('not a 20-byte hex address')
  })

  it('directs a paid tool to the x402 face instead of serving it free', async () => {
    const { body } = await rpc('/mcp/security', 'tools/call', { name: 'report', arguments: {} }, 3)
    expect(body?.['result'].isError).toBe(true)
    const required = body?.['result'].structuredContent.paymentRequired
    expect(required.x402Version).toBe(2)
    expect(required.accepts[0].network).toBe('eip155:56')
  })
})

describe('A2A face', () => {
  it('accepts the message/send envelope with a data part', async () => {
    const { body } = await rpc('/a2a/grid', 'message/send', {
      message: {
        role: 'user',
        messageId: 'm1',
        kind: 'message',
        parts: [{ kind: 'data', data: { skill: 'state', input: { gridId: 'nothing-here' } } }],
      },
    })
    expect(body?.['result'].kind).toBe('message')
    expect(body?.['result'].parts[0].data.result.exists).toBe(false)
  })

  it('accepts the shorthand skillId form', async () => {
    const { body } = await rpc('/a2a/grid', 'message/send', {
      skillId: 'state',
      input: { gridId: 'nothing-here' },
    })
    expect(body?.['result'].parts[0].data.result.exists).toBe(false)
  })

  it('explains what a message without a skill should have contained', async () => {
    const { body } = await rpc('/a2a/grid', 'message/send', { message: { parts: [] } })
    expect(body?.['error'].code).toBe(-32602)
    expect(body?.['error'].message).toContain('no data part named a skill')
    expect(body?.['error'].data.skills).toContain('analyse')
  })

  it('refuses to serve a paid skill for free and points at the x402 endpoint', async () => {
    const { body } = await rpc('/a2a/security', 'message/send', {
      skillId: 'report',
      input: { token: '0x0000000000000000000000000000000000000001' },
    })
    expect(body?.['error'].code).toBe(-32002)
    expect(body?.['error'].message).toContain('/x402/security/report')
  })
})

describe('x402 face', () => {
  const paidPath = '/x402/security/report'

  it('answers an unpaid request with a 402 and the challenge in the header', async () => {
    const res = await app.fetch(new Request(`${BASE}${paidPath}`, { method: 'POST', body: '{}' }))
    expect(res.status).toBe(402)
    // v2 is header-based; the body is empty on purpose.
    expect(await res.json()).toEqual({})
    expect(res.headers.get('www-authenticate')).toBe('Payment')

    const header = res.headers.get('payment-required')
    expect(header).toBeTruthy()
    const challenge = JSON.parse(Buffer.from(header!, 'base64').toString('utf8'))
    expect(challenge.x402Version).toBe(2)
    expect(challenge.resource.url).toBe(`${BASE}${paidPath}`)
    expect(challenge.accepts).toHaveLength(1)

    const accept = challenge.accepts[0]
    expect(accept.scheme).toBe('exact')
    expect(accept.network).toBe('eip155:56')
    expect(accept.payTo).toBe(config.payTo)
    expect(accept.asset).toBe('0x55d398326f99059fF775485246999027B3197955')
    // 0.50 USDT at eighteen decimals. Six would be a trillionth of the price.
    expect(accept.amount).toBe('500000000000000000')
    expect(accept.extra.decimals).toBe(18)
    expect(typeof accept.amount).toBe('string')
  })

  it('emits the v1 header alongside v2, so older payers still see it', async () => {
    const res = await app.fetch(new Request(`${BASE}${paidPath}`, { method: 'POST', body: '{}' }))
    expect(res.headers.get('x-payment')).toBe(res.headers.get('payment-required'))
  })

  it('produces a challenge our own x402 payer can parse', async () => {
    // The interop that matters: @hallmark/altana is the client side of this.
    const res = await app.fetch(new Request(`${BASE}${paidPath}`, { method: 'POST', body: '{}' }))
    const challenges = await parsePaymentRequired(res)
    expect(challenges).toHaveLength(1)
    expect(challenges[0]!.amountAtomic).toBe(500_000_000_000_000_000n)
    expect(challenges[0]!.chainId).toBe(56)
    expect(challenges[0]!.rail).toBe('permit2')
    expect(challenges[0]!.payTo).toBe(config.payTo)
  })

  it('refuses a payment it cannot verify rather than serving the work', async () => {
    const res = await app.fetch(
      new Request(`${BASE}${paidPath}`, {
        method: 'POST',
        headers: { 'payment-signature': Buffer.from('{"scheme":"exact"}').toString('base64') },
        body: '{}',
      }),
    )
    expect(res.status).toBe(402)
    const challenge = JSON.parse(
      Buffer.from(res.headers.get('payment-required')!, 'base64').toString('utf8'),
    )
    expect(challenge.error).toContain('No x402 facilitator is configured')
  })

  it('serves the work once a verifier accepts, and reports the settlement', async () => {
    // Negative control for the test above: the same request, the only
    // difference being a verifier that says yes.
    const accepting = buildApp({
      config,
      store: createMemoryStore(),
      sessions: providerFor(null),
      verifier: {
        name: 'test',
        async verify() {
          return { ok: true, detail: 'settled by the test verifier', txHash: '0xdeadbeef' }
        },
      },
    })
    const res = await accepting.fetch(
      new Request(`${BASE}/x402/grid/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'payment-signature': Buffer.from('{}').toString('base64') },
        body: JSON.stringify({ gridId: 'unknown-grid' }),
      }),
    )
    expect(res.status).toBe(200)
    const receipt = JSON.parse(
      Buffer.from(res.headers.get('payment-response')!, 'base64').toString('utf8'),
    )
    expect(receipt.success).toBe(true)
    expect(receipt.transaction).toBe('0xdeadbeef')
  })

  it('refuses to quote a challenge when no pay-to address is configured', async () => {
    const unconfigured = buildApp({
      config: { ...config, payTo: '0x0000000000000000000000000000000000000000' },
      store: createMemoryStore(),
      sessions: providerFor(null),
    })
    const res = await unconfigured.fetch(new Request(`${BASE}${paidPath}`, { method: 'POST', body: '{}' }))
    expect(res.status).toBe(503)
    expect((await res.json() as any).error).toBe('x402-unconfigured')
  })

  it('sends a free skill to the free faces rather than charging for it', async () => {
    const res = await app.fetch(new Request(`${BASE}/x402/security/analyse`, { method: 'POST', body: '{}' }))
    expect(res.status).toBe(400)
    expect((await res.json() as any).error).toBe('not-a-paid-skill')
  })
})

describe('cron face', () => {
  it('refuses every request when no secret is configured, rather than running open', async () => {
    const res = await app.fetch(new Request(`${BASE}/api/cron/health`, { method: 'POST', body: '{}' }))
    expect(res.status).toBe(503)
    expect((await res.json() as any).error).toBe('cron-unconfigured')
  })

  it('rejects a wrong secret', async () => {
    const guarded = buildApp({
      config: { ...config, cronSecret: 'shh' },
      store: createMemoryStore(),
      sessions: providerFor(null),
    })
    const res = await guarded.fetch(
      new Request(`${BASE}/api/cron/health`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
        body: '{}',
      }),
    )
    expect(res.status).toBe(401)
  })

  it('accepts the right secret and runs the watch skill', async () => {
    const guarded = buildApp({
      config: { ...config, cronSecret: 'shh' },
      store: createMemoryStore(),
      sessions: providerFor(null),
    })
    const res = await guarded.fetch(
      new Request(`${BASE}/api/cron/health`, {
        method: 'POST',
        headers: { authorization: 'Bearer shh', 'content-type': 'application/json' },
        body: JSON.stringify({ skill: 'watch', input: { borrowers: [], dryRun: true } }),
      }),
    )
    // An empty watchlist is an input error, which proves the secret passed and
    // the skill ran — a 401 or 503 here would not.
    expect(res.status).toBe(400)
    expect((await res.json() as any).errors[0]).toContain('at least 1 item')
  })
})
