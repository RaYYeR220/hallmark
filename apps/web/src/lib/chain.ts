import 'server-only'

import { createPublicClient, http, type PublicClient } from 'viem'
import { getChain, type SupportedChainId } from '@hallmark/core'

import { rpcUrlFor } from './env'

/**
 * Public clients, one per chain, reused across requests.
 *
 * Every read in the app goes through these. Batching is on: the agent list
 * issues one multicall per page rather than fifty `eth_call`s, which is the
 * difference between a page that loads and a public node that rate-limits us.
 */

const clients = new Map<number, PublicClient>()

export function publicClientFor(chainId: SupportedChainId): PublicClient {
  const cached = clients.get(chainId)
  if (cached !== undefined) return cached

  const chain = getChain(chainId)
  const client = createPublicClient({
    chain: chain.chain,
    transport: http(rpcUrlFor(chainId) ?? chain.rpcUrl, {
      // Public nodes are the default. Retry twice with a short backoff rather
      // than surfacing a transient 429 as a broken page.
      retryCount: 2,
      retryDelay: 250,
      timeout: 12_000,
      batch: { wait: 12 },
    }),
    batch: { multicall: { batchSize: 2_048, wait: 12 } },
  }) as PublicClient

  clients.set(chainId, client)
  return client
}

/** The multicall3 aggregator for a chain, used by every batched read. */
export function multicallAddressFor(chainId: SupportedChainId): `0x${string}` {
  return getChain(chainId).defi.multicall3
}

export function isSupportedChain(value: unknown): value is SupportedChainId {
  return value === 56 || value === 97
}

/** Parse a chain id out of a route segment. Returns null on anything else. */
export function parseChainId(raw: string | undefined): SupportedChainId | null {
  if (raw === undefined) return null
  const parsed = Number(raw)
  return isSupportedChain(parsed) ? parsed : null
}

/** Parse an agent id out of a route segment. Agent ids are positive integers. */
export function parseAgentId(raw: string | undefined): number | null {
  if (raw === undefined) return null
  if (!/^\d+$/.test(raw)) return null
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  return parsed
}
