import { erc20Abi, getChain, isSupportedChainId, type SupportedChainId } from '@hallmark/core'
import { parseUnits, type Address } from 'viem'

import { buildApproveCall, buildSupplyCall, listVenusMarkets } from '../../chain/venus.js'
import { clientFor } from '../../runtime/client.js'
import type { ActIntent, ActResult, IntentCall, SkillContext } from '../../runtime/types.js'
import { analyseYield, type YieldInput } from './analyse.js'
import { yieldManifest } from './manifest.js'

/**
 * Routing capital to the venue the analysis chose.
 *
 * Deliberately narrow: this agent supplies into a Venus market and nothing
 * else. The policy allowlist reaches the comptroller and the Venus markets;
 * a venue the analysis ranks first but the key cannot reach is reported as
 * exactly that — a recommendation the session key is not scoped for — rather
 * than quietly substituting second place.
 *
 * The ERC-20 approval leg goes to the *token*, which is not on the allowlist.
 * That is the allowlist working: an agent that could approve arbitrary tokens
 * could approve them to anyone. The approval is surfaced as a precondition for
 * the owner to satisfy once.
 */

export type YieldActInput = YieldInput & {
  intentId: string
  /** Destination venue name, as reported by `analyse`. Defaults to the best. */
  venue?: string
}

export async function actYield(
  input: YieldActInput,
  ctx: SkillContext,
): Promise<ActResult & { plan?: unknown }> {
  const chainId: SupportedChainId =
    input.chainId !== undefined && isSupportedChainId(input.chainId) ? input.chainId : ctx.chainId
  const now = ctx.now()
  const observedAt = new Date(now * 1000).toISOString()
  const binding = yieldManifest.policy!
  const chain = getChain(chainId)

  const analysis = await analyseYield(input, ctx, { deep: true })
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

  if (!decision.checksPass) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'precondition',
      detail:
        'The rates behind this allocation do not reconcile between their two sources, so no ' +
        'capital was moved. ' +
        [
          ...decision.checks.filter((check) => !check.agrees).map((check) => check.detail),
          ...decision.assertions.filter((check) => !check.holds).map((check) => `${check.label}: ${check.detail}`),
        ].join(' '),
      evidence: { checks: decision.checks, assertions: decision.assertions },
      observedAt,
    }
  }

  const target = input.venue
    ? decision.venues.find((venue) => venue.name === input.venue)
    : decision.best
  if (!target) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'nothing-to-do',
      detail: input.venue
        ? `No venue named "${input.venue}" in this comparison.`
        : 'No venue cleared the filters, so there is nothing to route into.',
      evidence: { venues: decision.venues.map((venue) => venue.name) },
      observedAt,
    }
  }

  if (target.onchain === null) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'not-authorised',
      detail:
        `${target.name} is the highest-yielding venue found, but this agent's session key is ` +
        'scoped to the Venus comptroller and its markets (plus the Aave V3 pool on mainnet). It ' +
        'cannot reach that venue, and it will not quietly route somewhere else instead. Widening ' +
        'the key is a decision for whoever granted it.',
      evidence: { recommended: target, allowlistCategory: binding.category },
      observedAt,
    }
  }

  if (decision.breakEven.apyDeltaPct !== null && decision.breakEven.apyDeltaPct <= 0) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'nothing-to-do',
      detail: decision.breakEven.detail,
      evidence: { breakEven: decision.breakEven },
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
        'No Altana session key is granted for yield routing on this chain. This agent holds no ' +
        'private key of its own; the allocation below is what it would have executed.',
      evidence: { plan: decision.allocation, target: target.name },
      observedAt,
    }
  }

  const client = clientFor(ctx, chainId)
  const markets = await listVenusMarkets({ client, chainId, symbols: [decision.asset] })
  const market = markets.find(
    (entry) => entry.vToken.toLowerCase() === target.onchain!.vToken.toLowerCase(),
  )
  if (!market) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'read-failed',
      detail: `Could not re-read the Venus market ${target.onchain.vToken} before building calldata.`,
      evidence: {},
      observedAt,
    }
  }

  const amount = parseUnits(input.amount, market.underlyingDecimals)
  const calls: IntentCall[] = []

  if (!market.isNative) {
    const allowance = (await client
      .readContract({
        address: market.underlying as Address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [handle.session.walletAddress, market.vToken],
      })
      .catch(() => 0n)) as bigint

    if (allowance < amount) {
      const approve = buildApproveCall({
        token: market.underlying as Address,
        spender: market.vToken,
        amount,
        symbol: market.underlyingSymbol,
      })
      return {
        status: 'aborted',
        intentId: input.intentId,
        replayed: false,
        reason: 'precondition',
        detail:
          `The wallet's ${market.underlyingSymbol} allowance to ${market.vTokenSymbol} is ` +
          `${allowance}, below the ${amount} this deposit needs. The session key is scoped to ` +
          'the Venus comptroller and its markets, not to token contracts, so this agent cannot ' +
          'grant the approval itself — that is the allowlist doing its job. Approve once from ' +
          'the owning wallet and call again.',
        evidence: {
          required: amount.toString(),
          allowance: allowance.toString(),
          approvalCalldata: { to: approve.to, data: approve.data, signature: approve.signature },
        },
        observedAt,
      }
    }
  }

  const supply = buildSupplyCall({
    vToken: market.vToken,
    isNative: market.isNative,
    amount,
    symbol: market.underlyingSymbol,
  })
  calls.push({
    to: supply.to,
    data: supply.data,
    value: supply.value,
    signature: supply.signature,
    label: supply.label,
  })

  const intent: ActIntent = {
    intentId: input.intentId,
    summary:
      `Supply ${input.amount} ${market.underlyingSymbol} into ${target.name} ` +
      `(${target.apyPct?.toFixed(2) ?? '—'}% APY) on ${chain.name}`,
    calls,
    spend: market.isNative
      ? []
      : [{ token: market.underlying as Address, amountAtomic: amount }],
  }

  const result = await ctx.execute(intent, ctx)
  return { ...result, plan: decision }
}
