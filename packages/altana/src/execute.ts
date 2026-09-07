import type { Call, ExecuteResult, Session, SessionPermissions } from '@altananetwork/sdk'
import { formatUnits, toFunctionSelector, type Address, type Hex } from 'viem'

import { shortAddress } from './addresses.js'
import { createAltanaClient } from './client.js'
import { getAltanaNetwork, OBSERVED_KEYSTORE_FEE_WEI, txExplorerUrl } from './network.js'

/**
 * Execution outcomes, with refusal as a first-class result.
 *
 * Hallmark's whole pitch is that a scoped key says no *before* anything
 * reaches the chain. If that arrived as a thrown exception it would look like
 * a bug, get swallowed by a `catch`, and the product would lose the one thing
 * it is trying to demonstrate. So: refusals are values, they carry the reason
 * and the copy, and nothing here throws for an expected answer.
 */

export type RefusalReason =
  | 'spend-cap'
  | 'call-not-allowed'
  | 'session-expired'
  | 'session-revoked'
  | 'fee'
  | 'unknown'

/** Where a refusal was decided. */
export type RefusalSource = 'preflight' | 'relay'

export type ExecuteOutcome =
  | {
      kind: 'confirmed'
      txHash: Hex
      explorerUrl: string
      statusCode: number
      callsId: Hex
      detail: string
    }
  | { kind: 'pending'; callsId: Hex; statusCode: number; detail: string }
  | {
      kind: 'refused'
      statusCode: number
      reason: RefusalReason
      detail: string
      callsId?: Hex
      /** `preflight` means we refused locally; nothing was sent. */
      source: RefusalSource
    }
  | { kind: 'reverted'; statusCode: number; detail: string; txHash?: Hex; callsId?: Hex }
  | { kind: 'unfunded'; detail: string; requiredWei: bigint; address?: Address }

/** The EIP-5792 status bands, as the Altana relay uses them. */
export type StatusBand = 'in-flight' | 'success' | 'refused' | 'reverted' | 'unknown'

