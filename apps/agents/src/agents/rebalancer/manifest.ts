import { getProtocols } from '@hallmark/altana'

import type { AgentManifest, SkillPrice } from '../../runtime/types.js'

export const REBALANCER_SLUG = 'rebalancer'

export const rebalancerManifest: AgentManifest = {
  slug: REBALANCER_SLUG,
  name: 'PancakeSwap v3 Range Keeper',
  category: 'rebalancing',
  categoryLabel: 'Rebalancing — manages LP ranges, resets positions automatically',
  description:
    'Watches a PancakeSwap v3 liquidity position, decides whether its range still earns, and ' +
    'resets it when it does not. There is no atomic rebalance on v3: closing and reopening a ' +
    'position is decreaseLiquidity → collect → burn → mint, plus a swap when the token ratio ' +
    'has to move. This agent prices that whole sequence before proposing it, and executes it ' +
    'only inside an Altana session key scoped to the position manager and the swap router.',
  version: '0.1.0',
  tags: ['pancakeswap', 'v3', 'liquidity', 'rebalancing', 'bnb-chain'],
  policy: {
    category: 'pancake-rebalance',
    rationale:
      'Scoped to two contracts — the PancakeSwap v3 position manager and the swap router — ' +
      'with a per-day spend cap and an expiry. The v3 periphery routes almost everything ' +
      'through multicall(bytes[]), so a selector allowlist would block the ordinary path ' +
      'while blocking nothing an attacker would use; the contract allowlist is the bound ' +
      'that actually holds.',
  },
  chains: [56, 97],
}

export function rebalancerReportPrice(chainId: 56 | 97): SkillPrice {
  const asset = getProtocols(chainId).defaultStable
  const symbol = chainId === 56 ? 'USDT' : '$U'
  return {
    amountAtomic: (25n * 10n ** 16n).toString(), // 0.25, eighteen decimals
    asset,
    decimals: 18,
    symbol,
    display: `0.25 ${symbol}`,
  }
}
