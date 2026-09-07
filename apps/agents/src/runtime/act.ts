import { formatUnits, toFunctionSelector, type Address, type Hex } from 'viem'
import {
  NATIVE_TOKEN,
  isNativeToken,
  tokenSymbol,
  type AgentPolicy,
  type ExecuteOutcome,
  type SpendCap,
} from '@hallmark/altana'
import type { SupportedChainId } from '@hallmark/core'

import type {
  ActIntent,
  ActResult,
  Executor,
  IntentCall,
  PolicyBinding,
  RefusalReport,
  RefusalRule,
  SessionProvider,
} from './types.js'
import type { Store } from './store.js'

/**
 * The safety spine.
 *
 * Everything an agent wants to change on-chain funnels through
 * `executeIntent`. It does four things and nothing else:
 *
 *   1. claims the intent id, so the same intent never executes twice;
 *   2. hands the calls to `executeWithSession` — the agent has no key and no
 *      other path to a signature;
 *   3. turns a refusal into a *report* — what was attempted, which policy line
 *      blocked it, the cap and the headroom left — never a thrown error;
 *   4. records what happened, so the replay in (1) has something to replay and
 *      the ledger in (3) has something to subtract.
 *
 * The agent proposes. The session key constrains. The chain enforces.
 */

const INTENT_PREFIX = 'intent'
const LEDGER_PREFIX = 'spend'

type IntentRecord =
  | { state: 'running'; startedAt: number; summary: string }
  | { state: 'done'; finishedAt: number; result: ActResult }

type LedgerRecord = { window: number; spentAtomic: string }

function periodSeconds(period: 'day' | 'hour'): number {
  return period === 'hour' ? 3_600 : 86_400
}

function selectorOf(data: Hex): Hex | null {
  return data.length >= 10 ? (data.slice(0, 10) as Hex) : null
}

