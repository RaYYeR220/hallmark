import { getProtocols } from '@hallmark/altana'

import type { AgentManifest, SkillPrice } from '../../runtime/types.js'

export const GRID_SLUG = 'grid'

export const gridManifest: AgentManifest = {
  slug: GRID_SLUG,
  name: 'PancakeSwap Grid Trader',
  category: 'grid',
  categoryLabel: 'Grid Trading — places and manages automated grid orders',
  description:
    'Runs a geometric grid over a PancakeSwap v3 pair: a band, a level count, a size per level, ' +
    'and a slot at each level that fills on the way down and unwinds on the way up. State is ' +
    'persisted, so a restart resumes on the same grid rather than re-buying levels it already ' +
    'owns. Every order is a single swap through the router, under an Altana session key scoped ' +
    'to that router and nothing else.',
  version: '0.1.0',
  tags: ['pancakeswap', 'grid', 'trading', 'bnb-chain'],
  policy: {
    category: 'pancake-grid',
    rationale:
      'One contract: the PancakeSwap v3 swap router. A grid trades inside a band and never ' +
      'touches the LP lifecycle, so the key does not need the position manager — and a key ' +
      'that cannot mint or burn a position is a key that cannot lose one.',
  },
  chains: [56, 97],
}

export function gridReportPrice(chainId: 56 | 97): SkillPrice {
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
