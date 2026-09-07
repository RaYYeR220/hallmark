import type { Address, Hex } from 'viem'
import type { Session } from '@hallmark/altana'

import type {
  ActIntent,
  Executor,
  RuntimeConfig,
  SessionHandle,
  SessionProvider,
  SkillContext,
} from '../../src/runtime/types.js'
import { executeIntent } from '../../src/runtime/act.js'
import { createMemoryStore, type Store } from '../../src/runtime/store.js'
import { loadConfig } from '../../src/runtime/config.js'
import type { ChainClient } from '../../src/chain/clients.js'

/**
 * Fixture chain state.
 *
 * Every test in this suite runs against a fake client rather than a network,
 * so the assertions are about *this* code's behaviour and not about what BNB
 * Chain happened to look like when the suite ran. Anything the fake is not
 * told about throws, loudly, naming the call — a fixture that silently returns
 * zero for an unstubbed read produces a passing test of nothing.
 */

export type ReadKey = string

export function readKey(address: string, functionName: string, args: readonly unknown[] = []): ReadKey {
  return `${address.toLowerCase()}::${functionName}(${args.map(String).join(',')})`
}

export type FakeChain = {
  reads: Record<ReadKey, unknown>
  code?: Record<string, Hex>
  storage?: Record<string, Hex>
  blockNumber?: bigint
  gasPrice?: bigint
  balances?: Record<string, bigint>
  /** Calls the fake was asked for but does not know, collected for assertions. */
  misses: string[]
}

export function fakeClient(chain: FakeChain): ChainClient {
  const client = {
    async readContract(args: { address: string; functionName: string; args?: readonly unknown[] }) {
      const key = readKey(args.address, args.functionName, args.args ?? [])
      if (key in chain.reads) return chain.reads[key]
      chain.misses.push(key)
      throw new Error(`fixture has no answer for ${key}`)
    },
    async simulateContract(args: { address: string; functionName: string; args?: readonly unknown[] }) {
      const key = readKey(args.address, args.functionName, args.args ?? [])
      if (key in chain.reads) return { result: chain.reads[key] }
      chain.misses.push(key)
      throw new Error(`fixture has no simulation for ${key}`)
    },
    async getCode(args: { address: string }) {
      return chain.code?.[args.address.toLowerCase()] ?? '0x'
    },
    async getStorageAt(args: { address: string; slot: string }) {
      return chain.storage?.[`${args.address.toLowerCase()}::${args.slot.toLowerCase()}`] ?? null
    },
    async getBlockNumber() {
      return chain.blockNumber ?? 40_000_000n
    },
    async getGasPrice() {
      return chain.gasPrice ?? 1_000_000_000n
    },
    async getBalance(args: { address: string }) {
      return chain.balances?.[args.address.toLowerCase()] ?? 0n
    },
    async getLogs() {
      return []
    },
    async call() {
      throw new Error('fixture does not simulate raw eth_call')
    },
    chain: { id: 56 },
  }
  return client as unknown as ChainClient
}

export function emptyChain(overrides: Partial<FakeChain> = {}): FakeChain {
  return { reads: {}, misses: [], ...overrides }
}

// ---------------------------------------------------------------------------
// Sessions and executors
// ---------------------------------------------------------------------------

/** A session object with no signing capability. Nothing in the tests signs. */
export function fakeSession(walletAddress: Address = '0x1111111111111111111111111111111111111111'): Session {
  return {
    walletAddress,
    signer: { address: walletAddress } as unknown as Session['signer'],
    publicKey: `0x${'ab'.repeat(32)}` as Hex,
    permissions: {},
    expiry: Math.floor(Date.now() / 1000) + 86_400,
  }
}

export function providerFor(handle: SessionHandle | null): SessionProvider {
  return { async get() { return handle } }
}

/** Records every intent it is handed, and answers with whatever you set. */
export function recordingExecutor(
  outcome: Awaited<ReturnType<Executor>> | ((n: number) => Awaited<ReturnType<Executor>>),
): { executor: Executor; calls: Array<{ chainId: number; calls: unknown[] }> } {
  const calls: Array<{ chainId: number; calls: unknown[] }> = []
  const executor: Executor = async (args) => {
    calls.push({ chainId: args.chainId, calls: [...args.calls] })
    return typeof outcome === 'function' ? outcome(calls.length) : outcome
  }
  return { executor, calls }
}

export const CONFIRMED = {
  kind: 'confirmed' as const,
  txHash: `0x${'11'.repeat(32)}` as Hex,
  explorerUrl: 'https://bscscan.com/tx/0x11',
  statusCode: 200,
  callsId: `0x${'22'.repeat(32)}` as Hex,
  detail: 'Confirmed on-chain within the session key’s scope.',
}

// ---------------------------------------------------------------------------
// Skill contexts
// ---------------------------------------------------------------------------

export type TestContextArgs = {
  client?: ChainClient
  store?: Store
  sessions?: SessionProvider
  executor?: Executor
  now?: number
  fetchImpl?: typeof fetch
  agentSlug?: string
  binding?: SkillContext extends never ? never : Parameters<typeof executeIntent>[1]['binding']
  config?: RuntimeConfig
}

export function testConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    ...loadConfig({ PUBLIC_BASE_URL: 'https://agents.test', X402_PAY_TO: '0x2222222222222222222222222222222222222222' }),
    ...overrides,
  }
}

export function testContext(args: TestContextArgs = {}): SkillContext {
  const store = args.store ?? createMemoryStore()
  const sessions = args.sessions ?? providerFor(null)
  const executor = args.executor ?? (async () => CONFIRMED)
  const now = () => args.now ?? 1_780_000_000
  const binding = args.binding ?? { category: 'venus-health-factor' as const, rationale: 'test' }

  const ctx: SkillContext = {
    chainId: 56,
    client: args.client ?? fakeClient(emptyChain()),
    fetch: args.fetchImpl ?? ((async () => { throw new Error('fixture does not fetch') }) as unknown as typeof fetch),
    store,
    now,
    session: sessions,
    config: args.config ?? testConfig(),
    execute: (intent: ActIntent) =>
      executeIntent(intent, {
        agentSlug: args.agentSlug ?? 'test',
        chainId: 56,
        binding,
        sessions,
        executor,
        store,
        now,
      }),
  }
  return ctx
}