export function classifyStatusCode(statusCode: number | undefined): StatusBand {
  if (statusCode === undefined || !Number.isFinite(statusCode)) return 'unknown'
  if (statusCode >= 100 && statusCode <= 199) return 'in-flight'
  if (statusCode >= 200 && statusCode <= 299) return 'success'
  if (statusCode >= 300 && statusCode <= 499) return 'refused'
  if (statusCode >= 500) return 'reverted'
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Local scope check
// ---------------------------------------------------------------------------

export type ScopeVerdict =
  | { allowed: true }
  | { allowed: false; reason: RefusalReason; detail: string }

function selectorOf(data: Hex | undefined): Hex | undefined {
  if (!data || data.length < 10) return undefined
  return data.slice(0, 10) as Hex
}

function ruleMatches(
  rule: NonNullable<SessionPermissions['calls']>[number],
  call: Call,
): boolean {
  const to = 'to' in rule ? rule.to : undefined
  const signature = 'signature' in rule ? rule.signature : undefined

  if (to && to.toLowerCase() !== call.to.toLowerCase()) return false
  if (signature) {
    const wanted = toFunctionSelector(signature)
    if (selectorOf(call.data)?.toLowerCase() !== wanted.toLowerCase()) return false
  }
  return true
}

/**
 * Decide, locally, whether a session's own grant already forbids these calls.
 *
 * This is the same question the relay asks, answered against the permissions
 * we hold in memory. It cannot see prior spending inside the rolling window,
 * so it only reports a spend-cap breach when a *single* intent already exceeds
 * the cap; anything subtler is left to the relay. Everything it does report is
 * a fact about the grant, not a guess.
 */
export function checkScope(args: {
  permissions: SessionPermissions
  expiry: number
  calls: readonly Call[]
  now?: number | undefined
}): ScopeVerdict {
  const now = args.now ?? Math.floor(Date.now() / 1000)

  if (args.expiry <= now) {
    return {
      allowed: false,
      reason: 'session-expired',
      detail:
        `This session key expired ${new Date(args.expiry * 1000).toISOString()}. ` +
        'Grant a new one — permissions are fixed at grant and cannot be extended.',
    }
  }

  const rules = args.permissions.calls
  if (rules && rules.length > 0) {
    for (const call of args.calls) {
      if (rules.some((rule) => ruleMatches(rule, call))) continue
      const selector = selectorOf(call.data)
      return {
        allowed: false,
        reason: 'call-not-allowed',
        detail:
          `${shortAddress(call.to)} is not on this session key's allowlist` +
          (selector ? ` (attempted selector ${selector})` : '') +
          '. The request was refused before it reached the chain.',
      }
    }
  }

  const nativeCap = args.permissions.spend?.find((cap) => cap.token === undefined)
  if (nativeCap) {
    const total = args.calls.reduce((sum, call) => sum + (call.value ?? 0n), 0n)
    if (total > nativeCap.limit) {
      return {
        allowed: false,
        reason: 'spend-cap',
        detail:
          `This intent moves ${formatUnits(total, 18)} BNB, over the session's ` +
          `${formatUnits(nativeCap.limit, 18)} BNB per-${nativeCap.period} cap. ` +
          'Refused before it reached the chain.',
      }
    }
  }

  return { allowed: true }
}

// ---------------------------------------------------------------------------
// Relay result → outcome
// ---------------------------------------------------------------------------

/**
 * Best-effort reason for a relay refusal.
 *
 * The relay reports a band, not a cause. We narrow it with the one thing we
 * can check ourselves — the grant — and otherwise say `unknown` rather than
 * inventing a story the UI would print as fact.
 */
export function diagnoseRefusal(args: {
  statusCode: number
  permissions?: SessionPermissions | undefined
  expiry?: number | undefined
  calls?: readonly Call[] | undefined
  now?: number | undefined
  message?: string | undefined
}): { reason: RefusalReason; detail: string } {
  const message = args.message ?? ''

  if (args.permissions && args.expiry !== undefined && args.calls) {
    const verdict = checkScope({
      permissions: args.permissions,
      expiry: args.expiry,
      calls: args.calls,
      now: args.now,
    })
    if (!verdict.allowed) return { reason: verdict.reason, detail: verdict.detail }
  }

  if (/revoked/i.test(message)) {
    return {
      reason: 'session-revoked',
      detail: 'The relay reports this session key as revoked. Revocation is permanent.',
    }
  }
  if (/expir/i.test(message)) {
    return {
      reason: 'session-expired',
      detail: 'The relay reports this session key as expired. Grant a new one.',
    }
  }
  if (/fee token|feeToken|not supported/i.test(message)) {
    return {
      reason: 'fee',
      detail:
        'The relay refused the fee token. BNB Chain relays settle fees in native BNB; ' +
        'do not pass a stablecoin as `feeToken`.',
    }
  }
  if (/unknown key|key hash/i.test(message)) {
    return {
      reason: 'session-revoked',
      detail:
        'The relay does not recognise this session key on the target chain — it was ' +
        'revoked, or the grant landed on a different chain.',
    }
  }

  // 300 is overwhelmingly the fee-vs-cap case in practice, but "overwhelmingly"
  // is not "certainly", so we name the likely cause without asserting it.
  const hint =
    args.statusCode === 300
      ? ' The usual cause is a native spend cap too small to cover the relay fee.'
      : ''
  return {
    reason: 'unknown',
    detail:
      `The relay refused this request (code ${args.statusCode}) before it reached the ` +
      `chain. Nothing was spent and nothing was mined.${hint}`,
  }
}

export type OutcomeContext = {
  chainId: number
  session?: Pick<Session, 'permissions' | 'expiry'> | undefined
  calls?: readonly Call[] | undefined
  now?: number | undefined
  /** Wallet the intent was for; surfaces on the `unfunded` outcome. */
  address?: Address | undefined
}

/** Translate the SDK's `ExecuteResult` into an outcome the UI can render. */
export function toExecuteOutcome(result: ExecuteResult, ctx: OutcomeContext): ExecuteOutcome {
  const band = classifyStatusCode(result.statusCode)

  if (result.status === 'CONFIRMED' || band === 'success') {
    const txHash = result.transactionHash
    if (txHash) {
      return {
        kind: 'confirmed',
        txHash,
        explorerUrl: txExplorerUrl(ctx.chainId, txHash),
        statusCode: result.statusCode ?? 200,
        callsId: result.callsId,
        detail: 'Confirmed on-chain within the session key’s scope.',
      }
    }
    // Confirmed without a receipt: the relay can settle an intent without
    // surfacing one. Treat it as pending rather than claiming a hash we lack.
    return {
      kind: 'pending',
      callsId: result.callsId,
      statusCode: result.statusCode ?? 200,
      detail:
        'The relay accepted and settled this intent but did not report a transaction ' +
        'hash. Poll the calls id to pick up the receipt.',
    }
  }

  if (band === 'refused') {
    const statusCode = result.statusCode as number
    const { reason, detail } = diagnoseRefusal({
      statusCode,
      permissions: ctx.session?.permissions,
      expiry: ctx.session?.expiry,
      calls: ctx.calls,
      now: ctx.now,
    })
    return { kind: 'refused', statusCode, reason, detail, callsId: result.callsId, source: 'relay' }
  }

  if (band === 'reverted') {
    const statusCode = result.statusCode as number
    return {
      kind: 'reverted',
      statusCode,
      ...(result.transactionHash ? { txHash: result.transactionHash } : {}),
      callsId: result.callsId,
      detail:
        `The transaction reached the chain and reverted (code ${statusCode}). ` +
        'The session key was in scope; the contract rejected the call. ' +
        'Check the trace on the explorer for the revert reason.',
    }
  }

  return {
    kind: 'pending',
    callsId: result.callsId,
    statusCode: result.statusCode ?? 0,
    detail:
      result.status === 'FAILED'
        ? 'The relay reported a failure without a status code, so the outcome is ' +
          'genuinely unknown. Poll the calls id before resubmitting.'
        : 'Still in flight. Poll the calls id for the final answer.',
  }
}

/**
 * Empty revert data from the relay is what an unfunded wallet looks like.
 *
 * Measured on chain 97: submitting a Keystore-registering intent from a wallet
 * with zero BNB comes back as `Rpc.ExecutionError ... Reason: 0x` — no revert
 * string, no selector, nothing to match on but the emptiness itself. It is not
 * a bug to chase; it means "fund the wallet".
 */
export function looksUnfunded(error: unknown): boolean {
  const message = errorMessage(error)
  if (/insufficient (funds|balance)/i.test(message)) return true
  // `Reason: 0x` with no data after it.
  if (/reason:\s*0x(?![0-9a-fA-F])/i.test(message)) return true
  if (/revert(ed)?\s+with\s+(the\s+)?(empty|no)\s+(revert\s+)?data/i.test(message)) return true
  return false
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause
    const causeText = cause instanceof Error ? `\n${cause.message}` : ''
    return `${error.message}${causeText}`
  }
  return String(error)
}

