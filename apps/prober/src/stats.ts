/**
 * Aggregates over stored runs. This is the number the pitch rests on, so it is
 * computed from the same records the evidence bundles were built from and
 * nothing is smoothed: an agent with zero contactable endpoints is counted,
 * loudly, in `noEndpoints`.
 */

import { FAILURE_CLASSES } from './types.ts'
import type { FailureClass } from './types.ts'
import { percentile } from './score.ts'
import { declaresMachineProtocol } from './tags.ts'
import type { RunRecord } from './store.ts'

export type LatencyStats = {
  count: number
  p50: number
  p75: number
  p90: number
  p95: number
  p99: number
  max: number
}

export type SweepStats = {
  chains: number[]
  agents: number
  /** The identity record exists but the registration file did not parse or resolve. */
  brokenCard: number
  /** Card parsed, but declared nothing reachable over http(s). */
  noEndpoints: number
  /** At least one declared endpoint answered. */
  reachable: number
  /** Every scoreable endpoint answered. */
  fullyReachable: number
  /** At least one endpoint answered *and* spoke its declared protocol. */
  protocolConformant: number
  /**
   * The strict metric, and the one Hallmark quotes publicly: at least one
   * endpoint is a working agent protocol — an A2A card with a non-empty
   * `skills` array, an MCP server that enumerated tools, or a decodable x402
   * challenge. A `web` face returning HTML never counts.
   */
  protocolLiveAgents: number
  /** Agents that declare a machine-callable protocol at all. The funnel's denominator. */
  declaringAgents: number
  /** How many of the live agents were live via each protocol. */
  protocolLiveByKind: Record<string, number>
  /** Distinct hostnames serving a live agent protocol. */
  protocolLiveHosts: string[]
  endpoints: { declared: number; scoreable: number; answered: number; protocolOk: number }
  failures: Record<FailureClass, number>
  kinds: Record<string, number>
  capabilities: {
    agentsWithMcpTools: number
    mcpToolsSeen: number
    agentsWithA2ASkills: number
    a2aSkillsSeen: number
    agentsWithX402: number
  }
  latencyMs: LatencyStats
  score: { mean: number; p50: number; buckets: Record<string, number> }
}

const SCORE_BUCKETS = ['0', '1-24', '25-49', '50-74', '75-89', '90-100'] as const

