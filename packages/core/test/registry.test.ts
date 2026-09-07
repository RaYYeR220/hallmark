import { describe, expect, it } from 'vitest'
import { custom, decodeFunctionData, encodeFunctionResult } from 'viem'
import type { Transport } from 'viem'

import { IDENTITY_EVENT_TOPICS, identityRegistryAbi, multicall3Abi, reputationRegistryAbi } from '../src/abis.js'
import { createRegistryReader, findRegisteredAgentId } from '../src/registry.js'

/** Roughly the live mainnet high-water mark at the time of writing. */
const HIGHEST = 338_006n
const OWNER = '0x89E9E1ab11dD1B138b1dcE6d6A4a0926aaFD5029'

/** Mirrors testnet agent 2210: two feedbacks from one validator, indices 1 and 2. */
const RATED_AGENT = 2_210n
const VALIDATOR = '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab'
const FEEDBACKS: Array<[bigint, number, string, string, boolean]> = [
  [100n, 0, 'reachable', '', false],
  [143n, 0, 'responsetime', '', false],
]

const CLAWNEWS_JSON =
  '{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1","name":"ClawNews","description":"Hacker News for AI agents","services":[{"name":"web","endpoint":"https://clawnews.io"}],"registrations":[{"agentId":null,"agentRegistry":"eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"}],"active":true,"x402Support":false,"supportedTrust":["reputation"]}'

function tokenUriFor(id: bigint): string {
  if (id === 1n) return `data:application/json;base64,${Buffer.from(CLAWNEWS_JSON, 'utf8').toString('base64')}`
  if (id === 2n) return '0x6446ad98a3f2b4b19cf1e1b0eafd6f5b76a26e1c'
  if (id === 3n) return ''
  return 'https://example.com/agent-card.json'
}

type Call3 = { target: `0x${string}`; allowFailure: boolean; callData: `0x${string}` }
type Call3Result = { success: boolean; returnData: `0x${string}` }

/**
 * Answers the reputation registry for `RATED_AGENT` only. Feedback indices are
 * 1-based on the deployed contract, so index 0 reverts here too.
 */
function answerReputation(callData: `0x${string}`): Call3Result | null {
  let inner: { functionName: string; args?: readonly unknown[] }
  try {
    inner = decodeFunctionData({ abi: reputationRegistryAbi, data: callData })
  } catch {
    return null
  }

  if (inner.args?.[0] !== RATED_AGENT) return { success: false, returnData: '0x' }

  type Readable = 'getLastIndex' | 'readFeedback' | 'readAllFeedback' | 'getSummary' | 'getClients'
  const ok = (functionName: Readable, result: unknown) => ({
    success: true,
    returnData: encodeFunctionResult({ abi: reputationRegistryAbi, functionName, result: result as never }),
  })

  switch (inner.functionName) {
    case 'getClients':
      return ok('getClients', [VALIDATOR])
    case 'getLastIndex':
      return ok('getLastIndex', BigInt(FEEDBACKS.length))
    case 'readFeedback': {
      const index = inner.args?.[2] as bigint
      const entry = FEEDBACKS[Number(index) - 1]
      if (index === 0n || entry === undefined) return { success: false, returnData: '0x' }
      return ok('readFeedback', entry)
    }
    case 'readAllFeedback':
      return ok('readAllFeedback', [
        FEEDBACKS.map(() => VALIDATOR),
        FEEDBACKS.map((_, i) => BigInt(i + 1)),
        FEEDBACKS.map((f) => f[0]),
        FEEDBACKS.map((f) => f[1]),
        FEEDBACKS.map((f) => f[2]),
        FEEDBACKS.map((f) => f[3]),
        FEEDBACKS.map((f) => f[4]),
      ])
    case 'getSummary': {
      // The deployment reverts when the client list is empty.
      const clients = inner.args?.[1] as readonly string[] | undefined
      if (clients === undefined || clients.length === 0) return { success: false, returnData: '0x' }
      return ok('getSummary', [BigInt(FEEDBACKS.length), 121n, 0])
    }
    default:
      return { success: false, returnData: '0x' }
  }
}

