import { getChain, isSupportedChainId, type SupportedChainId } from '@hallmark/core'
import { erc20Abi } from '@hallmark/core'
import type { Address } from 'viem'

import { positionManagerOwnershipAbi } from '../../chain/abis.js'
import { getAmountsForLiquidity, nearestUsableTick, tickToPrice } from '../../chain/math.js'
import {
  quoteExactInputSingle,
  readPosition,
  summariseGas,
  type PositionView,
} from '../../chain/pancake.js'
import { priceBothSides, priceUsdForSymbol, valueUsd } from '../../chain/usd.js'
import {
  allAgree,
  assertion,
  failedAssertions,
  reconcile,
  type Assertion,
  type Reconciliation,
} from '../../chain/reconcile.js'
import { fetchPancakeV3Pools } from '../../chain/yields.js'
import { narrate } from '../../runtime/narrative.js'
import { clientFor } from '../../runtime/client.js'
import type { Analysis, SkillContext, Source } from '../../runtime/types.js'
import { REBALANCER_SLUG } from './manifest.js'

/**
 * Deciding whether a v3 range still earns.
 *
 * The rule is deliberately boring and stated in the output: a position out of
 * range earns nothing, so it should move; a position inside its range but
 * within the drift tolerance of an edge is about to earn nothing, so it may
 * move; anything else holds, because a rebalance costs four transactions and a
 * swap and those are not free.
 *
 * Nothing here is a model's opinion. Every number below comes from
 * `positions(tokenId)`, the pool's `slot0`, exact tick math, and — for the
 * `report` variant — a live QuoterV2 simulation.
 */

export type RebalanceInput = {
  chainId?: number
  tokenId: string
  widthBps?: number
  driftToleranceBps?: number
  /** Whose approvals and ownership to check. Defaults to the position's owner. */
  wallet?: string
}

export type RangeView = {
  tickLower: number
  tickUpper: number
  priceLower: number
  priceUpper: number
  widthTicks: number
  /** Full width as a percentage of the lower bound. */
  widthPct: number
}

export type RebalanceDecision = {
  action: 'hold' | 'rebalance'
  urgency: 'none' | 'watch' | 'now'
  reason: string
  inRange: boolean
  current: RangeView
  proposed: RangeView | null
  drift: {
    currentTick: number
    price: number
    /** Positive means the price is above the lower edge by this many bps. */
    bpsAboveLower: number
    bpsBelowUpper: number
    nearestEdge: 'lower' | 'upper'
    nearestEdgeBps: number
    driftToleranceBps: number
  }
  value: {
    amount0: string
    amount1: string
    amount0Usd: number | null
    amount1Usd: number | null
    totalUsd: number | null
    uncollectedFees0: string
    uncollectedFees1: string
  }
  cost: ReturnType<typeof summariseGas> & {
    swap: {
      needed: boolean
      tokenIn: string
      tokenOut: string
      amountIn: string
      quotedOut: string | null
      priceImpactBps: number | null
      detail: string
    } | null
    totalUsd: number | null
  } | null
  recoup: {
    poolApr24hPct: number | null
    estimatedFeesPerDayUsd: number | null
    daysToRecoverCost: number | null
    detail: string
  } | null
  preconditions: {
    positionOwner: string | null
    ownedByWallet: boolean | null
    approvals: Array<{ token: string; symbol: string; spender: string; allowance: string; sufficient: boolean }>
    blocking: string[]
  }
  /**
   * Every figure above that drives the action, derived a second way and
   * required to agree. `checksPass: false` means `act` refuses.
   */
  checks: Reconciliation[]
  assertions: Assertion[]
  checksPass: boolean
}

function bpsBetweenTicks(from: number, to: number): number {
  return (Math.pow(1.0001, to - from) - 1) * 10_000
}

function rangeView(
  tickLower: number,
  tickUpper: number,
  decimals0: number,
  decimals1: number,
): RangeView {
  const priceLower = tickToPrice(tickLower, decimals0, decimals1)
  const priceUpper = tickToPrice(tickUpper, decimals0, decimals1)
  return {
    tickLower,
    tickUpper,
    priceLower,
    priceUpper,
    widthTicks: tickUpper - tickLower,
    widthPct: priceLower > 0 ? ((priceUpper - priceLower) / priceLower) * 100 : Number.NaN,
  }
}

