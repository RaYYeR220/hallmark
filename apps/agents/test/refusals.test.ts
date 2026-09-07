import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseEther, toFunctionSelector, type Address } from 'viem'
import {
  buildPolicy,
  checkScope,
  executeWithSession,
  pancakeRebalancePolicy,
  toAltanaPermissions,
  venusHealthFactorPolicy,
  type ExecuteOutcome,
} from '@hallmark/altana'
import { getChain } from '@hallmark/core'

import { executeIntent, listIntents, locateBlockingRule, readObservedSpend } from '../src/runtime/act.js'
import { createMemoryStore } from '../src/runtime/store.js'
import { vBnbAbi, vTokenErc20Abi } from '../src/chain/abis.js'
import { buildRepayCall, buildSupplyCall } from '../src/chain/venus.js'
import type { ActIntent, ActResult, PolicyBinding, SessionHandle } from '../src/runtime/types.js'
import { CONFIRMED, fakeSession, providerFor, recordingExecutor } from './support/fixtures.js'

/**
 * The safety spine.
 *
 * Every test here is about the same claim: an agent proposes, the session key
 * constrains, and a refusal is a *result* — a structured one, naming the rule
 * — never a thrown exception and never a retry.
 */

const chain = getChain(56)
const NOW = 1_780_000_000
const HEALTH_BINDING: PolicyBinding = { category: 'venus-health-factor', rationale: 'test' }
const REBALANCE_BINDING: PolicyBinding = { category: 'pancake-rebalance', rationale: 'test' }

function handle(category: PolicyBinding['category'], overrides: Parameters<typeof buildPolicy>[2] = {}): SessionHandle {
  return {
    session: fakeSession(),
    policy: buildPolicy(category, 56, { now: NOW, ttlSeconds: 86_400, ...overrides }),
    chainId: 56,
  }
}

function intent(calls: ActIntent['calls'], overrides: Partial<ActIntent> = {}): ActIntent {
  return { intentId: 'i-1', summary: 'test intent', calls, ...overrides }
}

const repayUsdt = buildRepayCall({
  vToken: chain.defi.venusVUsdt,
  isNative: false,
  amount: 10n ** 18n,
  symbol: 'USDT',
})

const borrowUsdt = {
  to: chain.defi.venusVUsdt,
  value: 0n,
  signature: 'borrow(uint256)',
  label: 'Borrow 100 USDT — the thing this agent must never be able to do',
  data: encodeFunctionData({ abi: vTokenErc20Abi, functionName: 'borrow', args: [100n * 10n ** 18n] }),
}

function run(args: {
  intent: ActIntent
  handle: SessionHandle | null
  outcome?: ExecuteOutcome | ((n: number) => ExecuteOutcome)
  store?: ReturnType<typeof createMemoryStore>
  binding?: PolicyBinding
}): Promise<ActResult> {
  const { executor } = recordingExecutor(args.outcome ?? CONFIRMED)
  return executeIntent(args.intent, {
    agentSlug: 'test',
    chainId: 56,
    binding: args.binding ?? HEALTH_BINDING,
    sessions: providerFor(args.handle),
    executor,
    store: args.store ?? createMemoryStore(),
    now: () => NOW,
  })
}

describe('the health policy cannot borrow', () => {
  it('has no borrow rule at all — the property, not the behaviour', () => {
    const policy = venusHealthFactorPolicy(56, { now: NOW })
    const signatures = policy.calls.map((rule) => rule.signature)
    expect(signatures).toContain('repayBorrow(uint256)')
    expect(signatures).toContain('repayBorrow()')
    expect(signatures).toContain('mint(uint256)')
    expect(signatures).toContain('redeemUnderlying(uint256)')
    expect(signatures.some((signature) => signature?.startsWith('borrow('))).toBe(false)
  })

  it('refuses a borrow attempt with the rule that blocked it', async () => {
    const result = await run({ intent: intent([borrowUsdt]), handle: handle('venus-health-factor') })
    expect(result.status).toBe('refused')
    if (result.status !== 'refused') throw new Error('unreachable')

    expect(result.refusal.blockedBy.rule).toBe('selector-allowlist')
    expect(result.refusal.blockedBy.detail).toContain('is on the allowlist, but only for')
    expect(result.refusal.blockedBy.detail).toContain('borrow(uint256)')
    expect(result.refusal.source).toBe('preflight')
    expect(result.refusal.attempted.calls[0]!.selector).toBe(
      toFunctionSelector('borrow(uint256)'),
    )
    expect(result.refusal.policy.allowlist.map((rule) => rule.signature)).not.toContain('borrow(uint256)')
  })

  it('allows the repay the same policy exists to permit — the negative control', async () => {
    const result = await run({ intent: intent([repayUsdt]), handle: handle('venus-health-factor') })
    expect(result.status).toBe('executed')
  })

  it('never throws for the refusal', async () => {
    // The whole point: a `catch` around this package means "we are broken",
    // not "the agent was told no".
    await expect(
      run({ intent: intent([borrowUsdt]), handle: handle('venus-health-factor') }),
    ).resolves.toMatchObject({ status: 'refused' })
  })
})

