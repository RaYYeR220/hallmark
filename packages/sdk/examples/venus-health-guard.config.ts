/**
 * Worked example: a `health-factor` agent.
 *
 * This is the config the README walks through. It watches Venus positions on
 * BNB Chain and unwinds them before liquidation, sells that as two skills, and
 * asks Hallmark to validate it on-chain once published.
 */

import { defineAgent } from '@hallmark/sdk'

export default defineAgent({
  name: 'Venus Health Guard',
  description:
    'Watches a wallet’s Venus position on BNB Chain and repays or unwinds it before the health factor crosses the liquidation threshold. Reports every action it takes and never takes custody.',
  image: 'https://agents.hallmark.market/venus-health-guard/icon.png',

  category: 'health-factor',
  chain: 'bsc',

  services: {
    a2a: 'https://agents.hallmark.market/venus-health-guard/.well-known/agent-card.json',
    mcp: 'https://agents.hallmark.market/venus-health-guard/mcp',
    x402: 'https://agents.hallmark.market/venus-health-guard/x402/watch',
    web: 'https://agents.hallmark.market/venus-health-guard',
  },

  skills: [
    {
      id: 'health-check',
      name: 'Health check',
      description:
        'Reads a wallet’s Venus account liquidity and returns its current health factor, borrow balance and the price move that would liquidate it.',
      inputSchema: {
        type: 'object',
        properties: {
          account: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
          comptroller: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        },
        required: ['account'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          healthFactor: { type: 'number' },
          borrowBalanceUsd: { type: 'number' },
          liquidationPriceUsd: { type: 'number' },
          checkedAtBlock: { type: 'integer' },
        },
        required: ['healthFactor', 'borrowBalanceUsd', 'checkedAtBlock'],
      },
    },
    {
      id: 'guard-position',
      name: 'Guard position',
      description:
        'Watches a position and repays debt from a funded allowance when the health factor drops below the threshold. Returns the transactions it sent.',
      inputSchema: {
        type: 'object',
        properties: {
          account: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
          minHealthFactor: { type: 'number', minimum: 1 },
          maxRepayUsd: { type: 'number', exclusiveMinimum: 0 },
          durationHours: { type: 'integer', minimum: 1, maximum: 720 },
        },
        required: ['account', 'minHealthFactor', 'maxRepayUsd'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                txHash: { type: 'string' },
                repaidUsd: { type: 'number' },
                healthFactorAfter: { type: 'number' },
              },
              required: ['txHash', 'repaidUsd', 'healthFactorAfter'],
            },
          },
          endedAt: { type: 'string', format: 'date-time' },
        },
        required: ['actions', 'endedAt'],
      },
      pricing: { model: 'x402', amount: '2.50', asset: '$U' },
    },
  ],

  pricing: { model: 'x402', amount: '0.50', asset: '$U' },
  trust: ['reputation', 'crypto-economic'],
  validation: { requestFrom: 'hallmark' },
})
