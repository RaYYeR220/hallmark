import { createPublicClient, http } from 'viem'
import type { PublicClient, Transport } from 'viem'

import {
  IDENTITY_EVENT_TOPICS,
  agenticCommerceAbi,
  identityRegistryAbi,
  reputationRegistryAbi,
  validationRegistryAbi,
} from './abis.js'
import { getChain } from './chains.js'
import type { Address, HallmarkChain, SupportedChainId } from './chains.js'
import { parseAgentCardFromTokenUri, resolveAgentCard } from './agentCard.js'
import type { ParseResult, ResolveOptions } from './agentCard.js'
import type { ReputationSummary, ValidationSummary } from './types.js'

export type OnChainAgent = {
  agentId: bigint
  owner: Address
  tokenUri: string
  card: ParseResult
}

export type FeedbackEntry = {
  client: Address
  /** 1-based, matching the registry's own numbering. */
  index: number
  value: number
  valueDecimals: number
  /** `value` scaled by `valueDecimals`. */
  score: number
  tag1: string
  tag2: string
  isRevoked: boolean
}

export type ValidationStatus = {
  validator: Address
  agentId: bigint
  response: number
  responseHash: `0x${string}`
  tag: string
  lastUpdate: bigint
}

export type CommerceJob = {
  jobId: bigint
  client: Address
  provider: Address
  paymentToken: Address
  metadataUri: string
  budget: bigint
  funded: bigint
  status: number
  evaluator: Address
}

export type RegistryReaderOptions = {
  rpcUrl?: string
  transport?: Transport
  /** Agent ids per multicall round-trip. */
  batchSize?: number
}

export type GetAgentOptions = {
  /** Follow http/ipfs tokenURIs over the network instead of failing fast. */
  resolveOffChain?: boolean
} & ResolveOptions

export type HighestAgentIdOptions = {
  /** Where to start probing. A good hint turns ~37 calls into ~4. */
  hint?: bigint
  /** Hard ceiling for the search. */
  maxId?: bigint
}

export type RegistryReader = {
  chainId: SupportedChainId
  chain: HallmarkChain
  client: PublicClient
  getAgent(agentId: bigint | number, opts?: GetAgentOptions): Promise<OnChainAgent | null>
  getAgents(agentIds: Array<bigint | number>): Promise<Array<OnChainAgent | null>>
  highestAgentId(opts?: HighestAgentIdOptions): Promise<bigint>
  /** Every address that has left this agent feedback. */
  feedbackClients(agentId: bigint | number): Promise<Address[] | null>
  /**
   * Omitting `clients` means "everyone": the registry's own `getSummary`
   * reverts on an empty list, so the client set is resolved first.
   */
  reputationSummary(
    agentId: bigint | number,
    clients?: Address[],
    tag1?: string,
    tag2?: string,
  ): Promise<ReputationSummary | null>
  allFeedback(
    agentId: bigint | number,
    clients?: Address[],
    tag1?: string,
    tag2?: string,
    includeRevoked?: boolean,
  ): Promise<FeedbackEntry[] | null>
  /** Feedback indices are 1-based; index 0 reverts and reads back as `null`. */
  readFeedback(
    agentId: bigint | number,
    client: Address,
    index: bigint | number,
  ): Promise<FeedbackEntry | null>
  /** Number of feedbacks this client left, i.e. the highest valid index. */
  lastFeedbackIndex(agentId: bigint | number, client: Address): Promise<number | null>
  /** Every feedback one client left, read over `1..lastFeedbackIndex` in one multicall. */
  feedbackByClient(agentId: bigint | number, client: Address): Promise<FeedbackEntry[] | null>
  validationSummary(
    agentId: bigint | number,
    validators?: Address[],
    tag?: string,
  ): Promise<ValidationSummary | null>
  agentValidations(agentId: bigint | number): Promise<`0x${string}`[] | null>
  validationStatus(requestHash: `0x${string}`): Promise<ValidationStatus | null>
  getJob(commerceAddress: Address, jobId: bigint | number): Promise<CommerceJob | null>
}

type MulticallEntry = { status: 'success'; result: unknown } | { status: 'failure'; error: unknown }

