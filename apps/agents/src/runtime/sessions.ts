import {
  buildPolicy,
  describePolicy,
  isKeyIdValid,
  keystoreExplorerUrl,
  keystoreKeyUrl,
  sessionKeyId,
  tokenSymbol,
  type AgentPolicy,
} from '@hallmark/altana'
import { getChain, type SupportedChainId } from '@hallmark/core'
import { formatUnits, type Address, type Hex } from 'viem'

import { AGENTS } from '../registry.js'
import { withDeadline } from './deadline.js'
import type { PolicyBinding, RuntimeConfig, SessionProvider } from './types.js'

/**
 * What the marketplace's sessions page renders.
 *
 * The interesting half is the ungranted case. A page that only lists live keys
 * tells a user nothing about what they would be agreeing to, so every category
 * appears here whether or not a session exists, carrying the policy that
 * *would* be granted — the same builder, the same caps, the same allowlist.
 * "Here is exactly what this agent could do, and it currently cannot do it" is
 * a more honest thing to show than an empty list.
 *
 * The `valid` flag is read from the Keystore on every request rather than
 * cached. A revocation is meant to be immediate and provable, and a page
 * serving a stale `true` would quietly undo that.
 */

export type SessionCap = {
  token: Address
  symbol: string
  limitAtomic: string
  limitDisplay: string
  period: 'day' | 'hour'
}

export type SessionView = {
  agent: string
  agentName: string
  category: PolicyBinding['category']
  chainId: SupportedChainId
  granted: boolean
  /** The wallet the key acts for. Absent when nothing is granted. */
  wallet: Address | null
  publicKey: Hex | null
  /** keccak256(publicKey) — how the Keystore names it. */
  keyId: Hex | null
  expiresAt: number | null
  expiresAtIso: string | null
  expired: boolean | null
  keystore: {
    contract: Address
    /** Live read. `null` when the key does not exist or the read failed. */
    valid: boolean | null
    accountUrl: string | null
    keyUrl: string | null
    detail: string
  }
  policy: {
    label: string
    /** Plain-English lines, the same copy the grant dialog shows. */
    lines: string[]
    allowlist: Array<{ to: Address | null; signature: string | null; label: string }>
    caps: SessionCap[]
    /** True when no rule in the allowlist can increase a position's debt. */
    cannotBorrow: boolean
  }
  detail: string
}

function capsOf(policy: AgentPolicy): SessionCap[] {
  return policy.spend.map((cap) => ({
    token: cap.token,
    symbol: tokenSymbol(cap.token),
    limitAtomic: cap.limitAtomic.toString(),
    limitDisplay: `${formatUnits(cap.limitAtomic, cap.decimals)} ${tokenSymbol(cap.token)}`,
    period: cap.period,
  }))
}

/**
 * Can anything on this allowlist increase debt?
 *
 * Reported rather than asserted, because it is the claim a reader most wants
 * checked and least wants to take on trust. A contract-scoped rule — one with
 * no signature — permits every function on that contract, `borrow` included,
 * so only a fully selector-scoped policy with no borrowing selector can answer
 * true here.
 */
export function cannotBorrow(policy: AgentPolicy): boolean {
  return policy.calls.every(
    (rule) => rule.signature !== undefined && !rule.signature.startsWith('borrow('),
  )
}

export async function describeSessions(args: {
  config: RuntimeConfig
  sessions: SessionProvider
  chainId: SupportedChainId
  /** Budget for each Keystore read. A slow node must not hang the page. */
  timeoutMs?: number
}): Promise<SessionView[]> {
  const { config, sessions, chainId } = args
  const chain = getChain(chainId)
  const now = Math.floor(Date.now() / 1000)
  const timeoutMs = args.timeoutMs ?? 6_000

  const views: SessionView[] = []

  for (const agent of AGENTS) {
    const binding = agent.manifest.policy
    if (binding === null) continue

    const handle = await sessions.get(chainId, binding).catch(() => null)
    const policy = handle?.policy ?? buildPolicy(binding.category, chainId, { now })

    const base = {
      agent: agent.manifest.slug,
      agentName: agent.manifest.name,
      category: binding.category,
      chainId,
      policy: {
        label: policy.label,
        lines: describePolicy(policy, { now }),
        allowlist: policy.calls.map((rule) => ({
          to: rule.to ?? null,
          signature: rule.signature ?? null,
          label: rule.label,
        })),
        caps: capsOf(policy),
        cannotBorrow: cannotBorrow(policy),
      },
    }

    if (handle === null) {
      views.push({
        ...base,
        granted: false,
        wallet: null,
        publicKey: null,
        keyId: null,
        expiresAt: null,
        expiresAtIso: null,
        expired: null,
        keystore: {
          contract: chain.contracts.altanaKeyStore,
          valid: null,
          accountUrl: null,
          keyUrl: null,
          detail:
            'No session is granted for this agent on this chain, so there is no key to check. ' +
            'The policy above is what a grant would authorise — nothing more, and it is fixed ' +
            'at grant time.',
        },
        detail:
          `${agent.manifest.name} is read-only right now: \`act\` answers with the calls it ` +
          'would have sent and why it cannot send them.',
      })
      continue
    }

    const keyId = sessionKeyId(handle.session.publicKey)
    const wallet = handle.session.walletAddress
    const expiresAt = handle.session.expiry

    const read = await withDeadline(
      isKeyIdValid(chainId, wallet, keyId, { rpcUrl: config.rpcUrl[chainId] ?? chain.rpcUrl }),
      { label: `keystore ${keyId}`, timeoutMs },
    ).catch(() => ({ ok: false as const, timedOut: true as const, label: 'keystore', timeoutMs }))

    const valid = read.ok ? read.value : null
    const expired = expiresAt <= now

    views.push({
      ...base,
      granted: true,
      wallet,
      publicKey: handle.session.publicKey,
      keyId,
      expiresAt,
      expiresAtIso: new Date(expiresAt * 1000).toISOString(),
      expired,
      keystore: {
        contract: chain.contracts.altanaKeyStore,
        valid,
        accountUrl: keystoreExplorerUrl(chainId, wallet),
        keyUrl: keystoreKeyUrl(chainId, keyId),
        detail:
          valid === null
            ? `The Keystore did not answer within ${timeoutMs}ms, so validity is unknown rather ` +
              'than assumed. Read it yourself: isValidKey(wallet, keyId) on ' +
              `${chain.contracts.altanaKeyStore}.`
            : valid
              ? `isValidKey(${wallet}, ${keyId}) returned true, read live from ` +
                `${chain.contracts.altanaKeyStore}. One eth_call, no credentials — repeat it ` +
                'against any public node.'
              : `isValidKey(${wallet}, ${keyId}) returned false: never registered, revoked, or ` +
                'expired. The agent cannot sign anything with it.',
      },
      detail: expired
        ? `The grant expired at ${new Date(expiresAt * 1000).toISOString()}. Permissions are fixed ` +
          'at grant time and cannot be extended; a new key has to be granted.'
        : valid === false
          ? 'Revoked or never registered. Revocation is one transaction and takes effect immediately.'
          : `Live. ${agent.manifest.name} can act inside the scope above and nowhere else.`,
    })
  }

  return views
}