describe('off-allowlist contracts', () => {
  const stranger: Address = '0x000000000000000000000000000000000000f00d'

  it('refuses a call to a contract nobody granted', async () => {
    const result = await run({
      intent: intent([
        {
          to: stranger,
          value: 0n,
          signature: 'transfer(address,uint256)',
          label: 'Drain to a stranger',
          data: '0xa9059cbb' as const,
        },
      ]),
      handle: handle('venus-health-factor'),
    })
    expect(result.status).toBe('refused')
    if (result.status !== 'refused') throw new Error('unreachable')
    expect(result.refusal.blockedBy.rule).toBe('contract-allowlist')
    expect(result.refusal.blockedBy.detail).toContain(stranger)
    expect(result.refusal.policy.allowlist.length).toBeGreaterThan(0)
  })

  it('distinguishes an off-allowlist contract from an off-allowlist selector', () => {
    const policy = venusHealthFactorPolicy(56, { now: NOW })
    const contractMiss = locateBlockingRule(
      policy,
      intent([{ to: stranger, value: 0n, signature: 'x()', label: 'x', data: '0x0dbe671f' as const }]),
      NOW,
    )
    const selectorMiss = locateBlockingRule(policy, intent([borrowUsdt]), NOW)
    expect(contractMiss?.rule).toBe('contract-allowlist')
    expect(selectorMiss?.rule).toBe('selector-allowlist')
  })

  it('finds nothing to block when the call is in scope', () => {
    const policy = venusHealthFactorPolicy(56, { now: NOW })
    expect(locateBlockingRule(policy, intent([repayUsdt]), NOW)).toBeNull()
  })
})

describe('spend caps', () => {
  const supplyBnb = buildSupplyCall({
    vToken: chain.defi.venusVBnb,
    isNative: true,
    amount: parseEther('10'),
    symbol: 'BNB',
  })

  it('refuses an intent that alone exceeds the native cap, with the headroom', async () => {
    // The default policy caps BNB at 0.05; this asks for 10.
    const result = await run({
      intent: intent([
        {
          to: supplyBnb.to,
          data: supplyBnb.data,
          value: supplyBnb.value,
          signature: supplyBnb.signature,
          label: supplyBnb.label,
        },
      ]),
      handle: handle('venus-health-factor'),
    })
    expect(result.status).toBe('refused')
    if (result.status !== 'refused') throw new Error('unreachable')

    expect(result.refusal.blockedBy.rule).toBe('spend-cap')
    expect(result.refusal.cap).not.toBeNull()
    expect(result.refusal.cap!.symbol).toBe('BNB')
    expect(result.refusal.cap!.limitDisplay).toBe('0.05 BNB')
    expect(result.refusal.cap!.attemptedDisplay).toBe('10 BNB')
    expect(result.refusal.cap!.remainingDisplay).toBe('0.05 BNB')
    expect(result.refusal.cap!.observedSpendAtomic).toBe('0')
  })

  it('reports shrinking headroom as the window fills', async () => {
    const store = createMemoryStore()
    const smallSupply = buildSupplyCall({
      vToken: chain.defi.venusVBnb,
      isNative: true,
      amount: parseEther('0.02'),
      symbol: 'BNB',
    })
    const call = {
      to: smallSupply.to,
      data: smallSupply.data,
      value: smallSupply.value,
      signature: smallSupply.signature,
      label: smallSupply.label,
    }

    const first = await run({
      intent: intent([call], { intentId: 'spend-1' }),
      handle: handle('venus-health-factor'),
      store,
    })
    expect(first.status).toBe('executed')

    const policy = buildPolicy('venus-health-factor', 56, { now: NOW, ttlSeconds: 86_400 })
    const nativeCap = policy.spend.find((cap) => cap.token.toLowerCase().startsWith('0xeeee'))!
    const observed = await readObservedSpend(store, 56, policy.label, nativeCap, NOW)
    expect(observed).toBe(parseEther('0.02'))

    // Now an intent that fits the cap outright but not the remaining headroom.
    const second = await run({
      intent: intent(
        [
          {
            ...call,
            value: parseEther('0.04'),
            data: encodeFunctionData({ abi: vBnbAbi, functionName: 'mint', args: [] }),
          },
        ],
        { intentId: 'spend-2' },
      ),
      handle: handle('venus-health-factor'),
      store,
      outcome: {
        kind: 'refused',
        statusCode: 300,
        reason: 'spend-cap',
        detail: 'relay says no',
        source: 'relay',
      },
    })
    expect(second.status).toBe('refused')
    if (second.status !== 'refused') throw new Error('unreachable')
    expect(second.refusal.cap!.remainingDisplay).toBe('0.03 BNB')
    expect(second.refusal.cap!.attemptedDisplay).toBe('0.04 BNB')
    // Refused here rather than at the relay: the ledger already knows the
    // headroom is gone, so the round trip is not spent.
    expect(second.refusal.source).toBe('preflight')
  })

  it('records declared ERC-20 spend, which calldata alone cannot reveal', async () => {
    const store = createMemoryStore()
    const usdt: Address = '0x55d398326f99059fF775485246999027B3197955'
    await run({
      intent: intent([repayUsdt], {
        intentId: 'erc20-1',
        spend: [{ token: usdt, amountAtomic: 25n * 10n ** 18n }],
      }),
      handle: handle('venus-health-factor'),
      store,
    })
    const policy = buildPolicy('venus-health-factor', 56, { now: NOW, ttlSeconds: 86_400 })
    const cap = policy.spend.find((entry) => entry.token.toLowerCase() === usdt.toLowerCase())!
    expect(await readObservedSpend(store, 56, policy.label, cap, NOW)).toBe(25n * 10n ** 18n)
  })
})