/**
 * Where the new range should sit.
 *
 * Centred on the current tick, keeping the position's existing width unless
 * the caller asked for a different one, then snapped to the pool's tick
 * spacing. Symmetric because an asymmetric range is a directional bet, and an
 * agent that quietly takes one on a user's behalf is doing something it was
 * not hired for.
 */
export function proposeRange(args: {
  currentTick: number
  tickLower: number
  tickUpper: number
  tickSpacing: number
  widthBps?: number | undefined
}): { tickLower: number; tickUpper: number; rationale: string } {
  const existingHalf = Math.max(1, Math.round((args.tickUpper - args.tickLower) / 2))
  const half =
    args.widthBps === undefined
      ? existingHalf
      : Math.max(
          args.tickSpacing,
          Math.round(Math.log(1 + args.widthBps / 10_000) / Math.log(1.0001)),
        )

  let lower = nearestUsableTick(args.currentTick - half, args.tickSpacing)
  let upper = nearestUsableTick(args.currentTick + half, args.tickSpacing)
  if (upper <= lower) upper = lower + args.tickSpacing

  return {
    tickLower: lower,
    tickUpper: upper,
    rationale:
      args.widthBps === undefined
        ? `Kept the position's existing width (${args.tickUpper - args.tickLower} ticks) and ` +
          `recentred it on the current tick ${args.currentTick}, snapped to the pool's ` +
          `${args.tickSpacing}-tick spacing. Changing the width would change the position's ` +
          'risk, which is a decision for whoever owns it.'
        : `Width set from the requested ±${args.widthBps} bps (${half} ticks each side), ` +
          `centred on tick ${args.currentTick} and snapped to the ${args.tickSpacing}-tick spacing.`,
  }
}

/** Which token to sell, and how much, to hit the new range's ratio. */
export function swapToRebalance(args: {
  position: PositionView
  proposedLower: number
  proposedUpper: number
}): { needed: boolean; sellToken0: boolean; amountIn: bigint; detail: string } {
  const { position } = args
  const price = position.price
  if (!(price > 0)) {
    return { needed: false, sellToken0: true, amountIn: 0n, detail: 'Pool price unavailable.' }
  }

  // Ratio the new range wants at the current price, from the same tick math
  // the pool uses. A unit of liquidity is enough: only the ratio matters.
  const wanted = getAmountsForLiquidity({
    sqrtPriceX96: position.sqrtPriceX96,
    tickLower: args.proposedLower,
    tickUpper: args.proposedUpper,
    liquidity: 10n ** 18n,
  })

  const have0 = position.amount0 + position.tokensOwed0
  const have1 = position.amount1 + position.tokensOwed1
  const scale0 = 10 ** position.token0.decimals
  const scale1 = 10 ** position.token1.decimals

  const w0 = Number(wanted.amount0) / scale0
  const w1 = Number(wanted.amount1) / scale1
  const h0 = Number(have0) / scale0
  const h1 = Number(have1) / scale1

  // Value everything in token1 and split it the way the new range wants.
  const totalValue1 = h1 + h0 * price
  const denom = w1 + w0 * price
  if (!(denom > 0) || !(totalValue1 > 0)) {
    return {
      needed: false,
      sellToken0: true,
      amountIn: 0n,
      detail:
        'The proposed range wants only one side at the current price, or the position holds ' +
        'nothing; no ratio swap is implied.',
    }
  }
  const target1 = totalValue1 * (w1 / denom)
  const delta1 = h1 - target1

  // Below a tenth of a percent of the position the swap costs more in gas and
  // fee than the imbalance costs in unused capital.
  const threshold = totalValue1 * 0.001
  if (Math.abs(delta1) < threshold) {
    return {
      needed: false,
      sellToken0: true,
      amountIn: 0n,
      detail:
        `The position is already within 0.1% of the ratio the new range wants ` +
        `(${position.token1.symbol} off by ${delta1.toFixed(6)}), so no swap is worth its own gas.`,
    }
  }

  if (delta1 > 0) {
    const amountIn = BigInt(Math.floor(delta1 * scale1))
    return {
      needed: true,
      sellToken0: false,
      amountIn,
      detail:
        `The new range wants more ${position.token0.symbol}: sell ${delta1.toFixed(6)} ` +
        `${position.token1.symbol} for ${position.token0.symbol} at the ${position.fee / 10_000}% tier.`,
    }
  }

  const amount0In = -delta1 / price
  return {
    needed: true,
    sellToken0: true,
    amountIn: BigInt(Math.floor(amount0In * scale0)),
    detail:
      `The new range wants more ${position.token1.symbol}: sell ${amount0In.toFixed(6)} ` +
      `${position.token0.symbol} for ${position.token1.symbol} at the ${position.fee / 10_000}% tier.`,
  }
}

