import type { CallPermission, SessionPermissions, SpendPermission } from '@altananetwork/sdk'
import { formatUnits, type Address } from 'viem'

import {
  getProtocols,
  isNativeToken,
  knownDecimals,
  NATIVE_TOKEN,
  shortAddress,
  tokenSymbol,
} from './addresses.js'
import { getAltanaNetwork, OBSERVED_KEYSTORE_FEE_WEI } from './network.js'

/**
 * Hallmark's scope model.
 *
 * Altana's permission shape is deliberately minimal — addresses, selectors and
 * bigint limits. That is the right thing for a protocol and the wrong thing for
 * a control panel, so we keep our own vocabulary on top: every rule carries the
 * sentence we show the user, and every cap carries the decimals it was written
 * against. `toAltanaPermissions` strips the copy back off at the boundary.
 */

/** A per-token spending cap over a rolling window. */
export type SpendCap = {
  /** ERC-20 address, or `NATIVE_TOKEN` for BNB. */
  token: Address
  /** The cap in the token's smallest unit. */
  limitAtomic: bigint
  /**
   * The token's decimals on this chain. Carried explicitly because getting it
   * wrong is the single most common way to write a cap that silently blocks
   * every payment — BNB Chain stablecoins are 18-decimal, not 6.
   */
  decimals: number
  period: 'day' | 'hour'
}

/** One allowed call. `to` and `signature` are ANDed when both are present. */
export type CallRule = {
  to?: Address
  /** A function signature, e.g. `repayBorrow(uint256)`. */
  signature?: string
  /** Human copy for the UI. Required — an unexplained rule is a bad rule. */
  label: string
}

export type AgentPolicy = {
  label: string
  calls: CallRule[]
  spend: SpendCap[]
  /** Unix seconds. */
  expiresAt: number
}

export type PolicyValidation = { ok: true } | { ok: false; problems: string[] }

/** A year out. Past this an "expiry" is decoration, not a safety property. */
export const MAX_POLICY_TTL_SECONDS = 365 * 24 * 60 * 60

/**
 * Unix *seconds* never reach 1e11 (that is the year 5138), so anything at or
 * above it is a millisecond timestamp that slipped through — by far the most
 * common way an expiry ends up meaningless.
 */
const MILLISECOND_TIMESTAMP_FLOOR = 1e11

/**
 * Smallest native cap that can plausibly do any work: two Keystore-fee-sized
 * relay charges. Relay fees come out of the native cap, so a cap under this
 * buys a session that cannot execute even once.
 */
export const MIN_NATIVE_CAP_WEI = OBSERVED_KEYSTORE_FEE_WEI * 2n

// ---------------------------------------------------------------------------
// Mapping to and from Altana's shape
// ---------------------------------------------------------------------------

function toCallPermission(rule: CallRule): CallPermission {
  if (rule.to && rule.signature) return { to: rule.to, signature: rule.signature }
  if (rule.signature) return { signature: rule.signature }
  if (rule.to) return { to: rule.to }
  throw new Error(`Call rule "${rule.label}" has neither \`to\` nor \`signature\`.`)
}

function toSpendPermission(cap: SpendCap): SpendPermission {
  // Altana signals "native" by omitting `token`; our sentinel is the wire form.
  return isNativeToken(cap.token)
    ? { limit: cap.limitAtomic, period: cap.period }
    : { limit: cap.limitAtomic, period: cap.period, token: cap.token }
}

/**
 * Translate a policy into the permissions object `grantSession` takes.
 *
 * An empty `calls` list is emitted as an omitted `calls` key, which is what
 * Altana reads as "any contract". That is a real and occasionally useful
 * setting, but never one Hallmark should reach by accident, so
 * `validatePolicy` reports it as a problem.
 */
export function toAltanaPermissions(policy: AgentPolicy): SessionPermissions {
  const calls = policy.calls.map(toCallPermission)
  const spend = policy.spend.map(toSpendPermission)
  return {
    ...(calls.length > 0 ? { calls } : {}),
    ...(spend.length > 0 ? { spend } : {}),
  }
}

