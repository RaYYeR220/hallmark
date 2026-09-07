import { defineSkill } from '../../runtime/types.js'
import type { AgentDefinition, Shape } from '../../runtime/types.js'
import { analyseSecurity, type SecurityInput } from './analyse.js'
import { securityManifest, securityReportPrice } from './manifest.js'

const shape: Shape = {
  token: {
    kind: 'address',
    description: 'The BNB Chain token to assess.',
  },
  chainId: {
    kind: 'integer',
    description: 'BNB Chain id: 56 (mainnet) or 97 (testnet).',
    optional: true,
    min: 56,
    max: 97,
  },
  holderWindowBlocks: {
    kind: 'integer',
    description:
      'Blocks of Transfer history to build the holder table from. Larger is more complete and slower.',
    optional: true,
    min: 1_000,
    max: 200_000,
  },
}

const analyse = defineSkill<SecurityInput>({
  id: 'analyse',
  name: 'Token triage',
  description:
    'Fast structural read: proxy detection and resolution, ownership, the privileged functions ' +
    'present in the implementation bytecode, and whether liquidity is burned or locked. Skips ' +
    'the two expensive checks — the holder scan and the buy/sell simulation — and reports them ' +
    'as unknown rather than implying they passed. Read-only.',
  mode: 'read',
  tags: ['analysis', 'security'],
  input: shape,
  examples: [
    'Is 0x… safe to buy?',
    'Does this token have a mint function behind a proxy?',
  ],
  run: (input, ctx) => analyseSecurity(input, ctx, { deep: false }),
})

const report = defineSkill<SecurityInput>({
  id: 'report',
  name: 'Full token safety report',
  description:
    'Everything `analyse` returns, plus the two checks that cost real work: a holder table ' +
    'built from Transfer logs, and buy-then-sell round trips simulated at several sizes through ' +
    '`eth_call` state overrides, which return the actual round-trip cost as a number rather ' +
    'than a honeypot yes/no. Sold over x402.',
  mode: 'read',
  tags: ['analysis', 'security', 'paid'],
  input: shape,
  price: securityReportPrice(56),
  run: (input, ctx) => analyseSecurity(input, ctx, { deep: true }),
})

export const securityAgent: AgentDefinition = {
  manifest: securityManifest,
  // No `act`. This agent never sends a transaction and holds no session key,
  // which is why its manifest declares `policy: null` — a read-only agent that
  // advertised an on-chain capability would be lying on its card.
  skills: [analyse, report],
}

export { securityManifest }