// ---------------------------------------------------------------------------

export type RebalanceAnalysis = Analysis<RebalanceDecision>

export async function analyseRebalance(
  input: RebalanceInput,
  ctx: SkillContext,
  opts: { deep: boolean },
): Promise<RebalanceAnalysis | { error: string; detail: string }> {
  const chainId: SupportedChainId =
    input.chainId !== undefined && isSupportedChainId(input.chainId)
      ? input.chainId
      : ctx.chainId
  const chain = getChain(chainId)
  const client = clientFor(ctx, chainId)
  const now = ctx.now()
  const sources: Source[] = []
  const warnings: string[] = []

  const tokenId = BigInt(input.tokenId)
  const position = await readPosition({ client, chainId, tokenId })
  if (!position.ok) {
    return {
      error: position.reason,
      detail: position.detail,
    }
  }

  sources.push({
    kind: 'onchain',
    label: 'PancakeSwap v3 position manager',
    detail: `positions(${tokenId}) on ${chain.defi.pancakeV3PositionManager} at block ${position.blockNumber}`,
    url: `${chain.explorer}/address/${chain.defi.pancakeV3PositionManager}`,
  })
  sources.push({
    kind: 'onchain',
    label: `Pool ${position.token0.symbol}/${position.token1.symbol} ${position.fee / 10_000}%`,
    detail: `slot0() and liquidity() on ${position.pool} at block ${position.blockNumber}`,
    url: `${chain.explorer}/address/${position.pool}`,
  })

  const drift = {
    currentTick: position.currentTick,
    price: position.price,
    bpsAboveLower: bpsBetweenTicks(position.tickLower, position.currentTick),
    bpsBelowUpper: bpsBetweenTicks(position.currentTick, position.tickUpper),
    nearestEdge: 'lower' as 'lower' | 'upper',
    nearestEdgeBps: 0,
    driftToleranceBps: input.driftToleranceBps ?? 0,
  }
  drift.nearestEdge = drift.bpsAboveLower <= drift.bpsBelowUpper ? 'lower' : 'upper'
  drift.nearestEdgeBps = Math.min(drift.bpsAboveLower, drift.bpsBelowUpper)

  const proposal = proposeRange({
    currentTick: position.currentTick,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    tickSpacing: position.tickSpacing,
    ...(input.widthBps === undefined ? {} : { widthBps: input.widthBps }),
  })

  const sameRange =
    proposal.tickLower === position.tickLower && proposal.tickUpper === position.tickUpper

  let action: RebalanceDecision['action']
  let urgency: RebalanceDecision['urgency']
  let reason: string

  if (!position.inRange) {
    action = 'rebalance'
    urgency = 'now'
    const side = position.currentTick < position.tickLower ? 'below' : 'at or above'
    reason =
      `The price is ${side} the position's range (tick ${position.currentTick} against ` +
      `[${position.tickLower}, ${position.tickUpper}]), so the position is entirely in ` +
      `${position.currentTick < position.tickLower ? position.token0.symbol : position.token1.symbol} ` +
      'and earning no fees at all. Resetting it around the current price puts the capital back to work.'
  } else if (drift.nearestEdgeBps <= drift.driftToleranceBps) {
    action = 'rebalance'
    urgency = 'watch'
    reason =
      `The price is ${drift.nearestEdgeBps.toFixed(0)} bps from the ${drift.nearestEdge} edge, ` +
      `inside the ${drift.driftToleranceBps} bps tolerance you set. The position still earns, ` +
      'but it is close enough to the edge that recentring now avoids a forced move later.'
  } else if (sameRange) {
    action = 'hold'
    urgency = 'none'
    reason =
      `The price is in range and the recentred range would snap to the same ticks ` +
      `[${position.tickLower}, ${position.tickUpper}]. There is nothing to change.`
  } else {
    action = 'hold'
    urgency = 'none'
    reason =
      `The price is in range, ${drift.nearestEdgeBps.toFixed(0)} bps from the ` +
      `${drift.nearestEdge} edge, which is outside the ${drift.driftToleranceBps} bps tolerance. ` +
      'Recentring would cost four transactions and a swap to buy a marginally better position; ' +
      'holding is cheaper.'
  }

  // --- value ---------------------------------------------------------------
  const pair = await priceBothSides({
    client,
    chainId,
    token0: position.token0,
    token1: position.token1,
    poolPrice: position.price,
    now,
  })
  warnings.push(...pair.notes)
  if (pair.token0.source === 'chainlink' || pair.token1.source === 'chainlink') {
    sources.push({
      kind: 'onchain',
      label: 'Chainlink price feeds',
      detail: [pair.token0, pair.token1]
        .filter((price) => price.source === 'chainlink')
        .map((price) => price.detail)
        .join('; '),
    })
  }

  const amount0Usd = valueUsd(
    position.amount0 + position.tokensOwed0,
    position.token0.decimals,
    pair.token0.usd,
  )
  const amount1Usd = valueUsd(
    position.amount1 + position.tokensOwed1,
    position.token1.decimals,
    pair.token1.usd,
  )
  const totalUsd = amount0Usd === null || amount1Usd === null ? null : amount0Usd + amount1Usd

  // --- preconditions -------------------------------------------------------
  const owner = (await client
    .readContract({
      address: chain.defi.pancakeV3PositionManager,
      abi: positionManagerOwnershipAbi,
      functionName: 'ownerOf',
      args: [tokenId],
    })
    .catch(() => null)) as Address | null

  const wallet = (input.wallet as Address | undefined) ?? owner
  const approvals: RebalanceDecision['preconditions']['approvals'] = []
  const blocking: string[] = []

  if (wallet) {
    for (const token of [position.token0, position.token1]) {
      const allowance = (await client
        .readContract({
          address: token.address,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [wallet, chain.defi.pancakeV3PositionManager],
        })
        .catch(() => 0n)) as bigint
      const held = token.address === position.token0.address ? position.amount0 : position.amount1
      const sufficient = allowance >= held
      approvals.push({
        token: token.address,
        symbol: token.symbol,
        spender: chain.defi.pancakeV3PositionManager,
        allowance: allowance.toString(),
        sufficient,
      })
      if (!sufficient) {
        blocking.push(
          `${token.symbol} allowance to the position manager is ${allowance}, below what the ` +
            'mint leg needs. The session key is scoped to the position manager and the swap ' +
            'router, not to token contracts, so this agent cannot grant the approval itself — ' +
            'that is the allowlist doing its job. Approve once from the owning wallet.',
        )
      }
    }
  }

  // --- cost ----------------------------------------------------------------
  let cost: RebalanceDecision['cost'] = null
  let recoup: RebalanceDecision['recoup'] = null

  if (action === 'rebalance') {
    const swap = swapToRebalance({
      position,
      proposedLower: proposal.tickLower,
      proposedUpper: proposal.tickUpper,
    })
    const gasPrice = await client.getGasPrice().catch(() => 1_000_000_000n)
    // Gas is paid in BNB whatever the pair is, so the BNB price is read
    // directly rather than hoped for from one of the pool's own tokens.
    const bnb = await priceUsdForSymbol({ client, chainId, symbol: 'BNB', now })
    if (bnb.usd === null) warnings.push(bnb.detail)
    const gas = summariseGas({
      includeSwap: swap.needed,
      gasPriceWei: gasPrice,
      bnbUsd: bnb.usd,
    })
    sources.push({
      kind: 'onchain',
      label: 'Gas price',
      detail: `eth_gasPrice = ${gasPrice} wei on chain ${chainId}`,
    })

    let quotedOut: string | null = null
    let priceImpactBps: number | null = null
    let swapDetail = swap.detail

    if (opts.deep && swap.needed && swap.amountIn > 0n) {
      const tokenIn = swap.sellToken0 ? position.token0 : position.token1
      const tokenOut = swap.sellToken0 ? position.token1 : position.token0
      const quote = await quoteExactInputSingle({
        client,
        chainId,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        fee: position.fee,
        amountIn: swap.amountIn,
      })
      if (quote.ok) {
        quotedOut = quote.amountOut.toString()
        const inUnits = Number(swap.amountIn) / 10 ** tokenIn.decimals
        const outUnits = Number(quote.amountOut) / 10 ** tokenOut.decimals
        const spotOut = swap.sellToken0 ? inUnits * position.price : inUnits / position.price
        priceImpactBps = spotOut > 0 ? ((spotOut - outUnits) / spotOut) * 10_000 : null
        swapDetail =
          `${swap.detail} QuoterV2 simulated it live: ${inUnits} ${tokenIn.symbol} in, ` +
          `${outUnits} ${tokenOut.symbol} out, crossing ${quote.ticksCrossed} initialised ` +
          `tick(s). That is ${priceImpactBps?.toFixed(1) ?? '—'} bps below the pool mid, fee included.`
        sources.push({
          kind: 'onchain',
          label: 'PancakeSwap QuoterV2',
          detail: `quoteExactInputSingle simulated on ${chain.defi.pancakeQuoterV2}`,
          url: `${chain.explorer}/address/${chain.defi.pancakeQuoterV2}`,
        })
      } else {
        warnings.push(`Swap quote unavailable: ${quote.detail}`)
        swapDetail = `${swap.detail} The live quote failed, so the swap cost below is not priced.`
      }
    }

    const swapCostUsd =
      priceImpactBps !== null && totalUsd !== null
        ? // Impact applies to the swapped leg, not the whole position.
          (Math.abs(priceImpactBps) / 10_000) *
          (Number(swap.amountIn) /
            10 ** (swap.sellToken0 ? position.token0.decimals : position.token1.decimals)) *
          ((swap.sellToken0 ? pair.token0.usd : pair.token1.usd) ?? 0)
        : null

    cost = {
      ...gas,
      swap: swap.needed
        ? {
            needed: true,
            tokenIn: swap.sellToken0 ? position.token0.symbol : position.token1.symbol,
            tokenOut: swap.sellToken0 ? position.token1.symbol : position.token0.symbol,
            amountIn: swap.amountIn.toString(),
            quotedOut,
            priceImpactBps,
            detail: swapDetail,
          }
        : { needed: false, tokenIn: '', tokenOut: '', amountIn: '0', quotedOut: null, priceImpactBps: null, detail: swapDetail },
      totalUsd:
        gas.gasCostUsd === null ? null : gas.gasCostUsd + (swapCostUsd ?? 0),
    }

    if (opts.deep) {
      recoup = await estimateRecoup({
        ctx,
        pool: position.pool,
        totalUsd,
        costUsd: cost.totalUsd,
        warnings,
        sources,
      })
    }
  }

  // --- reconciliation ------------------------------------------------------
  // The pool reports its price twice in one struct: as sqrtPriceX96 and as a
  // tick. They are independent encodings, and the tick is the floor, so they
  // must agree to within one basis point. They disagree when a caller has
  // mixed up token order or decimals — which is silent everywhere else.
  const priceFromTick = tickToPrice(
    position.currentTick,
    position.token0.decimals,
    position.token1.decimals,
  )
  const checks: Reconciliation[] = [
    reconcile({
      label: 'Pool price',
      primary: { source: 'slot0().sqrtPriceX96', value: position.price },
      secondary: { source: 'slot0().tick via 1.0001^tick', value: priceFromTick },
      toleranceBps: 10,
    }),
  ]

  const [poolBal0, poolBal1] = await Promise.all([
    client
      .readContract({ address: position.token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [position.pool] })
      .catch(() => null) as Promise<bigint | null>,
    client
      .readContract({ address: position.token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [position.pool] })
      .catch(() => null) as Promise<bigint | null>,
  ])

  const assertions: Assertion[] = [
    assertion(
      'Position amounts fit inside the pool',
      poolBal0 === null || poolBal1 === null
        ? true
        : position.amount0 <= poolBal0 && position.amount1 <= poolBal1,
      poolBal0 === null || poolBal1 === null
        ? 'Pool balances could not be read, so this check was skipped rather than assumed.'
        : `Tick math puts this position at ${position.amount0} ${position.token0.symbol} and ` +
          `${position.amount1} ${position.token1.symbol}; the pool holds ${poolBal0} and ${poolBal1}. ` +
          'A position larger than its own pool would mean the tick math is wrong.',
    ),
    assertion(
      'Range is well formed',
      position.tickLower < position.tickUpper &&
        position.tickLower % position.tickSpacing === 0 &&
        position.tickUpper % position.tickSpacing === 0,
      `Ticks [${position.tickLower}, ${position.tickUpper}] against a ${position.tickSpacing}-tick spacing.`,
    ),
  ]

  if (cost?.swap?.needed && cost.swap.priceImpactBps !== null) {
    // A single-hop exact-input swap pays the fee tier, so it can never beat
    // the pool mid. A negative impact means the mid we compared against was
    // stale or the token order was flipped — the exact bug that turns a cost
    // estimate into a phantom profit.
    assertions.push(
      assertion(
        'Swap quote is worse than the mid, as it must be',
        cost.swap.priceImpactBps >= -1,
        `QuoterV2 came back ${cost.swap.priceImpactBps.toFixed(1)} bps against the pool mid. ` +
          `The ${position.fee / 10_000}% fee alone makes anything better than the mid impossible, ` +
          'so a negative figure means the mid was stale or the token order was inverted.',
      ),
    )
  }

  const failed = failedAssertions(assertions)
  const checksPass = allAgree(checks) && failed.length === 0
  if (!checksPass) {
    warnings.push(
      ...checks.filter((check) => !check.agrees).map((check) => check.detail),
      ...failed.map((check) => `${check.label} failed: ${check.detail}`),
    )
  }

  const decision: RebalanceDecision = {
    action,
    urgency,
    reason,
    inRange: position.inRange,
    current: rangeView(
      position.tickLower,
      position.tickUpper,
      position.token0.decimals,
      position.token1.decimals,
    ),
    proposed:
      action === 'rebalance'
        ? rangeView(
            proposal.tickLower,
            proposal.tickUpper,
            position.token0.decimals,
            position.token1.decimals,
          )
        : null,
    drift,
    value: {
      amount0: position.amount0.toString(),
      amount1: position.amount1.toString(),
      amount0Usd,
      amount1Usd,
      totalUsd,
      uncollectedFees0: position.tokensOwed0.toString(),
      uncollectedFees1: position.tokensOwed1.toString(),
    },
    cost,
    recoup,
    preconditions: {
      positionOwner: owner,
      ownedByWallet: owner === null || wallet == null ? null : owner.toLowerCase() === wallet.toLowerCase(),
      approvals,
      blocking,
    },
    checks,
    assertions,
    checksPass,
  }

  const lines = [
    `${position.token0.symbol}/${position.token1.symbol} ${position.fee / 10_000}% position #${tokenId}: ${
      position.inRange ? 'in range' : 'OUT OF RANGE'
    }.`,
    reason,
    ...(decision.proposed
      ? [
          `Proposed range: ticks [${decision.proposed.tickLower}, ${decision.proposed.tickUpper}] ` +
            `(${decision.proposed.priceLower.toPrecision(6)} – ${decision.proposed.priceUpper.toPrecision(6)} ` +
            `${position.token1.symbol} per ${position.token0.symbol}). ${proposal.rationale}`,
        ]
      : []),
    ...(cost
      ? [
          `Cost to move: ${cost.gasTotal} gas over ${cost.steps.length} transactions at ` +
            `${cost.gasPriceWei} wei${cost.gasCostUsd === null ? '' : ` ≈ $${cost.gasCostUsd.toFixed(4)}`}` +
            `${cost.swap?.needed ? `, plus the ratio swap: ${cost.swap.detail}` : ', no ratio swap needed'}`,
        ]
      : []),
    ...(blocking.length > 0 ? [`Blocking: ${blocking.join(' ')}`] : []),
  ]

  return {
    agent: REBALANCER_SLUG,
    skill: opts.deep ? 'report' : 'analyse',
    chainId,
    subject: { tokenId: tokenId.toString(), pool: position.pool, pair: `${position.token0.symbol}/${position.token1.symbol}` },
    observedAt: new Date(now * 1000).toISOString(),
    blockNumber: position.blockNumber.toString(),
    decision,
    facts: {
      position: {
        tokenId: tokenId.toString(),
        token0: position.token0,
        token1: position.token1,
        fee: position.fee,
        tickSpacing: position.tickSpacing,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: position.liquidity.toString(),
        pool: position.pool,
      },
      pool: {
        sqrtPriceX96: position.sqrtPriceX96.toString(),
        tick: position.currentTick,
        liquidity: position.poolLiquidity.toString(),
        price: position.price,
      },
      prices: { token0: pair.token0, token1: pair.token1 },
    },
    sources,
    warnings,
    narrative: await narrate({
      agent: REBALANCER_SLUG,
      skill: opts.deep ? 'report' : 'analyse',
      decision,
      lines,
    }),
  }
}

