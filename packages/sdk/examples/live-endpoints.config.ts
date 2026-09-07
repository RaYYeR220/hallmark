/**
 * A config wired to endpoints that are actually up on the public internet, so
 * `hallmark doctor` has something real to report.
 *
 *   a2a    the agent card of ClawdMint, mainnet agent 2468, published by a
 *          third party at clawdmint-api.vercel.app
 *   mcp    DeepWiki's public MCP server, which answers `initialize` over SSE
 *   x402   the reference x402 endpoint, which answers 402 with the challenge
 *          in a base64 `payment-required` header rather than in the body
 *   web    8004scan, the ERC-8004 explorer
 *
 * None of these belong to Hallmark. They are here because a checker you cannot
 * point at real infrastructure is a checker nobody has tested.
 *
 *   hallmark doctor   --config examples/live-endpoints.config.ts
 *   hallmark estimate --config examples/live-endpoints.config.ts
 */

import { defineAgent } from '@hallmark/sdk'

export default defineAgent({
  name: 'Hallmark Endpoint Probe Demo',
  description:
    'A configuration that points at third-party endpoints which are live right now, so the doctor and estimate commands can be demonstrated against real infrastructure rather than a fixture.',
  image: 'https://8004scan.io/favicon.ico',

  category: 'research',
  chain: 'bsc',

  services: {
    a2a: 'https://clawdmint-api.vercel.app/.well-known/agent-card.json',
    mcp: 'https://mcp.deepwiki.com/mcp',
    x402: 'https://x402.org/protected',
    web: 'https://8004scan.io',
  },

  skills: [
    {
      id: 'probe-endpoint',
      name: 'Probe endpoint',
      description: 'Fetches one declared endpoint and reports whether it speaks the protocol it claims to.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri' },
          protocol: { type: 'string', enum: ['a2a', 'mcp', 'x402'] },
        },
        required: ['url', 'protocol'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'unreachable', 'malformed', 'refused'] },
          latencyMs: { type: 'integer' },
          detail: { type: 'string' },
        },
        required: ['status', 'latencyMs', 'detail'],
      },
    },
  ],

  pricing: { model: 'x402', amount: '0.01', asset: 'USDC' },
  trust: ['reputation'],
  validation: { requestFrom: 'hallmark' },
})
