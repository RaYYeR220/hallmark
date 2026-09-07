import { describe, expect, it } from 'vitest'

import {
  SCAN_FRONT_DOOR,
  SCAN_OFFICIAL_API,
  ScanApiError,
  ScanClient,
  createScanClient,
} from '../src/scan.js'
import type { ScanAgent, ScanPage } from '../src/scan.js'

type Call = { url: string; headers: Record<string, string> }

function recorder(responses: Array<() => Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  let index = 0

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    calls.push({ url, headers })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (next === undefined) throw new Error('no response queued')
    return next()
  }) as unknown as typeof fetch

  return { fetchImpl, calls }
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, ...init })

const agentPage = (items: number, total: number, offset = 0): ScanPage<ScanAgent> => ({
  items: Array.from({ length: items }, (_, i) => ({ token_id: String(offset + i) }) as unknown as ScanAgent),
  total,
  limit: items,
  offset,
})

const fast = { minIntervalMs: 0, retryBaseMs: 1 }

describe('ScanClient construction', () => {
  it('defaults to the front door and its measured pacing', () => {
    const client = new ScanClient({ fetchImpl: (() => {}) as unknown as typeof fetch })
    expect(client.baseUrl).toBe(SCAN_FRONT_DOOR)
    expect(client.minIntervalMs).toBe(Math.ceil(60_000 / 180))
  })

  it('paces the official API to its much lower limit', () => {
    const client = new ScanClient({
      baseUrl: SCAN_OFFICIAL_API,
      fetchImpl: (() => {}) as unknown as typeof fetch,
    })
    expect(client.minIntervalMs).toBe(2_000)
  })

  it('trims a trailing slash off the base', () => {
    const client = new ScanClient({
      baseUrl: `${SCAN_OFFICIAL_API}/`,
      fetchImpl: (() => {}) as unknown as typeof fetch,
    })
    expect(client.baseUrl).toBe(SCAN_OFFICIAL_API)
  })
})

describe('query building', () => {
  it('drops undefined, keeps false and zero, and repeats arrays', async () => {
    const { fetchImpl, calls } = recorder([() => json(agentPage(0, 0))])
    const client = createScanClient({ fetchImpl, ...fast })

    await client.listAgents({
      chain_id: 56,
      x402_supported: false,
      offset: 0,
      owner_address: undefined,
      oasf_skill: ['a/b', 'c/d'],
    })

    const url = new URL(calls[0]?.url ?? '')
    expect(url.pathname).toBe('/api/v1/agents')
    expect(url.searchParams.get('chain_id')).toBe('56')
    expect(url.searchParams.get('x402_supported')).toBe('false')
    expect(url.searchParams.get('offset')).toBe('0')
    expect(url.searchParams.has('owner_address')).toBe(false)
    expect(url.searchParams.getAll('oasf_skill')).toEqual(['a/b', 'c/d'])
  })

  it('sends X-API-Key only when a key is configured', async () => {
    const withKey = recorder([() => json(agentPage(0, 0))])
    await createScanClient({ fetchImpl: withKey.fetchImpl, apiKey: 'k-123', ...fast }).listAgents({ chain_id: 56 })
    expect(withKey.calls[0]?.headers['x-api-key']).toBe('k-123')

    const withoutKey = recorder([() => json(agentPage(0, 0))])
    await createScanClient({ fetchImpl: withoutKey.fetchImpl, ...fast }).listAgents({ chain_id: 56 })
    expect(withoutKey.calls[0]?.headers['x-api-key']).toBeUndefined()
  })
})

