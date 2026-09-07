import {
  deserializeSession,
  serializeSession,
  signerFromPrivateKey,
  type Client,
  type SerializedSession,
  type Session,
  type SessionPermissions,
  type Signer,
  type Wallet,
} from '@altananetwork/sdk'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'

import { createAltanaClient } from './client.js'
import { InvalidPolicyError } from './errors.js'
import {
  looksUnfunded,
  outcomeFromThrow,
  toExecuteOutcome,
  type ExecuteOutcome,
  type OutcomeContext,
} from './execute.js'
import {
  estimateGrantCostWei,
  keystoreExplorerUrl,
  keystoreKeyUrl,
  sessionKeyId,
} from './keystore.js'
import { getAltanaNetwork, txExplorerUrl } from './network.js'
import { toAltanaPermissions, validatePolicy, type AgentPolicy } from './policy.js'

/**
 * Granting and revoking the agent's authority.
 *
 * The invariant this module exists to hold: activating an agent never moves
 * custody. The user keeps the admin key; the agent gets a second key that the
 * account contract will only honour inside the policy, and that one
 * transaction can kill.
 */

export type AgentWallet = {
  wallet: Wallet
  signer: Signer
  /**
   * The wallet address. Altana delegates onto the EOA (EIP-7702), so this is
   * the signer's own address — not a new counterfactual account, and identical
   * on chains 56 and 97. Say so in UI copy; users notice.
   */
  address: Address
}

/** A fresh secp256k1 key. The SDK does not re-export viem's generator. */
export function generateSessionKey(): Hex {
  return generatePrivateKey()
}

/** The EOA address a private key controls — and therefore the wallet address. */
export function addressForPrivateKey(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address
}

/**
 * Set up (or re-attach to) the user's Altana wallet for a chain.
 *
 * No transaction: the relay registers the account counterfactually and the
 * first `execute` pays for the on-chain part.
 */
export async function createAgentWallet(
  chainId: number,
  privateKey: Hex,
  opts: { client?: Client | undefined } = {},
): Promise<AgentWallet> {
  const client = opts.client ?? createAltanaClient(chainId)
  const signer = signerFromPrivateKey(privateKey)
  const wallet = await client.createWallet({ signer })
  return { wallet: { address: wallet.address }, signer: wallet.signer, address: wallet.address }
}

// ---------------------------------------------------------------------------
// Grant
// ---------------------------------------------------------------------------

export type GrantedSession = {
  kind: 'granted'
  chainId: number
  policy: AgentPolicy
  permissions: SessionPermissions
  session: Session
  /** JSON-safe, key-free. Store this; store the key separately. */
  serialized: SerializedSession
  walletAddress: Address
  publicKey: Hex
  /** keccak256(publicKey) — how the Keystore names this key. */
  keyId: Hex
  expiresAt: number
  txHash?: Hex
  /** BscScan link for the grant transaction, when the relay reported one. */
  explorerUrl?: string
  /** Altana Keystore page for the wallet. */
  keystoreAccountUrl: string
  /** Altana Keystore page for this key: active, revoked or expired. */
  keystoreKeyUrl: string
}

/**
 * A grant either produces a session or produces one of the same failures an
 * execute can, so the failure half of the union is shared verbatim. UI code
 * switches on `kind` once and handles both.
 */
export type GrantResult = GrantedSession | Exclude<ExecuteOutcome, { kind: 'confirmed' }>

export type GrantAgentSessionArgs = {
  chainId: number
  wallet: Wallet
  /** The user's admin signer. Authorises the grant; never leaves the user. */
  adminSigner: Signer
  policy: AgentPolicy
  /**
   * The agent's key. One of these is required: an SDK-generated session key
   * lives only in process memory, and losing it strands a live on-chain
   * authorization that only a revoke can clear.
   */
  sessionPrivateKey?: Hex | undefined
  sessionSigner?: Signer | undefined
  /** Write the key to the Keystore so third parties can verify it. Default true. */
  register?: boolean | undefined
  client?: Client | undefined
  /** Skip `validatePolicy` when you have already run it. */
  skipValidation?: boolean | undefined
  now?: number | undefined
}

/**
 * Grant the agent its scoped key.
 *
 * Costs native BNB — the relay attaches a Keystore fee to each Controller call,
 * and a first grant makes two. An unfunded wallet comes back as an `unfunded`
 * outcome with the figure to send, not as an exception.
 */