/** An eth_call handler that answers multicall3 batches out of a fake registry. */
function fakeRegistry(): { transport: Transport; callCount: () => number } {
  let calls = 0

  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'eth_chainId') return '0x38'
      if (method !== 'eth_call') throw new Error(`unexpected rpc method ${method}`)

      calls += 1
      const [tx] = params as [{ data: `0x${string}` }]
      const decoded = decodeFunctionData({ abi: multicall3Abi, data: tx.data })
      const batch = decoded.args[0] as readonly Call3[]

      const results: Call3Result[] = batch.map((call) => {
        let inner: { functionName: string; args?: readonly unknown[] }
        try {
          inner = decodeFunctionData({ abi: identityRegistryAbi, data: call.callData })
        } catch {
          const reputation = answerReputation(call.callData)
          // Anything else reverts, which is exactly how a call to a method the
          // deployment does not have behaves on chain.
          return reputation ?? { success: false, returnData: '0x' }
        }

        const id = inner.args?.[0] as bigint | undefined
        if (id === undefined || id === 0n || id > HIGHEST) return { success: false, returnData: '0x' }

        if (inner.functionName === 'ownerOf') {
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: identityRegistryAbi,
              functionName: 'ownerOf',
              result: OWNER,
            }),
          }
        }
        if (inner.functionName === 'tokenURI') {
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: identityRegistryAbi,
              functionName: 'tokenURI',
              result: tokenUriFor(id),
            }),
          }
        }
        return { success: false, returnData: '0x' }
      })

      return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results })
    },
  }

  return { transport: custom(provider as never), callCount: () => calls }
}

describe('createRegistryReader', () => {
  it('refuses chains we have no addresses for', () => {
    expect(() => createRegistryReader(1)).toThrow(/Unsupported chain id 1/)
  })

  it('exposes the resolved chain', () => {
    const reader = createRegistryReader(97, { transport: fakeRegistry().transport })
    expect(reader.chainId).toBe(97)
    expect(reader.chain.contracts.identityRegistry).toBe('0x8004A818BFB912233c491871b3d84c89A494BD9e')
  })
})

describe('getAgent', () => {
  it('reads the owner and parses the card in one round-trip', async () => {
    const { transport, callCount } = fakeRegistry()
    const reader = createRegistryReader(56, { transport })

    const agent = await reader.getAgent(1)
    expect(agent).not.toBeNull()
    expect(agent?.agentId).toBe(1n)
    expect(agent?.owner).toBe(OWNER)
    expect(agent?.card.ok).toBe(true)
    if (agent?.card.ok === true) {
      expect(agent.card.card.name).toBe('ClawNews')
    }
    expect(callCount()).toBe(1)
  })

  it('returns null when ownerOf reverts', async () => {
    const reader = createRegistryReader(56, { transport: fakeRegistry().transport })
    expect(await reader.getAgent(HIGHEST + 1n)).toBeNull()
    expect(await reader.getAgent(0)).toBeNull()
  })

  it('keeps a garbage tokenURI as a failed parse rather than throwing', async () => {
    const reader = createRegistryReader(56, { transport: fakeRegistry().transport })

    const garbage = await reader.getAgent(2)
    expect(garbage?.card.ok).toBe(false)
    if (garbage?.card.ok === false) {
      expect(garbage.card.kind).toBe('unknown')
      expect(garbage.card.error).toMatch(/bare address/)
    }

    const empty = await reader.getAgent(3)
    expect(empty?.tokenUri).toBe('')
    if (empty?.card.ok === false) {
      expect(empty.card.error).toMatch(/reverted or is empty/)
    }
  })

  it('leaves off-chain cards unfetched unless asked', async () => {
    const reader = createRegistryReader(56, { transport: fakeRegistry().transport })
    const agent = await reader.getAgent(42)
    expect(agent?.card.ok).toBe(false)
    if (agent?.card.ok === false) expect(agent.card.kind).toBe('http')
  })

  it('follows off-chain cards when asked', async () => {
    const reader = createRegistryReader(56, { transport: fakeRegistry().transport })
    const fetchImpl = (async () => new Response(CLAWNEWS_JSON, { status: 200 })) as unknown as typeof fetch

    const agent = await reader.getAgent(42, { resolveOffChain: true, fetchImpl })
    expect(agent?.card.ok).toBe(true)
    if (agent?.card.ok === true) expect(agent.card.card.name).toBe('ClawNews')
  })
})