function displayAmount(amount: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(amount, decimals)} ${symbol}`
}

function intentKey(agentSlug: string, chainId: number, intentId: string): string {
  return `${INTENT_PREFIX}:${agentSlug}:${chainId}:${intentId}`
}

function ledgerKey(policyLabel: string, chainId: number, token: Address, period: string): string {
  return `${LEDGER_PREFIX}:${chainId}:${policyLabel}:${token.toLowerCase()}:${period}`
}

// ---------------------------------------------------------------------------
// Spend ledger
// ---------------------------------------------------------------------------

/**
 * What this service has watched go out inside the current cap window.
 *
 * The relay is the authority on whether a cap is breached; it does not tell us
 * the running total. So we keep our own, from confirmed executions only, and
 * label it as ours. It is a floor on spending, never an upper bound — a user's
 * own wallet activity is invisible to it — and the refusal copy says so.
 */
export async function readObservedSpend(
  store: Store,
  chainId: number,
  policyLabel: string,
  cap: SpendCap,
  now: number,
): Promise<bigint> {
  const window = Math.floor(now / periodSeconds(cap.period))
  const record = await store.get<LedgerRecord>(ledgerKey(policyLabel, chainId, cap.token, cap.period))
  if (record === null || record.window !== window) return 0n
  return BigInt(record.spentAtomic)
}

async function recordSpend(
  store: Store,
  chainId: number,
  policy: AgentPolicy,
  intent: ActIntent,
  now: number,
): Promise<void> {
  const moved = new Map<string, bigint>()
  const nativeTotal = intent.calls.reduce((sum, call) => sum + call.value, 0n)
  if (nativeTotal > 0n) moved.set(NATIVE_TOKEN.toLowerCase(), nativeTotal)
  for (const entry of intent.spend ?? []) {
    const key = entry.token.toLowerCase()
    moved.set(key, (moved.get(key) ?? 0n) + entry.amountAtomic)
  }

  for (const cap of policy.spend) {
    const amount = moved.get(cap.token.toLowerCase())
    if (amount === undefined || amount === 0n) continue
    const key = ledgerKey(policy.label, chainId, cap.token, cap.period)
    const window = Math.floor(now / periodSeconds(cap.period))
    const existing = await store.get<LedgerRecord>(key)
    const base = existing !== null && existing.window === window ? BigInt(existing.spentAtomic) : 0n
    await store.set<LedgerRecord>(key, { window, spentAtomic: (base + amount).toString() })
  }
}

// ---------------------------------------------------------------------------
// Refusal reporting
// ---------------------------------------------------------------------------

function ruleMatchesCall(rule: AgentPolicy['calls'][number], call: IntentCall): boolean {
  if (rule.to && rule.to.toLowerCase() !== call.to.toLowerCase()) return false
  if (rule.signature) {
    const wanted = toFunctionSelector(rule.signature).toLowerCase()
    if (selectorOf(call.data)?.toLowerCase() !== wanted) return false
  }
  return true
}

/**
 * Name the policy line that blocks an intent, locally.
 *
 * The relay answers with a status band, not a cause, and a user staring at
 * "code 300" learns nothing. This re-asks the same question against the grant
 * we hold and reports the specific rule — including the difference that
 * matters most in practice: a contract that is not on the list at all, versus
 * a contract that is but with a selector that is not.
 */
export function locateBlockingRule(
  policy: AgentPolicy,
  intent: ActIntent,
  now: number,
): { rule: RefusalRule; ruleLabel: string; detail: string; call?: IntentCall } | null {
  if (policy.expiresAt <= now) {
    return {
      rule: 'session-expired',
      ruleLabel: `Expiry ${new Date(policy.expiresAt * 1000).toISOString()}`,
      detail:
        `The session key expired at ${new Date(policy.expiresAt * 1000).toISOString()}. ` +
        'Permissions are fixed at grant time and cannot be extended — grant a new key.',
    }
  }

  for (const call of intent.calls) {
    if (policy.calls.some((rule) => ruleMatchesCall(rule, call))) continue

    const sameContract = policy.calls.filter(
      (rule) => rule.to !== undefined && rule.to.toLowerCase() === call.to.toLowerCase(),
    )
    const selector = selectorOf(call.data)

    if (sameContract.length > 0) {
      const allowed = sameContract
        .map((rule) => rule.signature ?? 'any function')
        .join(', ')
      return {
        rule: 'selector-allowlist',
        ruleLabel: sameContract.map((rule) => rule.label).join(' / '),
        detail:
          `${call.to} is on the allowlist, but only for ${allowed}. This intent called ` +
          `\`${call.signature}\`${selector ? ` (${selector})` : ''}, which is not granted. ` +
          'Nothing was sent.',
        call,
      }
    }

    return {
      rule: 'contract-allowlist',
      ruleLabel: `Allowlist of ${policy.calls.length} contract(s)`,
      detail:
        `${call.to} is not on this session key's contract allowlist, so \`${call.signature}\`` +
        `${selector ? ` (${selector})` : ''} could not be sent. The allowlist is ` +
        `${policy.calls.map((rule) => rule.label).join(', ')}.`,
      call,
    }
  }

  return null
}

function capForToken(policy: AgentPolicy, token: Address): SpendCap | undefined {
  return policy.spend.find((cap) => cap.token.toLowerCase() === token.toLowerCase())
}

/** Every token this intent moves, native leg plus declared ERC-20 legs. */
function intentSpend(intent: ActIntent): Map<string, { token: Address; amount: bigint }> {
  const out = new Map<string, { token: Address; amount: bigint }>()
  const native = intent.calls.reduce((sum, call) => sum + call.value, 0n)
  if (native > 0n) out.set(NATIVE_TOKEN.toLowerCase(), { token: NATIVE_TOKEN, amount: native })
  for (const entry of intent.spend ?? []) {
    const key = entry.token.toLowerCase()
    const prior = out.get(key)
    out.set(key, { token: entry.token, amount: (prior?.amount ?? 0n) + entry.amountAtomic })
  }
  return out
}

