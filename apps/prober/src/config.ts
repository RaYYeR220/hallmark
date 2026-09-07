/**
 * Configuration, resolved once and passed down explicitly.
 *
 * Everything has a working default except the two private keys, which have no
 * default on purpose: the prober must be runnable end to end — sweep, score,
 * store, serve, dry-run publish — with an empty environment and no wallet.
 * Only `publish --commit` needs a key, and it says so out loud when it is
 * missing rather than quietly doing nothing.
 */

import { getChain, isSupportedChainId } from '@hallmark/core'
import type { SupportedChainId } from '@hallmark/core'

export type ProbeSettings = {
  /**
   * Per-endpoint deadline. This is a *scoring* boundary, not just a patience
   * setting: `LATENCY_ZERO_MS` is also 5,000, so an endpoint that takes longer
   * than this scores zero for latency anyway. Raising it changes what the
   * score means.
   */
  timeoutMs: number
  /**
   * Deadline for fetching an off-chain registration file, which is a one-shot
   * document fetch and is not scored at all.
   *
   * Measured: at a shared 5s budget with 24-wide concurrency, 842 of 1,878
   * mainnet agents failed to resolve their card, hiding their endpoints
   * entirely and costing 448 agents a `reachable` verdict they deserved. There
   * was never a reason to starve this on the endpoint's latency budget.
   */
  cardTimeoutMs: number
  concurrency: number
  maxRedirects: number
  maxBodyBytes: number
  /** Resolve hostnames and reject the ones that point at private space. */
  checkDns: boolean
  userAgent: string
  /** Follow http/ipfs tokenURIs off-chain to fetch the registration file. */
  resolveOffChainCards: boolean
}

export type BudgetSettings = {
  /** Hard ceiling on what one `publish` invocation may spend, in wei. */
  perRunWei: bigint
  /** Hard ceiling across every run recorded in the store, in wei. */
  totalWei: bigint
}

export type ProberConfig = {
  rpcUrls: Record<SupportedChainId, string>
  /** `HallmarkHook` per chain; null where it is not deployed. */
  hookAddresses: Record<SupportedChainId, string | null>
  scanApiKey: string | null
  evidenceBaseUrl: string
  storeDir: string
  cronSecret: string | null
  validatorPrivateKey: string | null
  attestorPrivateKey: string | null
  /**
   * Optional. Only `validationRequest` needs it, because the Validation
   * Registry refuses that call from anyone but the agent's owner or operator.
   */
  agentOwnerPrivateKey: string | null
  port: number
  probe: ProbeSettings
  budget: BudgetSettings
}

/** Deployed on BSC testnet; mainnet is set through `HALLMARK_HOOK_56`. */
export const DEFAULT_HOOK_97 = '0xc240452ef94071Df0c6740Dd3c86aeb0Ca374798'

/**
 * Evidence bundles are served by the marketplace app, not by the prober, so
 * this is the URL that ends up inside every on-chain attestation. It must be
 * publicly fetchable and byte-identical to what was hashed. `serve` exists for
 * local runs; point `EVIDENCE_BASE_URL` at `http://localhost:8787` to use it.
 */
export const DEFAULT_EVIDENCE_BASE_URL = 'https://hallmark-market.vercel.app/api/evidence'

/** 0.0015 BNB. The wallet holds about 0.005 BNB on mainnet; a run may not eat it. */
export const DEFAULT_PER_RUN_WEI = 1_500_000_000_000_000n
/** 0.0035 BNB across every publish this store has ever recorded. */
export const DEFAULT_TOTAL_WEI = 3_500_000_000_000_000n

export const DEFAULT_PROBE: ProbeSettings = {
  timeoutMs: 5_000,
  cardTimeoutMs: 15_000,
  concurrency: 20,
  maxRedirects: 3,
  maxBodyBytes: 2 * 1024 * 1024,
  checkDns: true,
  userAgent: 'hallmark-prober/0.1 (+https://github.com/hallmark; ERC-8004 liveness probe)',
  resolveOffChainCards: true,
}

export type ConfigOverrides = Partial<Omit<ProberConfig, 'probe' | 'budget' | 'rpcUrls' | 'hookAddresses'>> & {
  probe?: Partial<ProbeSettings>
  budget?: Partial<BudgetSettings>
  rpcUrls?: Partial<Record<SupportedChainId, string>>
  hookAddresses?: Partial<Record<SupportedChainId, string | null>>
  env?: Record<string, string | undefined>
}

let envFileLoaded = false