describe('expiry', () => {
  it('refuses on an expired key without contacting the relay at all', async () => {
    const expired: SessionHandle = {
      session: fakeSession(),
      policy: { ...venusHealthFactorPolicy(56, { now: NOW }), expiresAt: NOW - 60 },
      chainId: 56,
    }
    const { executor, calls } = recordingExecutor(CONFIRMED)
    const result = await executeIntent(intent([repayUsdt]), {
      agentSlug: 'test',
      chainId: 56,
      binding: HEALTH_BINDING,
      sessions: providerFor(expired),
      executor,
      store: createMemoryStore(),
      now: () => NOW,
    })

    // Nothing was sent, and the executor — which in production is the only
    // path to a signature — was never reached.
    expect(calls).toHaveLength(0)
    expect(result.status).toBe('refused')
    if (result.status !== 'refused') throw new Error('unreachable')
    expect(result.refusal.blockedBy.rule).toBe('session-expired')
    expect(result.refusal.source).toBe('preflight')
  })

  it('does execute inside a live key — the negative control for the expiry check', async () => {
    const live: SessionHandle = {
      session: fakeSession(),
      policy: { ...venusHealthFactorPolicy(56, { now: NOW }), expiresAt: NOW + 60 },
      chainId: 56,
    }
    const { executor, calls } = recordingExecutor(CONFIRMED)
    const result = await executeIntent(intent([repayUsdt]), {
      agentSlug: 'test',
      chainId: 56,
      binding: HEALTH_BINDING,
      sessions: providerFor(live),
      executor,
      store: createMemoryStore(),
      now: () => NOW,
    })
    expect(calls).toHaveLength(1)
    expect(result.status).toBe('executed')
  })
})

describe('no session granted', () => {
  it('answers with the plan it would have sent, not an error', async () => {
    const result = await run({ intent: intent([repayUsdt]), handle: null })
    expect(result.status).toBe('aborted')
    if (result.status !== 'aborted') throw new Error('unreachable')
    expect(result.reason).toBe('no-session')
    expect(result.detail).toContain('never holds a private key')
    expect((result.evidence['wouldHaveSent'] as unknown[]).length).toBe(1)
  })

  it('releases the intent id so a later grant can use it', async () => {
    const store = createMemoryStore()
    const first = await run({ intent: intent([repayUsdt]), handle: null, store })
    expect(first.status).toBe('aborted')

    const second = await run({
      intent: intent([repayUsdt]),
      handle: handle('venus-health-factor'),
      store,
    })
    expect(second.status).toBe('executed')
  })
})

