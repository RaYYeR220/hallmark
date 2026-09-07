import { serve } from '@hono/node-server'

import { buildApp } from './app.js'
import { AGENTS } from './registry.js'
import { agentUrls, isPayToConfigured, loadConfig } from './runtime/config.js'

/**
 * The Node entry point.
 *
 * The startup banner names what is *not* configured, because every one of
 * those is a capability the service will refuse rather than fake: no session
 * key means `act` answers `no-session`; no pay-to address means the x402 face
 * refuses to quote; no cron secret means the scheduled endpoint refuses every
 * request.
 */

const config = loadConfig()
const app = buildApp({ config })
const port = Number(process.env['PORT'] ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  const lines: string[] = [
    `hallmark-agents ${config.version} listening on http://localhost:${info.port}`,
    `public base URL: ${config.baseUrl}`,
    `default chain:   ${config.defaultChainId}`,
    '',
    'agents:',
    ...AGENTS.map((agent) => {
      const urls = agentUrls(config, agent.manifest.slug)
      return `  ${agent.manifest.slug.padEnd(10)} ${agent.manifest.categoryLabel}\n` +
        `             card ${urls.card}\n` +
        `             a2a  ${urls.a2a}\n` +
        `             mcp  ${urls.mcp}\n` +
        `             x402 ${urls.x402}`
    }),
    '',
    'refusals in force:',
    ...(isPayToConfigured(config)
      ? []
      : ['  X402_PAY_TO unset — the x402 face refuses to quote a challenge (503).']),
    ...(config.cronSecret === null
      ? ['  CRON_SECRET unset — the scheduled endpoint refuses every request (503).']
      : []),
    ...(process.env['HALLMARK_SESSION_HEALTH'] === undefined
      ? ['  No session keys granted — every `act` answers `aborted / no-session` with the plan it would have sent.']
      : []),
  ]
  // eslint-disable-next-line no-console -- this is the process's own banner.
  console.log(lines.join('\n'))
})
