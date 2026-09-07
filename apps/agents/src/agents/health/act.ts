import { erc20Abi, isSupportedChainId, type SupportedChainId } from '@hallmark/core'
import type { Address } from 'viem'

import { buildRepayCall, planRepay, readVenusAccount } from '../../chain/venus.js'
import { clientFor } from '../../runtime/client.js'
import type { ActIntent, ActResult, SkillContext } from '../../runtime/types.js'
import { analyseHealth, type HealthInput } from './analyse.js'
import { healthManifest } from './manifest.js'

/**
 * Repaying, precisely, and only ever downward.
 *
 * Two guarantees hold here that are worth stating separately.
 *
 * The first is behavioural: this function refuses to build an intent when the
 * analysis failed closed — a stale feed, a feed with the wrong decimals, a
 * Chainlink price that disagrees with Venus's, or two derivations of health
 * that do not reconcile. It returns the evidence instead of a transaction.
 *
 * The second is structural, and does not depend on this function behaving:
 * `venusHealthFactorPolicy` allowlists `enterMarkets`, `mint`, `repayBorrow`
 * and `redeemUnderlying`, and does not allowlist `borrow`. A key granted to
 * this agent cannot lever a position up even if the code above were replaced.
 * The test suite asserts a `borrow` attempt comes back refused.
 */

export type HealthActInput = HealthInput & {
  intentId: string
}

export async function actHealth(
  input: HealthActInput,
  ctx: SkillContext,
): Promise<ActResult & { plan?: unknown }> {
  const chainId: SupportedChainId =
    input.chainId !== undefined && isSupportedChainId(input.chainId) ? input.chainId : ctx.chainId
  const now = ctx.now()
  const observedAt = new Date(now * 1000).toISOString()
  const binding = healthManifest.policy!

  const analysis = await analyseHealth(input, ctx, { deep: true })
  if ('error' in analysis) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'read-failed',
      detail: analysis.detail,
      evidence: { error: analysis.error },
      observedAt,
    }
  }

  const decision = analysis.decision

  if (decision.failClosed) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: decision.failClosed.reason,
      detail: decision.failClosed.detail,
      evidence: {
        feeds: decision.feeds,
        checks: decision.checks,
        assertions: decision.assertions,
        healthFactor: decision.healthFactor,
      },
      observedAt,
    }
  }

  if (decision.action !== 'repay') {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'nothing-to-do',
      detail: decision.reason,
      evidence: { healthFactor: decision.healthFactor, trigger: decision.triggerHealthFactor },
      observedAt,
    }
  }

  const handle = await ctx.session.get(chainId, binding)
  if (handle === null) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'no-session',
      detail:
        'No Altana session key is granted for health-factor defence on this chain. This agent ' +
        'holds no private key of its own; the repay below is what it would have sent.',
      evidence: { plan: decision.repay, healthFactor: decision.healthFactor },
      observedAt,
    }
  }
  const wallet = handle.session.walletAddress

  // Re-read the position and re-size the repay against the balance the wallet
  // actually holds right now. The analysis above did many round trips, and an
  // amount computed from a health factor a minute old is not precise.
  const client = clientFor(ctx, chainId)
  const fresh = await readVenusAccount({ client, chainId, borrower: input.borrower as Address })
  if (!fresh.ok) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'read-failed',
      detail: `Re-reading the position before building calldata failed: ${fresh.detail}`,
      evidence: {},
      observedAt,
    }
  }

  const debtMarket = fresh.markets
    .filter((market) => market.borrowUnderlying > 0n)
    .sort((a, b) => b.borrowUsd - a.borrowUsd)[0]
  if (!debtMarket) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'nothing-to-do',
      detail: 'The position has no outstanding debt any more; nothing to repay.',
      evidence: {},
      observedAt,
    }
  }

  const walletBalance = debtMarket.isNative
    ? await client.getBalance({ address: wallet }).catch(() => 0n)
    : ((await client
        .readContract({
          address: debtMarket.underlying as Address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [wallet],
        })
        .catch(() => 0n)) as bigint)

  const plan = planRepay({
    account: fresh,
    vToken: debtMarket.vToken,
    targetHealthFactor: decision.targetHealthFactor,
    walletBalance,
  })
  if (!plan.ok) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: plan.reason === 'already-healthy' ? 'nothing-to-do' : 'precondition',
      detail: plan.detail,
      evidence: { walletBalance: walletBalance.toString(), market: debtMarket.vTokenSymbol },
      observedAt,
    }
  }

  if (!plan.market.isNative) {
    const allowance = (await client
      .readContract({
        address: plan.market.underlying as Address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [wallet, plan.market.vToken],
      })
      .catch(() => 0n)) as bigint
    if (allowance < plan.repayUnderlying) {
      return {
        status: 'aborted',
        intentId: input.intentId,
        replayed: false,
        reason: 'precondition',
        detail:
          `The wallet's ${plan.market.underlyingSymbol} allowance to ${plan.market.vTokenSymbol} ` +
          `is ${allowance}, below the ${plan.repayUnderlying} this repay needs. The session key ` +
          'is scoped to the Venus markets by selector and cannot call a token contract at all, ' +
          'so it cannot grant the approval — approve once from the owning wallet. Standing ' +
          'approval to the vToken is worth setting up before a position gets close to its ' +
          'trigger, because this is a race with liquidators.',
        evidence: {
          required: plan.repayUnderlying.toString(),
          allowance: allowance.toString(),
        },
        observedAt,
      }
    }
  }

  // The vBNB split. vBNB takes `repayBorrow()` payable with the amount in
  // msg.value; every ERC-20 market takes `repayBorrow(uint256)`. Both are on
  // the policy allowlist for their own market and neither is on the other's.
  const repayCall = buildRepayCall({
    vToken: plan.market.vToken,
    isNative: plan.market.isNative,
    amount: plan.repayUnderlying,
    symbol: plan.market.underlyingSymbol,
  })

  const intent: ActIntent = {
    intentId: input.intentId,
    summary:
      `Repay ${plan.repayUnderlying} ${plan.market.underlyingSymbol} of Venus debt for ` +
      `${input.borrower}, moving health from ${decision.healthFactor?.toFixed(3) ?? '—'} to ` +
      `${plan.projectedHealthFactor.toFixed(3)}`,
    calls: [
      {
        to: repayCall.to,
        data: repayCall.data,
        value: repayCall.value,
        signature: repayCall.signature,
        label: repayCall.label,
      },
    ],
    spend: plan.market.isNative
      ? []
      : [{ token: plan.market.underlying as Address, amountAtomic: plan.repayUnderlying }],
  }

  const result = await ctx.execute(intent, ctx)
  return { ...result, plan: { ...decision, executedRepay: {
    vToken: plan.market.vToken,
    symbol: plan.market.underlyingSymbol,
    amount: plan.repayUnderlying.toString(),
    usd: plan.repayUsd,
    signature: repayCall.signature,
    projectedHealthFactor: plan.projectedHealthFactor,
    cappedBy: plan.cappedBy,
  } } }
}
