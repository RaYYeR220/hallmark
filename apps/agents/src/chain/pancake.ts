import {
  getChain,
  pancakeV3PoolAbi,
  pancakeV3PositionManagerAbi,
  type SupportedChainId,
} from '@hallmark/core'
import type { Address, PublicClient } from 'viem'

import { pancakeQuoterV2Abi, pancakeV3FactoryAbi } from './abis.js'
import { getAmountsForLiquidity, sqrtPriceX96ToPrice, tickSpacingForFee, tickToPrice } from './math.js'
import { readTokenMeta, type TokenMeta } from './tokens.js'

/**
 * PancakeSwap v3 reads.
 *
 * The pool address comes from `factory.getPool` rather than a CREATE2
 * derivation. One extra `eth_call` buys immunity from an init-code-hash that
 * differs between the fork and its upstream — and PancakeSwap's does.
 */

export type PositionView = {
  tokenId: bigint
  operator: Address
  fee: number
  tickSpacing: number
  tickLower: number
  tickUpper: number
  liquidity: bigint
  tokensOwed0: bigint
  tokensOwed1: bigint
  token0: TokenMeta
  token1: TokenMeta
  pool: Address
  sqrtPriceX96: bigint
  currentTick: number
  poolLiquidity: bigint
  /** Token amounts the position currently holds, from the exact tick math. */
  amount0: bigint
  amount1: bigint
  /** Whole token1 per whole token0, decimal-adjusted. */
  price: number
  priceLower: number
  priceUpper: number
  inRange: boolean
  blockNumber: bigint
}

export type PositionReadFailure = {
  ok: false
  reason: 'not-found' | 'no-pool' | 'read-failed'
  detail: string
}

export type PositionReadResult = ({ ok: true } & PositionView) | PositionReadFailure

