import {
  networkToChainId,
  PERMIT2_ADDRESS,
  selectX402Requirement,
  type Client,
  type FetchWithX402Options,
  type Session,
  type Signer,
  type Wallet,
  type X402Requirement,
} from '@altananetwork/sdk'
import type { Address } from 'viem'

import { createAltanaClient } from './client.js'
import { outcomeFromThrow, toExecuteOutcome, type ExecuteOutcome } from './execute.js'
import { getAltanaNetwork } from './network.js'

/**
 * Paying for HTTP with the session key.
 *
 * x402 turns a 402 response into a signed payment the client attaches and
 * retries with. From an Altana wallet the signature is the session key's, and
 * the merchant's facilitator verifies it on-chain through ERC-1271 — so the
 * same spend cap that bounds the agent's trading also bounds what it can spend
 * on APIs, with no separate budget to keep in sync.
 */

export type X402Rail = 'permit2' | 'eip3009'

/** One payment option from a 402 challenge, in units we can reason about. */
export type PaymentChallenge = {
  scheme: string
  /** As sent: CAIP-2 (`eip155:56`) or a legacy short name (`bsc`). */
  network: string
  /** Resolved from `network` when we recognise it. */
  chainId?: number
  /** Amount in the asset's smallest unit. */
  amountAtomic: bigint
  asset: Address
  payTo: Address
  maxTimeoutSeconds?: number
  /** The rail the merchant expects, when the challenge says. */
  rail?: X402Rail
  /** What the payment buys. */
  resource?: string
  /** The requirement verbatim, for handing back to the SDK. */
  raw: X402Requirement
}

function decodeChallengePayload(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  // Both header dialects allow raw JSON or base64-of-JSON.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return undefined
    }
  }
  try {
    const decoded =
      typeof atob === 'function'
        ? atob(trimmed)
        : Buffer.from(trimmed, 'base64').toString('utf8')
    return JSON.parse(decoded)
  } catch {
    return undefined
  }
}

function requirementsFrom(payload: unknown): X402Requirement[] {
  if (!payload) return []
  if (Array.isArray(payload)) return payload as X402Requirement[]
  if (typeof payload !== 'object') return []

  const body = payload as Record<string, unknown>
  for (const key of ['accepts', 'paymentRequirements', 'requirements', 'options']) {
    const list = body[key]
    if (Array.isArray(list)) return list as X402Requirement[]
    if (list && typeof list === 'object') return [list as X402Requirement]
  }
  // A bare requirement object.
  if ('payTo' in body && 'asset' in body) return [body as unknown as X402Requirement]
  return []
}

function topLevelResource(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const resource = (payload as Record<string, unknown>).resource
  if (typeof resource === 'string') return resource
  if (resource && typeof resource === 'object') {
    const url = (resource as Record<string, unknown>).url
    if (typeof url === 'string') return url
  }
  return undefined
}

/**
 * Which rail the SDK will actually sign for.
 *
 * Deliberately identical to the SDK's private `resolveRail`, including the
 * non-obvious part: a bare `scheme: "exact"` with no `assetTransferMethod`
 * means EIP-3009, not Permit2. If this drifted from the SDK we would show the
 * user one rail and approve the checker for another.
 */
function railOf(requirement: X402Requirement): X402Rail | undefined {
  const method = requirement.extra?.assetTransferMethod
  if (method === 'permit2-exact' || method === 'permit2') return 'permit2'
  if (method === 'eip3009') return 'eip3009'
  if (requirement.scheme === 'permit2') return 'permit2'
  if (requirement.scheme === 'exact') return 'eip3009'
  return undefined
}

function toChallenge(
  requirement: X402Requirement,
  fallbackResource?: string,
): PaymentChallenge | undefined {
  const rawAmount = requirement.amount ?? requirement.maxAmountRequired
  if (rawAmount === undefined || !requirement.asset || !requirement.payTo) return undefined

  let amountAtomic: bigint
  try {
    amountAtomic = BigInt(rawAmount)
  } catch {
    return undefined
  }

  let chainId: number | undefined
  try {
    chainId = networkToChainId(requirement.network)
  } catch {
    chainId = undefined
  }

  const resource =
    typeof requirement.resource === 'string'
      ? requirement.resource
      : requirement.resource?.url ?? fallbackResource

  const rail = railOf(requirement)

  return {
    scheme: requirement.scheme,
    network: requirement.network,
    ...(chainId === undefined ? {} : { chainId }),
    amountAtomic,
    asset: requirement.asset,
    payTo: requirement.payTo,
    ...(requirement.maxTimeoutSeconds === undefined
      ? {}
      : { maxTimeoutSeconds: requirement.maxTimeoutSeconds }),
    ...(rail ? { rail } : {}),
    ...(resource ? { resource } : {}),
    raw: requirement,
  }
}

/**
 * Decode an HTTP 402 challenge into the payment options it offers.
 *
 * Three dialects reach us in practice and all three are handled:
 *   - x402 v2: a `PAYMENT-REQUIRED` response header;
 *   - x402 v1: the challenge echoed in an `X-PAYMENT` response header;
 *   - either version: the JSON body, `{ x402Version, accepts: [...] }`.
 *
 * Header wins over body when both are present. Returns an empty array for a
 * response that is not a payment challenge, rather than throwing — a 402 from
 * a merchant we cannot parse is a fact to report, not a crash.
 */
