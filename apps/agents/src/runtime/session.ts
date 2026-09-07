import {
  buildPolicy,
  executeWithSession,
  fromAltanaPermissions,
  restoreSessionFromKey,
  type AgentPolicy,
  type SerializedSession,
  type Session,
} from '@hallmark/altana'
import type { SupportedChainId } from '@hallmark/core'
import type { Hex } from 'viem'

import type { Executor, PolicyBinding, SessionHandle, SessionProvider } from './types.js'

/**
 * Where the agent's authority comes from — and, mostly, where it does not.
 *
 * The agent never sees a user's private key. What it can hold is *its own*
 * session key: a second key the user granted, which the account contract only
 * honours inside a contract allowlist, a spend cap and an expiry, and which
 * one transaction revokes. This module is the only place that key is loaded,
 * and `executeWithSession` is the only thing that can use it.
 *
 * The default provider returns `null` for every chain. A deployment with no
 * grant is read-only and says so: `act` answers `aborted / no-session` with
 * the calls it *would* have sent, which is a more useful demo than a
 * transaction nobody authorised.
 */

export function noSessionProvider(): SessionProvider {
  return { async get() { return null } }
}

/** Fixed handles, keyed `${chainId}:${policyCategory}`. Used by the tests. */
export function staticSessionProvider(
  handles: Record<string, SessionHandle | null>,
): SessionProvider {
  return {
    async get(chainId, binding) {
      return handles[`${chainId}:${binding.category}`] ?? null
    },
  }
}

const ENV_SUFFIX: Record<PolicyBinding['category'], string> = {
  'pancake-rebalance': 'REBALANCE',
  'pancake-grid': 'GRID',
  'yield-routing': 'YIELD',
  'venus-health-factor': 'HEALTH',
}

function readJson<T>(raw: string | undefined): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * Load session keys from the environment.
 *
 * Two variables per category, e.g. `HALLMARK_SESSION_HEALTH` (the serialized
 * session, no key material) and `HALLMARK_SESSION_KEY_HEALTH` (the key). They
 * are split on purpose: the serialized half is safe to log, commit to a
 * deployment record, or show a user; the key half is not, and keeping them in
 * one blob is how the key ends up somewhere it should not be.
 *
 * The policy is reconstructed from the session's own permissions, so what the
 * refusal report shows is what the chain will actually enforce — not a policy
 * object we built from a template and hoped matched.
 */
export function envSessionProvider(
  env: Record<string, string | undefined> = process.env,
): SessionProvider {
  const cache = new Map<string, SessionHandle | null>()

  return {
    async get(chainId, binding) {
      const key = `${chainId}:${binding.category}`
      const cached = cache.get(key)
      if (cached !== undefined) return cached

      const suffix = ENV_SUFFIX[binding.category]
      const serialized = readJson<SerializedSession>(env[`HALLMARK_SESSION_${suffix}`])
      const privateKey = env[`HALLMARK_SESSION_KEY_${suffix}`] as Hex | undefined

      if (serialized === null || !privateKey) {
        cache.set(key, null)
        return null
      }

      let session: Session
      try {
        session = restoreSessionFromKey(serialized, privateKey)
      } catch {
        // A stored session that will not restore is not a session. Treating it
        // as absent keeps the failure visible as `no-session` rather than as a
        // crash halfway through an act.
        cache.set(key, null)
        return null
      }

      const policy: AgentPolicy = fromAltanaPermissions(session.permissions, {
        label: buildPolicy(binding.category, chainId).label,
        expiresAt: session.expiry,
      })

      const handle: SessionHandle = { session, policy, chainId }
      cache.set(key, handle)
      return handle
    },
  }
}

/**
 * The real executor. The only path from an agent's decision to a signature.
 *
 * Preflight stays on: refusing locally costs no relay round trip and produces
 * the same answer, and `executeWithSession` returns the refusal as a value
 * either way.
 */
export function altanaExecutor(): Executor {
  return async ({ chainId, session, calls }) =>
    executeWithSession({ chainId, session, calls, preflight: true })
}

/** A session handle built straight from a policy category. For fixtures. */
export function handleFromPolicy(
  chainId: SupportedChainId,
  session: Session,
  category: PolicyBinding['category'],
  opts: { now?: number; ttlSeconds?: number } = {},
): SessionHandle {
  const policy = buildPolicy(category, chainId, {
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.ttlSeconds === undefined ? {} : { ttlSeconds: opts.ttlSeconds }),
  })
  return { session, policy, chainId }
}
