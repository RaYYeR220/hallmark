/**
 * The ERC-8004 feedback tag vocabulary, typed.
 *
 * The standard's example vocabulary is not just a list of names — each tag has
 * a type, and the type constrains the `(int128 value, uint8 valueDecimals)`
 * pair the Reputation Registry stores:
 *
 *   starred             0-100
 *   reachable           bool
 *   ownerVerified       bool
 *   uptime              percent x100
 *   successRate         percent
 *   responseTime        milliseconds
 *   blocktimeFreshness  blocks
 *
 * Writing a 0-100 score into `reachable` is non-conformant. It also publishes
 * the conflation this whole service exists to refuse: `reachable` means "the
 * socket answered", and a web page answering is not an agent working. We
 * measured that difference — a 4x timeout change moves `reachable` by 448
 * agents and `protocolLive` by 1 — so the two claims go into two tags with two
 * meanings, and neither one pretends to be the other.
 *
 * What Hallmark writes per agent:
 *
 *   reachable    100 or 0. 100 = at least one declared endpoint answered.
 *   successRate  100 or 0, and ONLY for an agent that declares a machine-callable
 *                protocol. 100 = at least one of those endpoints is protocol-live
 *                by the strict rule. An agent that declares no protocol gets no
 *                successRate entry at all: there is no rate to report, and a 0
 *                there would be a slur rather than a measurement.
 *   responseTime opt-in, milliseconds, median across the endpoints that answered.
 *
 * Everything else — the graded score, the per-endpoint breakdown, the failure
 * classification, the discovered capabilities — lives in the evidence bundle,
 * which every attestation links by URI and commits to by hash. The chain
 * carries claims that are true and typed; the bundle carries the detail.
 */

import type { RunRecord } from './store.ts'

export type TagValueType = 'bool' | 'percent' | 'percent-x100' | 'millis' | 'score' | 'blocks'

export type TagSpec = {
  type: TagValueType
  valueDecimals: number
  /** Inclusive bounds on the raw `int128 value`, before decimals are applied. */
  min: bigint
  max: bigint
  description: string
}

/** The standard's own vocabulary. We do not invent tags where this has one. */
export const TAG_VOCABULARY = {
  reachable: {
    type: 'bool',
    valueDecimals: 0,
    min: 0n,
    max: 100n,
    description: 'at least one declared endpoint answered',
  },
  ownerVerified: {
    type: 'bool',
    valueDecimals: 0,
    min: 0n,
    max: 100n,
    description: 'the declared owner was verified',
  },
  successRate: {
    type: 'percent',
    valueDecimals: 0,
    min: 0n,
    max: 100n,
    description: 'share of attempts that succeeded',
  },
  uptime: {
    type: 'percent-x100',
    valueDecimals: 2,
    min: 0n,
    max: 10_000n,
    description: 'availability as a percent scaled by 100',
  },
  responseTime: {
    type: 'millis',
    valueDecimals: 0,
    min: 0n,
    max: 3_600_000n,
    description: 'round trip in milliseconds',
  },
  starred: {
    type: 'score',
    valueDecimals: 0,
    min: 0n,
    max: 100n,
    description: 'a graded 0-100 rating',
  },
  blocktimeFreshness: {
    type: 'blocks',
    valueDecimals: 0,
    min: 0n,
    max: 1_000_000_000n,
    description: 'staleness in blocks',
  },
} as const satisfies Record<string, TagSpec>

export type FeedbackTag = keyof typeof TAG_VOCABULARY

export const ALL_TAGS = Object.keys(TAG_VOCABULARY) as FeedbackTag[]

/** The tags Hallmark writes unless told otherwise. */
export const DEFAULT_TAGS: FeedbackTag[] = ['reachable', 'successRate']

/** Stamped as `tag2` on every entry so Hallmark's writes are filterable. */
export const HALLMARK_TAG = 'hallmark'

/** A boolean tag is written as 100 for true and 0 for false, never anything else. */
export const BOOL_TRUE = 100n
export const BOOL_FALSE = 0n

