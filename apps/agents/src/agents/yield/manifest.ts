import { getProtocols } from '@hallmark/altana'

import type { AgentManifest, SkillPrice } from '../../runtime/types.js'

export const YIELD_SLUG = 'yield'

export const yieldManifest: AgentManifest = {
  slug: YIELD_SLUG,
  name: 'BNB Chain Yield Router',
  category: 'yield',
  categoryLabel: 'Yield Optimisation — routes liquidity to the highest available APR',
  description:
    'Compares what an asset earns across BNB Chain venues and says where to put it, with the ' +
    'risk it is taking and the cost of getting there. Rates come from two independent places — ' +
    'DeFiLlama and the lending market\'s own on-chain rate — and a venue whose two readings ' +
    'disagree is reported, not recommended. Depth is read on-chain, because DeFiLlama\'s TVL ' +
    'field for a lending pool is available liquidity rather than total deposits and understates ' +
    'real depth several-fold.',
  version: '0.1.0',
  tags: ['yield', 'venus', 'defillama', 'lending', 'bnb-chain'],
  policy: {
    category: 'yield-routing',
    rationale:
      'Scoped to the Venus comptroller and its markets, plus the Aave V3 pool on mainnet. ' +
      'Moving capital between lending venues needs nothing else, and a key that cannot reach ' +
      'an arbitrary contract cannot be talked into approving one.',
  },
  chains: [56, 97],
}

export function yieldReportPrice(chainId: 56 | 97): SkillPrice {
  const asset = getProtocols(chainId).defaultStable
  const symbol = chainId === 56 ? 'USDT' : '$U'
  return {
    amountAtomic: (25n * 10n ** 16n).toString(),
    asset,
    decimals: 18,
    symbol,
    display: `0.25 ${symbol}`,
  }
}