export async function parsePaymentRequired(response: Response): Promise<PaymentChallenge[]> {
  const headers = response.headers
  const headerValue =
    headers?.get?.('payment-required') ??
    headers?.get?.('x-payment-required') ??
    headers?.get?.('x-payment') ??
    undefined

  let payload = headerValue ? decodeChallengePayload(headerValue) : undefined

  if (requirementsFrom(payload).length === 0) {
    try {
      const source = typeof response.clone === 'function' ? response.clone() : response
      const text = await source.text()
      const fromBody = text ? decodeChallengePayload(text) : undefined
      if (requirementsFrom(fromBody).length > 0) payload = fromBody
    } catch {
      // A body we cannot read leaves us with whatever the headers gave.
    }
  }

  const fallbackResource = topLevelResource(payload) ?? response.url ?? undefined
  return requirementsFrom(payload)
    .map((requirement) => toChallenge(requirement, fallbackResource))
    .filter((challenge): challenge is PaymentChallenge => challenge !== undefined)
}

/**
 * Pick which option to pay, using the SDK's own preference order (payable
 * options first, then the requested chain, then the rail that works for smart
 * accounts).
 */
export function selectPaymentChallenge(
  challenges: readonly PaymentChallenge[],
  opts: FetchWithX402Options = {},
): PaymentChallenge | undefined {
  const chosen = selectX402Requirement(
    challenges.map((challenge) => challenge.raw),
    opts,
  )
  if (!chosen) return undefined
  return challenges.find((challenge) => challenge.raw === chosen)
}

// ---------------------------------------------------------------------------
// Paying
// ---------------------------------------------------------------------------

export type PayWithSessionArgs = {
  chainId: number
  session: Session
  url: string
  init?: RequestInit | undefined
  /** Defaults to permit2 — the rail that works for any token from a 7702 account. */
  preferRail?: X402Rail | undefined
  client?: Client | undefined
}

/**
 * `fetch`, but a 402 is paid from the session key and the request retried.
 * Non-402 responses pass straight through.
 */
export async function payWithSession(args: PayWithSessionArgs): Promise<Response> {
  const network = getAltanaNetwork(args.chainId)
  const client = args.client ?? createAltanaClient(args.chainId)
  return client.fetchWithX402({
    session: args.session,
    url: args.url,
    chainId: network.chainId,
    ...(args.init ? { init: args.init } : {}),
    ...(args.preferRail ? { preferRail: args.preferRail } : {}),
  })
}

// ---------------------------------------------------------------------------
// One-time setup
// ---------------------------------------------------------------------------

export type EnableX402Args = {
  chainId: number
  wallet: Wallet
  /** The user's admin signer — setup is an admin action, not the agent's. */
  adminSigner: Signer
  session: Session
  /** The token the merchant charges in. */
  token: Address
  rail?: X402Rail | undefined
  /** Permit2 allowance. Omit for the SDK's default (unlimited). */
  amount?: bigint | undefined
  client?: Client | undefined
}

export type EnableX402Result = {
  rail: X402Rail
  /** The contract now allowed to verify the session's signatures. */
  checker: Address
  /** Only on the permit2 rail: the ERC-20 approval to Permit2. */
  tokenApproval?: ExecuteOutcome
  checkerApproval: ExecuteOutcome
  ok: boolean
}

/**
 * The two approvals an x402 payer needs once per token.
 *
 * On the permit2 rail: approve the token to Permit2, then tell the account
 * that Permit2 may verify this session's signatures. On the eip3009 rail there
 * is no Permit2 leg and the checker is the token itself — which only works for
 * tokens whose EIP-3009 implementation is ERC-1271 aware.
 *
 * Neither leg throws for a relay refusal; both come back as outcomes.
 */
export async function enableX402(args: EnableX402Args): Promise<EnableX402Result> {
  const network = getAltanaNetwork(args.chainId)
  const client = args.client ?? createAltanaClient(args.chainId)
  const rail: X402Rail = args.rail ?? 'permit2'
  const checker: Address = rail === 'permit2' ? PERMIT2_ADDRESS : args.token
  const ctx = { chainId: network.chainId, address: args.wallet.address }

  let tokenApproval: ExecuteOutcome | undefined
  if (rail === 'permit2') {
    try {
      const result = await client.approveTokenForPermit2({
        wallet: args.wallet,
        signer: args.adminSigner,
        token: args.token,
        chainId: network.chainId,
        ...(args.amount === undefined ? {} : { amount: args.amount }),
      })
      tokenApproval = toExecuteOutcome(result, ctx)
    } catch (error) {
      tokenApproval = outcomeFromThrow(error, ctx)
    }
    if (tokenApproval.kind !== 'confirmed') {
      return { rail, checker, tokenApproval, checkerApproval: tokenApproval, ok: false }
    }
  }

  let checkerApproval: ExecuteOutcome
  try {
    const result = await client.approveSignatureChecker({
      wallet: args.wallet,
      signer: args.adminSigner,
      session: args.session,
      checker,
      chainId: network.chainId,
    })
    checkerApproval = toExecuteOutcome(result, ctx)
  } catch (error) {
    checkerApproval = outcomeFromThrow(error, ctx)
  }

  return {
    rail,
    checker,
    ...(tokenApproval ? { tokenApproval } : {}),
    checkerApproval,
    ok: checkerApproval.kind === 'confirmed',
  }
}

export { PERMIT2_ADDRESS }
export type { X402Requirement }