const DEFAULT_BATCH_SIZE = 50
const DEFAULT_MAX_AGENT_ID = 10_000_000n

export function createRegistryReader(chainId: number, options: RegistryReaderOptions = {}): RegistryReader {
  const chain = getChain(chainId)
  const transport = options.transport ?? http(options.rpcUrl ?? chain.rpcUrl)
  const client = createPublicClient({ chain: chain.chain, transport }) as PublicClient
  const multicallAddress = chain.defi.multicall3
  const identity = chain.contracts.identityRegistry
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)

  async function multicall(contracts: unknown[]): Promise<MulticallEntry[]> {
    const results = await client.multicall({
      // The heterogeneous call list defeats viem's per-entry inference; the
      // decoded values are re-narrowed at each use site below.
      contracts: contracts as never,
      allowFailure: true,
      multicallAddress,
    })
    return results as unknown as MulticallEntry[]
  }

  async function readAgentPairs(ids: bigint[]): Promise<Array<OnChainAgent | null>> {
    if (ids.length === 0) return []

    const contracts = ids.flatMap((id) => [
      { address: identity, abi: identityRegistryAbi, functionName: 'ownerOf', args: [id] },
      { address: identity, abi: identityRegistryAbi, functionName: 'tokenURI', args: [id] },
    ])

    const results = await multicall(contracts)

    return ids.map((id, index) => {
      const ownerEntry = results[index * 2]
      const uriEntry = results[index * 2 + 1]
      if (ownerEntry === undefined || ownerEntry.status !== 'success') return null

      const owner = ownerEntry.result as Address
      const tokenUri = uriEntry !== undefined && uriEntry.status === 'success' ? String(uriEntry.result) : ''
      const card: ParseResult =
        tokenUri === ''
          ? { ok: false, kind: 'unknown', error: 'tokenURI reverted or is empty', raw: '' }
          : parseAgentCardFromTokenUri(tokenUri)

      return { agentId: id, owner, tokenUri, card }
    })
  }

  async function lastFeedbackIndex(agentId: bigint | number, client: Address): Promise<number | null> {
    const [entry] = await multicall([
      {
        address: chain.contracts.reputationRegistry,
        abi: reputationRegistryAbi,
        functionName: 'getLastIndex',
        args: [toBigInt(agentId), client],
      },
    ])
    if (entry === undefined || entry.status !== 'success') return null
    return Number(entry.result as bigint)
  }

  async function feedbackClients(agentId: bigint | number): Promise<Address[] | null> {
    const [entry] = await multicall([
      {
        address: chain.contracts.reputationRegistry,
        abi: reputationRegistryAbi,
        functionName: 'getClients',
        args: [toBigInt(agentId)],
      },
    ])
    if (entry === undefined || entry.status !== 'success') return null
    return [...(entry.result as readonly Address[])]
  }

  async function exists(id: bigint): Promise<boolean> {
    const [entry] = await multicall([
      { address: identity, abi: identityRegistryAbi, functionName: 'ownerOf', args: [id] },
    ])
    return entry !== undefined && entry.status === 'success'
  }

  return {
    chainId: chain.id,
    chain,
    client,

    async getAgent(agentId, opts = {}) {
      const id = toBigInt(agentId)
      const [agent] = await readAgentPairs([id])
      if (agent === undefined || agent === null) return null

      if (opts.resolveOffChain === true && !agent.card.ok && (agent.card.kind === 'http' || agent.card.kind === 'ipfs')) {
        return { ...agent, card: await resolveAgentCard(agent.tokenUri, opts) }
      }
      return agent
    },

    async getAgents(agentIds) {
      const ids = agentIds.map(toBigInt)
      const out: Array<OnChainAgent | null> = []
      for (let i = 0; i < ids.length; i += batchSize) {
        out.push(...(await readAgentPairs(ids.slice(i, i + batchSize))))
      }
      return out
    },

    /**
     * The registry is not ERC-721 Enumerable, so there is no `totalSupply()`.
     * Find the last minted id by ramping until `ownerOf` reverts, then
     * bisecting the gap. Roughly 2*log2(n) eth_calls, bounded by `maxId`.
     */
    async highestAgentId(opts = {}) {
      const maxId = opts.maxId ?? DEFAULT_MAX_AGENT_ID

      let low = 0n // highest id known to exist
      let high = 0n // lowest id known to be missing, 0 until one is found

      const hint = opts.hint
      if (hint !== undefined && hint > 0n && hint <= maxId) {
        if (await exists(hint)) low = hint
        else high = hint
      }

      if (high === 0n) {
        let probe = low === 0n ? 1n : low * 2n
        while (probe <= maxId) {
          if (await exists(probe)) {
            low = probe
            probe *= 2n
          } else {
            high = probe
            break
          }
        }
        if (high === 0n) high = maxId + 1n
      }

      while (low + 1n < high) {
        const mid: bigint = low + (high - low) / 2n
        if (await exists(mid)) low = mid
        else high = mid
      }

      return low
    },

    feedbackClients,

    async reputationSummary(agentId, clients = [], tag1 = '', tag2 = '') {
      let audience = clients
      if (audience.length === 0) {
        const known = await feedbackClients(agentId)
        if (known === null || known.length === 0) return null
        audience = known
      }

      const [entry] = await multicall([
        {
          address: chain.contracts.reputationRegistry,
          abi: reputationRegistryAbi,
          functionName: 'getSummary',
          args: [toBigInt(agentId), audience, tag1, tag2],
        },
      ])
      if (entry === undefined || entry.status !== 'success') return null

      const tuple = entry.result as readonly [bigint, bigint, number]
      const value = Number(tuple[1])
      const valueDecimals = Number(tuple[2])
      return {
        count: Number(tuple[0]),
        value,
        valueDecimals,
        score: scaleValue(value, valueDecimals),
      }
    },

    async allFeedback(agentId, clients = [], tag1 = '', tag2 = '', includeRevoked = false) {
      const [entry] = await multicall([
        {
          address: chain.contracts.reputationRegistry,
          abi: reputationRegistryAbi,
          functionName: 'readAllFeedback',
          args: [toBigInt(agentId), clients, tag1, tag2, includeRevoked],
        },
      ])
      if (entry === undefined || entry.status !== 'success') return null

      const tuple = entry.result as readonly [
        readonly Address[],
        readonly bigint[],
        readonly bigint[],
        readonly number[],
        readonly string[],
        readonly string[],
        readonly boolean[],
      ]

      return (tuple[0] ?? []).map((clientAddress, i) => {
        const value = Number(tuple[2]?.[i] ?? 0n)
        const valueDecimals = Number(tuple[3]?.[i] ?? 0)
        return {
          client: clientAddress,
          index: Number(tuple[1]?.[i] ?? 0n),
          value,
          valueDecimals,
          score: scaleValue(value, valueDecimals),
          tag1: tuple[4]?.[i] ?? '',
          tag2: tuple[5]?.[i] ?? '',
          isRevoked: tuple[6]?.[i] ?? false,
        }
      })
    },

    async readFeedback(agentId, client: Address, index) {
      const wanted = toBigInt(index)
      const [entry] = await multicall([
        {
          address: chain.contracts.reputationRegistry,
          abi: reputationRegistryAbi,
          functionName: 'readFeedback',
          args: [toBigInt(agentId), client, wanted],
        },
      ])
      if (entry === undefined || entry.status !== 'success') return null
      return decodeFeedback(client, wanted, entry.result)
    },

    lastFeedbackIndex,

    async feedbackByClient(agentId, client: Address) {
      const last = await lastFeedbackIndex(agentId, client)
      if (last === null) return null
      if (last <= 0) return []

      const id = toBigInt(agentId)
      const indexes = Array.from({ length: last }, (_, i) => BigInt(i + 1))
      const results = await multicall(
        indexes.map((index) => ({
          address: chain.contracts.reputationRegistry,
          abi: reputationRegistryAbi,
          functionName: 'readFeedback',
          args: [id, client, index],
        })),
      )

      const entries: FeedbackEntry[] = []
      indexes.forEach((index, i) => {
        const entry = results[i]
        if (entry === undefined || entry.status !== 'success') return
        entries.push(decodeFeedback(client, index, entry.result))
      })
      return entries
    },

    async validationSummary(agentId, validators = [], tag = '') {
      const [entry] = await multicall([
        {
          address: chain.contracts.validationRegistry,
          abi: validationRegistryAbi,
          functionName: 'getSummary',
          args: [toBigInt(agentId), validators, tag],
        },
      ])
      if (entry === undefined || entry.status !== 'success') return null

      const tuple = entry.result as readonly [bigint, number]
      return { count: Number(tuple[0]), averageResponse: Number(tuple[1]) }
    },

    async agentValidations(agentId) {
      const [entry] = await multicall([
        {
          address: chain.contracts.validationRegistry,
          abi: validationRegistryAbi,
          functionName: 'getAgentValidations',
          args: [toBigInt(agentId)],
        },
      ])
      if (entry === undefined || entry.status !== 'success') return null
      return [...(entry.result as readonly `0x${string}`[])]
    },

    async validationStatus(requestHash) {
      const [entry] = await multicall([
        {
          address: chain.contracts.validationRegistry,
          abi: validationRegistryAbi,
          functionName: 'getValidationStatus',
          args: [requestHash],
        },
      ])
      if (entry === undefined || entry.status !== 'success') return null

      const tuple = entry.result as readonly [Address, bigint, number, `0x${string}`, string, bigint]
      return {
        validator: tuple[0],
        agentId: tuple[1],
        response: Number(tuple[2]),
        responseHash: tuple[3],
        tag: tuple[4],
        lastUpdate: tuple[5],
      }
    },

    async getJob(commerceAddress, jobId) {
      const [entry] = await multicall([
        {
          address: commerceAddress,
          abi: agenticCommerceAbi,
          functionName: 'getJob',
          args: [toBigInt(jobId)],
        },
      ])
      if (entry === undefined || entry.status !== 'success') return null

      const tuple = entry.result as readonly [
        bigint,
        Address,
        Address,
        Address,
        string,
        bigint,
        bigint,
        number,
        Address,
      ]
      return {
        jobId: tuple[0],
        client: tuple[1],
        provider: tuple[2],
        paymentToken: tuple[3],
        metadataUri: tuple[4],
        budget: tuple[5],
        funded: tuple[6],
        status: Number(tuple[7]),
        evaluator: tuple[8],
      }
    },
  }
}