export type EncodedFeedback = {
  tag1: FeedbackTag
  value: bigint
  valueDecimals: number
  /** Why this value, in one line, for the dry-run plan. */
  reason: string
}

export class TagValueError extends Error {
  readonly tag: string
  readonly value: bigint

  constructor(message: string, tag: string, value: bigint) {
    super(message)
    this.name = 'TagValueError'
    this.tag = tag
    this.value = value
  }
}

export function isKnownTag(tag: string): tag is FeedbackTag {
  return Object.prototype.hasOwnProperty.call(TAG_VOCABULARY, tag)
}

function specFor(tag: FeedbackTag): TagSpec {
  return TAG_VOCABULARY[tag]
}

/** Case-insensitive, so `--tags responsetime` resolves to `responseTime`. */
export function resolveTag(input: string): FeedbackTag {
  const trimmed = input.trim()
  if (isKnownTag(trimmed)) return trimmed
  const lowered = trimmed.toLowerCase()
  for (const known of ALL_TAGS) {
    if (known.toLowerCase() === lowered) return known
  }
  throw new TagValueError(
    `unknown feedback tag "${input}"; the ERC-8004 vocabulary is ${ALL_TAGS.join(', ')}`,
    input,
    0n,
  )
}

/**
 * Hard-fail a value that violates its tag's type. This throws rather than
 * warns on purpose: a warning would still let a non-conformant attestation
 * reach the chain, and the chain is not somewhere you can take it back.
 */
export function assertTagValue(tag: FeedbackTag, value: bigint, valueDecimals: number): void {
  if (!isKnownTag(tag)) {
    throw new TagValueError(`unknown feedback tag "${String(tag)}"`, String(tag), value)
  }
  const spec = specFor(tag)
  if (valueDecimals !== spec.valueDecimals) {
    throw new TagValueError(
      `tag "${tag}" is ${spec.type} and requires valueDecimals ${spec.valueDecimals}, got ${valueDecimals}`,
      tag,
      value,
    )
  }
  if (spec.type === 'bool' && value !== BOOL_TRUE && value !== BOOL_FALSE) {
    throw new TagValueError(
      `tag "${tag}" is a boolean in the ERC-8004 vocabulary; its value must be ${BOOL_TRUE} (true) or ${BOOL_FALSE} (false), got ${value}`,
      tag,
      value,
    )
  }
  if (value < spec.min || value > spec.max) {
    throw new TagValueError(
      `tag "${tag}" is ${spec.type}; its value must be within ${spec.min}..${spec.max}, got ${value}`,
      tag,
      value,
    )
  }
}

/** Endpoint kinds that claim a machine-callable agent protocol. */
export const MACHINE_CALLABLE_KINDS = new Set(['a2a', 'mcp', 'x402', 'oasf'])

export function declaresMachineProtocol(record: Pick<RunRecord, 'kinds'>): boolean {
  return record.kinds.some((kind) => MACHINE_CALLABLE_KINDS.has(kind))
}

/**
 * Whether `successRate` has anything to say about this agent.
 *
 * True when the agent declares a machine-callable protocol — or when one of its
 * endpoints turned out to speak one regardless of how the card labelled it. An
 * agent that lists an endpoint as `web` and then answers with a valid x402
 * challenge has demonstrably got a working protocol, and withholding the
 * positive attestation because its own card was badly labelled would punish it
 * for someone else's tagging. Evidence beats the label; the label alone never
 * beats the absence of evidence.
 */
export function hasSuccessRate(record: Pick<RunRecord, 'kinds' | 'protocolLive'>): boolean {
  return declaresMachineProtocol(record) || record.protocolLive
}

/**
 * What this run lets us claim about an agent.
 *
 *   positive      a declared protocol demonstrably works
 *   negative      it declares one and does not speak it — the informative case
 *   unreachable   it declared endpoints and none of them answered at all
 *   inapplicable  nothing contactable was declared, so we tried nothing and
 *                 have nothing to say
 *
 * `negative` and `unreachable` are the half of the distribution that a
 * marketplace actually needs and that an optimistic publisher never writes.
 */
