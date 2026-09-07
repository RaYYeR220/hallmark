import 'server-only'

/**
 * Server-side configuration.
 *
 * `server-only` at the top of this module is load-bearing: importing it from a
 * client component is a build error, not a runtime surprise, so a secret can
 * never reach the browser bundle by accident.
 *
 * Nothing here throws on a missing value. The app is meant to be cloned and
 * run by a stranger with an empty `.env`, and every capability that needs a
 * variable degrades to an explained "not configured on this deployment"
 * instead of a 500.
 */

function str(name: string): string | null {
  const raw = process.env[name]
  if (raw === undefined) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

function int(name: string, fallback: number): number {
  const raw = str(name)
  if (raw === null) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export const env = {
  scanApiKey: str('SCAN_API_KEY'),
  scanBaseUrl: str('SCAN_BASE_URL'),
  rpcUrl56: str('RPC_URL_56'),
  rpcUrl97: str('RPC_URL_97'),
  sponsorPrivateKey: str('SPONSOR_PRIVATE_KEY'),
  // Default sits below the sponsor wallet's working balance so a run cannot
  // be sized larger than the money behind it, and comfortably above the
  // escrow's 0.1 $U minimum attestable budget so a sponsored job still earns
  // its rating. Raise it only alongside the balance.
  sponsorMaxBudgetU: int('SPONSOR_MAX_BUDGET_U', 2),
  sponsorRateLimitPerHour: int('SPONSOR_RATE_LIMIT_PER_HOUR', 3),
} as const

export function rpcUrlFor(chainId: number): string | undefined {
  if (chainId === 56) return env.rpcUrl56 ?? undefined
  if (chainId === 97) return env.rpcUrl97 ?? undefined
  return undefined
}

export type SponsorStatus =
  | { available: true; maxBudgetU: number; perHour: number }
  | { available: false; reason: string }

/**
 * Whether the sponsored demo hire can run on this deployment.
 *
 * The key is validated shallowly on purpose — the point is to tell a visitor
 * why the button is disabled, not to prove the key is funded.
 */
export function sponsorStatus(): SponsorStatus {
  const key = env.sponsorPrivateKey
  if (key === null) {
    return {
      available: false,
      reason:
        'This deployment has no sponsor key configured, so the server cannot pay for a demo hire. ' +
        'Every other flow on this page works; connect a wallet on BNB testnet to run the real one.',
    }
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    return {
      available: false,
      reason:
        'The configured sponsor key is not a 32-byte hex private key, so sponsored hires are disabled.',
    }
  }
  return {
    available: true,
    maxBudgetU: env.sponsorMaxBudgetU,
    perHour: env.sponsorRateLimitPerHour,
  }
}
