/**
 * Two registry behaviours that are easy to get wrong and expensive to get
 * wrong on chain. Both are exercised through the real `createRegistryReader`
 * with a fake transport, so the assertions are about the calldata that would
 * actually go out, not about a re-implementation.
 *
 *   1. Reputation feedback indices are 1-based. `readFeedback(agentId, client, 0)`
 *      reverts with "index must be > 0", and `getLastIndex` returns the count,
 *      so the valid range is 1..getLastIndex.
 *   2. `getSummary` reverts on an empty `clients` array. The audience has to be
 *      resolved with `getClients` first.
 */

import { describe, expect, it } from 'vitest'
import { custom, decodeFunctionData, encodeFunctionResult, multicall3Abi } from 'viem'
import type { Address } from 'viem'

import { createRegistryReader, reputationRegistryAbi } from '@hallmark/core'

type InnerCall = { target: Address; callData: `0x${string}` }
type Decoded = { functionName: string; args: readonly unknown[] }

type Handler = (call: Decoded) => { success: boolean; returnData: `0x${string}` }

function fakeReader(handler: Handler) {
  const seen: Decoded[] = []

  const transport = custom({
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'eth_chainId') return '0x61'
      if (method !== 'eth_call') throw new Error(`unexpected rpc method ${method}`)

      const call = (params as Array<{ data: `0x${string}` }>)[0]
      if (call === undefined) throw new Error('eth_call with no params')

      const outer = decodeFunctionData({ abi: multicall3Abi, data: call.data })
      if (outer.functionName !== 'aggregate3') throw new Error(`unexpected multicall ${outer.functionName}`)

      const inner = outer.args[0] as readonly InnerCall[]
      const results = inner.map((entry) => {
        const decoded = decodeFunctionData({ abi: reputationRegistryAbi, data: entry.callData })
        const record: Decoded = { functionName: decoded.functionName, args: (decoded.args ?? []) as readonly unknown[] }
        seen.push(record)
        return handler(record)
      })

      return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results })
    },
  })

  return { reader: createRegistryReader(97, { transport }), seen }
}

const CLIENT: Address = '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab'
const REVERT = { success: false, returnData: '0x' as `0x${string}` }

function feedbackResult(value: bigint, tag1: string): { success: true; returnData: `0x${string}` } {
  return {
    success: true,
    returnData: encodeFunctionResult({
      abi: reputationRegistryAbi,
      functionName: 'readFeedback',
      result: [value, 0, tag1, 'hallmark', false],
    }),
  }
}

describe('reputation feedback indices are 1-based', () => {
  it('reads index 0 back as null instead of throwing', async () => {
    const { reader, seen } = fakeReader((call) => (call.functionName === 'readFeedback' ? REVERT : REVERT))
    const entry = await reader.readFeedback(2210, CLIENT, 0)
    expect(entry).toBe(null)
    expect(seen[0]?.args[2]).toBe(0n)
  })

  it('walks 1..getLastIndex and never asks for index 0', async () => {
    const { reader, seen } = fakeReader((call) => {
      if (call.functionName === 'getLastIndex') {
        return {
          success: true,
          returnData: encodeFunctionResult({ abi: reputationRegistryAbi, functionName: 'getLastIndex', result: 3n }),
        }
      }
      if (call.functionName === 'readFeedback') return feedbackResult(84n, 'reachable')
      return REVERT
    })

    const entries = await reader.feedbackByClient(2210, CLIENT)
    expect(entries).toHaveLength(3)

    const indices = seen.filter((c) => c.functionName === 'readFeedback').map((c) => c.args[2])
    expect(indices).toEqual([1n, 2n, 3n])
    expect(indices).not.toContain(0n)
    expect(entries?.map((e) => e.index)).toEqual([1, 2, 3])
  })

  it('reads no feedback at all when the client has left none', async () => {
    const { reader, seen } = fakeReader((call) => {
      if (call.functionName === 'getLastIndex') {
        return {
          success: true,
          returnData: encodeFunctionResult({ abi: reputationRegistryAbi, functionName: 'getLastIndex', result: 0n }),
        }
      }
      return REVERT
    })

    expect(await reader.feedbackByClient(2210, CLIENT)).toEqual([])
    expect(seen.some((c) => c.functionName === 'readFeedback')).toBe(false)
  })

  it('treats getLastIndex as a count, so the newest entry is at that index', async () => {
    const { reader } = fakeReader((call) => {
      if (call.functionName === 'getLastIndex') {
        return {
          success: true,
          returnData: encodeFunctionResult({ abi: reputationRegistryAbi, functionName: 'getLastIndex', result: 2n }),
        }
      }
      return feedbackResult(91n, 'reachable')
    })

    const last = await reader.lastFeedbackIndex(2210, CLIENT)
    expect(last).toBe(2)
    const newest = await reader.readFeedback(2210, CLIENT, last ?? 0)
    expect(newest?.index).toBe(2)
  })
})

describe('getSummary is never called with an empty client list', () => {
  it('resolves the audience with getClients first', async () => {
    const { reader, seen } = fakeReader((call) => {
      if (call.functionName === 'getClients') {
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: reputationRegistryAbi,
            functionName: 'getClients',
            result: [CLIENT],
          }),
        }
      }
      if (call.functionName === 'getSummary') {
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: reputationRegistryAbi,
            functionName: 'getSummary',
            result: [1n, 84n, 0],
          }),
        }
      }
      return REVERT
    })

    const summary = await reader.reputationSummary(2210)
    expect(summary).toMatchObject({ count: 1, score: 84 })

    const order = seen.map((c) => c.functionName)
    expect(order).toEqual(['getClients', 'getSummary'])

    const summaryCall = seen.find((c) => c.functionName === 'getSummary')
    expect(summaryCall?.args[1]).toEqual([CLIENT])
    expect((summaryCall?.args[1] as readonly unknown[]).length).toBeGreaterThan(0)
  })

  it('does not call getSummary at all when the agent has no clients', async () => {
    const { reader, seen } = fakeReader((call) => {
      if (call.functionName === 'getClients') {
        return {
          success: true,
          returnData: encodeFunctionResult({ abi: reputationRegistryAbi, functionName: 'getClients', result: [] }),
        }
      }
      return REVERT
    })

    expect(await reader.reputationSummary(2210)).toBe(null)
    expect(seen.map((c) => c.functionName)).toEqual(['getClients'])
    expect(seen.some((c) => c.functionName === 'getSummary')).toBe(false)
  })

  it('passes an explicit audience straight through', async () => {
    const { reader, seen } = fakeReader((call) => {
      if (call.functionName === 'getSummary') {
        return {
          success: true,
          returnData: encodeFunctionResult({
            abi: reputationRegistryAbi,
            functionName: 'getSummary',
            result: [2n, 9_000n, 2],
          }),
        }
      }
      return REVERT
    })

    const summary = await reader.reputationSummary(2210, [CLIENT], 'reachable')
    expect(summary?.score).toBe(90)
    expect(seen.some((c) => c.functionName === 'getClients')).toBe(false)
    expect(seen[0]?.args[2]).toBe('reachable')
  })
})
