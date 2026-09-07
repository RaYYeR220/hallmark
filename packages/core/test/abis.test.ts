import { describe, expect, it } from 'vitest'
import { getAbiItem, toEventSelector, toFunctionSelector } from 'viem'

import {
  IDENTITY_EVENT_TOPICS,
  agenticCommerceAbi,
  identityRegistryAbi,
  reputationRegistryAbi,
  validationRegistryAbi,
} from '../src/abis.js'

describe('IDENTITY_EVENT_TOPICS', () => {
  it('matches the events declared in the ABI', () => {
    for (const name of ['Transfer', 'Registered', 'MetadataSet'] as const) {
      const item = getAbiItem({ abi: identityRegistryAbi, name })
      expect(item, name).toBeDefined()
      expect(toEventSelector(item as never), name).toBe(IDENTITY_EVENT_TOPICS[name])
    }
  })

  it('pins the values read off the deployed registry', () => {
    expect(IDENTITY_EVENT_TOPICS.Transfer).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    )
    expect(IDENTITY_EVENT_TOPICS.Registered).toBe(
      '0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a',
    )
    expect(IDENTITY_EVENT_TOPICS.MetadataSet).toBe(
      '0x2c149ed548c6d2993cd73efe187df6eccabe4538091b33adbd25fafdb8a1468b',
    )
  })
})

describe('identityRegistryAbi', () => {
  it('has no totalSupply — the registry is not ERC-721 Enumerable', () => {
    const names = identityRegistryAbi.map((item) => ('name' in item ? item.name : ''))
    expect(names).not.toContain('totalSupply')
    expect(names).toContain('ownerOf')
    expect(names).toContain('tokenURI')
  })

  it('keeps both register overloads', () => {
    const registers = identityRegistryAbi.filter((item) => item.type === 'function' && item.name === 'register')
    expect(registers).toHaveLength(2)
    const selectors = new Set(registers.map((item) => toFunctionSelector(item as never)))
    expect(selectors.size).toBe(2)
  })
})

describe('registry summaries have the shapes the deployments actually return', () => {
  it('reputation getSummary is (count, summaryValue, summaryValueDecimals)', () => {
    const item = getAbiItem({ abi: reputationRegistryAbi, name: 'getSummary' })
    expect(item?.outputs.map((o) => `${o.name}:${o.type}`)).toEqual([
      'count:uint64',
      'summaryValue:int128',
      'summaryValueDecimals:uint8',
    ])
  })

  it('validation getSummary is (count, avgResponse)', () => {
    const item = getAbiItem({ abi: validationRegistryAbi, name: 'getSummary' })
    expect(item?.outputs.map((o) => `${o.name}:${o.type}`)).toEqual(['count:uint64', 'avgResponse:uint8'])
  })

  it('readAllFeedback returns seven parallel arrays', () => {
    const item = getAbiItem({ abi: reputationRegistryAbi, name: 'readAllFeedback' })
    expect(item?.outputs.map((o) => o.type)).toEqual([
      'address[]',
      'uint64[]',
      'int128[]',
      'uint8[]',
      'string[]',
      'string[]',
      'bool[]',
    ])
  })

  it('NewFeedback carries the eleven parameters from the EIP', () => {
    const item = getAbiItem({ abi: reputationRegistryAbi, name: 'NewFeedback' })
    expect(item?.inputs).toHaveLength(11)
    expect(item?.inputs.filter((input) => input.indexed === true).map((input) => input.name)).toEqual([
      'agentId',
      'clientAddress',
      'indexedTag1',
    ])
  })

  it('getJob returns the nine ERC-8183 fields', () => {
    const item = getAbiItem({ abi: agenticCommerceAbi, name: 'getJob' })
    expect(item?.outputs.map((o) => o.name)).toEqual([
      'jobId',
      'client',
      'provider',
      'paymentToken',
      'metadataUri',
      'budget',
      'funded',
      'status',
      'evaluator',
    ])
  })
})