export async function readPosition(args: {
  client: PublicClient
  chainId: SupportedChainId
  tokenId: bigint
}): Promise<PositionReadResult> {
  const { client, chainId, tokenId } = args
  const chain = getChain(chainId)
  const manager = chain.defi.pancakeV3PositionManager

  let raw: readonly [
    bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint,
  ]
  try {
    raw = (await client.readContract({
      address: manager,
      abi: pancakeV3PositionManagerAbi,
      functionName: 'positions',
      args: [tokenId],
    })) as never
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason: 'not-found',
      detail:
        `positions(${tokenId}) reverted on the PancakeSwap v3 position manager at ${manager}. ` +
        `The token id does not exist on chain ${chainId}, or the position was burned. (${message})`,
    }
  }

  const [, operator, token0Address, token1Address, fee, tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] = raw

  let pool: Address
  try {
    pool = (await client.readContract({
      address: chain.defi.pancakeV3Factory,
      abi: pancakeV3FactoryAbi,
      functionName: 'getPool',
      args: [token0Address, token1Address, fee],
    })) as Address
  } catch (error) {
    return {
      ok: false,
      reason: 'read-failed',
      detail: `factory.getPool failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (pool === '0x0000000000000000000000000000000000000000') {
    return {
      ok: false,
      reason: 'no-pool',
      detail:
        `The factory has no pool for ${token0Address}/${token1Address} at fee ${fee}. The ` +
        'position exists but its pool does not, which should be impossible — check the chain id.',
    }
  }

  const [slot0, poolLiquidity, blockNumber, token0, token1] = await Promise.all([
    client.readContract({ address: pool, abi: pancakeV3PoolAbi, functionName: 'slot0' }) as Promise<
      readonly [bigint, number, number, number, number, number, boolean]
    >,
    client.readContract({
      address: pool,
      abi: pancakeV3PoolAbi,
      functionName: 'liquidity',
    }) as Promise<bigint>,
    client.getBlockNumber(),
    readTokenMeta(client, token0Address),
    readTokenMeta(client, token1Address),
  ])

  const [sqrtPriceX96, currentTick] = slot0
  const amounts = getAmountsForLiquidity({ sqrtPriceX96, tickLower, tickUpper, liquidity })

  return {
    ok: true,
    tokenId,
    operator,
    fee,
    tickSpacing: tickSpacingForFee(fee),
    tickLower,
    tickUpper,
    liquidity,
    tokensOwed0,
    tokensOwed1,
    token0,
    token1,
    pool,
    sqrtPriceX96,
    currentTick,
    poolLiquidity,
    amount0: amounts.amount0,
    amount1: amounts.amount1,
    price: sqrtPriceX96ToPrice(sqrtPriceX96, token0.decimals, token1.decimals),
    priceLower: tickToPrice(tickLower, token0.decimals, token1.decimals),
    priceUpper: tickToPrice(tickUpper, token0.decimals, token1.decimals),
    inRange: currentTick >= tickLower && currentTick < tickUpper,
    blockNumber,
  }
}

export type PoolView = {
  pool: Address
  token0: TokenMeta
  token1: TokenMeta
  fee: number
  tickSpacing: number
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  price: number
}

export async function readPool(args: {
  client: PublicClient
  chainId: SupportedChainId
  token0: Address
  token1: Address
  fee: number
}): Promise<PoolView | { ok: false; detail: string }> {
  const chain = getChain(args.chainId)
  const pool = (await args.client.readContract({
    address: chain.defi.pancakeV3Factory,
    abi: pancakeV3FactoryAbi,
    functionName: 'getPool',
    args: [args.token0, args.token1, args.fee],
  })) as Address

  if (pool === '0x0000000000000000000000000000000000000000') {
    return {
      ok: false,
      detail: `No PancakeSwap v3 pool for ${args.token0}/${args.token1} at fee ${args.fee} on chain ${args.chainId}.`,
    }
  }

  const [slot0, liquidity, token0Address, token1Address] = await Promise.all([
    args.client.readContract({ address: pool, abi: pancakeV3PoolAbi, functionName: 'slot0' }) as Promise<
      readonly [bigint, number, number, number, number, number, boolean]
    >,
    args.client.readContract({ address: pool, abi: pancakeV3PoolAbi, functionName: 'liquidity' }) as Promise<bigint>,
    args.client.readContract({ address: pool, abi: pancakeV3PoolAbi, functionName: 'token0' }) as Promise<Address>,
    args.client.readContract({ address: pool, abi: pancakeV3PoolAbi, functionName: 'token1' }) as Promise<Address>,
  ])

  const [token0, token1] = await Promise.all([
    readTokenMeta(args.client, token0Address),
    readTokenMeta(args.client, token1Address),
  ])

  return {
    pool,
    token0,
    token1,
    fee: args.fee,
    tickSpacing: tickSpacingForFee(args.fee),
    sqrtPriceX96: slot0[0],
    tick: slot0[1],
    liquidity,
    price: sqrtPriceX96ToPrice(slot0[0], token0.decimals, token1.decimals),
  }
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

export type QuoteResult =
  | {
      ok: true
      amountIn: bigint
      amountOut: bigint
      sqrtPriceX96After: bigint
      ticksCrossed: number
      gasEstimate: bigint
    }
  | { ok: false; detail: string }

/**
 * QuoterV2 by simulation.
 *
 * The quoter is not a `view`: it performs the swap and reverts with the
 * answer, so it has to go through `simulateContract`. Reading it as a view
 * returns nothing useful and looks like a broken RPC.
 */
export async function quoteExactInputSingle(args: {
  client: PublicClient
  chainId: SupportedChainId
  tokenIn: Address
  tokenOut: Address
  fee: number
  amountIn: bigint
}): Promise<QuoteResult> {
  const chain = getChain(args.chainId)
  try {
    const { result } = await args.client.simulateContract({
      address: chain.defi.pancakeQuoterV2,
      abi: pancakeQuoterV2Abi,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          amountIn: args.amountIn,
          fee: args.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })
    const [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] = result as readonly [
      bigint,
      bigint,
      number,
      bigint,
    ]
    return {
      ok: true,
      amountIn: args.amountIn,
      amountOut,
      sqrtPriceX96After,
      ticksCrossed: Number(initializedTicksCrossed),
      gasEstimate,
    }
  } catch (error) {
    return {
      ok: false,
      detail: `QuoterV2 could not quote ${args.amountIn} of ${args.tokenIn} → ${args.tokenOut} at fee ${args.fee}: ${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }`,
    }
  }
}

// ---------------------------------------------------------------------------
// Cost of a rebalance
// ---------------------------------------------------------------------------

/**
 * Gas budget for the rebalance sequence.
 *
 * There is no atomic rebalance on v3: closing and reopening a position is
 * `decreaseLiquidity` → `collect` → `burn` → `mint`, four separate calls, plus
 * a swap when the ratio has to move. These are budget figures for BNB Chain
 * periphery calls, not simulations — simulating the sequence needs the
 * position owner's signature, which this service does not have and will not
 * ask for. They are stated so a caller can substitute their own.
 */
export const REBALANCE_GAS_BUDGET = Object.freeze({
  decreaseLiquidity: 165_000n,
  collect: 120_000n,
  burn: 55_000n,
  mint: 470_000n,
  swap: 160_000n,
})

export type RebalanceCost = {
  steps: Array<{ step: string; gas: string }>
  gasTotal: string
  gasPriceWei: string
  gasCostWei: string
  gasCostBnb: number
  gasCostUsd: number | null
  bnbUsd: number | null
  /** Value lost to the swap: fee tier plus the price impact the quoter showed. */
  swapCostUsd: number | null
  swapDetail: string
  totalUsd: number | null
}

export function summariseGas(args: {
  includeSwap: boolean
  gasPriceWei: bigint
  bnbUsd: number | null
}): Omit<RebalanceCost, 'swapCostUsd' | 'swapDetail' | 'totalUsd'> {
  const steps: Array<{ step: string; gas: bigint }> = [
    { step: 'decreaseLiquidity', gas: REBALANCE_GAS_BUDGET.decreaseLiquidity },
    { step: 'collect', gas: REBALANCE_GAS_BUDGET.collect },
    { step: 'burn', gas: REBALANCE_GAS_BUDGET.burn },
    ...(args.includeSwap ? [{ step: 'swap (exactInputSingle)', gas: REBALANCE_GAS_BUDGET.swap }] : []),
    { step: 'mint', gas: REBALANCE_GAS_BUDGET.mint },
  ]
  const gasTotal = steps.reduce((sum, entry) => sum + entry.gas, 0n)
  const gasCostWei = gasTotal * args.gasPriceWei
  const gasCostBnb = Number(gasCostWei) / 1e18

  return {
    steps: steps.map((entry) => ({ step: entry.step, gas: entry.gas.toString() })),
    gasTotal: gasTotal.toString(),
    gasPriceWei: args.gasPriceWei.toString(),
    gasCostWei: gasCostWei.toString(),
    gasCostBnb,
    gasCostUsd: args.bnbUsd === null ? null : gasCostBnb * args.bnbUsd,
    bnbUsd: args.bnbUsd,
  }
}
