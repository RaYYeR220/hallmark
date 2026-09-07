import { keccak256, toBytes } from 'viem'
import { canonicalize } from '@hallmark/core'

/**
 * Evidence bundles: reading them, and proving they are what they claim to be.
 *
 * An evidence bundle is content-addressed. Its name is `keccak256` over an
 * RFC-8785-style canonical JSON serialisation of itself, and that hash is
 * written on-chain as `feedbackHash` on the Reputation Registry and
 * `responseHash` on the Validation Registry. The URI beside it points here.
 *
 * The consequence, and the whole reason this module exists separately from the
 * route that uses it: the bytes served must be the bytes hashed, exactly.
 * `JSON.parse` followed by `JSON.stringify` reorders nothing on a modern V8,
 * but it does drop the canonical escaping rules, and `NextResponse.json()`
 * re-encodes unconditionally. Either one silently breaks the hash, and a
 * broken hash quietly demolishes the claim the whole project rests on —
 * that anyone can re-derive our data without trusting us.
 *
 * So: read bytes, verify bytes, return bytes. Never an object.
 */

const HASH_PATTERN = /^0x[0-9a-f]{64}$/

/** Path-safety as much as validation: this value arrives off an HTTP route. */
export function isEvidenceHash(value: string): value is `0x${string}` {
  return HASH_PATTERN.test(value)
}

export function normaliseHash(value: string): `0x${string}` | null {
  const lowered = value.trim().toLowerCase()
  return isEvidenceHash(lowered) ? lowered : null
}

/** keccak256 over the canonical UTF-8 bytes of a parsed bundle. */
export function hashBundle(bundle: unknown): `0x${string}` {
  return keccak256(toBytes(canonicalize(bundle)))
}

export type VerifyResult =
  | { ok: true; hash: `0x${string}` }
  | { ok: false; hash: `0x${string}` | null; reason: string }

/**
 * Re-derive a document's name from the document.
 *
 * Two independent checks, and both have to pass:
 *
 *  1. The document hashes to the hash it was requested under. A mismatch means
 *     the store is serving something other than what the chain committed to.
 *  2. The stored text is already canonical. A document can hash correctly and
 *     still be stored non-canonically — pretty-printed, say — and serving that
 *     hands a verifier bytes that do not reproduce the hash. Passing check 1
 *     and failing check 2 is the subtle failure this exists to catch.
 */
export function verifyBundleText(text: string, expected: string): VerifyResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      hash: null,
      reason: `stored evidence is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  let actual: `0x${string}`
  try {
    actual = hashBundle(parsed)
  } catch (error) {
    return {
      ok: false,
      hash: null,
      reason: `stored evidence could not be canonicalised: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }

  if (actual.toLowerCase() !== expected.toLowerCase()) {
    return {
      ok: false,
      hash: actual,
      reason: `hash mismatch: this document hashes to ${actual}, not ${expected}`,
    }
  }

  if (canonicalize(parsed) !== text) {
    return {
      ok: false,
      hash: actual,
      reason:
        'the document hashes correctly but is not stored in canonical form. ' +
        'Serving it verbatim would hand a verifier bytes that do not reproduce the hash.',
    }
  }

  return { ok: true, hash: actual }
}

export type BundleLookup =
  | { found: true; text: string; source: 'store' | 'upstream' }
  | { found: false; reason: string; checked: string[] }

/**
 * Find a bundle's canonical bytes.
 *
 * Two sources, tried in order:
 *
 *  1. The local evidence store — the same `<dir>/evidence/<hash>.json` layout
 *     the prober writes. Present when the store ships with the deployment or
 *     when both processes share a volume.
 *  2. An upstream prober over HTTP, when `PROBER_BASE_URL` is set. The body is
 *     forwarded as text and never parsed on the way through, so a proxied
 *     bundle is byte-identical to a locally stored one.
 *
 * Every path this looked in is reported back, because "404" on a URL that an
 * on-chain attestation points at deserves an explanation rather than a blank.
 */
export async function loadBundleText(hash: `0x${string}`): Promise<BundleLookup> {
  const checked: string[] = []

  const dirs = storeDirs()
  for (const dir of dirs) {
    const path = `${dir}/evidence/${hash}.json`
    checked.push(path)
    const text = await readFileOrNull(path)
    if (text !== null) return { found: true, text, source: 'store' }
  }

  const upstream = proberBaseUrl()
  if (upstream !== null) {
    const url = `${upstream}/api/evidence/${hash}`
    checked.push(url)
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(6_000),
        cache: 'no-store',
      })
      if (response.ok) {
        // .text(), never .json(): the bytes are the payload.
        return { found: true, text: await response.text(), source: 'upstream' }
      }
    } catch {
      // Falls through to the not-found answer below, which names the URL.
    }
  }

  return {
    found: false,
    reason:
      dirs.length === 0 && upstream === null
        ? 'This deployment has no evidence store configured. Set EVIDENCE_STORE_DIR to a ' +
          'directory written by the prober, or PROBER_BASE_URL to a running prober.'
        : 'No bundle is stored under that hash.',
    checked,
  }
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where to look for `evidence/<hash>.json`.
 *
 * `EVIDENCE_STORE_DIR` first when set, then the prober's own default store
 * directory relative to the repository root, which is what a local `pnpm dev`
 * across both apps produces.
 */
function storeDirs(): string[] {
  const dirs: string[] = []
  const configured = process.env['EVIDENCE_STORE_DIR']?.trim()
  if (configured !== undefined && configured !== '') dirs.push(configured.replace(/\/+$/, ''))
  dirs.push('./data', '../prober/data', '../../apps/prober/data')
  return [...new Set(dirs)]
}

function proberBaseUrl(): string | null {
  const raw = process.env['PROBER_BASE_URL']?.trim()
  if (raw === undefined || raw === '') return null
  return raw.replace(/\/+$/, '')
}

/**
 * Read a file if it exists.
 *
 * `node:fs/promises` is imported dynamically so this module stays importable
 * from a bundle that never touches the filesystem — the verification helpers
 * above are pure and are used by tests and by the client-side hash display.
 */
async function readFileOrNull(path: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises')
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
