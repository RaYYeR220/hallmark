import type { AgentConfig, Address, Hex } from '../src/types.js'
import type { AgentWalletClient, TransactionReceiptLike, WriteRequest } from '../src/clients.js'

export const OWNER: Address = '0x1111111111111111111111111111111111111111'
export const IDENTITY_56: Address = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'
export const IDENTITY_97: Address = '0x8004A818BFB912233c491871b3d84c89A494BD9e'

/** DNS that always answers with a routable public address, so no real lookup happens. */
export const publicLookup = async (): Promise<string[]> => ['93.184.216.34']

export function validConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'Venus Health Guard',
    description: 'Unwinds a Venus position on BNB Chain before it can be liquidated.',
    image: 'https://example.com/icon.png',
    category: 'health-factor',
    chain: 'bsc-testnet',
    services: {
      a2a: 'https://example.com/.well-known/agent-card.json',
      mcp: 'https://example.com/mcp',
      web: 'https://example.com',
    },
    skills: [
      {
        id: 'health-check',
        name: 'Health check',
        description: 'Returns the current health factor of a Venus account.',
        inputSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] },
        outputSchema: { type: 'object', properties: { healthFactor: { type: 'number' } } },
      },
    ],
    pricing: { model: 'free' },
    trust: ['reputation'],
    ...overrides,
  }
}

/* ------------------------------------------------------------------ */
/* chain fakes                                                         */
/* ------------------------------------------------------------------ */

export const ZERO_TOPIC = `0x${'0'.repeat(64)}` as Hex

export function addressTopic(address: string): Hex {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}` as Hex
}

export function idTopic(id: bigint): Hex {
  return `0x${id.toString(16).padStart(64, '0')}` as Hex
}

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export function mintLog(registry: string, to: string, agentId: bigint) {
  return { address: registry, topics: [TRANSFER_TOPIC, ZERO_TOPIC, addressTopic(to), idTopic(agentId)] }
}

/** A `Transfer` that is a resale, not a mint: `from` is not the zero address. */
export function resaleLog(registry: string, from: string, to: string, agentId: bigint) {
  return { address: registry, topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to), idTopic(agentId)] }
}

export type RecordedWrite = WriteRequest

export type FakeWallet = AgentWalletClient & {
  writes: RecordedWrite[]
  hashes: Hex[]
}

export function fakeWallet(chainId: number, owner: Address = OWNER): FakeWallet {
  const writes: RecordedWrite[] = []
  const hashes: Hex[] = []
  return {
    writes,
    hashes,
    account: { address: owner },
    chain: { id: chainId },
    async writeContract(request: WriteRequest): Promise<Hex> {
      writes.push(request)
      const hash = `0x${(writes.length).toString(16).padStart(64, '0')}` as Hex
      hashes.push(hash)
      return hash
    },
  }
}

export function fakePublicClient(receipts: Record<string, TransactionReceiptLike>) {
  return {
    async waitForTransactionReceipt({ hash }: { hash: Hex }): Promise<TransactionReceiptLike> {
      const receipt = receipts[hash]
      if (receipt === undefined) throw new Error(`no receipt stubbed for ${hash}`)
      return receipt
    },
  }
}

/* ------------------------------------------------------------------ */
/* http fakes                                                          */
/* ------------------------------------------------------------------ */

export type RouteHandler = (request: { url: string; method: string; body: string | null }) => Response

/**
 * A fetch that serves a fixed routing table. Anything not in the table is a
 * connection error, which is what an unreachable host looks like.
 */
export function fakeFetch(routes: Record<string, RouteHandler | Response | (() => Response)>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const route = routes[url]
    if (route === undefined) {
      throw new TypeError(`fetch failed: nothing listening at ${url}`)
    }
    if (route instanceof Response) return route.clone()
    const body = typeof init?.body === 'string' ? init.body : null
    const handler = route as RouteHandler
    return handler({ url, method: init?.method ?? 'GET', body })
  }) as unknown as typeof fetch
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

export function sseResponse(message: unknown, init: ResponseInit = {}): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) },
  })
}

export const A2A_CARD = {
  name: 'Venus Health Guard',
  description: 'Unwinds Venus positions.',
  url: 'https://example.com',
  version: '1.0.0',
  capabilities: { streaming: false },
  skills: [
    { id: 'health-check', name: 'Health check', description: 'x' },
    { id: 'guard-position', name: 'Guard position', description: 'y' },
  ],
}

export function mcpInitializeResult(): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'venus-health-guard', version: '1.0.0' },
    },
  }
}

export function mcpToolsResult(names: string[]): unknown {
  return {
    jsonrpc: '2.0',
    id: 2,
    result: { tools: names.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) },
  }
}

export function x402Challenge(): unknown {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:56',
        maxAmountRequired: '500000000000000000',
        payTo: '0x2222222222222222222222222222222222222222',
        asset: '0xcE24439F2D9C6a2289F741120FE202248B666666',
        resource: 'https://example.com/x402/watch',
      },
    ],
  }
}