function hostOf(endpoint: string | null): string | null {
  if (endpoint === null) return null
  try {
    return new URL(endpoint).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function computeStats(records: RunRecord[]): SweepStats {
  const failures = Object.fromEntries(FAILURE_CLASSES.map((c) => [c, 0])) as Record<FailureClass, number>
  const kinds: Record<string, number> = {}
  const buckets = Object.fromEntries(SCORE_BUCKETS.map((b) => [b, 0])) as Record<string, number>

  const chains = new Set<number>()
  const latencies: number[] = []
  const scores: number[] = []

  let brokenCard = 0
  let noEndpoints = 0
  let reachable = 0
  let fullyReachable = 0
  let protocolConformant = 0
  let protocolLiveAgents = 0
  let declaringAgents = 0
  const protocolLiveByKind: Record<string, number> = {}
  const liveHosts = new Set<string>()
  let declared = 0
  let scoreable = 0
  let answered = 0
  let protocolOk = 0
  let agentsWithMcpTools = 0
  let mcpToolsSeen = 0
  let agentsWithA2ASkills = 0
  let a2aSkillsSeen = 0
  let agentsWithX402 = 0

  for (const record of records) {
    chains.add(record.chainId)
    scores.push(record.score)
    buckets[bucketFor(record.score)] = (buckets[bucketFor(record.score)] ?? 0) + 1

    if (record.cardError !== null) brokenCard += 1
    if (record.scoredCount === 0) noEndpoints += 1
    if (record.okCount > 0) reachable += 1
    if (record.scoredCount > 0 && record.okCount === record.scoredCount) fullyReachable += 1
    if (record.protocolOkCount > 0) protocolConformant += 1
    if (declaresMachineProtocol(record)) declaringAgents += 1
    if (record.protocolLive) {
      protocolLiveAgents += 1
      for (const kind of record.protocolLiveKinds) {
        protocolLiveByKind[kind] = (protocolLiveByKind[kind] ?? 0) + 1
      }
      const host = hostOf(record.primaryEndpoint)
      if (host !== null) liveHosts.add(host)
    }

    declared += record.endpointCount
    scoreable += record.scoredCount
    answered += record.okCount
    protocolOk += record.protocolOkCount

    for (const [name, count] of Object.entries(record.failures)) {
      if (isFailureKey(name)) failures[name] += count ?? 0
    }
    for (const kind of record.kinds) kinds[kind] = (kinds[kind] ?? 0) + 1

    latencies.push(...record.latencies)

    if (record.mcpTools > 0) {
      agentsWithMcpTools += 1
      mcpToolsSeen += record.mcpTools
    }
    if (record.a2aSkills > 0) {
      agentsWithA2ASkills += 1
      a2aSkillsSeen += record.a2aSkills
    }
    if (record.x402) agentsWithX402 += 1
  }

  return {
    chains: [...chains].sort((a, b) => a - b),
    agents: records.length,
    brokenCard,
    noEndpoints,
    reachable,
    fullyReachable,
    protocolConformant,
    protocolLiveAgents,
    declaringAgents,
    protocolLiveByKind,
    protocolLiveHosts: [...liveHosts].sort(),
    endpoints: { declared, scoreable, answered, protocolOk },
    failures,
    kinds,
    capabilities: {
      agentsWithMcpTools,
      mcpToolsSeen,
      agentsWithA2ASkills,
      a2aSkillsSeen,
      agentsWithX402,
    },
    latencyMs: {
      count: latencies.length,
      p50: Math.round(percentile(latencies, 50)),
      p75: Math.round(percentile(latencies, 75)),
      p90: Math.round(percentile(latencies, 90)),
      p95: Math.round(percentile(latencies, 95)),
      p99: Math.round(percentile(latencies, 99)),
      max: latencies.length === 0 ? 0 : Math.max(...latencies),
    },
    score: {
      mean: scores.length === 0 ? 0 : Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
      p50: Math.round(percentile(scores, 50)),
      buckets,
    },
  }
}

/** Human-readable block, used by `stats` and by the end of `sweep`. */
export function formatStats(stats: SweepStats): string {
  const lines: string[] = []
  const pct = (n: number, d: number) => (d === 0 ? '  0.0%' : `${((100 * n) / d).toFixed(1).padStart(5)}%`)

  lines.push(`agents probed            ${stats.agents}`)
  lines.push(
    `  PROTOCOL-LIVE (strict)  ${String(stats.protocolLiveAgents).padStart(5)}  ${pct(stats.protocolLiveAgents, stats.agents)}   ${pct(stats.protocolLiveAgents, stats.declaringAgents).trim()} of the ${stats.declaringAgents} that declare one`,
  )
  lines.push(`  reachable (>=1 ok)     ${String(stats.reachable).padStart(6)}  ${pct(stats.reachable, stats.agents)}`)
  lines.push(
    `  fully reachable        ${String(stats.fullyReachable).padStart(6)}  ${pct(stats.fullyReachable, stats.agents)}`,
  )
  lines.push(
    `  protocol conformant    ${String(stats.protocolConformant).padStart(6)}  ${pct(stats.protocolConformant, stats.agents)}`,
  )
  lines.push(
    `  no contactable endpoint${String(stats.noEndpoints).padStart(6)}  ${pct(stats.noEndpoints, stats.agents)}`,
  )
  lines.push(`  unparseable card       ${String(stats.brokenCard).padStart(6)}  ${pct(stats.brokenCard, stats.agents)}`)
  lines.push('')
  lines.push(
    `endpoints declared ${stats.endpoints.declared}, scoreable ${stats.endpoints.scoreable}, answered ${stats.endpoints.answered} (${pct(stats.endpoints.answered, stats.endpoints.scoreable).trim()}), protocol-ok ${stats.endpoints.protocolOk}`,
  )
  lines.push('')
  lines.push(
    `protocol-live by kind  ${Object.entries(stats.protocolLiveByKind).map(([k, v]) => `${k} ${v}`).join('  ') || '(none)'}`,
  )
  lines.push(
    `protocol-live hosts    ${stats.protocolLiveHosts.length}${stats.protocolLiveHosts.length === 0 ? '' : `: ${stats.protocolLiveHosts.slice(0, 12).join(', ')}${stats.protocolLiveHosts.length > 12 ? ', …' : ''}`}`,
  )
  lines.push('')
  lines.push('failure breakdown')
  const failureRows = Object.entries(stats.failures)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
  if (failureRows.length === 0) lines.push('  (none)')
  for (const [name, count] of failureRows) {
    lines.push(`  ${name.padEnd(20)} ${String(count).padStart(6)}  ${pct(count, stats.endpoints.declared)}`)
  }
  lines.push('')
  lines.push('endpoint kinds declared')
  for (const [kind, count] of Object.entries(stats.kinds).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${kind.padEnd(20)} ${String(count).padStart(6)}`)
  }
  lines.push('')
  lines.push(
    `capabilities  mcp-tools ${stats.capabilities.agentsWithMcpTools} agents / ${stats.capabilities.mcpToolsSeen} tools   a2a-skills ${stats.capabilities.agentsWithA2ASkills} agents / ${stats.capabilities.a2aSkillsSeen} skills   x402 ${stats.capabilities.agentsWithX402} agents`,
  )
  lines.push(
    `latency (ms)  n=${stats.latencyMs.count}  p50 ${stats.latencyMs.p50}  p75 ${stats.latencyMs.p75}  p90 ${stats.latencyMs.p90}  p95 ${stats.latencyMs.p95}  p99 ${stats.latencyMs.p99}  max ${stats.latencyMs.max}`,
  )
  lines.push(`score         mean ${stats.score.mean}  p50 ${stats.score.p50}`)
  for (const bucket of SCORE_BUCKETS) {
    lines.push(`  ${bucket.padEnd(20)} ${String(stats.score.buckets[bucket] ?? 0).padStart(6)}`)
  }
  return lines.join('\n')
}

function bucketFor(score: number): string {
  if (score <= 0) return '0'
  if (score < 25) return '1-24'
  if (score < 50) return '25-49'
  if (score < 75) return '50-74'
  if (score < 90) return '75-89'
  return '90-100'
}

function isFailureKey(name: string): name is FailureClass {
  return (FAILURE_CLASSES as readonly string[]).includes(name)
}
