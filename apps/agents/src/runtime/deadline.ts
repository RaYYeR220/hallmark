/**
 * Nothing in this service may hang.
 *
 * A face that eventually fails is recoverable; a face that never answers is
 * scored dead. Our own prober records a hang as `timeout` and marks the agent
 * offline, and so does everyone else's — so an unbounded wait is not a
 * degraded outcome, it is the worst one available.
 *
 * Every boundary therefore carries an explicit deadline: reading a request
 * body, running a skill, and the request as a whole. Each returns a *result*
 * saying what ran out of time, so the caller can answer with something a
 * client can read instead of holding the socket open.
 */

export type DeadlineResult<T> =
  | { ok: true; value: T; elapsedMs: number }
  | { ok: false; timedOut: true; label: string; timeoutMs: number }

/**
 * Race a promise against a timer.
 *
 * The underlying work is not cancelled — a promise cannot be — so the timer is
 * unref'd where the runtime supports it and the abandoned work is left to
 * settle into nothing. What matters is that the *caller* is released.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  args: { label: string; timeoutMs: number },
): Promise<DeadlineResult<T>> {
  const started = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined

  const expiry = new Promise<DeadlineResult<T>>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, timedOut: true, label: args.label, timeoutMs: args.timeoutMs }),
      args.timeoutMs,
    )
    // Do not hold the process open for a deadline nobody is waiting on.
    ;(timer as { unref?: () => void }).unref?.()
  })

  try {
    return await Promise.race([
      work.then((value): DeadlineResult<T> => ({ ok: true, value, elapsedMs: Date.now() - started })),
      expiry,
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Timeouts, all overridable, all well inside the platform's own limit. */
export type Timeouts = {
  /** Reading the request body. */
  body: number
  /** One skill invocation. */
  skill: number
  /** The whole request, including the body read and the skill. */
  request: number
}

/**
 * Defaults sized against Vercel's 60-second `maxDuration`.
 *
 * The request deadline has to fire *before* the platform kills the function,
 * or the client sees a connection drop rather than an answer that explains
 * itself. Everything else nests inside it.
 */
export const DEFAULT_TIMEOUTS: Timeouts = {
  body: 10_000,
  skill: 45_000,
  request: 50_000,
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

export function loadTimeouts(env: Record<string, string | undefined> = process.env): Timeouts {
  return {
    body: positiveInt(env['HALLMARK_BODY_TIMEOUT_MS'], DEFAULT_TIMEOUTS.body),
    skill: positiveInt(env['HALLMARK_SKILL_TIMEOUT_MS'], DEFAULT_TIMEOUTS.skill),
    request: positiveInt(env['HALLMARK_REQUEST_TIMEOUT_MS'], DEFAULT_TIMEOUTS.request),
  }
}