describe('idempotency', () => {
  it('executes once and replays afterwards, however many times it is called', async () => {
    const store = createMemoryStore()
    const { executor, calls } = recordingExecutor(CONFIRMED)
    const deps = {
      agentSlug: 'test',
      chainId: 56 as const,
      binding: HEALTH_BINDING,
      sessions: providerFor(handle('venus-health-factor')),
      executor,
      store,
      now: () => NOW,
    }

    const first = await executeIntent(intent([repayUsdt], { intentId: 'once' }), deps)
    const second = await executeIntent(intent([repayUsdt], { intentId: 'once' }), deps)
    const third = await executeIntent(intent([repayUsdt], { intentId: 'once' }), deps)

    expect(calls).toHaveLength(1)
    expect(first.status).toBe('executed')
    expect(first.replayed).toBe(false)
    expect(second.status).toBe('executed')
    expect(second.replayed).toBe(true)
    expect(third.replayed).toBe(true)
    if (first.status !== 'executed' || second.status !== 'executed') throw new Error('unreachable')
    expect(second.txHash).toBe(first.txHash)
  })

  it('does execute a different intent id — the negative control', async () => {
    const store = createMemoryStore()
    const { executor, calls } = recordingExecutor(CONFIRMED)
    const deps = {
      agentSlug: 'test',
      chainId: 56 as const,
      binding: HEALTH_BINDING,
      sessions: providerFor(handle('venus-health-factor')),
      executor,
      store,
      now: () => NOW,
    }
    await executeIntent(intent([repayUsdt], { intentId: 'a' }), deps)
    await executeIntent(intent([repayUsdt], { intentId: 'b' }), deps)
    expect(calls).toHaveLength(2)
  })

  it('replays a refusal too, and never reaches the executor for either attempt', async () => {
    const store = createMemoryStore()
    const { executor, calls } = recordingExecutor(CONFIRMED)
    const deps = {
      agentSlug: 'test',
      chainId: 56 as const,
      binding: HEALTH_BINDING,
      sessions: providerFor(handle('venus-health-factor')),
      executor,
      store,
      now: () => NOW,
    }
    const first = await executeIntent(intent([borrowUsdt], { intentId: 'refused-once' }), deps)
    const second = await executeIntent(intent([borrowUsdt], { intentId: 'refused-once' }), deps)
    expect(first.status).toBe('refused')
    expect(second.status).toBe('refused')
    expect(second.replayed).toBe(true)
    // Refused in this process both times: the signing path was never touched.
    expect(calls).toHaveLength(0)
  })

  it('records every intent it ran, for an audit', async () => {
    const store = createMemoryStore()
    await run({ intent: intent([repayUsdt], { intentId: 'audit-1' }), handle: handle('venus-health-factor'), store })
    const records = await listIntents(store, 'test', 56)
    expect(records.map((entry) => entry.intentId)).toEqual(['audit-1'])
    expect(records[0]!.record.state).toBe('done')
  })

  it('refuses an empty intent rather than executing nothing successfully', async () => {
    const result = await run({ intent: intent([]), handle: handle('venus-health-factor') })
    expect(result.status).toBe('aborted')
    if (result.status !== 'aborted') throw new Error('unreachable')
    expect(result.reason).toBe('nothing-to-do')
  })
})

describe('the rebalance policy', () => {
  it('reaches the position manager and the router, and nothing else', async () => {
    const policy = pancakeRebalancePolicy(56, { now: NOW })
    const allowed = policy.calls.map((rule) => rule.to?.toLowerCase())
    expect(allowed).toContain(chain.defi.pancakeV3PositionManager.toLowerCase())
    expect(allowed).toContain(chain.defi.pancakeV3SwapRouter.toLowerCase())
    expect(allowed).toHaveLength(2)
  })

  it('cannot approve a token, which is why the agent reports the approval instead', async () => {
    const approve = {
      to: '0x55d398326f99059fF775485246999027B3197955' as Address,
      value: 0n,
      signature: 'approve(address,uint256)',
      label: 'Approve USDT to the position manager',
      data: '0x095ea7b3' as const,
    }
    const result = await run({
      intent: intent([approve]),
      handle: handle('pancake-rebalance'),
      binding: REBALANCE_BINDING,
    })
    expect(result.status).toBe('refused')
    if (result.status !== 'refused') throw new Error('unreachable')
    expect(result.refusal.blockedBy.rule).toBe('contract-allowlist')
  })
})

describe('scope checking agrees with the package it wraps', () => {
  it('reaches the same verdict as @hallmark/altana checkScope', () => {
    const policy = venusHealthFactorPolicy(56, { now: NOW })
    const permissions = toAltanaPermissions(policy)
    const verdict = checkScope({
      permissions,
      expiry: policy.expiresAt,
      calls: [{ to: borrowUsdt.to, data: borrowUsdt.data, value: 0n }],
      now: NOW,
    })
    expect(verdict.allowed).toBe(false)
    expect(locateBlockingRule(policy, intent([borrowUsdt]), NOW)).not.toBeNull()
  })

  it('lets executeWithSession refuse without a network call at all', async () => {
    const policy = venusHealthFactorPolicy(56, { now: NOW })
    const session = { ...fakeSession(), permissions: toAltanaPermissions(policy), expiry: policy.expiresAt }
    const outcome = await executeWithSession({
      chainId: 56,
      session,
      calls: [{ to: borrowUsdt.to, data: borrowUsdt.data, value: 0n }],
      now: NOW,
      client: {
        async execute() {
          throw new Error('preflight should have refused before reaching the relay')
        },
      },
    })
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') throw new Error('unreachable')
    expect(outcome.source).toBe('preflight')
  })
})