describe('getAgents', () => {
  it('batches ids into multicalls and preserves order', async () => {
    const { transport, callCount } = fakeRegistry()
    const reader = createRegistryReader(56, { transport, batchSize: 2 })

    const agents = await reader.getAgents([1, 2, HIGHEST + 5n, 3n])
    expect(agents).toHaveLength(4)
    expect(agents[0]?.agentId).toBe(1n)
    expect(agents[1]?.agentId).toBe(2n)
    expect(agents[2]).toBeNull()
    expect(agents[3]?.agentId).toBe(3n)
    expect(callCount()).toBe(2)
  })

  it('handles an empty list without a round-trip', async () => {
    const { transport, callCount } = fakeRegistry()
    const reader = createRegistryReader(56, { transport })
    expect(await reader.getAgents([])).toEqual([])
    expect(callCount()).toBe(0)
  })
})

describe('highestAgentId', () => {
  it('finds the last minted id without totalSupply', async () => {
    const { transport, callCount } = fakeRegistry()
    const reader = createRegistryReader(56, { transport })

    expect(await reader.highestAgentId()).toBe(HIGHEST)
    expect(callCount()).toBeLessThan(60)
  })

  it('uses a hint below the answer', async () => {
    const { transport, callCount } = fakeRegistry()
    const reader = createRegistryReader(56, { transport })

    expect(await reader.highestAgentId({ hint: HIGHEST - 6n })).toBe(HIGHEST)
    expect(callCount()).toBeLessThan(40)
  })

  it('uses a hint above the answer', async () => {
    const reader = createRegistryReader(56, { transport: fakeRegistry().transport })
    expect(await reader.highestAgentId({ hint: 1_000_000n })).toBe(HIGHEST)
  })

  it('respects the ceiling', async () => {
    const reader = createRegistryReader(56, { transport: fakeRegistry().transport })
    expect(await reader.highestAgentId({ maxId: 1_000n })).toBe(1_000n)
  })

  it('reports zero for an empty registry', async () => {
    const provider = {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return '0x38'
        return encodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          result: [{ success: false, returnData: '0x' }],
        })
      },
    }
    const reader = createRegistryReader(56, { transport: custom(provider as never) })
    expect(await reader.highestAgentId()).toBe(0n)
  })
})

describe('reputation reads', () => {
  it('treats feedback index 0 as out of range', async () => {
    const reader = createRegistryReader(97, { transport: fakeRegistry().transport })
    expect(await reader.readFeedback(RATED_AGENT, VALIDATOR, 0)).toBeNull()
  })

  it('reads the 1-based indices the registry actually uses', async () => {
    const reader = createRegistryReader(97, { transport: fakeRegistry().transport })

    expect(await reader.lastFeedbackIndex(RATED_AGENT, VALIDATOR)).toBe(2)
    expect(await reader.readFeedback(RATED_AGENT, VALIDATOR, 1)).toEqual({
      client: VALIDATOR,
      index: 1,
      value: 100,
      valueDecimals: 0,
      score: 100,
      tag1: 'reachable',
      tag2: '',
      isRevoked: false,
    })
    expect(await reader.readFeedback(RATED_AGENT, VALIDATOR, 2)).toMatchObject({ index: 2, tag1: 'responsetime' })
    expect(await reader.readFeedback(RATED_AGENT, VALIDATOR, 3)).toBeNull()
  })

  it('walks a client from index 1, not 0', async () => {
    const reader = createRegistryReader(97, { transport: fakeRegistry().transport })
    const entries = await reader.feedbackByClient(RATED_AGENT, VALIDATOR)
    expect(entries?.map((entry) => entry.index)).toEqual([1, 2])
    expect(entries?.map((entry) => entry.score)).toEqual([100, 143])
  })

  it('decodes the seven parallel arrays readAllFeedback returns', async () => {
    const reader = createRegistryReader(97, { transport: fakeRegistry().transport })
    const entries = await reader.allFeedback(RATED_AGENT)
    expect(entries).toEqual([
      { client: VALIDATOR, index: 1, value: 100, valueDecimals: 0, score: 100, tag1: 'reachable', tag2: '', isRevoked: false },
      { client: VALIDATOR, index: 2, value: 143, valueDecimals: 0, score: 143, tag1: 'responsetime', tag2: '', isRevoked: false },
    ])
  })

  it('reads the summary as (count, value, valueDecimals)', async () => {
    const reader = createRegistryReader(97, { transport: fakeRegistry().transport })
    expect(await reader.reputationSummary(RATED_AGENT, [VALIDATOR])).toEqual({
      count: 2,
      value: 121,
      valueDecimals: 0,
      score: 121,
    })
  })

  it('resolves the client list itself, since getSummary reverts on an empty one', async () => {
    const { transport, callCount } = fakeRegistry()
    const reader = createRegistryReader(97, { transport })

    expect(await reader.feedbackClients(RATED_AGENT)).toEqual([VALIDATOR])
    expect(await reader.reputationSummary(RATED_AGENT)).toMatchObject({ count: 2, score: 121 })
    // getClients, then getSummary — on top of the standalone feedbackClients read.
    expect(callCount()).toBe(3)
  })

  it('scales value by valueDecimals', async () => {
    const reader = createRegistryReader(97, { transport: fakeRegistry().transport })
    const entry = await reader.readFeedback(RATED_AGENT, VALIDATOR, 1)
    expect(entry?.score).toBe(entry?.value)
  })
})

