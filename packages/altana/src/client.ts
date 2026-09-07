import { createClient, type Client } from '@altananetwork/sdk'

import { getAltanaNetwork } from './network.js'

/**
 * One Altana client per chain.
 *
 * A client is a bundle of configuration — chains, relay endpoints — with no
 * per-user state, so handing out a shared instance is safe and saves rebuilding
 * relay plumbing on every call. Pass `fresh: true` if you want your own.
 */
const cache = new Map<number, Client>()

export function createAltanaClient(
  chainId: number,
  opts: { fresh?: boolean | undefined } = {},
): Client {
  const network = getAltanaNetwork(chainId)
  if (!opts.fresh) {
    const cached = cache.get(network.chainId)
    if (cached) return cached
  }
  const client = createClient({ chains: [network.config], defaultChainId: network.chainId })
  if (!opts.fresh) cache.set(network.chainId, client)
  return client
}

/** Drop cached clients. Tests and long-lived processes that swap RPCs. */
export function resetAltanaClients(): void {
  cache.clear()
}

export type { Client }
