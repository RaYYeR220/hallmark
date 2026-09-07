/**
 * One read of everything three ERC-8004 registries know about an agent:
 * who owns it, what its registration file says, what has been validated and
 * what clients have said about it.
 */

import { addressUrl, createRegistryReader, getChain } from '@hallmark/core'
import type { AgentCard, RegistryReaderOptions, ReputationSummary, TokenUriKind } from '@hallmark/core'

import { getValidationStatus, type ValidationStatusReport } from './validation.js'
import type { Address } from './types.js'

export type AgentStatusReport = {
  chainId: number
  agentId: bigint
  exists: boolean
  owner: Address | null
  tokenUriKind: TokenUriKind | null
  tokenUriBytes: number | null
  card: AgentCard | null
  cardError: string | null
  cardWarnings: string[]
  validation: ValidationStatusReport | null
  reputation: (ReputationSummary & { clients: number }) | null
  explorerUrls: { registry: string; agent: string }
}

export type AgentStatusInput = {
  agentId: bigint | number
  chainId: number
  /** Follow http/ipfs tokenURIs off-chain. Off by default: it is a network call to a host the agent chose. */
  resolveOffChain?: boolean
} & RegistryReaderOptions

export async function getAgentStatus(input: AgentStatusInput): Promise<AgentStatusReport> {
  const { agentId, chainId, resolveOffChain, ...readerOptions } = input
  const chain = getChain(chainId)
  const reader = createRegistryReader(chain.id, readerOptions)
  const id = BigInt(agentId)

  const agent = await reader.getAgent(id, resolveOffChain === true ? { resolveOffChain: true } : {})

  const explorerUrls = {
    registry: addressUrl(chain.id, chain.contracts.identityRegistry),
    agent: `${chain.explorer}/token/${chain.contracts.identityRegistry}?a=${id}`,
  }

  if (agent === null) {
    return {
      chainId: chain.id,
      agentId: id,
      exists: false,
      owner: null,
      tokenUriKind: null,
      tokenUriBytes: null,
      card: null,
      cardError: 'agent id has never been minted',
      cardWarnings: [],
      validation: null,
      reputation: null,
      explorerUrls,
    }
  }

  const [validation, clients] = await Promise.all([
    getValidationStatus({ agentId: id, chainId: chain.id, ...readerOptions }),
    reader.feedbackClients(id),
  ])

  let reputation: AgentStatusReport['reputation'] = null
  if (clients !== null && clients.length > 0) {
    const summary = await reader.reputationSummary(id, clients)
    if (summary !== null) reputation = { ...summary, clients: clients.length }
  }

  return {
    chainId: chain.id,
    agentId: id,
    exists: true,
    owner: agent.owner,
    tokenUriKind: agent.card.kind,
    tokenUriBytes: agent.tokenUri.length,
    card: agent.card.ok ? agent.card.card : null,
    cardError: agent.card.ok ? null : agent.card.error,
    cardWarnings: agent.card.ok ? agent.card.warnings : [],
    validation,
    reputation,
    explorerUrls,
  }
}
