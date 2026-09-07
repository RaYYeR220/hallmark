import { createPublicClient, http, type PublicClient } from 'viem'
import { getChain, type SupportedChainId } from '@hallmark/core'

/**
 * Read-only chain access.
 *
 * One client per (chain, RPC), cached, batching enabled. There is no wallet
 * client anywhere in this service: the only path to a signature is
 * `executeWithSession`, and it builds its own transport through the Altana
 * relay. If you find yourself wanting a `createWalletClient` here, the design
 * has slipped.
 */

const cache = new Map<string, PublicClient>()

export function publicClientFor(chainId: SupportedChainId, rpcUrl?: string): PublicClient {
  const chain = getChain(chainId)
  const url = rpcUrl ?? chain.rpcUrl
  const key = `${chainId}|${url}`
  const cached = cache.get(key)
  if (cached) return cached

  const client = createPublicClient({
    chain: chain.chain,
    transport: http(url, { batch: true, retryCount: 2, timeout: 15_000 }),
  }) as PublicClient

  cache.set(key, client)
  return client
}

export function resetClients(): void {
  cache.clear()
}
