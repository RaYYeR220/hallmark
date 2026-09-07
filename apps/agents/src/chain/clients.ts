import { createPublicClient, http, type Chain, type HttpTransport, type PublicClient } from 'viem'
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

/**
 * The one client shape this service uses.
 *
 * Naming it matters for more than tidiness. `createPublicClient` infers its
 * return type from the exact `chain` object handed to it, and a fully-specified
 * BNB Chain definition makes that inference deep enough to trip
 * `TS2589: Type instantiation is excessively deep`. Giving the call a
 * contextual type — and widening `chain` to the `Chain` interface — stops the
 * compiler having to build the specialised type at all, which is a fix rather
 * than a suppression: the earlier `as PublicClient` was an assertion between
 * two types that did not overlap, and TypeScript was right to flag it.
 */
export type ChainClient = PublicClient<HttpTransport, Chain>

const cache = new Map<string, ChainClient>()

export function publicClientFor(chainId: SupportedChainId, rpcUrl?: string): ChainClient {
  const chain = getChain(chainId)
  const url = rpcUrl ?? chain.rpcUrl
  const key = `${chainId}|${url}`
  const cached = cache.get(key)
  if (cached) return cached

  const client: ChainClient = createPublicClient<HttpTransport, Chain>({
    chain: chain.chain satisfies Chain,
    transport: http(url, { batch: true, retryCount: 2, timeout: 15_000 }),
  })

  cache.set(key, client)
  return client
}

export function resetClients(): void {
  cache.clear()
}