/**
 * Turn a thrown relay/SDK error into an outcome.
 *
 * Used by both `executeWithSession` and `grantAgentSession`: the SDK throws in
 * a couple of places where it has no result object to hand back, and those
 * throws still describe ordinary situations a user can fix.
 */
export function outcomeFromThrow(
  error: unknown,
  ctx: OutcomeContext & { requiredWei?: bigint | undefined },
): ExecuteOutcome {
  const message = errorMessage(error)

  if (looksUnfunded(error)) {
    const requiredWei = ctx.requiredWei ?? OBSERVED_KEYSTORE_FEE_WEI * 2n
    const network = getAltanaNetwork(ctx.chainId)
    return {
      kind: 'unfunded',
      requiredWei,
      ...(ctx.address ? { address: ctx.address } : {}),
      detail:
        `${ctx.address ? `Wallet ${shortAddress(ctx.address)} has` : 'The wallet has'} ` +
        `no ${network.nativeSymbol} to pay Altana's Keystore fee. Send at least ` +
        `${formatUnits(requiredWei, 18)} ${network.nativeSymbol} to it and try again. ` +
        'The relay reports this as an execution error with empty revert data, which ' +
        'is what an unfunded wallet looks like from the outside.',
    }
  }

  // `grantSession` throws "Session grant did not confirm: status=FAILED (relay code 300)".
  const relayCode = /relay code (\d+)/.exec(message)
  if (relayCode) {
    const statusCode = Number(relayCode[1])
    const band = classifyStatusCode(statusCode)
    if (band === 'refused') {
      const { reason, detail } = diagnoseRefusal({
        statusCode,
        permissions: ctx.session?.permissions,
        expiry: ctx.session?.expiry,
        calls: ctx.calls,
        now: ctx.now,
        message,
      })
      return { kind: 'refused', statusCode, reason, detail, source: 'relay' }
    }
    if (band === 'reverted') {
      return {
        kind: 'reverted',
        statusCode,
        detail: `The transaction reverted on-chain (code ${statusCode}). ${message}`,
      }
    }
  }

  if (/fee token not supported/i.test(message)) {
    return {
      kind: 'refused',
      statusCode: -32602,
      reason: 'fee',
      detail:
        'The relay rejected the fee token. On BNB Chain the relay settles fees in native ' +
        'BNB only — remove `feeToken` (or set it to the native token).',
      source: 'relay',
    }
  }

  return {
    kind: 'reverted',
    statusCode: 0,
    detail: `The relay call failed before producing a status: ${message}`,
  }
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export type ExecuteWithSessionArgs = {
  chainId: number
  session: Session
  calls: Call | readonly Call[]
  /** Reuse a client instead of building one. */
  client?: undefined | {
    execute(opts: {
      session: Session
      calls: Call | readonly Call[]
      chainId?: number
      feeToken?: Address
      noWait?: boolean
    }): Promise<ExecuteResult>
  }
  /**
   * Refuse locally when the grant already forbids the call, without spending a
   * relay round-trip. Default true; set false to watch the relay do it.
   */
  preflight?: boolean | undefined
  noWait?: boolean | undefined
  /** Injectable clock for the expiry check, unix seconds. */
  now?: number | undefined
}

/**
 * Run calls as the agent, and answer with an outcome — never an exception for
 * anything the user could reasonably have caused.
 */
export async function executeWithSession(args: ExecuteWithSessionArgs): Promise<ExecuteOutcome> {
  const calls = Array.isArray(args.calls) ? (args.calls as Call[]) : [args.calls as Call]
  const ctx: OutcomeContext = {
    chainId: args.chainId,
    session: args.session,
    calls,
    now: args.now,
    address: args.session.walletAddress,
  }

  if (calls.length === 0) {
    return {
      kind: 'refused',
      statusCode: 0,
      reason: 'unknown',
      detail: 'Nothing to execute: the intent contained no calls.',
      source: 'preflight',
    }
  }

  if (args.preflight !== false) {
    const verdict = checkScope({
      permissions: args.session.permissions,
      expiry: args.session.expiry,
      calls,
      now: args.now,
    })
    if (!verdict.allowed) {
      return {
        kind: 'refused',
        statusCode: 0,
        reason: verdict.reason,
        detail: verdict.detail,
        source: 'preflight',
      }
    }
  }

  const client = args.client ?? createAltanaClient(args.chainId)

  try {
    const result = await client.execute({
      session: args.session,
      calls,
      chainId: args.chainId,
      ...(args.noWait ? { noWait: true } : {}),
    })
    return toExecuteOutcome(result, ctx)
  } catch (error) {
    return outcomeFromThrow(error, ctx)
  }
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export type OutcomeCopy = {
  headline: string
  detail: string
  tone: 'ok' | 'pending' | 'blocked' | 'error'
}

/** Everything a UI needs to render an outcome, already phrased. */
export function describeOutcome(outcome: ExecuteOutcome): OutcomeCopy {
  switch (outcome.kind) {
    case 'confirmed':
      return { headline: 'Executed', detail: outcome.detail, tone: 'ok' }
    case 'pending':
      return { headline: 'In flight', detail: outcome.detail, tone: 'pending' }
    case 'refused':
      return {
        headline:
          outcome.source === 'preflight'
            ? 'Blocked by the session key'
            : 'Refused before it reached the chain',
        detail: outcome.detail,
        tone: 'blocked',
      }
    case 'reverted':
      return { headline: 'Reverted on-chain', detail: outcome.detail, tone: 'error' }
    case 'unfunded':
      return { headline: 'Wallet needs gas', detail: outcome.detail, tone: 'error' }
  }
}

/** True when nothing was sent and nothing was spent. */
export function isRefusal(outcome: ExecuteOutcome): outcome is Extract<
  ExecuteOutcome,
  { kind: 'refused' }
> {
  return outcome.kind === 'refused'
}
