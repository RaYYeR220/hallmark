import { getProtocols } from '@hallmark/altana'

import type { AgentManifest, SkillPrice } from '../../runtime/types.js'

export const HEALTH_SLUG = 'health'

export const healthManifest: AgentManifest = {
  slug: HEALTH_SLUG,
  name: 'Venus Liquidation Guard',
  category: 'health-factor',
  categoryLabel: 'Health Factor Monitoring — protects lending positions from liquidation',
  description:
    'Watches a Venus position, computes its health and the exact price at which it liquidates, ' +
    'and repays precisely enough to restore a target margin when it crosses a threshold. It is ' +
    'schedulable, so it runs unattended. It fails closed: a stale price feed, a feed with the ' +
    'wrong decimals, a read that did not return, or two derivations of health that disagree all ' +
    'stop it acting and say why. And it cannot make a position worse — the session key it runs ' +
    'under has no `borrow` in its allowlist, so the only direction it can move a position is ' +
    'safer.',
  version: '0.1.0',
  tags: ['venus', 'lending', 'liquidation', 'health-factor', 'bnb-chain'],
  policy: {
    category: 'venus-health-factor',
    rationale:
      'The narrowest of the four policies, and the only selector-scoped one: enterMarkets, ' +
      'mint, repayBorrow and redeemUnderlying on the Venus markets. `borrow` is absent by ' +
      'construction, so a key granted to this agent can unwind a position and can never lever ' +
      'one up — not as a matter of the agent behaving, but as a matter of what the account ' +
      'contract will sign.',
  },
  chains: [56, 97],
}

export function healthReportPrice(chainId: 56 | 97): SkillPrice {
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
