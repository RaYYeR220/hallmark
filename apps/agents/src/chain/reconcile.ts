/**
 * Two derivations, or nothing.
 *
 * The failure mode this file exists to prevent is not a crash. It is a fast,
 * fluent, confidently wrong number: a holder table with silent gaps, a
 * valuation off by a factor, a slippage figure computed against a stale spot.
 * Every one of those looks exactly like a right answer, and none of them is
 * caught by being careful.
 *
 * So: any number that drives an on-chain action is computed twice, by
 * independent routes, and the two are required to agree. A disagreement is not
 * a warning to log — it is a refusal to act, because when two derivations
 * differ we do not know which one is wrong.
 */

export type Reconciliation = {
  label: string
  /** What the two routes were. */
  primary: { source: string; value: number }
  secondary: { source: string; value: number }
  deviationBps: number
  toleranceBps: number
  agrees: boolean
  detail: string
}

function bpsBetween(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b))
  if (scale === 0) return 0
  return (Math.abs(a - b) / scale) * 10_000
}

export function reconcile(args: {
  label: string
  primary: { source: string; value: number }
  secondary: { source: string; value: number }
  toleranceBps: number
}): Reconciliation {
  const { primary, secondary, toleranceBps } = args
  const finite = Number.isFinite(primary.value) && Number.isFinite(secondary.value)
  const deviationBps = finite ? bpsBetween(primary.value, secondary.value) : Number.POSITIVE_INFINITY
  const agrees = finite && deviationBps <= toleranceBps

  return {
    label: args.label,
    primary,
    secondary,
    deviationBps,
    toleranceBps,
    agrees,
    detail: agrees
      ? `${args.label}: ${primary.source} and ${secondary.source} agree to ` +
        `${deviationBps.toFixed(1)} bps.`
      : !finite
        ? `${args.label}: one of the two derivations is not a finite number ` +
          `(${primary.source} = ${primary.value}, ${secondary.source} = ${secondary.value}). ` +
          'Refusing to act on it.'
        : `${args.label}: ${primary.source} says ${primary.value}, ${secondary.source} says ` +
          `${secondary.value} — ${deviationBps.toFixed(0)} bps apart, past the ${toleranceBps} bps ` +
          'this service will act across. One of the two is wrong and we cannot tell which.',
  }
}

/** Every check that failed, so a refusal can list all of them at once. */
export function disagreements(checks: readonly Reconciliation[]): Reconciliation[] {
  return checks.filter((check) => !check.agrees)
}

export function allAgree(checks: readonly Reconciliation[]): boolean {
  return checks.every((check) => check.agrees)
}

/**
 * A check that is not a number comparison — a count that should be complete, a
 * flag that should hold. Same contract: false means do not act.
 */
export type Assertion = {
  label: string
  holds: boolean
  detail: string
}

export function assertion(label: string, holds: boolean, detail: string): Assertion {
  return { label, holds, detail }
}

export function failedAssertions(checks: readonly Assertion[]): Assertion[] {
  return checks.filter((check) => !check.holds)
}
