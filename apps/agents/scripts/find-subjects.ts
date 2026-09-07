/**
 * Find real mainnet subjects to run the agents against.
 *
 * Read-only. Pulls a live PancakeSwap v3 position id and a live Venus borrower
 * out of recent events, so the proof run is against something that actually
 * exists rather than a hand-picked id that might have been burned.
 */
import { createPublicClient, http, parseAbiItem } from 'viem'
import { bsc } from 'viem/chains'
import { getChain } from '@hallmark/core'

const chain = getChain(56)
const client = createPublicClient({ chain: bsc, transport: http(chain.rpcUrl) })

const increaseLiquidity = parseAbiItem(
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
)
const borrow = parseAbiItem(
  'event Borrow(address borrower, uint256 borrowAmount, uint256 accountBorrows, uint256 totalBorrows)',
)

const latest = await client.getBlockNumber()
console.log(`latest block ${latest}`)

const positions = await client.getLogs({
  address: chain.defi.pancakeV3PositionManager,
  event: increaseLiquidity,
  fromBlock: latest - 400n,
  toBlock: latest,
})
console.log(`PancakeSwap v3 IncreaseLiquidity events in the last 400 blocks: ${positions.length}`)
for (const log of positions.slice(-8)) {
  console.log(`  tokenId ${log.args.tokenId} liquidity ${log.args.liquidity} (block ${log.blockNumber})`)
}

for (const [name, market] of [
  ['vUSDT', chain.defi.venusVUsdt],
  ['vBNB', chain.defi.venusVBnb],
] as const) {
  const borrows = await client.getLogs({
    address: market,
    event: borrow,
    fromBlock: latest - 2_000n,
    toBlock: latest,
  })
  console.log(`Venus ${name} Borrow events in the last 2000 blocks: ${borrows.length}`)
  for (const log of borrows.slice(-6)) {
    console.log(`  borrower ${log.args.borrower} amount ${log.args.borrowAmount} (block ${log.blockNumber})`)
  }
}
