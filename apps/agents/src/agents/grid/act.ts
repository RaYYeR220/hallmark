import { getChain, isSupportedChainId, type SupportedChainId } from '@hallmark/core'
import { encodeFunctionData, type Address } from 'viem'

import { pancakeSwapRouterAbi } from '../../chain/abis.js'
import { quoteExactInputSingle } from '../../chain/pancake.js'
import { clientFor } from '../../runtime/client.js'
import type { ActIntent, ActResult, SkillContext } from '../../runtime/types.js'
import { analyseGrid, type GridInput } from './analyse.js'
import { gridManifest } from './manifest.js'
import { loadGrid, saveGrid, type GridState } from './state.js'

/**
 * Placing the next grid order.
 *
 * One order per call, one swap per order, one contract in the allowlist. The
 * grid's state is only advanced after the relay confirms — a slot marked
 * filled on an intent that was refused would sell inventory the grid does not
 * own, which is the failure that turns a grid bot into a short.
 */

export type GridActInput = GridInput & {
  intentId: string
  slippageBps?: number
  deadlineSeconds?: number
}

export async function actGrid(
  input: GridActInput,
  ctx: SkillContext,
): Promise<ActResult & { plan?: unknown }> {
  const chainId: SupportedChainId =
    input.chainId !== undefined && isSupportedChainId(input.chainId) ? input.chainId : ctx.chainId
  const now = ctx.now()
  const observedAt = new Date(now * 1000).toISOString()
  const binding = gridManifest.policy!

  const analysis = await analyseGrid(input, ctx, { deep: true })
  if ('error' in analysis) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: analysis.error === 'grid-not-defined' ? 'precondition' : 'read-failed',
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
        'The price and grid state this order would be built from do not reconcile, so no order ' +
        'was placed. ' +
        [
          ...decision.checks.filter((check) => !check.agrees).map((check) => check.detail),
          ...decision.assertions.filter((check) => !check.holds).map((check) => `${check.label}: ${check.detail}`),
        ].join(' '),
      evidence: { checks: decision.checks, assertions: decision.assertions },
      observedAt,
    }
  }

  const action = decision.action
  if (action.side === 'none') {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'nothing-to-do',
      detail: action.reason,
      evidence: { price: decision.price, filled: decision.filled, empty: decision.empty },
      observedAt,
    }
  }

  const state = await loadGrid(ctx.store, chainId, input.gridId)
  if (state === null) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'read-failed',
      detail: `Grid "${input.gridId}" vanished between the analysis and the order.`,
      evidence: {},
      observedAt,
    }
  }
  const definition = state.definition

  const handle = await ctx.session.get(chainId, binding)
  if (handle === null) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'no-session',
      detail:
        'No Altana session key is granted for grid trading on this chain. This agent holds no ' +
        'private key of its own; the order below is what it would have placed.',
      evidence: { order: action, price: decision.price },
      observedAt,
    }
  }
  const wallet = handle.session.walletAddress

  const buying = action.side === 'buy'
  const tokenIn = buying ? definition.token1 : definition.token0
  const tokenOut = buying ? definition.token0 : definition.token1
  const tokenInSymbol = buying ? definition.token1Symbol : definition.token0Symbol
  const tokenOutSymbol = buying ? definition.token0Symbol : definition.token1Symbol
  const client = clientFor(ctx, chainId)

  // Re-quote immediately before building calldata. The analysis above did
  // several round trips, and a slippage bound computed against a price from
  // thirty seconds ago is not a bound.
  const quote = await quoteExactInputSingle({
    client,
    chainId,
    tokenIn,
    tokenOut,
    fee: definition.fee,
    amountIn: action.amountInAtomic,
  })
  if (!quote.ok) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'precondition',
      detail:
        `No live quote for this order, so there is no honest slippage bound to set: ${quote.detail}. ` +
        'Sending it with amountOutMinimum = 0 would hand the order to a sandwich; refusing instead.',
      evidence: { order: action },
      observedAt,
    }
  }

  const slippageBps = input.slippageBps ?? 50
  const minOut = (quote.amountOut * BigInt(10_000 - slippageBps)) / 10_000n
  const chain = getChain(chainId)
  const router = chain.defi.pancakeV3SwapRouter

  const intent: ActIntent = {
    intentId: input.intentId,
    summary:
      `Grid "${definition.gridId}" ${action.side} at level ${action.slot} ` +
      `(${action.slotPrice.toPrecision(8)}): ${action.amountInAtomic} ${tokenInSymbol} → ` +
      `at least ${minOut} ${tokenOutSymbol}`,
    calls: [
      {
        to: router,
        value: 0n,
        signature: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
        label:
          `${buying ? 'Buy' : 'Sell'} at grid level ${action.slot}: swap ${action.amountInAtomic} ` +
          `${tokenInSymbol} for at least ${minOut} ${tokenOutSymbol} at the ` +
          `${definition.fee / 10_000}% tier`,
        data: encodeFunctionData({
          abi: pancakeSwapRouterAbi,
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn: tokenIn as Address,
              tokenOut: tokenOut as Address,
              fee: definition.fee,
              recipient: wallet,
              amountIn: action.amountInAtomic,
              amountOutMinimum: minOut,
              sqrtPriceLimitX96: 0n,
            },
          ],
        }),
      },
    ],
    spend: [{ token: tokenIn as Address, amountAtomic: action.amountInAtomic }],
  }

  const result = await ctx.execute(intent, ctx)

  // State advances only on a confirmed order. Anything else leaves the grid
  // exactly as it was, so the next call retries the same level rather than
  // skipping it.
  if (result.status === 'executed' && !result.replayed) {
    applyFill(state, {
      action,
      amountOut: quote.amountOut,
      intentId: input.intentId,
      at: observedAt,
      txHash: result.txHash,
    })
  }

  if (!state.history.some((entry) => entry.intentId === input.intentId)) {
    state.history.push({
      at: observedAt,
      intentId: input.intentId,
      side: action.side,
      slot: action.slot,
      price: decision.price,
      amountInAtomic: action.amountInAtomic.toString(),
      minOutAtomic: minOut.toString(),
      status: result.status,
      ...(result.status === 'executed' ? { txHash: result.txHash } : {}),
      detail:
        result.status === 'executed'
          ? `Confirmed: ${result.explorerUrl}`
          : result.status === 'refused'
            ? `Refused by the session key: ${result.refusal.blockedBy.detail}`
            : result.status === 'aborted'
              ? `Aborted (${result.reason}): ${result.detail}`
              : result.status,
    })
  }
  await saveGrid(ctx.store, state)

  return { ...result, plan: decision }
}

/**
 * Advance a slot after a confirmed order.
 *
 * A buy stores what was actually received, not what was requested, so a later
 * sell offers the real balance. A sell books the difference against the token1
 * that bought the slot — the realised step, which is the only profit a grid
 * makes.
 */
export function applyFill(
  state: GridState,
  args: {
    action: { side: 'buy' | 'sell'; slot: number; amountInAtomic: bigint }
    amountOut: bigint
    intentId: string
    at: string
    txHash: string
  },
): void {
  const slot = state.slots[args.action.slot]
  if (slot === undefined) return

  if (args.action.side === 'buy') {
    slot.state = 'filled'
    slot.heldAtomic = args.amountOut.toString()
    slot.filledAt = args.at
    slot.fillIntentId = args.intentId
    slot.fillTxHash = args.txHash
    return
  }

  const spent = BigInt(state.definition.sizePerLevelAtomic)
  slot.state = 'empty'
  slot.heldAtomic = '0'
  slot.filledAt = null
  slot.fillIntentId = null
  slot.fillTxHash = null
  slot.cycles += 1
  slot.realisedToken1Atomic = (
    BigInt(slot.realisedToken1Atomic) +
    (args.amountOut - spent)
  ).toString()
}
