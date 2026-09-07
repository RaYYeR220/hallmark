import type { Address } from 'viem'

import type { AgentManifest, AgentSkill, RuntimeConfig } from './types.js'
import type { SupportedChainId } from '@hallmark/core'

/**
 * The x402 face: an endpoint that answers `402` with a payment challenge and
 * does the work once the payment verifies.
 *
 * **v2 is header-based.** Measured against the live reference endpoint at
 * `https://x402.org/protected`: the 402 carries an empty `{}` body and the
 * challenge base64-encoded in a `payment-required` response header. A payer
 * that only reads the body sees nothing. The v1 body-carried form is legacy,
 * but it costs nothing to emit alongside — and older clients still look for
 * `X-PAYMENT` — so this serves both and reads either on the way back in.
 *
 * Two more details that are easy to get wrong and expensive to get wrong:
 *
 *   - `network` is CAIP-2 (`eip155:56`), not a bare chain id;
 *   - `amount` is atomic, as a string, and BNB Chain stablecoins are
 *     **18 decimals**. A price copied from a 6-decimal USDC codebase is off by
 *     a factor of a trillion, and in the direction that serves the work free.
 *
 * Verification is an injected interface with a *refusing* default. Settling an
 * x402 payment means a facilitator submitting an on-chain transfer. This
 * service holds no key and will not pretend a payment landed: with no
 * facilitator configured, a paid request comes back as another 402 saying
 * exactly that, rather than serving the work and calling it paid.
 */

/** One payment option, x402 v2 shape. */
export type X402Accept = {
  scheme: 'exact'
  /** CAIP-2. `eip155:56` on BNB Smart Chain. */
  network: string
  /** Atomic units of `asset`, as a string. */
  amount: string
  asset: Address
  payTo: Address
  maxTimeoutSeconds: number
  extra: {
    name: string
    version: string
    decimals: number
    /** `permit2-exact` is the rail a 7702 smart account can actually sign. */
    assetTransferMethod: 'permit2-exact'
  }
  /** v1 compatibility: older payers read this key rather than `amount`. */
  maxAmountRequired: string
  /** v1 compatibility: older payers expect the resource on the accept. */
  resource: string
  mimeType: 'application/json'
  description: string
}

export type X402Challenge = {
  x402Version: 2
  error?: string
  resource: {
    url: string
    description: string
    mimeType: 'application/json'
  }
  accepts: X402Accept[]
}

export type PaymentPayload = {
  x402Version?: number
  scheme?: string
  network?: string
  payload?: unknown
  [key: string]: unknown
}

export type VerificationResult =
  | { ok: true; payer?: Address; txHash?: string; detail: string }
  | { ok: false; reason: string; retryable: boolean }

export type PaymentVerifier = {
  name: string
  verify: (args: {
    payment: PaymentPayload
    accept: X402Accept
    resource: string
  }) => Promise<VerificationResult>
}

/**
 * The default. Refuses every payment, with the reason.
 *
 * Not a stub for a missing feature — it is the correct behaviour for a service
 * with no settlement path. An agent that served paid work on an unverified
 * payment header would be free money for anyone who can spell base64.
 */
export function rejectingVerifier(): PaymentVerifier {
  return {
    name: 'none',
    async verify() {
      return {
        ok: false,
        retryable: false,
        reason:
          'No x402 facilitator is configured for this deployment, so the payment cannot be ' +
          'verified or settled. Set X402_FACILITATOR_URL to a facilitator that serves ' +
          '/verify and /settle for this network.',
      }
    },
  }
}

/**
 * Talk to a standard x402 facilitator: `POST /verify`, then `POST /settle`.
 *
 * A facilitator that verifies but fails to settle is a refusal, not a success:
 * the work is only paid for once the transfer is on-chain.
 */