export type Verdict = 'positive' | 'negative' | 'unreachable' | 'reachable-only' | 'inapplicable'

export const VERDICTS: Verdict[] = ['positive', 'negative', 'unreachable', 'reachable-only', 'inapplicable']

export function verdictOf(record: Pick<RunRecord, 'kinds' | 'protocolLive' | 'okCount' | 'scoredCount'>): Verdict {
  // Nothing contactable was declared, so we tried nothing.
  if (record.scoredCount === 0) return 'inapplicable'
  if (record.protocolLive) return 'positive'
  // Declared endpoints, none answered: `reachable: 0` is a true claim whether
  // or not it named a protocol.
  if (record.okCount === 0) return 'unreachable'
  if (declaresMachineProtocol(record)) return 'negative'
  return 'reachable-only'
}

/** The verdicts a default publish run draws from. */
export const DEFAULT_PUBLISH_VERDICTS: Verdict[] = ['positive', 'negative', 'unreachable']

/** Which side of the ledger a verdict sits on, for `--verdict positive|negative|both`. */
export function verdictSide(verdict: Verdict): 'positive' | 'negative' | 'neither' {
  if (verdict === 'positive') return 'positive'
  if (verdict === 'negative' || verdict === 'unreachable') return 'negative'
  return 'neither'
}

/**
 * Encode one tag from a probe run.
 *
 * Returns `null` when the tag does not apply to this agent — which is not a
 * failure, it is the whole point of `successRate` not being written for an
 * agent that declares nothing callable.
 */
export function encodeTag(record: RunRecord, tag: FeedbackTag): EncodedFeedback | null {
  switch (tag) {
    case 'reachable': {
      // Nothing contactable was declared, so we never tried, so we have no
      // business saying anything. `reachable: 0` here would describe our own
      // inaction as the agent's failure.
      if (record.scoredCount === 0) return null
      const answered = record.okCount > 0
      return finish(tag, answered ? BOOL_TRUE : BOOL_FALSE, 0, answered
        ? `${record.okCount}/${record.scoredCount} declared endpoints answered`
        : `none of the ${record.scoredCount} declared endpoints answered`)
    }

    case 'successRate': {
      if (!hasSuccessRate(record)) return null
      const live = record.protocolLive
      return finish(tag, live ? 100n : 0n, 0, live
        ? `protocol-live via ${record.protocolLiveKinds.join(', ')}`
        : 'declares a machine-callable protocol; none of those endpoints spoke it')
    }

    case 'responseTime': {
      if (record.latencies.length === 0) return null
      const value = BigInt(Math.round(medianOf(record.latencies)))
      return finish(tag, value, 0, `median of ${record.latencies.length} answering endpoints`)
    }

    case 'uptime': {
      if (record.scoredCount === 0) return null
      const share = record.okCount / record.scoredCount
      return finish(tag, BigInt(Math.round(share * 10_000)), 2, `${record.okCount}/${record.scoredCount} endpoints answered`)
    }

    case 'starred': {
      return finish(tag, BigInt(clampInt(record.score, 0, 100)), 0, `Hallmark score ${record.score}/100`)
    }

    default:
      // A vocabulary tag we recognise but have no measurement for. Refusing is
      // better than inventing a number to fill it.
      throw new TagValueError(`hallmark-probe measures nothing that maps onto "${tag}"`, tag, 0n)
  }
}

/** Every applicable tag for this agent, in the order they will be written. */
export function planFeedbackTags(record: RunRecord, tags: FeedbackTag[] = DEFAULT_TAGS): EncodedFeedback[] {
  const out: EncodedFeedback[] = []
  for (const tag of tags) {
    const encoded = encodeTag(record, tag)
    if (encoded !== null) out.push(encoded)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function finish(tag: FeedbackTag, value: bigint, valueDecimals: number, reason: string): EncodedFeedback {
  assertTagValue(tag, value, valueDecimals)
  return { tag1: tag, value, valueDecimals, reason }
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length === 0) return 0
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}
