/**
 * Formatting. Shared by server and client, so nothing in here may depend on
 * `window`, and every function must produce identical output on both sides —
 * a locale-sensitive formatter would hydrate differently to how it rendered.
 * Hence the explicit 'en-GB' + UTC everywhere.
 */

const NUMBER = new Intl.NumberFormat('en-GB')
const COMPACT = new Intl.NumberFormat('en-GB', {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
})
const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' })

export function formatNumber(value: number | bigint): string {
  return NUMBER.format(value)
}

/** "307,740" becomes "307.7k". For headline figures only — tables get exact. */
export function formatCompact(value: number | bigint): string {
  return COMPACT.format(value)
}

export function formatDateTime(value: Date | string | number | null | undefined): string {
  const date = toDate(value)
  return date === null ? '—' : `${DATE_TIME.format(date)} UTC`
}

export function formatDate(value: Date | string | number | null | undefined): string {
  const date = toDate(value)
  return date === null ? '—' : DATE.format(date)
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null
  const date =
    value instanceof Date ? value : typeof value === 'number' ? new Date(value) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * "4 minutes ago", "in 2 days".
 *
 * Rendered on the server for the first paint and refreshed on the client by
 * <RelativeTime>, which is why this takes an explicit `now`: passing the
 * server's clock into a client re-render would produce a hydration mismatch.
 */
export function formatRelative(
  value: Date | string | number | null | undefined,
  now: number = Date.now(),
): string {
  const date = toDate(value)
  if (date === null) return 'never'

  const deltaSeconds = Math.round((date.getTime() - now) / 1000)
  const past = deltaSeconds < 0
  const abs = Math.abs(deltaSeconds)

  const [amount, unit] = pickUnit(abs)
  if (amount === 0) return 'just now'

  const plural = amount === 1 ? unit : `${unit}s`
  return past ? `${amount} ${plural} ago` : `in ${amount} ${plural}`
}

function pickUnit(seconds: number): [number, string] {
  if (seconds < 45) return [seconds < 10 ? 0 : seconds, 'second']
  if (seconds < 3_600) return [Math.round(seconds / 60), 'minute']
  if (seconds < 86_400) return [Math.round(seconds / 3_600), 'hour']
  if (seconds < 2_592_000) return [Math.round(seconds / 86_400), 'day']
  if (seconds < 31_536_000) return [Math.round(seconds / 2_592_000), 'month']
  return [Math.round(seconds / 31_536_000), 'year']
}

/** "2h 14m" — a duration, not a point in time. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const secs = Math.floor(seconds % 60)

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes > 0) return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`
  return `${secs}s`
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1_000) return `${Math.round(ms)} ms`
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`
}

/** `0x8004A1…9a432` — enough to compare against a block explorer at a glance. */
export function shortAddress(address: string | null | undefined, size = 6): string {
  if (address === null || address === undefined || address.length < size * 2 + 2) {
    return address ?? '—'
  }
  return `${address.slice(0, size)}…${address.slice(-4)}`
}

export function shortHash(hash: string | null | undefined): string {
  if (hash === null || hash === undefined) return '—'
  if (hash.length <= 18) return hash
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`
}

/**
 * Format a token amount from its atomic units.
 *
 * Deliberately not `Number(atomic) / 10 ** decimals`: on BNB Chain the
 * stablecoins are 18-decimal and that division loses precision well inside the
 * range a spend cap uses.
 */
export function formatUnitsFixed(atomic: bigint, decimals: number, maxFraction = 4): string {
  const negative = atomic < 0n
  const value = negative ? -atomic : atomic
  const base = 10n ** BigInt(decimals)
  const whole = value / base
  const fraction = value % base

  let fractionText = fraction.toString().padStart(decimals, '0').slice(0, maxFraction)
  fractionText = fractionText.replace(/0+$/, '')

  const wholeText = NUMBER.format(whole)
  const body = fractionText === '' ? wholeText : `${wholeText}.${fractionText}`
  return negative ? `-${body}` : body
}

/** Percentage of a cap that has been consumed, clamped to 0…100. */
export function percentOf(used: bigint, cap: bigint): number {
  if (cap <= 0n) return 0
  const scaled = Number((used * 10_000n) / cap) / 100
  return Math.max(0, Math.min(100, scaled))
}

export function pluralise(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`)
}

/** `count + noun`, with the count formatted. "3 probes", "1 probe". */
export function countOf(count: number, singular: string, plural?: string): string {
  return `${formatNumber(count)} ${pluralise(count, singular, plural)}`
}

/**
 * Trim a description down for a table cell without cutting mid-word.
 * Returns the original when it already fits.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** Collapse whitespace so a multi-line card description sits on one row. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