function toBigInt(value: bigint | number): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
}

function scaleValue(value: number, decimals: number): number {
  return decimals === 0 ? value : value / 10 ** decimals
}

function decodeFeedback(client: Address, index: bigint, result: unknown): FeedbackEntry {
  const tuple = result as readonly [bigint, number, string, string, boolean]
  const value = Number(tuple[0])
  const valueDecimals = Number(tuple[1])
  return {
    client,
    index: Number(index),
    value,
    valueDecimals,
    score: scaleValue(value, valueDecimals),
    tag1: tuple[2],
    tag2: tuple[3],
    isRevoked: tuple[4],
  }
}

export type RegistrationLog = {
  address: string
  topics: readonly string[]
}

const ZERO_TOPIC = `0x${'0'.repeat(64)}`

/**
 * Recover the minted agent id from a `register` receipt.
 *
 * The registry emits four logs and only three of them are part of its
 * interface, so the reliable source is the ERC-721 `Transfer` mint:
 * `topics[3]` is the token id. `owner` narrows it further when a receipt
 * carries transfers for more than one account.
 */
export function findRegisteredAgentId(
  logs: readonly RegistrationLog[],
  registry: string,
  owner?: string,
): bigint | null {
  const registryLower = registry.toLowerCase()
  const ownerTopic = owner === undefined ? null : addressTopic(owner)

  for (const log of logs) {
    if (log.address.toLowerCase() !== registryLower) continue
    if (log.topics.length < 4) continue
    if (log.topics[0]?.toLowerCase() !== IDENTITY_EVENT_TOPICS.Transfer) continue
    if (log.topics[1]?.toLowerCase() !== ZERO_TOPIC) continue
    if (ownerTopic !== null && log.topics[2]?.toLowerCase() !== ownerTopic) continue

    const tokenId = log.topics[3]
    if (tokenId === undefined) continue
    return BigInt(tokenId)
  }
  return null
}

function addressTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`
}
