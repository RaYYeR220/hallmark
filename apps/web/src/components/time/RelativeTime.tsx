'use client'

import { useEffect, useState } from 'react'

import { formatDateTime, formatRelative } from '@/lib/format'

/**
 * "4 minutes ago", kept honest.
 *
 * The server renders the relative string against its own clock, which is
 * correct at the moment of render and drifts thereafter. This re-computes on
 * an interval so a page left open does not keep claiming a probe is fresh
 * twenty minutes after it stopped being fresh — the exact failure mode a
 * product about liveness cannot afford.
 *
 * First render matches the server output exactly (the same `serverNow` is used
 * on both sides), so there is no hydration mismatch; the interval only starts
 * after mount.
 */
export function RelativeTime({
  value,
  serverNow,
  prefix,
}: {
  /** ISO-8601 string, or null for "never". */
  value: string | null
  /** `Date.now()` as the server saw it, so the first paint agrees. */
  serverNow: number
  prefix?: string
}) {
  const [now, setNow] = useState(serverNow)

  useEffect(() => {
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(interval)
  }, [])

  if (value === null) {
    return <span title="No observation has ever been recorded">never</span>
  }

  return (
    <time dateTime={value} title={formatDateTime(value)}>
      {prefix === undefined ? '' : `${prefix} `}
      {formatRelative(value, now)}
    </time>
  )
}

/**
 * A countdown to a fixed instant. Used for session expiries, where the
 * remaining time is the safety property being displayed.
 */
export function Countdown({
  expiresAt,
  serverNow,
}: {
  /** Unix seconds. */
  expiresAt: number
  serverNow: number
}) {
  const [now, setNow] = useState(serverNow)

  useEffect(() => {
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(interval)
  }, [])

  const remaining = expiresAt - Math.floor(now / 1000)
  if (remaining <= 0) {
    return (
      <time dateTime={new Date(expiresAt * 1000).toISOString()}>
        expired {formatRelative(new Date(expiresAt * 1000).toISOString(), now)}
      </time>
    )
  }

  const days = Math.floor(remaining / 86_400)
  const hours = Math.floor((remaining % 86_400) / 3_600)
  const minutes = Math.floor((remaining % 3_600) / 60)
  const seconds = remaining % 60

  const parts =
    days > 0
      ? `${days}d ${hours}h ${minutes}m`
      : hours > 0
        ? `${hours}h ${minutes}m ${seconds}s`
        : `${minutes}m ${seconds}s`

  return (
    <time
      dateTime={new Date(expiresAt * 1000).toISOString()}
      title={formatDateTime(new Date(expiresAt * 1000))}
      className="tnum"
    >
      {parts}
    </time>
  )
}