async function estimateRecoup(args: {
  ctx: SkillContext
  pool: string
  totalUsd: number | null
  costUsd: number | null
  warnings: string[]
  sources: Source[]
}): Promise<RebalanceDecision['recoup']> {
  try {
    const pools = await fetchPancakeV3Pools({ fetchImpl: args.ctx.fetch })
    const match = pools.find((entry) => entry.id.toLowerCase() === args.pool.toLowerCase())
    args.sources.push({
      kind: 'http',
      label: 'PancakeSwap Explorer pool list',
      detail: `apr24h for ${args.pool} (a decimal fraction upstream; converted to a percentage here)`,
      url: 'https://explorer.pancakeswap.com/api/cached/pools/list?chains=bsc&protocols=v3',
    })
    if (!match || match.apr24hPct === null) {
      return {
        poolApr24hPct: null,
        estimatedFeesPerDayUsd: null,
        daysToRecoverCost: null,
        detail: `PancakeSwap's explorer has no 24h APR for ${args.pool}, so the payback period is not estimated.`,
      }
    }
    const feesPerDay =
      args.totalUsd === null ? null : (args.totalUsd * (match.apr24hPct / 100)) / 365
    const days =
      feesPerDay === null || args.costUsd === null || feesPerDay <= 0
        ? null
        : args.costUsd / feesPerDay
    return {
      poolApr24hPct: match.apr24hPct,
      estimatedFeesPerDayUsd: feesPerDay,
      daysToRecoverCost: days,
      detail:
        `The pool returned ${match.apr24hPct.toFixed(2)}% APR over the last 24h. At that rate a ` +
        `${args.totalUsd === null ? 'position of unknown size' : `$${args.totalUsd.toFixed(2)} position`} ` +
        `earns ${feesPerDay === null ? 'an unknown amount' : `$${feesPerDay.toFixed(4)}`} a day, so the ` +
        `move pays for itself in ${days === null ? 'an unknown number of' : days.toFixed(2)} days — ` +
        'assuming the last 24h of volume repeats, which is the assumption to be sceptical of.',
    }
  } catch (error) {
    args.warnings.push(
      `PancakeSwap explorer unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}
