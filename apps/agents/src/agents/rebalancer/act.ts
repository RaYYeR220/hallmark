import { getChain, isSupportedChainId, pancakeV3PositionManagerAbi, type SupportedChainId } from '@hallmark/core'
import { encodeFunctionData, type Address } from 'viem'

import { pancakeSwapRouterAbi } from '../../chain/abis.js'
import { readPosition } from '../../chain/pancake.js'
import { clientFor } from '../../runtime/client.js'
import type { ActIntent, ActResult, IntentCall, SkillContext } from '../../runtime/types.js'
import { analyseRebalance, swapToRebalance } from './analyse.js'
import { rebalancerManifest, REBALANCER_SLUG } from './manifest.js'

/**
 * Resetting a range, under a session key.
 *
 * A v3 rebalance is five calls in sequence, not one:
 *
 *     decreaseLiquidity → collect → burn → [swap] → mint
 *
 * All five go to two contracts — the position manager and the swap router —
 * which is exactly the pair `pancakeRebalancePolicy` allowlists. Anything else
 * this function could try to send is refused before it leaves the process, and
 * the refusal names the rule.
 *
 * The approval leg is the interesting omission. `mint` needs an ERC-20
 * allowance from the owner to the position manager, and granting it means
 * calling the *token*, which is not on the allowlist. This agent does not try:
 * it reports the missing approval and stops. Widening the key so an agent
 * could approve arbitrary tokens would hand it the ability to approve anything
 * to anyone, which is the whole thing the key exists to prevent.
 */

const MAX_UINT128 = 2n ** 128n - 1n

export type RebalanceActInput = {
  chainId?: number
  tokenId: string
  intentId: string
  widthBps?: number
  driftToleranceBps?: number
  slippageBps?: number
  deadlineSeconds?: number
}

export type CycleRecord = {
  cycle: number
  intentId: string
  at: string
  chainId: number
  tokenId: string
  from: { tickLower: number; tickUpper: number }
  to: { tickLower: number; tickUpper: number }
  status: ActResult['status']
  txHash?: string
  detail: string
}

function cyclesKey(chainId: number, tokenId: string): string {
  return `rebalancer:cycles:${chainId}:${tokenId}`
}

export async function readCycles(
  ctx: SkillContext,
  chainId: number,
  tokenId: string,
): Promise<CycleRecord[]> {
  return (await ctx.store.get<CycleRecord[]>(cyclesKey(chainId, tokenId))) ?? []
}

function minusSlippage(amount: bigint, bps: number): bigint {
  return (amount * BigInt(10_000 - bps)) / 10_000n
}