export type PolicyReconstruction = {
  label: string
  expiresAt: number
  /** Decimals for a token we cannot recognise. Defaults to 18 (BNB Chain). */
  decimalsOf?: ((token: Address) => number) | undefined
  /** Copy for a rule. Defaults to a generated description. */
  labelOf?: ((permission: CallPermission, index: number) => string) | undefined
}

function defaultRuleLabel(permission: CallPermission): string {
  const to = 'to' in permission ? permission.to : undefined
  const signature = 'signature' in permission ? permission.signature : undefined
  if (to && signature) return `${signature} on ${shortAddress(to)}`
  if (signature) return `${signature} on any contract`
  return `Any call to ${shortAddress(to as Address)}`
}

/**
 * The inverse of `toAltanaPermissions`, for reading a session that came back
 * from storage or from someone else's grant.
 *
 * Lossy by construction: Altana stores no labels and no decimals, so those
 * come from `ctx` (or sensible BNB Chain defaults). Everything that is
 * enforced on-chain round-trips exactly.
 */
export function fromAltanaPermissions(
  permissions: SessionPermissions,
  ctx: PolicyReconstruction,
): AgentPolicy {
  const labelOf = ctx.labelOf ?? ((permission: CallPermission) => defaultRuleLabel(permission))
  const decimalsOf = ctx.decimalsOf ?? ((token: Address) => knownDecimals(token) ?? 18)

  const calls: CallRule[] = (permissions.calls ?? []).map((permission, index) => {
    const to = 'to' in permission ? permission.to : undefined
    const signature = 'signature' in permission ? permission.signature : undefined
    return {
      ...(to ? { to } : {}),
      ...(signature ? { signature } : {}),
      label: labelOf(permission, index),
    }
  })

  const spend: SpendCap[] = (permissions.spend ?? []).map((permission) => {
    const token = permission.token ?? NATIVE_TOKEN
    if (permission.period !== 'day' && permission.period !== 'hour') {
      throw new Error(
        `Hallmark policies only use 'day' and 'hour' spend periods; got '${permission.period}'.`,
      )
    }
    return {
      token,
      limitAtomic: permission.limit,
      decimals: decimalsOf(token),
      period: permission.period,
    }
  })

  return { label: ctx.label, calls, spend, expiresAt: ctx.expiresAt }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function formatAmount(cap: SpendCap): string {
  return `${formatUnits(cap.limitAtomic, cap.decimals)} ${tokenSymbol(cap.token)}`
}

/**
 * Every mistake we know how to catch before a grant costs the user gas.
 *
 * Not a linter for taste — each entry below is a way we have actually seen a
 * session key end up either useless or dangerous.
 */
export function validatePolicy(
  policy: AgentPolicy,
  opts: { now?: number | undefined } = {},
): PolicyValidation {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const problems: string[] = []

  if (!policy.label.trim()) problems.push('Policy has no label; the control panel needs one.')

  // --- calls ---------------------------------------------------------------
  if (policy.calls.length === 0) {
    problems.push(
      'No call rules: Altana reads an empty allowlist as "any contract". ' +
        'The session would be bounded only by its spend caps.',
    )
  }
  policy.calls.forEach((rule, i) => {
    if (!rule.to && !rule.signature) {
      problems.push(`Call rule ${i} ("${rule.label}") sets neither a contract nor a signature.`)
    }
    if (!rule.label.trim()) {
      problems.push(`Call rule ${i} has no label; every rule needs copy a user can read.`)
    }
    if (rule.signature && !/^[A-Za-z_]\w*\(.*\)$/.test(rule.signature)) {
      problems.push(
        `Call rule ${i} ("${rule.label}") has signature "${rule.signature}", ` +
          'which is not a `name(type,type)` function signature.',
      )
    }
  })
  const seenRules = new Set<string>()
  for (const rule of policy.calls) {
    const fingerprint = `${rule.to?.toLowerCase() ?? '*'}|${rule.signature ?? '*'}`
    if (seenRules.has(fingerprint)) {
      problems.push(`Duplicate call rule: ${rule.label}.`)
    }
    seenRules.add(fingerprint)
  }

  // --- expiry --------------------------------------------------------------
  if (!Number.isInteger(policy.expiresAt)) {
    problems.push(`expiresAt must be whole unix seconds; got ${policy.expiresAt}.`)
  } else if (policy.expiresAt >= MILLISECOND_TIMESTAMP_FLOOR) {
    problems.push(
      `expiresAt is ${policy.expiresAt}, which looks like milliseconds. Altana takes ` +
        'whole unix seconds — divide by 1000, or the "expiry" lands tens of thousands ' +
        'of years out and bounds nothing.',
    )
  } else if (policy.expiresAt <= now) {
    problems.push(
      `Expiry ${new Date(policy.expiresAt * 1000).toISOString()} is in the past; ` +
        'the session would be dead on arrival.',
    )
  } else if (policy.expiresAt - now > MAX_POLICY_TTL_SECONDS) {
    const days = Math.round((policy.expiresAt - now) / 86_400)
    problems.push(
      `Expiry is ${days} days out. Anything past ${MAX_POLICY_TTL_SECONDS / 86_400} days ` +
        'is not a time bound, it is a permanent grant with extra steps.',
    )
  }

  // --- spend ---------------------------------------------------------------
  if (policy.spend.length === 0) {
    problems.push('No spend caps: the session would have no spending bound at all.')
  }

  const seenTokens = new Set<string>()
  for (const cap of policy.spend) {
    const symbol = tokenSymbol(cap.token)

    if (seenTokens.has(cap.token.toLowerCase())) {
      problems.push(`Two spend caps for ${symbol}; keep one per token.`)
    }
    seenTokens.add(cap.token.toLowerCase())

    if (!Number.isInteger(cap.decimals) || cap.decimals < 0 || cap.decimals > 36) {
      problems.push(`Spend cap for ${symbol} declares implausible decimals: ${cap.decimals}.`)
      continue
    }

    if (cap.limitAtomic <= 0n) {
      problems.push(
        `Spend cap for ${symbol} is ${cap.limitAtomic}. A zero cap is not "no spending", ` +
          'it is a session that can never execute — relay fees come out of the cap too.',
      )
      continue
    }

    const declared = knownDecimals(cap.token)
    if (declared !== undefined && declared !== cap.decimals) {
      problems.push(
        `${symbol} has ${declared} decimals on BNB Chain, but the cap declares ` +
          `${cap.decimals}. Amounts are off by 10^${Math.abs(declared - cap.decimals)}.`,
      )
      continue
    }

    // The 6-vs-18 trap: an amount sized for 6-decimal USDC dropped into an
    // 18-decimal field. 100 USDT written as 100_000_000n caps the agent at one
    // ten-billionth of a token, and every payment fails against a limit that
    // reads as generous.
    const oneToken = 10n ** BigInt(cap.decimals)
    const dust = oneToken / 1000n
    if (cap.decimals >= 18 && cap.limitAtomic < dust) {
      if (cap.limitAtomic >= 10n ** 4n) {
        const asSixDecimals = formatUnits(cap.limitAtomic, 6)
        problems.push(
          `Spend cap for ${symbol} is ${formatAmount(cap)} — that looks like ` +
            `${asSixDecimals} written for a 6-decimal token. On BNB Chain ${symbol} ` +
            `has ${cap.decimals} decimals; multiply the limit by 10^${cap.decimals - 6}.`,
        )
      } else {
        problems.push(
          `Spend cap for ${symbol} is ${formatAmount(cap)}, which is dust. ` +
            'Check the decimals the amount was written against.',
        )
      }
      continue
    }

    if (isNativeToken(cap.token) && cap.limitAtomic < MIN_NATIVE_CAP_WEI) {
      problems.push(
        `Native cap is ${formatAmount(cap)}. Relay fees are charged against it ` +
          `(~${formatUnits(OBSERVED_KEYSTORE_FEE_WEI, 18)} BNB per Keystore call), so a cap ` +
          'this small produces a session the relay rejects before inclusion.',
      )
    }
  }

  if (policy.spend.length > 0 && !policy.spend.some((cap) => isNativeToken(cap.token))) {
    problems.push(
      'No native (BNB) spend cap. Relay fees are paid in BNB, so this policy puts no ' +
        'bound on the gas the agent can burn — add a native cap with fee headroom.',
    )
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems }
}

// ---------------------------------------------------------------------------
// Human copy
// ---------------------------------------------------------------------------

function humanDuration(seconds: number): string {
  if (seconds <= 0) return 'already expired'
  const days = Math.floor(seconds / 86_400)
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`
  const hours = Math.floor(seconds / 3_600)
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`
  const minutes = Math.max(1, Math.floor(seconds / 60))
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * Plain-English lines for the control panel. One claim per line, phrased so it
 * can be read out loud in a demo without a translation layer.
 */
export function describePolicy(
  policy: AgentPolicy,
  opts: { now?: number | undefined } = {},
): string[] {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const lines: string[] = [`Scope: ${policy.label}`]

  if (policy.calls.length === 0) {
    lines.push('Can call: any contract — this policy sets no allowlist.')
  } else {
    for (const rule of policy.calls) {
      const where = rule.to ? ` (${shortAddress(rule.to)})` : ' (any contract)'
      const what = rule.signature ? `, only \`${rule.signature}\`` : ''
      lines.push(`Can call: ${rule.label}${where}${what}`)
    }
  }

  if (policy.spend.length === 0) {
    lines.push('Can spend: unbounded — this policy sets no cap.')
  } else {
    for (const cap of policy.spend) {
      const fees = isNativeToken(cap.token) ? ' (relay fees come out of this too)' : ''
      lines.push(`Can spend: up to ${formatAmount(cap)} per ${cap.period}${fees}`)
    }
  }

  lines.push(
    `Expires: ${new Date(policy.expiresAt * 1000).toISOString()} ` +
      `(${humanDuration(policy.expiresAt - now)} from now)`,
  )
  lines.push(
    policy.calls.length > 0
      ? 'Cannot: hold your funds, or act on anything outside the list above.'
      : 'Cannot: hold your funds. Everything else is only bounded by the caps above.',
  )
  lines.push('Revocable: one transaction, effective immediately, provable on-chain.')

  return lines
}

// ---------------------------------------------------------------------------
// Ready-made policies for Hallmark's four agent categories
// ---------------------------------------------------------------------------

export type AgentCategory =
  | 'pancake-rebalance'
  | 'pancake-grid'
  | 'yield-routing'
  | 'venus-health-factor'

export type PolicyBuilderOptions = {
  /** Absolute expiry, unix seconds. Wins over `ttlSeconds`. */
  expiresAt?: number | undefined
  /** Lifetime from `now`. Default 7 days. */
  ttlSeconds?: number | undefined
  /** Injectable clock, unix seconds. */
  now?: number | undefined
  /** Override the generated label. */
  label?: string | undefined
  /** Stablecoin cap, atomic units. Default 250 tokens at 18 decimals. */
  stableCapAtomic?: bigint | undefined
  /** Override the stablecoin. Defaults to USDT (56) / $U (97). */
  stableToken?: Address | undefined
  /** Native cap, wei. Default 0.05 BNB — trading headroom plus relay fees. */
  nativeCapWei?: bigint | undefined
  period?: ('day' | 'hour') | undefined
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60
const DEFAULT_STABLE_CAP = 250n * 10n ** 18n
const DEFAULT_NATIVE_CAP = 5n * 10n ** 16n // 0.05 BNB

function baseCaps(chainId: number, opts: PolicyBuilderOptions): SpendCap[] {
  const protocols = getProtocols(chainId)
  const period = opts.period ?? 'day'
  const stable = opts.stableToken ?? protocols.defaultStable
  return [
    {
      token: stable,
      limitAtomic: opts.stableCapAtomic ?? DEFAULT_STABLE_CAP,
      decimals: knownDecimals(stable) ?? 18,
      period,
    },
    {
      token: NATIVE_TOKEN,
      limitAtomic: opts.nativeCapWei ?? DEFAULT_NATIVE_CAP,
      decimals: 18,
      period,
    },
  ]
}

function expiryFrom(opts: PolicyBuilderOptions): number {
  if (opts.expiresAt !== undefined) return opts.expiresAt
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  return now + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS)
}

/**
 * Keep an existing PancakeSwap v3 position in range.
 *
 * Scoped to contracts rather than selectors on purpose: the v3 periphery routes
 * almost everything through `multicall(bytes[])`, so a selector allowlist here
 * would block the ordinary path while blocking nothing an attacker would use.
 */
export function pancakeRebalancePolicy(
  chainId: number,
  opts: PolicyBuilderOptions = {},
): AgentPolicy {
  const network = getAltanaNetwork(chainId)
  const { pancake } = getProtocols(chainId)
  return {
    label: opts.label ?? `PancakeSwap v3 rebalancing on ${network.name}`,
    calls: [
      { to: pancake.positionManager, label: 'PancakeSwap v3 position manager' },
      { to: pancake.swapRouter, label: 'PancakeSwap v3 swap router' },
    ],
    spend: baseCaps(chainId, opts),
    expiresAt: expiryFrom(opts),
  }
}

/** Run a grid: repeated swaps inside a band. Router only — no LP lifecycle. */
export function pancakeGridPolicy(chainId: number, opts: PolicyBuilderOptions = {}): AgentPolicy {
  const network = getAltanaNetwork(chainId)
  const { pancake } = getProtocols(chainId)
  return {
    label: opts.label ?? `PancakeSwap grid trading on ${network.name}`,
    calls: [{ to: pancake.swapRouter, label: 'PancakeSwap v3 swap router' }],
    spend: baseCaps(chainId, opts),
    expiresAt: expiryFrom(opts),
  }
}

/**
 * Move idle capital between lending venues.
 *
 * Aave's BNB Chain market is mainnet-only, so chain 97 gets the Venus legs
 * alone rather than a placeholder address.
 */
export function yieldRoutingPolicy(chainId: number, opts: PolicyBuilderOptions = {}): AgentPolicy {
  const network = getAltanaNetwork(chainId)
  const { venus, aave } = getProtocols(chainId)
  const calls: CallRule[] = [
    { to: venus.comptroller, label: 'Venus comptroller (enter/exit markets)' },
    { to: venus.vBNB, label: 'Venus vBNB market' },
    { to: venus.vUSDT, label: 'Venus vUSDT market' },
  ]
  if (aave.pool) calls.push({ to: aave.pool, label: 'Aave V3 pool' })
  return {
    label: opts.label ?? `Yield routing on ${network.name}`,
    calls,
    spend: baseCaps(chainId, opts),
    expiresAt: expiryFrom(opts),
  }
}

/**
 * Defend a Venus position's health factor.
 *
 * The narrowest of the four: only the calls that *reduce* risk. Supplying
 * collateral and repaying debt are allowed; `borrow` is not on the list, so an
 * agent granted this key cannot lever the position up, only unwind it.
 */
export function venusHealthFactorPolicy(
  chainId: number,
  opts: PolicyBuilderOptions = {},
): AgentPolicy {
  const network = getAltanaNetwork(chainId)
  const { venus } = getProtocols(chainId)
  return {
    label: opts.label ?? `Venus health-factor defence on ${network.name}`,
    calls: [
      { to: venus.comptroller, signature: 'enterMarkets(address[])', label: 'Enter Venus markets' },
      { to: venus.vBNB, signature: 'mint()', label: 'Supply BNB collateral' },
      { to: venus.vBNB, signature: 'repayBorrow()', label: 'Repay BNB debt' },
      {
        to: venus.vBNB,
        signature: 'redeemUnderlying(uint256)',
        label: 'Withdraw supplied BNB',
      },
      { to: venus.vUSDT, signature: 'mint(uint256)', label: 'Supply USDT collateral' },
      { to: venus.vUSDT, signature: 'repayBorrow(uint256)', label: 'Repay USDT debt' },
      {
        to: venus.vUSDT,
        signature: 'redeemUnderlying(uint256)',
        label: 'Withdraw supplied USDT',
      },
    ],
    spend: baseCaps(chainId, opts),
    expiresAt: expiryFrom(opts),
  }
}

/** Every category, so the UI can enumerate rather than hard-code. */
export const POLICY_BUILDERS: Record<
  AgentCategory,
  (chainId: number, opts?: PolicyBuilderOptions) => AgentPolicy
> = {
  'pancake-rebalance': pancakeRebalancePolicy,
  'pancake-grid': pancakeGridPolicy,
  'yield-routing': yieldRoutingPolicy,
  'venus-health-factor': venusHealthFactorPolicy,
}

export function buildPolicy(
  category: AgentCategory,
  chainId: number,
  opts: PolicyBuilderOptions = {},
): AgentPolicy {
  return POLICY_BUILDERS[category](chainId, opts)
}