describe('findRegisteredAgentId', () => {
  const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e'
  const MINTER = '0x38c6Fc4a5525B37f9545423A7132157f69ce08dA'
  const topicFor = (address: string) => `0x${address.toLowerCase().slice(2).padStart(64, '0')}`

  const receiptLogs = [
    {
      address: REGISTRY.toLowerCase(),
      topics: [
        IDENTITY_EVENT_TOPICS.Transfer,
        `0x${'0'.repeat(64)}`,
        topicFor(MINTER),
        `0x${(2210).toString(16).padStart(64, '0')}`,
      ],
    },
    { address: REGISTRY.toLowerCase(), topics: [IDENTITY_EVENT_TOPICS.Registered, `0x${'0'.repeat(63)}1`] },
    { address: REGISTRY.toLowerCase(), topics: [IDENTITY_EVENT_TOPICS.MetadataSet, `0x${'0'.repeat(63)}1`] },
    {
      address: REGISTRY.toLowerCase(),
      topics: ['0xf8e1a15aba9398e019f0b49df1a4fde98ee17ae345cb5f6b5e2c27f5033e8ce7'],
    },
  ]

  it('reads the id off the Transfer mint log', () => {
    expect(findRegisteredAgentId(receiptLogs, REGISTRY, MINTER)).toBe(2210n)
  })

  it('works without an owner filter', () => {
    expect(findRegisteredAgentId(receiptLogs, REGISTRY)).toBe(2210n)
  })

  it('ignores logs from other contracts and other owners', () => {
    expect(findRegisteredAgentId(receiptLogs, '0x0000000000000000000000000000000000000001')).toBeNull()
    expect(findRegisteredAgentId(receiptLogs, REGISTRY, OWNER)).toBeNull()
  })

  it('ignores a non-mint transfer', () => {
    const resale = [
      {
        address: REGISTRY.toLowerCase(),
        topics: [IDENTITY_EVENT_TOPICS.Transfer, topicFor(OWNER), topicFor(MINTER), `0x${'0'.repeat(63)}9`],
      },
    ]
    expect(findRegisteredAgentId(resale, REGISTRY)).toBeNull()
  })

  it('returns null when there is nothing to find', () => {
    expect(findRegisteredAgentId([], REGISTRY)).toBeNull()
  })
})

describe('reads that are allowed to be missing', () => {
  it('returns null instead of throwing when a registry call reverts', async () => {
    const reader = createRegistryReader(56, { transport: fakeRegistry().transport })

    expect(await reader.reputationSummary(1)).toBeNull()
    expect(await reader.feedbackClients(1)).toBeNull()
    expect(await reader.readFeedback(1, OWNER, 1)).toBeNull()
    expect(await reader.lastFeedbackIndex(1, OWNER)).toBeNull()
    expect(await reader.feedbackByClient(1, OWNER)).toBeNull()
    expect(await reader.allFeedback(1)).toBeNull()
    expect(await reader.validationSummary(1)).toBeNull()
    expect(await reader.agentValidations(1)).toBeNull()
    expect(await reader.validationStatus(`0x${'11'.repeat(32)}`)).toBeNull()
    expect(await reader.getJob(reader.chain.contracts.altanaCommerce, 1)).toBeNull()
  })
})
