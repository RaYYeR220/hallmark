/**
 * The Hallmark liveness score.
 *
 * A number on a marketplace listing is worthless unless anyone can re-derive
 * it from the evidence, so the whole scorer is here, it is pure, and its
 * weights travel inside every evidence bundle under `scorer`. Change a weight
 * and you must bump `PROBER_SCORER_VERSION`, because an old bundle must always
 * re-derive to the number it was published with.
 *
 * ┌──────────────┬────────┬──────────────────────────────────────────────────┐
 * │ dimension    │ weight │ what it measures                                 │
 * ├──────────────┼────────┼──────────────────────────────────────────────────┤
 * │ reachability │   35   │ share of scoreable endpoints that answered       │
 * │ protocol     │   25   │ share that answered *and* spoke their protocol   │
 * │ latency      │   15   │ median round trip of the endpoints that answered │
 * │ capabilities │   15   │ MCP tools and A2A skills actually enumerated     │
 * │ x402         │   10   │ a priced service advertised and quoted           │
 * └──────────────┴────────┴──────────────────────────────────────────────────┘
 *
 * Endpoints that cannot be contacted over HTTP at all — `did:`, `mailto:`, a
 * bare ENS name — are marked `scored: false` and left out of both denominators.
 * They are still recorded; they are just not evidence of liveness either way.
 *
 * An agent with no scoreable endpoint scores 0. That is deliberate: the point
 * of this service is that "reachable" can never be vacuously true.
 */

import type { EvidenceScorer } from '@hallmark/core'
import type { EndpointProbe, ProbeCapabilities, ScoreBreakdown } from './types.ts'

export const PROBER_SCORER_VERSION = 'prober/1.0.0'

export const PROBE_WEIGHTS = {
  reachability: 35,
  protocol: 25,
  latency: 15,
  capabilities: 15,
  x402: 10,
} as const

/** Full marks at or under this round trip. */
export const LATENCY_FULL_MS = 200
/** Zero marks at or over this round trip. Linear in between. */
export const LATENCY_ZERO_MS = 5_000

/** The two capability families the score recognises, worth half the weight each. */
export const CAPABILITY_FAMILIES = ['mcpTools', 'a2aSkills'] as const

export const PROBER_SCORER: EvidenceScorer = {
  name: 'hallmark',
  version: PROBER_SCORER_VERSION,
  weights: { ...PROBE_WEIGHTS },
}

export type ScoreInput = {
  probe: EndpointProbe[]
  capabilities: ProbeCapabilities
}

export type ScoreResult = {
  score: number
  breakdown: ScoreBreakdown
}

export function scoreRun(input: ScoreInput): ScoreResult {
  const scoreable = input.probe.filter((p) => p.scored)
  const answered = scoreable.filter((p) => p.ok)
  const conformant = scoreable.filter((p) => p.protocolOk)

  const breakdown: ScoreBreakdown = {
    reachability: round2(scoreable.length === 0 ? 0 : PROBE_WEIGHTS.reachability * (answered.length / scoreable.length)),
    protocol: round2(scoreable.length === 0 ? 0 : PROBE_WEIGHTS.protocol * (conformant.length / scoreable.length)),
    latency: round2(
      answered.length === 0 ? 0 : PROBE_WEIGHTS.latency * latencyFactor(median(answered.map((p) => p.latencyMs))),
    ),
    capabilities: round2((PROBE_WEIGHTS.capabilities * capabilityCount(input.capabilities)) / CAPABILITY_FAMILIES.length),
    x402: input.capabilities.x402 === null || input.capabilities.x402 === undefined ? 0 : PROBE_WEIGHTS.x402,
  }

  // Nothing contactable was declared, so there is nothing to attest to.
  if (scoreable.length === 0) {
    const zeroed: ScoreBreakdown = { reachability: 0, protocol: 0, latency: 0, capabilities: 0, x402: 0 }
    return { score: 0, breakdown: zeroed }
  }

  const total =
    breakdown.reachability + breakdown.protocol + breakdown.latency + breakdown.capabilities + breakdown.x402

  return { score: clamp(Math.round(total), 0, 100), breakdown }
}

/**
 * Latency credit: 1.0 at or below `LATENCY_FULL_MS`, 0.0 at or above
 * `LATENCY_ZERO_MS`, linear in between.
 */
export function latencyFactor(latencyMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs <= LATENCY_FULL_MS) return 1
  if (latencyMs >= LATENCY_ZERO_MS) return 0
  return (LATENCY_ZERO_MS - latencyMs) / (LATENCY_ZERO_MS - LATENCY_FULL_MS)
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** Percentiles over a sorted-on-demand sample, used by `stats`. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p / 100) * (sorted.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  const lowValue = sorted[low] ?? 0
  if (low === high) return lowValue
  const highValue = sorted[high] ?? lowValue
  return lowValue + (highValue - lowValue) * (rank - low)
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function capabilityCount(capabilities: ProbeCapabilities): number {
  let count = 0
  for (const family of CAPABILITY_FAMILIES) {
    if ((capabilities[family]?.length ?? 0) > 0) count += 1
  }
  return count
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
