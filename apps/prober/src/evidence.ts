/**
 * Evidence bundles: the content-addressed record of one probe run.
 *
 * The bundle is the thing the on-chain attestation points at, and its keccak256
 * is the thing the on-chain attestation *is*. That makes byte-stability a
 * correctness requirement, not a nicety — if the same run canonicalises two
 * ways, the hash we published stops matching the document we serve and the
 * whole claim falls over.
 *
 * So: canonicalisation comes from `@hallmark/core` (RFC 8785 style — sorted
 * keys, no insignificant whitespace, escaped non-ASCII), the stored file is
 * the canonical text verbatim rather than a re-serialisation, and
 * `test/evidence.test.ts` asserts that shuffling every key in the bundle leaves
 * the hash unchanged.
 */

import { canonicalize, evidenceHash } from '@hallmark/core'
import { PROBER_SCORER, scoreRun } from './score.ts'
import type {
  AgentProvenance,
  ChainObservation,
  EndpointProbe,
  ProbeCapabilities,
  ProbeEvidenceBundle,
} from './types.ts'

export type BuildEvidenceInput = {
  chainId: number
  agentId: number
  probe: EndpointProbe[]
  capabilities: ProbeCapabilities
  observed: ChainObservation
  agent: AgentProvenance
  probedAt?: Date | string
}

export function buildEvidenceBundle(input: BuildEvidenceInput): ProbeEvidenceBundle {
  const { score, breakdown } = scoreRun({ probe: input.probe, capabilities: input.capabilities })
  const probedAt =
    typeof input.probedAt === 'string' ? input.probedAt : (input.probedAt ?? new Date()).toISOString()

  return {
    version: 1,
    chainId: input.chainId,
    agentId: input.agentId,
    probedAt,
    probe: input.probe,
    capabilities: input.capabilities,
    score,
    breakdown,
    scorer: { ...PROBER_SCORER, weights: { ...PROBER_SCORER.weights } },
    observed: input.observed,
    agent: input.agent,
  }
}

/** The exact bytes that get hashed, stored on disk, and served at `/api/evidence/:hash`. */
export function canonicalBundleJson(bundle: ProbeEvidenceBundle): string {
  return canonicalize(bundle)
}

/** keccak256 over the canonical UTF-8 bytes. This is what goes on-chain. */
export function bundleHash(bundle: ProbeEvidenceBundle): `0x${string}` {
  return evidenceHash(bundle)
}

/**
 * Re-hash a stored document and compare. Used by the CLI before it publishes
 * and by anyone auditing a `feedbackURI` against its `feedbackHash`.
 */
export function verifyBundleText(text: string, expected: string): { ok: boolean; actual: string | null; reason: string | null } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, actual: null, reason: `stored evidence is not JSON: ${messageOf(err)}` }
  }
  const bundle = parsed as ProbeEvidenceBundle
  const actual = evidenceHash(bundle)
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    return { ok: false, actual, reason: `hash mismatch: document hashes to ${actual}, expected ${expected}` }
  }
  if (canonicalize(bundle) !== text) {
    return {
      ok: false,
      actual,
      reason: 'document hashes correctly but is not stored in canonical form; serve the canonical bytes',
    }
  }
  return { ok: true, actual, reason: null }
}

/**
 * Where a bundle is publicly fetchable — what goes into `feedbackURI` on the
 * Reputation Registry and `responseURI` on the Validation Registry.
 *
 * Bundles are served by the marketplace app, so `EVIDENCE_BASE_URL` is normally
 * the full route prefix (`https://hallmark-market.vercel.app/api/evidence`).
 * A bare origin is also accepted, for the local `serve` command, and gets the
 * route appended.
 */
export function evidenceUri(baseUrl: string, hash: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return /\/api\/evidence$/.test(base) ? `${base}/${hash}` : `${base}/api/evidence/${hash}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
