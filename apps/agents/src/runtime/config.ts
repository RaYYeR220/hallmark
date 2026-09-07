import { getChain, isSupportedChainId, type SupportedChainId } from '@hallmark/core'
import { getProtocols } from '@hallmark/altana'
import type { Address } from 'viem'

import type { RuntimeConfig } from './types.js'

/**
 * Configuration, with defaults that are safe rather than convenient.
 *
 * Anything missing degrades to the cautious option: no cron secret means the
 * scheduled endpoints refuse rather than run unauthenticated; no BscScan key
 * means source verification reports `unknown` rather than `unverified`; the
 * default chain is mainnet, because "agents surfaced on the marketplace must
 * be live on BSC" and a testnet default would quietly make that untrue.
 */

export const SERVICE_VERSION = '0.1.0'

/** Production origin for this service. Overridden by `PUBLIC_BASE_URL`. */
export const DEFAULT_BASE_URL = 'https://hallmark-agents.vercel.app'
/** The marketplace each agent card points at as its `web` service. */
export const DEFAULT_MARKETPLACE_URL = 'https://hallmark-market.vercel.app'

/**
 * Every absolute URL this service emits, derived from one origin.
 *
 * Vercel serves the whole app from a single origin, so five agents cannot each
 * own `/.well-known/agent-card.json`. The per-agent card lives under the
 * agent's own prefix, the origin-level well-known path serves a directory of
 * all five, and the A2A endpoint answers a plain `GET` with its own card —
 * which is what a prober tries first.
 */
export function agentUrls(config: RuntimeConfig, slug: string) {
  const base = config.baseUrl.replace(/\/+$/, '')
  return {
    a2a: `${base}/a2a/${slug}`,
    mcp: `${base}/mcp/${slug}`,
    x402: `${base}/x402/${slug}`,
    card: `${base}/${slug}/.well-known/agent-card.json`,
    cron: `${base}/api/cron/${slug}`,
    web: config.marketplaceUrl.replace(/\/+$/, ''),
  }
}

export type AgentUrls = ReturnType<typeof agentUrls>

function chainIdFrom(value: string | undefined, fallback: SupportedChainId): SupportedChainId {
  if (!value) return fallback
  const parsed = Number(value)
  return isSupportedChainId(parsed) ? parsed : fallback
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RuntimeConfig {
  const defaultChainId = chainIdFrom(env['HALLMARK_CHAIN_ID'], 56)
  const baseUrl = (env['PUBLIC_BASE_URL'] ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const marketplaceUrl = (env['HALLMARK_MARKETPLACE_URL'] ?? DEFAULT_MARKETPLACE_URL).replace(
    /\/+$/,
    '',
  )

  const rpcUrl: Partial<Record<SupportedChainId, string>> = {}
  if (env['BSC_RPC_URL']) rpcUrl[56] = env['BSC_RPC_URL']
  if (env['BSC_TESTNET_RPC_URL']) rpcUrl[97] = env['BSC_TESTNET_RPC_URL']

  // x402 prices are quoted in the 18-decimal stablecoin each chain settles in:
  // USDT on 56, $U on 97. Both are 18 decimals on BNB Chain — the six-decimal
  // habit from Ethereum is the classic way to price a call at a trillionth of
  // what was meant.
  const stable56 = getProtocols(56).defaultStable
  const stable97 = getProtocols(97).defaultStable

  return {
    baseUrl,
    marketplaceUrl,
    defaultChainId,
    payTo: (env['X402_PAY_TO'] as Address | undefined) ?? ZERO_PAYTO,
    x402Asset: {
      56: { address: stable56, decimals: 18, symbol: 'USDT' },
      97: { address: stable97, decimals: 18, symbol: '$U' },
    },
    cronSecret: env['CRON_SECRET'] ?? env['HALLMARK_CRON_SECRET'] ?? null,
    rpcUrl,
    bscscanApiKey: env['BSCSCAN_API_KEY'] ?? null,
    version: SERVICE_VERSION,
  }
}

/**
 * The address a 402 names when the operator has not set one.
 *
 * Deliberately the zero address, not a placeholder that looks real: a payer
 * that sends to it loses the funds, so a challenge quoting it is obviously
 * unconfigured. The x402 handler refuses to serve a paid skill while `payTo`
 * is this value.
 */
export const ZERO_PAYTO: Address = '0x0000000000000000000000000000000000000000'

export function isPayToConfigured(config: RuntimeConfig): boolean {
  return config.payTo.toLowerCase() !== ZERO_PAYTO.toLowerCase()
}

export function rpcUrlFor(config: RuntimeConfig, chainId: SupportedChainId): string {
  return config.rpcUrl[chainId] ?? getChain(chainId).rpcUrl
}
