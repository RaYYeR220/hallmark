import { getProtocols } from '@hallmark/altana'

import type { AgentManifest, SkillPrice } from '../../runtime/types.js'

export const SECURITY_SLUG = 'security'

export const securityManifest: AgentManifest = {
  slug: SECURITY_SLUG,
  name: 'BNB Chain Token Safety',
  category: 'security',
  categoryLabel: 'Trading & Security — token safety, honeypot and rug analysis',
  description:
    'Answers whether a BNB Chain token can be bought, held and sold, with the evidence for ' +
    'every finding. Proxies are detected from the bytecode and the standard storage slots and ' +
    'resolved to their implementation before anything else is checked — a scanner that reads a ' +
    '45-byte delegation stub finds no mint function and reports the token clean. Sellability is ' +
    'measured, not inferred: buy-then-sell round trips are simulated at several sizes through ' +
    '`eth_call` state overrides, and the round-trip cost comes back as a number. A contract ' +
    'with no red flags and a guaranteed round-trip loss is still a no, and this says so. ' +
    'Read-only, and sold over x402.',
  version: '0.1.0',
  tags: ['security', 'honeypot', 'rug', 'token', 'bnb-chain', 'trading'],
  policy: null,
  chains: [56, 97],
}

export function securityReportPrice(chainId: 56 | 97): SkillPrice {
  const asset = getProtocols(chainId).defaultStable
  const symbol = chainId === 56 ? 'USDT' : '$U'
  return {
    amountAtomic: (5n * 10n ** 17n).toString(), // 0.50
    asset,
    decimals: 18,
    symbol,
    display: `0.50 ${symbol}`,
  }
}