describe('retries', () => {
  it('retries a 500 and returns the eventual success', async () => {
    const { fetchImpl, calls } = recorder([
      () => new Response('boom', { status: 500 }),
      () => new Response('boom', { status: 502 }),
      () => json(agentPage(1, 1)),
    ])
    const page = await createScanClient({ fetchImpl, ...fast }).listAgents({ chain_id: 56 })
    expect(calls).toHaveLength(3)
    expect(page.total).toBe(1)
  })

  it('retries the 200-with-error-envelope the front door likes to send', async () => {
    const { fetchImpl, calls } = recorder([
      () => json({ success: false, error: { code: 'DATABASE_ERROR', message: 'Database error occurred' } }),
      () => json(agentPage(2, 2)),
    ])
    const page = await createScanClient({ fetchImpl, ...fast }).listAgents({ chain_id: 56 })
    expect(calls).toHaveLength(2)
    expect(page.items).toHaveLength(2)
  })

  it('retries a network failure', async () => {
    let attempt = 0
    const fetchImpl = (async () => {
      attempt += 1
      if (attempt < 3) throw new Error('ECONNRESET')
      return json(agentPage(1, 1))
    }) as unknown as typeof fetch

    const page = await createScanClient({ fetchImpl, ...fast }).listAgents({ chain_id: 56 })
    expect(attempt).toBe(3)
    expect(page.total).toBe(1)
  })

  it('gives up after maxRetries and reports the last failure', async () => {
    const { fetchImpl, calls } = recorder([() => new Response('nope', { status: 503 })])
    const client = createScanClient({ fetchImpl, maxRetries: 2, fallbackBaseUrl: null, ...fast })

    await expect(client.listAgents({ chain_id: 56 })).rejects.toBeInstanceOf(ScanApiError)
    expect(calls).toHaveLength(3)
  })

  it('does not retry a 404', async () => {
    const { fetchImpl, calls } = recorder([() => new Response('{"detail":"Not Found"}', { status: 404 })])
    const client = createScanClient({ fetchImpl, ...fast })

    await expect(client.getAgent(56, 999)).rejects.toMatchObject({ status: 404 })
    expect(calls).toHaveLength(1)
  })

  it('does not retry an unrecognised error envelope', async () => {
    const { fetchImpl, calls } = recorder([() => json({ success: false, error: { code: 'BAD_REQUEST' } })])
    const client = createScanClient({ fetchImpl, ...fast })

    await expect(client.listAgents({ chain_id: 56 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(calls).toHaveLength(1)
  })
})

describe('base fallback', () => {
  it('defaults to the other base and switches once the first is exhausted', async () => {
    const { fetchImpl, calls } = recorder([
      () => json({ success: false, error: { code: 'DATABASE_ERROR' } }),
      () => json({ success: false, error: { code: 'DATABASE_ERROR' } }),
      () => json(agentPage(1, 1)),
    ])
    const client = createScanClient({ fetchImpl, maxRetries: 1, ...fast })
    expect(client.fallbackBaseUrl).toBe(SCAN_OFFICIAL_API)

    const page = await client.listAgents({ chain_id: 56 })
    expect(page.total).toBe(1)
    expect(calls.map((call) => new URL(call.url).host)).toEqual([
      '8004scan.io',
      '8004scan.io',
      'api.8004scan.io',
    ])
  })

  it('does not fall back on a non-retryable failure', async () => {
    const { fetchImpl, calls } = recorder([() => new Response('{}', { status: 404 })])
    const client = createScanClient({ fetchImpl, ...fast })

    await expect(client.listAgents({ chain_id: 56 })).rejects.toMatchObject({ status: 404 })
    expect(calls).toHaveLength(1)
  })

  it('can be turned off', async () => {
    const { fetchImpl, calls } = recorder([() => new Response('nope', { status: 500 })])
    const client = createScanClient({ fetchImpl, fallbackBaseUrl: null, maxRetries: 1, ...fast })
    expect(client.fallbackBaseUrl).toBeNull()

    await expect(client.listAgents({ chain_id: 56 })).rejects.toBeInstanceOf(ScanApiError)
    expect(calls).toHaveLength(2)
  })
})

describe('rate limit headers', () => {
  it('reads the per-minute and per-day counters the API sends', async () => {
    const { fetchImpl } = recorder([
      () =>
        json(agentPage(0, 0), {
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-limit-minute': '30',
            'x-ratelimit-remaining-minute': '29',
            'x-ratelimit-limit-day': '1000',
            'x-ratelimit-remaining-day': '980',
          },
        }),
    ])
    const client = createScanClient({ fetchImpl, ...fast })

    expect(client.getRateLimit().updatedAt).toBeNull()
    await client.listAgents({ chain_id: 56 })

    const state = client.getRateLimit()
    expect(state.limitMinute).toBe(30)
    expect(state.remainingMinute).toBe(29)
    expect(state.limitDay).toBe(1000)
    expect(state.remainingDay).toBe(980)
    expect(state.updatedAt).toBeInstanceOf(Date)
  })

  it('honours retry-after when backing off a 429', async () => {
    const { fetchImpl, calls } = recorder([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
      () => json(agentPage(1, 1)),
    ])
    await createScanClient({ fetchImpl, ...fast }).listAgents({ chain_id: 56 })
    expect(calls).toHaveLength(2)
  })
})

describe('endpoints', () => {
  it('keeps the success envelope on /chains', async () => {
    const { fetchImpl, calls } = recorder([
      () => json({ success: true, data: { chains: [], testnet_chain_ids: [97], mainnet_chain_ids: [56] } }),
    ])
    const result = await createScanClient({ fetchImpl, ...fast }).chains()
    expect(calls[0]?.url).toBe(`${SCAN_FRONT_DOOR}/chains`)
    expect(result.success).toBe(true)
    expect(result.data.mainnet_chain_ids).toEqual([56])
  })

  it('builds the paths for the per-agent and per-wallet routes', async () => {
    const detail = recorder([() => json({ token_id: '1' })])
    await createScanClient({ fetchImpl: detail.fetchImpl, ...fast }).getAgent(56, 1)
    expect(detail.calls[0]?.url).toBe(`${SCAN_FRONT_DOOR}/agents/56/1`)

    const wallet = recorder([() => json(agentPage(0, 0))])
    await createScanClient({ fetchImpl: wallet.fetchImpl, ...fast }).agentsByWallet('0xdead', { limit: 5 })
    expect(wallet.calls[0]?.url).toBe(`${SCAN_FRONT_DOOR}/wallets/0xdead/agents?limit=5`)

    const semantic = recorder([() => json(agentPage(0, 0))])
    await createScanClient({ fetchImpl: semantic.fetchImpl, ...fast }).semanticSearch('grid bot', { chain_id: 56 })
    const url = new URL(semantic.calls[0]?.url ?? '')
    expect(url.pathname).toBe('/api/v1/agents/search/semantic')
    expect(url.searchParams.get('q')).toBe('grid bot')
    expect(url.searchParams.get('chain_id')).toBe('56')
  })
})

describe('paginate', () => {
  it('walks pages until the total is reached', async () => {
    let call = 0
    const fetchImpl = (async () => {
      const page = call === 0 ? agentPage(100, 150, 0) : agentPage(50, 150, 100)
      call += 1
      return json(page)
    }) as unknown as typeof fetch

    const seen: string[] = []
    for await (const agent of createScanClient({ fetchImpl, ...fast }).paginate({ chain_id: 56 })) {
      seen.push(agent.token_id)
    }
    expect(seen).toHaveLength(150)
    expect(call).toBe(2)
  })

  it('stops at max even when more rows exist', async () => {
    const fetchImpl = (async () => json(agentPage(100, 100_000, 0))) as unknown as typeof fetch

    let count = 0
    for await (const _agent of createScanClient({ fetchImpl, ...fast }).paginate({ chain_id: 56 }, 10)) {
      void _agent
      count += 1
    }
    expect(count).toBe(10)
  })

  it('stops on an empty page', async () => {
    const fetchImpl = (async () => json(agentPage(0, 999))) as unknown as typeof fetch

    let count = 0
    for await (const _agent of createScanClient({ fetchImpl, ...fast }).paginate({ chain_id: 56 })) {
      void _agent
      count += 1
    }
    expect(count).toBe(0)
  })
})
