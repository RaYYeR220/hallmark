import { createPublicClient, http, type Chain } from 'viem'
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
 * Build the one client shape this service uses.
 *
 * Two things are deliberate, and both were bugs before.
 *
 * `chain` is typed as the wide `Chain` interface rather than a specific chain
 * object. viem infers the client type from whatever it is handed, and a
 * fully-specified BNB Chain definition makes that inference deep enough to
 * trip `TS2589: Type instantiation is excessively deep`.
 *
 * And the generics are left to inference rather than written out. Naming them
 * (`createPublicClient<HttpTransport, Chain>`) looks tidier and is wrong: the
 * account parameter then takes its default while the value passed infers
 * something else, and the two disagree — which typechecked locally and failed
 * in the deployment, the worst place to find out.
 */
function createChainClient(chain: Chain, rpcUrl: string) {
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { batch: true, retryCount: 2, timeout: 15_000 }),
  })
}

/**
 * Exact by construction: the type is whatever the constructor returns, so it
 * cannot drift from it the way a hand-written annotation can.
 */
export type ChainClient = ReturnType<typeof createChainClient>

const cache = new Map<string, ChainClient>()

export function publicClientFor(chainId: SupportedChainId, rpcUrl?: string): ChainClient {
  const chain = getChain(chainId)
  const url = rpcUrl ?? chain.rpcUrl
  const key = `${chainId}|${url}`
  const cached = cache.get(key)
  if (cached) return cached

  const client = createChainClient(chain.chain, url)
  cache.set(key, client)
  return client
}

export function resetClients(): void {
  cache.clear()
}