export async function grantAgentSession(args: GrantAgentSessionArgs): Promise<GrantResult> {
  const network = getAltanaNetwork(args.chainId)

  if (!args.skipValidation) {
    const validation = validatePolicy(args.policy, { now: args.now })
    if (!validation.ok) throw new InvalidPolicyError(validation.problems)
  }

  const sessionSigner =
    args.sessionSigner ??
    (args.sessionPrivateKey ? signerFromPrivateKey(args.sessionPrivateKey) : undefined)
  if (!sessionSigner) {
    throw new InvalidPolicyError([
      'grantAgentSession needs an explicit sessionPrivateKey or sessionSigner. ' +
        'Letting the SDK generate one puts the only copy of a live on-chain ' +
        'authorization in process memory.',
    ])
  }

  const permissions = toAltanaPermissions(args.policy)
  const client = args.client ?? createAltanaClient(args.chainId)
  const ctx: OutcomeContext = {
    chainId: network.chainId,
    now: args.now,
    address: args.wallet.address,
    session: { permissions, expiry: args.policy.expiresAt },
  }

  try {
    const granted = await client.grantSession({
      wallet: args.wallet,
      signer: args.adminSigner,
      sessionSigner,
      permissions,
      expiry: args.policy.expiresAt,
      chainId: network.chainId,
      ...(args.register === undefined ? {} : { register: args.register }),
    })

    const session: Session = {
      walletAddress: granted.walletAddress,
      signer: granted.signer,
      publicKey: granted.publicKey,
      permissions: granted.permissions,
      expiry: granted.expiry,
    }
    const keyId = sessionKeyId(session.publicKey)

    return {
      kind: 'granted',
      chainId: network.chainId,
      policy: args.policy,
      permissions,
      session,
      serialized: serializeSession(session),
      walletAddress: session.walletAddress,
      publicKey: session.publicKey,
      keyId,
      expiresAt: session.expiry,
      ...(granted.transactionHash
        ? {
            txHash: granted.transactionHash,
            explorerUrl: txExplorerUrl(network.chainId, granted.transactionHash),
          }
        : {}),
      keystoreAccountUrl: keystoreExplorerUrl(network.chainId, session.walletAddress),
      keystoreKeyUrl: keystoreKeyUrl(network.chainId, keyId),
    }
  } catch (error) {
    // grantSession is the one SDK entry point that throws on a failed relay
    // answer, because it has no Session to hand back. Everything it can throw
    // for is still an ordinary situation, so it comes back as an outcome.
    //
    // The Keystore fee moves, so an unfunded wallet gets a live quote rather
    // than the constant we measured once. A failed read just falls back.
    const requiredWei = looksUnfunded(error)
      ? await estimateGrantCostWei(network.chainId, {
          ...(args.register === undefined ? {} : { register: args.register }),
        }).catch(() => undefined)
      : undefined
    const outcome = outcomeFromThrow(error, {
      ...ctx,
      ...(requiredWei === undefined ? {} : { requiredWei }),
    })
    return outcome as Exclude<ExecuteOutcome, { kind: 'confirmed' }>
  }
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

export type RevokeAgentSessionArgs = {
  chainId: number
  wallet: Wallet
  adminSigner: Signer
  /** The live session, or just its public key. */
  session: Session | Hex
  client?: Client | undefined
}

/**
 * Kill the agent's authority. One transaction, effective immediately, and
 * visible to anyone reading the Keystore afterwards.
 */
export async function revokeAgentSession(
  args: RevokeAgentSessionArgs,
): Promise<ExecuteOutcome> {
  const network = getAltanaNetwork(args.chainId)
  const client = args.client ?? createAltanaClient(args.chainId)
  const ctx: OutcomeContext = { chainId: network.chainId, address: args.wallet.address }

  try {
    const result = await client.revokeSession({
      wallet: args.wallet,
      signer: args.adminSigner,
      session: args.session,
      chainId: network.chainId,
    })
    return toExecuteOutcome(result, ctx)
  } catch (error) {
    return outcomeFromThrow(error, ctx)
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export type StoredSessionMeta = {
  version: 1
  chainId?: number
  keyId: Hex
  label?: string
  /** Unix seconds. */
  grantedAt: number
  txHash?: Hex
}

/**
 * `serializeSession` plus a small Hallmark envelope.
 *
 * The SDK ignores unknown top-level fields on restore, so the envelope costs
 * nothing and saves the app a second table just to remember which chain and
 * which agent a stored session belongs to. Still no key material.
 */
export type StoredSession = SerializedSession & { hallmark: StoredSessionMeta }

export function persistSession(
  session: Session,
  meta: {
    chainId?: number | undefined
    label?: string | undefined
    grantedAt?: number | undefined
    txHash?: Hex | undefined
  } = {},
): StoredSession {
  return {
    ...serializeSession(session),
    hallmark: {
      version: 1,
      keyId: sessionKeyId(session.publicKey),
      grantedAt: meta.grantedAt ?? Math.floor(Date.now() / 1000),
      ...(meta.chainId === undefined ? {} : { chainId: meta.chainId }),
      ...(meta.label === undefined ? {} : { label: meta.label }),
      ...(meta.txHash === undefined ? {} : { txHash: meta.txHash }),
    },
  }
}

/**
 * Rebuild a live session from storage plus the key you kept.
 *
 * Throws when the key does not match the stored public key — loudly here
 * beats opaquely at the relay three steps later.
 */
export function restoreSession(stored: SerializedSession, signer: Signer): Session {
  return deserializeSession(stored, signer)
}

/** Convenience: restore straight from a stored session and its private key. */
export function restoreSessionFromKey(stored: SerializedSession, privateKey: Hex): Session {
  return deserializeSession(stored, signerFromPrivateKey(privateKey))
}

export { signerFromPrivateKey }
export type { SerializedSession, Session, SessionPermissions, Signer, Wallet }