export async function actRebalance(
  input: RebalanceActInput,
  ctx: SkillContext,
): Promise<ActResult & { plan?: unknown }> {
  const chainId: SupportedChainId =
    input.chainId !== undefined && isSupportedChainId(input.chainId) ? input.chainId : ctx.chainId
  const now = ctx.now()
  const observedAt = new Date(now * 1000).toISOString()
  const binding = rebalancerManifest.policy!

  const analysis = await analyseRebalance(
    {
      chainId,
      tokenId: input.tokenId,
      ...(input.widthBps === undefined ? {} : { widthBps: input.widthBps }),
      ...(input.driftToleranceBps === undefined ? {} : { driftToleranceBps: input.driftToleranceBps }),
    },
    ctx,
    { deep: true },
  )

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

  // Cross-checks first. A number that two independent derivations disagree on
  // is not a number we move money on.
  if (!decision.checksPass) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'precondition',
      detail:
        'Two independent derivations of the numbers behind this rebalance disagree, so the ' +
        'agent will not act on either. ' +
        [
          ...decision.checks.filter((check) => !check.agrees).map((check) => check.detail),
          ...decision.assertions.filter((check) => !check.holds).map((check) => `${check.label}: ${check.detail}`),
        ].join(' '),
      evidence: { checks: decision.checks, assertions: decision.assertions },
      observedAt,
    }
  }

  if (decision.action === 'hold' || decision.proposed === null) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'nothing-to-do',
      detail: decision.reason,
      evidence: { decision },
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
        'No Altana session key is granted for range keeping on this chain. This agent holds no ' +
        'private key of its own and cannot sign; the plan below is what it would have sent.',
      evidence: { plan: decision, chainId },
      observedAt,
    }
  }
  const wallet = handle.session.walletAddress

  if (
    decision.preconditions.positionOwner !== null &&
    decision.preconditions.positionOwner.toLowerCase() !== wallet.toLowerCase()
  ) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'not-authorised',
      detail:
        `Position #${input.tokenId} is owned by ${decision.preconditions.positionOwner}, not by ` +
        `the wallet this session key acts for (${wallet}). Nothing was attempted.`,
      evidence: { owner: decision.preconditions.positionOwner, sessionWallet: wallet },
      observedAt,
    }
  }

  if (decision.preconditions.blocking.length > 0) {
    return {
      status: 'aborted',
      intentId: input.intentId,
      replayed: false,
      reason: 'precondition',
      detail: decision.preconditions.blocking.join(' '),
      evidence: { approvals: decision.preconditions.approvals },
      observedAt,
    }
  }

  // Re-read the position immediately before building calldata: the analysis
  // above did network round trips, and minting against a price from thirty
  // seconds ago is how a "safe" slippage bound becomes a real loss.
  const client = clientFor(ctx, chainId)
  const fresh = await readPosition({ client, chainId, tokenId: BigInt(input.tokenId) })
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

  const chain = getChain(chainId)
  const manager = chain.defi.pancakeV3PositionManager
  const router = chain.defi.pancakeV3SwapRouter
  const slippageBps = input.slippageBps ?? 50
  const deadline = BigInt(now + (input.deadlineSeconds ?? 600))
  const proposed = decision.proposed

  const calls: IntentCall[] = []

  if (fresh.liquidity > 0n) {
    calls.push({
      to: manager,
      value: 0n,
      signature:
        'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))',
      label: `Withdraw all ${fresh.liquidity} liquidity from position #${input.tokenId}`,
      data: encodeFunctionData({
        abi: pancakeV3PositionManagerAbi,
        functionName: 'decreaseLiquidity',
        args: [
          {
            tokenId: fresh.tokenId,
            liquidity: fresh.liquidity,
            amount0Min: minusSlippage(fresh.amount0, slippageBps),
            amount1Min: minusSlippage(fresh.amount1, slippageBps),
            deadline,
          },
        ],
      }),
    })
  }

  calls.push({
    to: manager,
    value: 0n,
    signature: 'collect((uint256,address,uint128,uint128))',
    label: 'Collect the withdrawn tokens and every uncollected fee',
    data: encodeFunctionData({
      abi: pancakeV3PositionManagerAbi,
      functionName: 'collect',
      args: [
        { tokenId: fresh.tokenId, recipient: wallet, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
      ],
    }),
  })

  calls.push({
    to: manager,
    value: 0n,
    signature: 'burn(uint256)',
    label: `Burn the now-empty position NFT #${input.tokenId}`,
    data: encodeFunctionData({
      abi: pancakeV3PositionManagerAbi,
      functionName: 'burn',
      args: [fresh.tokenId],
    }),
  })

  const swap = swapToRebalance({
    position: fresh,
    proposedLower: proposed.tickLower,
    proposedUpper: proposed.tickUpper,
  })

  let amount0Desired = fresh.amount0 + fresh.tokensOwed0
  let amount1Desired = fresh.amount1 + fresh.tokensOwed1

  if (swap.needed && swap.amountIn > 0n) {
    const tokenIn = swap.sellToken0 ? fresh.token0 : fresh.token1
    const tokenOut = swap.sellToken0 ? fresh.token1 : fresh.token0
    const quotedOut = decision.cost?.swap?.quotedOut
    const minOut = quotedOut ? minusSlippage(BigInt(quotedOut), slippageBps) : 0n

    if (minOut === 0n) {
      return {
        status: 'aborted',
        intentId: input.intentId,
        replayed: false,
        reason: 'precondition',
        detail:
          'The ratio swap has no live quote, so there is no honest slippage bound to set. ' +
          'Sending it with amountOutMinimum = 0 would hand the whole position to a sandwich; ' +
          'refusing instead.',
        evidence: { swap: swap.detail },
        observedAt,
      }
    }

    calls.push({
      to: router,
      value: 0n,
      signature: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))',
      label:
        `Swap ${swap.amountIn} ${tokenIn.symbol} for at least ${minOut} ${tokenOut.symbol} ` +
        `to reach the ratio the new range needs`,
      data: encodeFunctionData({
        abi: pancakeSwapRouterAbi,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: tokenIn.address,
            tokenOut: tokenOut.address,
            fee: fresh.fee,
            recipient: wallet,
            amountIn: swap.amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    })

    if (swap.sellToken0) {
      amount0Desired -= swap.amountIn
      amount1Desired += minOut
    } else {
      amount1Desired -= swap.amountIn
      amount0Desired += minOut
    }
  }

  calls.push({
    to: manager,
    value: 0n,
    signature:
      'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))',
    label:
      `Mint the replacement position over ticks [${proposed.tickLower}, ${proposed.tickUpper}]`,
    data: encodeFunctionData({
      abi: pancakeV3PositionManagerAbi,
      functionName: 'mint',
      args: [
        {
          token0: fresh.token0.address as Address,
          token1: fresh.token1.address as Address,
          fee: fresh.fee,
          tickLower: proposed.tickLower,
          tickUpper: proposed.tickUpper,
          amount0Desired,
          amount1Desired,
          amount0Min: minusSlippage(amount0Desired, slippageBps),
          amount1Min: minusSlippage(amount1Desired, slippageBps),
          recipient: wallet,
          deadline,
        },
      ],
    }),
  })

  const intent: ActIntent = {
    intentId: input.intentId,
    summary:
      `Reset PancakeSwap v3 position #${input.tokenId} from ticks ` +
      `[${fresh.tickLower}, ${fresh.tickUpper}] to [${proposed.tickLower}, ${proposed.tickUpper}]`,
    calls,
    spend: [
      { token: fresh.token0.address as Address, amountAtomic: amount0Desired },
      { token: fresh.token1.address as Address, amountAtomic: amount1Desired },
    ],
  }

  const result = await ctx.execute(intent, ctx)
  await appendCycle(ctx, {
    chainId,
    tokenId: input.tokenId,
    intentId: input.intentId,
    from: { tickLower: fresh.tickLower, tickUpper: fresh.tickUpper },
    to: { tickLower: proposed.tickLower, tickUpper: proposed.tickUpper },
    result,
    observedAt,
  })

  return { ...result, plan: decision }
}

