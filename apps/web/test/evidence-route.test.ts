import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalize } from '@hallmark/core'
import { beforeAll, describe, expect, it } from 'vitest'

import { hashBundle, verifyBundleText } from '../src/lib/evidenceStore'

/**
 * The contract this file exists to hold:
 *
 *   fetching /api/evidence/{hash} and recomputing keccak256 over the canonical
 *   form of the response body must reproduce {hash}.
 *
 * That is the entire basis for "anyone can re-derive our data". If it breaks,
 * every on-chain attestation Hallmark has written points at bytes that do not
 * verify, and nothing else in the product matters.
 */

let storeDir: string
let route: typeof import('../src/app/api/evidence/[hash]/route')

/** Shaped like the prober's ProbeEvidenceBundle, with keys deliberately out of order. */
const bundle = {
  version: 1,
  scorer: {
    name: 'hallmark',
    version: '1.0.0',
    weights: { reachability: 45, latency: 15, mcpTools: 15, a2aSkills: 15, x402: 10 },
  },
  agentId: 2210,
  chainId: 97,
  probedAt: '2026-09-07T09:24:38.000Z',
  score: 92,
  capabilities: {
    mcpTools: ['probe.run', 'probe.latest'],
    a2aSkills: ['liveness'],
    x402: null,
  },
  probe: [
    {
      endpoint: 'https://hallmark.market/a2a/validator',
      kind: 'a2a',
      ok: true,
      httpStatus: 200,
      latencyMs: 143,
    },
    {
      endpoint: 'https://hallmark.market/mcp/validator',
      kind: 'mcp',
      ok: true,
      httpStatus: 200,
      latencyMs: 168,
    },
  ],
  // Non-ASCII, to exercise the canonical escaping rules rather than just key
  // ordering — this is the half that a JSON.stringify round-trip gets wrong.
  note: 'probe ran from eu-west — latency measured end to end',
}

const canonicalText = canonicalize(bundle)
const hash = hashBundle(bundle)

async function callRoute(requested: string): Promise<Response> {
  return route.GET(new Request(`https://hallmark-market.vercel.app/api/evidence/${requested}`), {
    params: Promise.resolve({ hash: requested }),
  })
}

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'hallmark-evidence-'))
  await mkdir(join(storeDir, 'evidence'), { recursive: true })
  await writeFile(join(storeDir, 'evidence', `${hash}.json`), canonicalText, 'utf8')

  process.env['EVIDENCE_STORE_DIR'] = storeDir
  // No upstream: the test must not depend on a running prober.
  delete process.env['PROBER_BASE_URL']

  route = await import('../src/app/api/evidence/[hash]/route')
})

describe('GET /api/evidence/:hash', () => {
  it('serves the exact bytes that were hashed', async () => {
    const response = await callRoute(hash)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('x-evidence-hash')).toBe(hash)

    const body = await response.text()

    // The point of the whole exercise: byte equality, then a fresh hash over
    // what came back rather than over what we sent.
    expect(body).toBe(canonicalText)
    expect(hashBundle(JSON.parse(body))).toBe(hash)
    expect(verifyBundleText(body, hash)).toEqual({ ok: true, hash })
  })

  it('is not a JSON.stringify round-trip', async () => {
    // If the route ever grows a `Response.json(...)`, this is the assertion
    // that catches it: the canonical form and the default encoding differ, and
    // only one of them reproduces the on-chain hash.
    const body = await (await callRoute(hash)).text()
    expect(JSON.stringify(bundle)).not.toBe(canonicalText)
    expect(body).not.toBe(JSON.stringify(bundle))
    expect(hashBundle(JSON.parse(JSON.stringify(bundle)))).toBe(hash)
  })

  it('accepts an uppercase hash and answers under the lowercase one', async () => {
    const response = await callRoute(hash.toUpperCase().replace('0X', '0x'))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-evidence-hash')).toBe(hash)
  })

  it('rejects a malformed hash without touching the store', async () => {
    const response = await callRoute('not-a-hash')
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('invalid-hash')
  })

  it('404s an unknown hash and says where it looked', async () => {
    const response = await callRoute(`0x${'ab'.repeat(32)}`)
    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body.error).toBe('unknown-evidence')
    expect(Array.isArray(body.searched)).toBe(true)
  })

  it('refuses to serve a document that does not reproduce its own hash', async () => {
    const wrongHash = `0x${'cd'.repeat(32)}` as const
    await writeFile(join(storeDir, 'evidence', `${wrongHash}.json`), canonicalText, 'utf8')

    const response = await callRoute(wrongHash)
    expect(response.status).toBe(500)
    expect((await response.json()).error).toBe('integrity-failure')
  })

  it('refuses a document stored in non-canonical form even when it hashes right', async () => {
    // Pretty-printed: same object, same hash once canonicalised, different
    // bytes. Serving it would hand a verifier something that does not verify.
    const prettyDir = await mkdtemp(join(tmpdir(), 'hallmark-evidence-pretty-'))
    await mkdir(join(prettyDir, 'evidence'), { recursive: true })
    await writeFile(
      join(prettyDir, 'evidence', `${hash}.json`),
      JSON.stringify(bundle, null, 2),
      'utf8',
    )

    const previous = process.env['EVIDENCE_STORE_DIR']
    process.env['EVIDENCE_STORE_DIR'] = prettyDir
    try {
      const response = await callRoute(hash)
      expect(response.status).toBe(500)
      const body = await response.json()
      expect(body.error).toBe('integrity-failure')
      expect(String(body.message)).toContain('canonical')
    } finally {
      process.env['EVIDENCE_STORE_DIR'] = previous
    }
  })
})

describe('verifyBundleText', () => {
  it('names the hash a document actually has when it does not match', () => {
    const result = verifyBundleText(canonicalText, `0x${'11'.repeat(32)}`)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.hash).toBe(hash)
      expect(result.reason).toContain('hash mismatch')
    }
  })

  it('reports invalid JSON rather than throwing', () => {
    const result = verifyBundleText('{ not json', hash)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('not JSON')
  })
})