/**
 * Would this intent, on its own, put a token past its cap?
 *
 * Only a *single-intent* breach can be decided locally — the relay is the
 * authority on the rolling window, and it knows about spending this service
 * never saw. What we can prove is that the amount asked for here exceeds what
 * the cap allows minus what we have watched go out, and that is enough to
 * refuse without a round trip.
 */
export async function exceedsCap(
  store: Store,
  chainId: number,
  policy: AgentPolicy,
  intent: ActIntent,
  now: number,
): Promise<boolean> {
  for (const [, moved] of intentSpend(intent)) {
    const cap = capForToken(policy, moved.token)
    if (cap === undefined) continue
    const observed = await readObservedSpend(store, chainId, policy.label, cap, now)
    const remaining = cap.limitAtomic > observed ? cap.limitAtomic - observed : 0n
    if (moved.amount > remaining) return true
  }
  return false
}

export async function buildRefusalReport(args: {
  store: Store
  chainId: number
  policy: AgentPolicy
  intent: ActIntent
  now: number
  source: 'preflight' | 'relay'
  statusCode: number
  /** The relay's own words, when it gave any. */
  relayDetail?: string
}): Promise<RefusalReport> {
  const { policy, intent, now } = args
  const located = locateBlockingRule(policy, intent, now)

  let rule: RefusalRule = located?.rule ?? 'unknown'
  let ruleLabel = located?.ruleLabel ?? 'Session key policy'
  let detail =
    located?.detail ??
    args.relayDetail ??
    `The relay refused this intent (code ${args.statusCode}) before it reached the chain. ` +
      'Nothing was spent and nothing was mined.'

  // A cap breach only shows up locally when a single intent already exceeds
  // the limit; anything subtler is the relay's call. Either way the report
  // carries the headroom we can prove.
  let capReport: RefusalReport['cap'] = null
  for (const [, moved] of intentSpend(intent)) {
    const cap = capForToken(policy, moved.token)
    if (cap === undefined) continue
    const observed = await readObservedSpend(args.store, args.chainId, policy.label, cap, now)
    const remaining = cap.limitAtomic > observed ? cap.limitAtomic - observed : 0n
    if (moved.amount <= remaining && located !== null) continue

    const symbol = tokenSymbol(cap.token)
    capReport = {
      token: cap.token,
      symbol,
      limitAtomic: cap.limitAtomic.toString(),
      limitDisplay: displayAmount(cap.limitAtomic, cap.decimals, symbol),
      period: cap.period,
      attemptedAtomic: moved.amount.toString(),
      attemptedDisplay: displayAmount(moved.amount, cap.decimals, symbol),
      remainingAtomic: remaining.toString(),
      remainingDisplay: displayAmount(remaining, cap.decimals, symbol),
      observedSpendAtomic: observed.toString(),
    }
    if (located === null) {
      rule = 'spend-cap'
      ruleLabel = `${symbol} cap, ${displayAmount(cap.limitAtomic, cap.decimals, symbol)} per ${cap.period}`
      detail =
        `This intent moves ${capReport.attemptedDisplay}. The session key allows ` +
        `${capReport.limitDisplay} per ${cap.period}, and this service has watched ` +
        `${displayAmount(observed, cap.decimals, symbol)} go out in the current window, ` +
        `leaving ${capReport.remainingDisplay}. Refused before it reached the chain.`
    }
    break
  }

  if (rule === 'unknown' && args.statusCode === 300 && capReport === null) {
    const native = policy.spend.find((cap) => isNativeToken(cap.token))
    if (native) {
      ruleLabel = `Native cap, ${displayAmount(native.limitAtomic, native.decimals, 'BNB')} per ${native.period}`
      detail +=
        ' The usual cause of a bare code 300 is a native cap too small to cover the relay fee, ' +
        'which is charged against the same cap.'
    }
  }

  return {
    attempted: {
      intentId: intent.intentId,
      summary: intent.summary,
      calls: intent.calls.map((call) => ({
        to: call.to,
        selector: selectorOf(call.data),
        signature: call.signature,
        valueWei: call.value.toString(),
        label: call.label,
      })),
    },
    blockedBy: { rule, ruleLabel, detail },
    cap: capReport,
    policy: {
      label: policy.label,
      expiresAt: policy.expiresAt,
      expiresAtIso: new Date(policy.expiresAt * 1000).toISOString(),
      allowlist: policy.calls.map((entry) => ({
        to: entry.to ?? null,
        signature: entry.signature ?? null,
        label: entry.label,
      })),
      caps: policy.spend.map((cap) => ({
        token: cap.token,
        symbol: tokenSymbol(cap.token),
        limitDisplay: displayAmount(cap.limitAtomic, cap.decimals, tokenSymbol(cap.token)),
        period: cap.period,
      })),
    },
    source: args.source,
    statusCode: args.statusCode,
  }
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export type ExecuteIntentDeps = {
  agentSlug: string
  chainId: SupportedChainId
  binding: PolicyBinding
  sessions: SessionProvider
  executor: Executor
  store: Store
  now: () => number
}

function callSummary(intent: ActIntent): RefusalReport['attempted']['calls'] {
  return intent.calls.map((call) => ({
    to: call.to,
    selector: selectorOf(call.data),
    signature: call.signature,
    valueWei: call.value.toString(),
    label: call.label,
  }))
}

function outcomeToResult(args: {
  outcome: ExecuteOutcome
  intent: ActIntent
  observedAt: string
}): Exclude<ActResult, { status: 'refused' }> | { needsRefusalReport: ExecuteOutcome } {
  const { outcome, intent, observedAt } = args
  switch (outcome.kind) {
    case 'confirmed':
      return {
        status: 'executed',
        intentId: intent.intentId,
        replayed: false,
        summary: intent.summary,
        txHash: outcome.txHash,
        explorerUrl: outcome.explorerUrl,
        calls: callSummary(intent),
        observedAt,
      }
    case 'pending':
      return {
        status: 'pending',
        intentId: intent.intentId,
        replayed: false,
        summary: intent.summary,
        callsId: outcome.callsId,
        detail: outcome.detail,
        observedAt,
      }
    case 'reverted':
      return {
        status: 'reverted',
        intentId: intent.intentId,
        replayed: false,
        summary: intent.summary,
        detail: outcome.detail,
        statusCode: outcome.statusCode,
        ...(outcome.txHash ? { txHash: outcome.txHash } : {}),
        observedAt,
      }
    case 'unfunded':
      return {
        status: 'unfunded',
        intentId: intent.intentId,
        replayed: false,
        detail: outcome.detail,
        requiredWei: outcome.requiredWei.toString(),
        ...(outcome.address ? { address: outcome.address } : {}),
        observedAt,
      }
    case 'refused':
      return { needsRefusalReport: outcome }
  }
}

function markReplayed(result: ActResult): ActResult {
  return result.status === 'aborted' ? result : { ...result, replayed: true }
}

/**
 * Run an intent under the agent's session key.
 *
 * Never throws for anything a user could have caused. A missing session, an
 * expired key, an off-allowlist call, a cap breach and a revert are all
 * results, each carrying enough detail to render without a second round-trip.
 */
export async function executeIntent(
  intent: ActIntent,
  deps: ExecuteIntentDeps,
): Promise<ActResult> {
  const now = deps.now()
  const observedAt = new Date(now * 1000).toISOString()
  const key = intentKey(deps.agentSlug, deps.chainId, intent.intentId)

  if (intent.calls.length === 0) {
    return {
      status: 'aborted',
      intentId: intent.intentId,
      replayed: false,
      reason: 'nothing-to-do',
      detail: 'The agent produced no calls for this intent, so there was nothing to execute.',
      evidence: { summary: intent.summary },
      observedAt,
    }
  }

  const claim = await deps.store.claim<IntentRecord>(key, {
    state: 'running',
    startedAt: now,
    summary: intent.summary,
  })

  if (!claim.claimed) {
    if (claim.existing.state === 'done') return markReplayed(claim.existing.result)
    return {
      status: 'aborted',
      intentId: intent.intentId,
      replayed: false,
      reason: 'precondition',
      detail:
        `Intent ${intent.intentId} is already in flight (claimed at ` +
        `${new Date(claim.existing.startedAt * 1000).toISOString()}). Re-running the same ` +
        'intent id never double-executes; poll instead of retrying.',
      evidence: { claimedAt: claim.existing.startedAt, summary: claim.existing.summary },
      observedAt,
    }
  }

  const handle = await deps.sessions.get(deps.chainId, deps.binding)
  if (handle === null) {
    // Release the claim: nothing ran, so a later attempt with a granted key
    // must be allowed to use the same intent id.
    await deps.store.delete(key)
    return {
      status: 'aborted',
      intentId: intent.intentId,
      replayed: false,
      reason: 'no-session',
      detail:
        'No Altana session key is granted for this agent on this chain, so it has no way to ' +
        'send a transaction. This agent never holds a private key: it can only act inside a ' +
        'session a user granted, and it read that none exists. Grant one to enable `act`.',
      evidence: {
        policyCategory: deps.binding.category,
        chainId: deps.chainId,
        wouldHaveSent: callSummary(intent),
      },
      observedAt,
    }
  }

  const { policy, session } = handle

  const finish = async (result: ActResult): Promise<ActResult> => {
    await deps.store.set<IntentRecord>(key, { state: 'done', finishedAt: now, result })
    return result
  }

  // Refuse locally, before the executor is reached.
  //
  // The relay would refuse too, and `executeWithSession` preflights as well —
  // but relying on either would make the guarantee a property of whatever
  // executor happens to be injected. Checking here means an agent's intent is
  // measured against the grant on the way out of *this* process, whoever is
  // downstream, and the refusal costs no round trip.
  const blocked = locateBlockingRule(policy, intent, now)
  const overCap = await exceedsCap(deps.store, deps.chainId, policy, intent, now)
  if (blocked !== null || overCap) {
    const report = await buildRefusalReport({
      store: deps.store,
      chainId: deps.chainId,
      policy,
      intent,
      now,
      source: 'preflight',
      statusCode: 0,
    })
    return finish({
      status: 'refused',
      intentId: intent.intentId,
      replayed: false,
      refusal: report,
      observedAt,
    })
  }

  const outcome = await deps.executor({
    chainId: deps.chainId,
    session,
    calls: intent.calls.map((call) => ({ to: call.to, data: call.data, value: call.value })),
  })

  const mapped = outcomeToResult({ outcome, intent, observedAt })

  if ('needsRefusalReport' in mapped) {
    const refusal = outcome as Extract<ExecuteOutcome, { kind: 'refused' }>
    const report = await buildRefusalReport({
      store: deps.store,
      chainId: deps.chainId,
      policy,
      intent,
      now,
      source: refusal.source,
      statusCode: refusal.statusCode,
      relayDetail: refusal.detail,
    })
    return finish({
      status: 'refused',
      intentId: intent.intentId,
      replayed: false,
      refusal: report,
      observedAt,
    })
  }

  if (mapped.status === 'executed' || mapped.status === 'pending') {
    await recordSpend(deps.store, deps.chainId, policy, intent, now)
  }

  return finish(mapped)
}

/** Every intent this agent has run on a chain, newest last. */
export async function listIntents(
  store: Store,
  agentSlug: string,
  chainId: number,
): Promise<Array<{ intentId: string; record: IntentRecord }>> {
  const prefix = `${INTENT_PREFIX}:${agentSlug}:${chainId}:`
  const keys = await store.list(prefix)
  const out: Array<{ intentId: string; record: IntentRecord }> = []
  for (const key of keys) {
    const record = await store.get<IntentRecord>(key)
    if (record !== null) out.push({ intentId: key.slice(prefix.length), record })
  }
  return out
}

export type { IntentRecord }