async function appendCycle(
  ctx: SkillContext,
  args: {
    chainId: number
    tokenId: string
    intentId: string
    from: { tickLower: number; tickUpper: number }
    to: { tickLower: number; tickUpper: number }
    result: ActResult
    observedAt: string
  },
): Promise<void> {
  const key = cyclesKey(args.chainId, args.tokenId)
  const existing = (await ctx.store.get<CycleRecord[]>(key)) ?? []

  // Idempotency all the way down: a replayed intent must not add a cycle.
  if (existing.some((entry) => entry.intentId === args.intentId)) return

  const record: CycleRecord = {
    cycle: existing.length + 1,
    intentId: args.intentId,
    at: args.observedAt,
    chainId: args.chainId,
    tokenId: args.tokenId,
    from: args.from,
    to: args.to,
    status: args.result.status,
    ...(args.result.status === 'executed' ? { txHash: args.result.txHash } : {}),
    detail:
      args.result.status === 'executed'
        ? `Confirmed: ${args.result.explorerUrl}`
        : args.result.status === 'refused'
          ? `Refused by the session key: ${args.result.refusal.blockedBy.detail}`
          : args.result.status === 'aborted'
            ? `Aborted (${args.result.reason}): ${args.result.detail}`
            : args.result.status,
  }
  await ctx.store.set(key, [...existing, record])
}

export { REBALANCER_SLUG }