export function facilitatorVerifier(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): PaymentVerifier {
  const root = baseUrl.replace(/\/+$/, '')
  return {
    name: root,
    async verify({ payment, accept }) {
      const body = JSON.stringify({
        x402Version: 2,
        paymentPayload: payment,
        paymentRequirements: accept,
      })
      const headers = { 'content-type': 'application/json' }

      let verifyJson: Record<string, unknown>
      try {
        const res = await fetchImpl(`${root}/verify`, { method: 'POST', headers, body })
        verifyJson = (await res.json()) as Record<string, unknown>
        if (!res.ok || verifyJson['isValid'] !== true) {
          return {
            ok: false,
            retryable: false,
            reason: `Facilitator rejected the payment: ${String(
              verifyJson['invalidReason'] ?? `HTTP ${res.status}`,
            )}`,
          }
        }
      } catch (error) {
        return {
          ok: false,
          retryable: true,
          reason: `Could not reach the facilitator to verify: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }

      try {
        const res = await fetchImpl(`${root}/settle`, { method: 'POST', headers, body })
        const settleJson = (await res.json()) as Record<string, unknown>
        if (!res.ok || settleJson['success'] !== true) {
          return {
            ok: false,
            retryable: true,
            reason: `Facilitator verified but did not settle: ${String(
              settleJson['errorReason'] ?? `HTTP ${res.status}`,
            )}`,
          }
        }
        return {
          ok: true,
          detail: 'Payment settled by the facilitator.',
          ...(typeof settleJson['payer'] === 'string'
            ? { payer: settleJson['payer'] as Address }
            : {}),
          ...(typeof settleJson['transaction'] === 'string'
            ? { txHash: settleJson['transaction'] as string }
            : {}),
        }
      } catch (error) {
        return {
          ok: false,
          retryable: true,
          reason: `Could not reach the facilitator to settle: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Challenge construction
// ---------------------------------------------------------------------------

export function caip2(chainId: SupportedChainId): string {
  return `eip155:${chainId}`
}

export function buildAccept(args: {
  skill: AgentSkill
  manifest: AgentManifest
  chainId: SupportedChainId
  config: RuntimeConfig
  resource: string
}): X402Accept | null {
  const price = args.skill.price
  if (!price) return null
  const asset = args.config.x402Asset[args.chainId]
  const description = `${args.manifest.name} — ${args.skill.name}: ${args.skill.description}`
  return {
    scheme: 'exact',
    network: caip2(args.chainId),
    amount: price.amountAtomic,
    asset: price.asset,
    payTo: args.config.payTo,
    maxTimeoutSeconds: 120,
    extra: {
      name: price.symbol,
      version: '1',
      decimals: asset?.decimals ?? price.decimals,
      assetTransferMethod: 'permit2-exact',
    },
    // v1 compatibility, emitted alongside rather than instead.
    maxAmountRequired: price.amountAtomic,
    resource: args.resource,
    mimeType: 'application/json',
    description,
  }
}

export function buildChallenge(args: {
  accepts: X402Accept[]
  resource: string
  description: string
  error?: string
}): X402Challenge {
  return {
    x402Version: 2,
    ...(args.error === undefined ? {} : { error: args.error }),
    resource: {
      url: args.resource,
      description: args.description,
      mimeType: 'application/json',
    },
    accepts: args.accepts,
  }
}

/** Base64 for the `payment-required` response header. */
export function encodeChallengeHeader(challenge: X402Challenge): string {
  return Buffer.from(JSON.stringify(challenge), 'utf8').toString('base64')
}

/** Base64 for the `payment-response` header a paid request answers with. */
export function encodePaymentResponseHeader(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

/**
 * Read the payment the client attached.
 *
 * v2 sends `payment-signature`; v1 sent `X-PAYMENT`. Header names are
 * case-insensitive, so both are read lowercased, and both forms of the value —
 * base64-of-JSON or raw JSON — are accepted. Nothing here is trusted: this
 * only turns bytes into an object for the verifier to judge.
 */
export function decodePaymentHeader(...values: Array<string | null | undefined>): PaymentPayload | null {
  for (const value of values) {
    if (!value) continue
    const trimmed = value.trim()
    if (trimmed === '') continue
    const candidates = trimmed.startsWith('{')
      ? [trimmed]
      : [Buffer.from(trimmed, 'base64').toString('utf8'), trimmed]
    for (const candidate of candidates) {
      try {
        const parsed: unknown = JSON.parse(candidate)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          return parsed as PaymentPayload
        }
      } catch {
        // An undecodable header is "no payment": the caller answers with a
        // fresh challenge rather than an opaque 400.
      }
    }
  }
  return null
}

export function createVerifier(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): PaymentVerifier {
  const url = env['X402_FACILITATOR_URL']
  return url ? facilitatorVerifier(url, fetchImpl) : rejectingVerifier()
}