/** Reads `.env` once, if the runtime supports it, then never again. */
export function loadEnvFile(path = '.env'): void {
  if (envFileLoaded) return
  envFileLoaded = true
  const loader = (process as { loadEnvFile?: (p: string) => void }).loadEnvFile
  if (typeof loader !== 'function') return
  try {
    loader.call(process, path)
  } catch {
    // No .env, or an unreadable one. Real environments set real variables.
  }
}

export function loadConfig(overrides: ConfigOverrides = {}): ProberConfig {
  loadEnvFile()
  const env = overrides.env ?? process.env

  const config: ProberConfig = {
    rpcUrls: {
      56: overrides.rpcUrls?.[56] ?? env['RPC_URL_56'] ?? getChain(56).rpcUrl,
      97: overrides.rpcUrls?.[97] ?? env['RPC_URL_97'] ?? getChain(97).rpcUrl,
    },
    hookAddresses: {
      56: overrides.hookAddresses?.[56] ?? nonEmpty(env['HALLMARK_HOOK_56']),
      97: overrides.hookAddresses?.[97] ?? nonEmpty(env['HALLMARK_HOOK_97']) ?? DEFAULT_HOOK_97,
    },
    scanApiKey: overrides.scanApiKey ?? nonEmpty(env['SCAN_API_KEY']),
    evidenceBaseUrl: trimSlash(
      overrides.evidenceBaseUrl ?? nonEmpty(env['EVIDENCE_BASE_URL']) ?? DEFAULT_EVIDENCE_BASE_URL,
    ),
    storeDir: overrides.storeDir ?? nonEmpty(env['STORE_DIR']) ?? './data',
    cronSecret: overrides.cronSecret ?? nonEmpty(env['CRON_SECRET']),
    validatorPrivateKey: overrides.validatorPrivateKey ?? nonEmpty(env['VALIDATOR_PRIVATE_KEY']),
    attestorPrivateKey: overrides.attestorPrivateKey ?? nonEmpty(env['ATTESTOR_PRIVATE_KEY']),
    agentOwnerPrivateKey: overrides.agentOwnerPrivateKey ?? nonEmpty(env['AGENT_OWNER_PRIVATE_KEY']),
    port: overrides.port ?? intOr(env['PORT'], 8787),
    probe: {
      timeoutMs: overrides.probe?.timeoutMs ?? intOr(env['PROBE_TIMEOUT_MS'], DEFAULT_PROBE.timeoutMs),
      cardTimeoutMs:
        overrides.probe?.cardTimeoutMs ?? intOr(env['PROBE_CARD_TIMEOUT_MS'], DEFAULT_PROBE.cardTimeoutMs),
      concurrency: overrides.probe?.concurrency ?? intOr(env['PROBE_CONCURRENCY'], DEFAULT_PROBE.concurrency),
      maxRedirects: overrides.probe?.maxRedirects ?? intOr(env['PROBE_MAX_REDIRECTS'], DEFAULT_PROBE.maxRedirects),
      maxBodyBytes: overrides.probe?.maxBodyBytes ?? intOr(env['PROBE_MAX_BODY_BYTES'], DEFAULT_PROBE.maxBodyBytes),
      checkDns: overrides.probe?.checkDns ?? boolOr(env['PROBE_CHECK_DNS'], DEFAULT_PROBE.checkDns),
      userAgent: overrides.probe?.userAgent ?? nonEmpty(env['PROBE_USER_AGENT']) ?? DEFAULT_PROBE.userAgent,
      resolveOffChainCards:
        overrides.probe?.resolveOffChainCards ??
        boolOr(env['PROBE_RESOLVE_OFFCHAIN'], DEFAULT_PROBE.resolveOffChainCards),
    },
    budget: {
      perRunWei: overrides.budget?.perRunWei ?? bigintOr(env['BUDGET_WEI_PER_RUN'], DEFAULT_PER_RUN_WEI),
      totalWei: overrides.budget?.totalWei ?? bigintOr(env['BUDGET_WEI_TOTAL'], DEFAULT_TOTAL_WEI),
    },
  }

  return config
}

export function rpcUrlFor(config: ProberConfig, chainId: number): string {
  if (!isSupportedChainId(chainId)) {
    throw new Error(`unsupported chain ${chainId}; Hallmark runs on BNB Smart Chain 56 and 97`)
  }
  return config.rpcUrls[chainId]
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim()
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function intOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return value === undefined || value.trim() === '' || !Number.isFinite(parsed) ? fallback : Math.trunc(parsed)
}

function boolOr(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback
  const lowered = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false
  return fallback
}

function bigintOr(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || value.trim() === '') return fallback
  try {
    return BigInt(value.trim())
  } catch {
    return fallback
  }
}
