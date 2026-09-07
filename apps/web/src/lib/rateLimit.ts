import 'server-only'

/**
 * A small in-memory rate limiter for the sponsored hire.
 *
 * In-memory is a deliberate limitation, not an oversight: this project keeps
 * no database, and standing one up to count clicks would be a worse trade than
 * accepting that a limiter resets when the process does. On a serverless
 * deployment each instance counts separately, so the real ceiling is the
 * sponsor wallet's balance — which is the actual, hard limit and the one worth
 * relying on. This exists to stop the ordinary case of one person clicking a
 * button repeatedly.
 *
 * Said out loud in the UI too, because a limit you cannot enforce and imply
 * you can is worse than no limit.
 */

type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()
const WINDOW_MS = 60 * 60 * 1000

/** Drop expired buckets so a long-lived process does not grow without bound. */
function sweep(now: number): void {
  if (buckets.size < 512) return
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

export type RateVerdict =
  | { allowed: true; remaining: number; resetAt: number }
  | { allowed: false; remaining: 0; resetAt: number; retryAfterSeconds: number }

export function consume(key: string, limit: number): RateVerdict {
  const now = Date.now()
  sweep(now)

  const existing = buckets.get(key)
  if (existing === undefined || existing.resetAt <= now) {
    const bucket = { count: 1, resetAt: now + WINDOW_MS }
    buckets.set(key, bucket)
    return { allowed: true, remaining: limit - 1, resetAt: bucket.resetAt }
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: existing.resetAt,
      retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000),
    }
  }

  existing.count += 1
  return { allowed: true, remaining: limit - existing.count, resetAt: existing.resetAt }
}

/**
 * A caller identity for rate limiting.
 *
 * `x-forwarded-for` is client-controllable in general, but on Vercel the
 * platform overwrites it at the edge, so the leftmost entry is the real peer.
 * Anywhere else this degrades to a shared bucket, which fails closed rather
 * than open.
 */
export function callerKey(headers: Headers, prefix: string): string {
  const forwarded = headers.get('x-forwarded-for')
  const ip =
    forwarded?.split(',')[0]?.trim() ??
    headers.get('x-real-ip') ??
    headers.get('cf-connecting-ip') ??
    'unknown'
  return `${prefix}:${ip}`
}
