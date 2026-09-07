import { keccak256, toBytes } from 'viem'
import type { EvidenceBundle, EvidenceCapabilities, EvidenceScorer, ProbeResult } from './types.js'

export const SCORER_VERSION = '1.0.0'

/**
 * How a probe run turns into a 0-100 number. The weights sum to 100 and are
 * carried inside every bundle so a score can always be re-derived from the
 * evidence that produced it.
 *
 *  reachability  the share of declared endpoints that answered
 *  latency       median round-trip of the endpoints that answered
 *  mcpTools      the MCP server actually enumerated tools
 *  a2aSkills     the A2A agent card actually listed skills
 *  x402          a priced service is advertised and quoted
 */
export const SCORE_WEIGHTS = {
  reachability: 45,
  latency: 15,
  mcpTools: 15,
  a2aSkills: 15,
  x402: 10,
} as const

export const SCORER: EvidenceScorer = {
  name: 'hallmark',
  version: SCORER_VERSION,
  weights: { ...SCORE_WEIGHTS },
}

/** Latency scores full marks at or under this, zero at or over `LATENCY_FLOOR_MS`. */
const LATENCY_CEILING_MS = 200
const LATENCY_FLOOR_MS = 5_000

/**
 * Score a single endpoint probe: 60 points for answering at all, up to 40 more
 * for answering quickly. Deterministic and integral.
 */
export function scoreProbe(probe: ProbeResult): number {
  if (!probe.ok) return 0
  return 60 + Math.round(40 * latencyFactor(probe.latencyMs))
}

export type ScoreInput = {
  probe: ProbeResult[]
  capabilities: EvidenceCapabilities
}

/** Score a whole probe run using `SCORE_WEIGHTS`. */
export function scoreEvidence(input: ScoreInput): number {
  const { probe, capabilities } = input

  let total = 0
  if (probe.length > 0) {
    const ok = probe.filter((p) => p.ok)
    total += SCORE_WEIGHTS.reachability * (ok.length / probe.length)
    if (ok.length > 0) {
      total += SCORE_WEIGHTS.latency * latencyFactor(median(ok.map((p) => p.latencyMs)))
    }
  }
  if ((capabilities.mcpTools?.length ?? 0) > 0) total += SCORE_WEIGHTS.mcpTools
  if ((capabilities.a2aSkills?.length ?? 0) > 0) total += SCORE_WEIGHTS.a2aSkills
  if (capabilities.x402 !== null && capabilities.x402 !== undefined) total += SCORE_WEIGHTS.x402

  return clamp(Math.round(total), 0, 100)
}

export type EvidenceInput = {
  chainId: number
  agentId: number
  probe: ProbeResult[]
  capabilities?: EvidenceCapabilities
  probedAt?: Date | string
}

export function createEvidenceBundle(input: EvidenceInput): EvidenceBundle {
  const capabilities = input.capabilities ?? {}
  const probedAt =
    typeof input.probedAt === 'string'
      ? input.probedAt
      : (input.probedAt ?? new Date()).toISOString()

  return {
    version: 1,
    chainId: input.chainId,
    agentId: input.agentId,
    probedAt,
    probe: input.probe,
    capabilities,
    score: scoreEvidence({ probe: input.probe, capabilities }),
    scorer: { ...SCORER, weights: { ...SCORER.weights } },
  }
}

/**
 * Deterministic JSON in the style of RFC 8785: object keys sorted by UTF-16
 * code unit, no insignificant whitespace, every non-ASCII character escaped.
 * Two bundles that differ only in key order canonicalise identically.
 */
export function canonicalize(value: unknown): string {
  return serialize(value)
}

/** keccak256 over the canonical UTF-8 bytes. This is the evidence id. */
export function evidenceHash(bundle: EvidenceBundle): `0x${string}` {
  return keccak256(toBytes(canonicalize(bundle)))
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function serialize(value: unknown): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`cannot canonicalize non-finite number ${String(value)}`)
      }
      // String() already matches the ECMAScript number grammar RFC 8785 requires,
      // including -0 collapsing to "0".
      return String(value)
    case 'string':
      return quote(value)
    case 'bigint':
      throw new Error('cannot canonicalize a bigint; convert it to a string first')
    case 'object':
      break
    default:
      throw new Error(`cannot canonicalize a ${typeof value}`)
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => serialize(item === undefined ? null : item))
    return `[${items.join(',')}]`
  }

  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort(compareCodeUnits)
  const entries = keys.map((key) => `${quote(key)}:${serialize(obj[key])}`)
  return `{${entries.join(',')}}`
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

const ESCAPES: Record<number, string> = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
  0x22: '\\"',
  0x5c: '\\\\',
}

function quote(input: string): string {
  let out = '"'
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i)
    const escape = ESCAPES[code]
    if (escape !== undefined) {
      out += escape
    } else if (code < 0x20 || code > 0x7e) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else {
      out += input[i]
    }
  }
  return `${out}"`
}

function latencyFactor(latencyMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs <= LATENCY_CEILING_MS) return 1
  if (latencyMs >= LATENCY_FLOOR_MS) return 0
  return (LATENCY_FLOOR_MS - latencyMs) / (LATENCY_FLOOR_MS - LATENCY_CEILING_MS)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
