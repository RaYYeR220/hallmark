import { loadBundleText, normaliseHash, verifyBundleText } from '@/lib/evidenceStore'

/**
 * `GET /api/evidence/:hash` — the public, credential-free home of an evidence
 * bundle.
 *
 * This URL is written into ERC-8004 attestations as `feedbackURI` (Reputation
 * Registry) and `responseURI` (Validation Registry), beside the `keccak256` of
 * the document. A judge clicking through from BscScan lands here, and the only
 * thing that makes the click worth anything is that the bytes returned rehash
 * to the hash on-chain.
 *
 * So the route does exactly three things:
 *
 *   1. Reads the stored canonical text.
 *   2. Re-derives the hash from it and refuses to serve a document that does
 *      not reproduce its own name.
 *   3. Returns those bytes verbatim, as a string body with an explicit
 *      content-type — never `Response.json()`, which re-encodes.
 *
 * The response carries `x-evidence-hash` so a verifier can compare without
 * parsing, and immutable caching because a content-addressed document at a
 * content-addressed URL can never change.
 */

// Bundles are read from the filesystem or proxied from the prober, so this
// route is dynamic and runs on Node rather than the edge.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ hash: string }> }

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { hash: raw } = await context.params
  const hash = normaliseHash(raw)

  if (hash === null) {
    return problem(400, 'invalid-hash', {
      message:
        'An evidence hash is 0x followed by 64 hex characters — the keccak256 of the ' +
        'bundle’s canonical JSON, exactly as it appears on-chain.',
      received: raw.slice(0, 80),
    })
  }

  const lookup = await loadBundleText(hash)
  if (!lookup.found) {
    return problem(404, 'unknown-evidence', {
      message: lookup.reason,
      hash,
      // Naming what was searched turns a dead link from an on-chain
      // attestation into something an operator can actually fix.
      searched: lookup.checked,
    })
  }

  const verified = verifyBundleText(lookup.text, hash)
  if (!verified.ok) {
    // Serving a document that fails its own integrity check would be worse
    // than serving nothing: it looks like proof and is not.
    return problem(500, 'integrity-failure', {
      message: verified.reason,
      requested: hash,
      computed: verified.hash,
    })
  }

  return new Response(lookup.text, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Content-addressed: this body can never change under this URL.
      'cache-control': 'public, max-age=31536000, immutable',
      'x-evidence-hash': hash,
      'x-evidence-source': lookup.source,
      // Verifiers are expected to be scripts on other origins.
      'access-control-allow-origin': '*',
    },
  })
}

export async function HEAD(request: Request, context: RouteContext): Promise<Response> {
  const response = await GET(request, context)
  return new Response(null, { status: response.status, headers: response.headers })
}

function problem(status: number, code: string, detail: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: code, ...detail }, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  })
}
