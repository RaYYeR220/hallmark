import 'server-only'

import { unstable_cache } from 'next/cache'

import { getEcosystemSnapshot, getHighestAgentId, type EcosystemSnapshot } from './agents'
import { getCachedHookConfig } from './evidence'
import type { SupportedChainId } from './deployments'

/**
 * Caching policy, in one place, with the windows chosen per fact rather than
 * globally.
 *
 * The rule the product lives by: cache aggressively, but never let a cached
 * number look live. Every cached value below carries the timestamp of the read
 * that produced it, and every surface that renders one prints that timestamp.
 * A reader is always told how old the thing in front of them is.
 *
 * Nothing that gates money is cached. `isHireable` is read fresh on the hire
 * page every single time, because a stale "yes" there is a reverted
 * transaction and a confused user.
 */

/** Registry-wide counts. Change slowly; a few minutes stale is honest. */
export const ECOSYSTEM_TTL_SECONDS = 300

/** Contract configuration. Owner-settable, so re-read hourly, not never. */
/** Contract configuration. Owner-settable, so re-read hourly, not never. Applied in `evidence.ts`. */
export const HOOK_CONFIG_TTL_SECONDS = 3_600

/** The highest minted agent id. Climbs steadily; cheap to be slightly behind. */
export const HIGHEST_ID_TTL_SECONDS = 900

/**
 * Never cache a failure.
 *
 * `getEcosystemSnapshot` returns null when the index does not answer, and
 * `unstable_cache` will happily store that null for the full window — so one
 * transient blip blanks the landing page's headline count for five minutes and
 * every subsequent request is served the failure from cache without retrying.
 * That is exactly what happened once, and the symptom ("the public index is
 * not answering") outlived the outage by minutes.
 *
 * A thrown error is not cached, so the inner function throws and the wrapper
 * turns it back into a null. The next request retries.
 */
const cachedEcosystem = unstable_cache(
  async (chainId: SupportedChainId): Promise<EcosystemSnapshot> => {
    const snapshot = await getEcosystemSnapshot(chainId)
    if (snapshot === null) throw new Error(`ecosystem snapshot unavailable for chain ${chainId}`)
    return snapshot
  },
  ['ecosystem-snapshot'],
  { revalidate: ECOSYSTEM_TTL_SECONDS, tags: ['ecosystem'] },
)

export async function getCachedEcosystem(
  chainId: SupportedChainId,
): Promise<EcosystemSnapshot | null> {
  return cachedEcosystem(chainId).catch(() => null)
}

// Defined in `evidence.ts`, beside the uncached read it wraps, and re-exported
// here so every caching decision in the app is still listed in one file.
export { getCachedHookConfig }

export const getCachedHighestAgentId = unstable_cache(
  async (chainId: SupportedChainId, hint: number): Promise<number | null> =>
    getHighestAgentId(chainId, hint),
  ['highest-agent-id'],
  { revalidate: HIGHEST_ID_TTL_SECONDS, tags: ['highest-agent-id'] },
)

/**
 * A hint for the binary search that finds the highest minted agent id.
 *
 * The registry is ERC-721 but not Enumerable, so there is no `totalSupply()`
 * and the id has to be discovered by probing `ownerOf`. A good hint turns
 * roughly 37 `eth_call`s into about 4. These are floors observed at build
 * time — being wrong only costs a few extra calls, never a wrong answer.
 */
export const HIGHEST_ID_HINTS: Record<SupportedChainId, number> = {
  56: 338_000,
  97: 2_200,
}
