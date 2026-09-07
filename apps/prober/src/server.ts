/**
 * The public face of the prober.
 *
 * `/api/evidence/:hash` is the important one: it is what `feedbackURI` on the
 * ERC-8004 Reputation Registry points at, so it must be fetchable without
 * credentials and must return the exact bytes that were hashed. It therefore
 * streams the stored canonical text rather than re-serialising the object, and
 * it re-checks the hash before answering — a document that no longer matches
 * its own name is a 500, never a 200.
 *
 * Hono, so the same app runs under Node and on a Vercel Function.
 */

import { Hono } from 'hono'
import type { Context } from 'hono'

import { isSupportedChainId } from '@hallmark/core'

import { createProbeContext, probeAgent, sweep } from './probe/index.ts'
import { evidenceUri, verifyBundleText } from './evidence.ts'
import { computeStats } from './stats.ts'
import { isEvidenceHash } from './store.ts'
import type { EvidenceStore } from './store.ts'
import { selectAgents } from './select.ts'
import { silentLogger } from './log.ts'
import type { Logger } from './log.ts'
import type { ProberConfig } from './config.ts'

export type ServerDeps = {
  config: ProberConfig
  store: EvidenceStore
  logger?: Logger
  /** Upper bound on how many agents one cron invocation may probe. */
  maxCronSweep?: number
  startedAt?: Date
}

export const DEFAULT_MAX_CRON_SWEEP = 200

export function createServer(deps: ServerDeps) {
  const logger = deps.logger ?? silentLogger
  const maxCronSweep = deps.maxCronSweep ?? DEFAULT_MAX_CRON_SWEEP
  const startedAt = deps.startedAt ?? new Date()

  const app = new Hono()

  app.get('/health', (c) =>
    c.json({
      ok: true,
      service: 'hallmark-prober',
      startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      chains: [56, 97],
      evidenceBaseUrl: deps.config.evidenceBaseUrl,
      cronConfigured: deps.config.cronSecret !== null,
    }),
  )

  app.get('/api/agents/:chainId/:agentId/evidence', async (c) => {
    const chainId = Number(c.req.param('chainId'))
    const agentId = Number(c.req.param('agentId'))
    if (!isSupportedChainId(chainId)) return c.json({ error: `unsupported chain ${c.req.param('chainId')}` }, 400)
    if (!Number.isInteger(agentId) || agentId < 0) return c.json({ error: 'agentId must be a non-negative integer' }, 400)

    const record = await deps.store.getLatest(chainId, agentId)
    if (record === null) return c.json({ error: 'no evidence stored for this agent' }, 404)

    const bundle = await deps.store.getBundle(record.evidenceHash)
    return c.json({
      record,
      bundle,
      evidenceUri: evidenceUri(deps.config.evidenceBaseUrl, record.evidenceHash),
    })
  })

  app.get('/api/evidence/:hash', async (c) => {
    const hash = c.req.param('hash').toLowerCase()
    if (!isEvidenceHash(hash)) return c.json({ error: 'hash must be 0x followed by 64 lowercase hex characters' }, 400)

    const text = await deps.store.getBundleText(hash)
    if (text === null) return c.json({ error: 'unknown evidence hash' }, 404)

    const verified = verifyBundleText(text, hash)
    if (!verified.ok) {
      logger.error('stored evidence does not match its own hash', { hash, reason: verified.reason })
      return c.json({ error: 'stored evidence failed its own integrity check', detail: verified.reason }, 500)
    }

    // The bytes, verbatim. Anything that re-encodes here breaks the on-chain hash.
    return c.body(text, 200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-evidence-hash': hash,
    })
  })

  app.get('/api/stats', async (c) => {
    const raw = c.req.query('chainId')
    const chainId = raw === undefined ? undefined : Number(raw)
    if (chainId !== undefined && !isSupportedChainId(chainId)) {
      return c.json({ error: `unsupported chain ${raw}` }, 400)
    }
    const records = await deps.store.listLatest(chainId)
    return c.json(computeStats(records))
  })

  app.post('/api/cron/sweep', async (c) => {
    const refusal = cronRefusal(c, deps.config.cronSecret)
    if (refusal !== null) return c.json({ error: refusal }, 401)

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>)
    const chainId = Number((body as Record<string, unknown>)['chainId'] ?? 97)
    if (!isSupportedChainId(chainId)) return c.json({ error: `unsupported chain ${chainId}` }, 400)

    const requested = Number((body as Record<string, unknown>)['limit'] ?? 25)
    const limit = Math.max(1, Math.min(Number.isFinite(requested) ? requested : 25, maxCronSweep))
    const mode = String((body as Record<string, unknown>)['mode'] ?? 'recent')
    const seed = String((body as Record<string, unknown>)['seed'] ?? new Date().toISOString().slice(0, 10))

    const ctx = createProbeContext({ config: deps.config, chainId, logger })
    const selection = await selectAgents({
      reader: ctx.reader,
      chainId,
      ...(mode === 'sample' ? { sample: limit, seed } : { recent: limit }),
    })

    const started = Date.now()
    const runs = await sweep(ctx, selection.agentIds, {
      onResult: async (run) => {
        await deps.store.putRun(run)
      },
    })

    return c.json({
      chainId,
      strategy: selection.strategy,
      ceiling: selection.ceiling,
      probed: runs.length,
      elapsedMs: Date.now() - started,
      stats: computeStats(await Promise.all(runs.map(async (run) => (await deps.store.getLatest(chainId, run.agentId)) ?? toStub(run)))),
      agents: runs.map((run) => ({
        agentId: run.agentId,
        score: run.score,
        evidenceHash: run.evidenceHash,
      })),
    })
  })

  app.get('/api/agents/:chainId/:agentId/probe', async (c) => {
    const refusal = cronRefusal(c, deps.config.cronSecret)
    if (refusal !== null) return c.json({ error: refusal }, 401)

    const chainId = Number(c.req.param('chainId'))
    const agentId = Number(c.req.param('agentId'))
    if (!isSupportedChainId(chainId)) return c.json({ error: `unsupported chain ${chainId}` }, 400)

    const ctx = createProbeContext({ config: deps.config, chainId, logger })
    const run = await probeAgent(ctx, agentId)
    await deps.store.putRun(run)
    return c.json(run)
  })

  app.notFound((c) => c.json({ error: 'not found' }, 404))

  app.onError((err, c) => {
    logger.error('request failed', { path: c.req.path, error: err.message })
    return c.json({ error: 'internal error' }, 500)
  })

  return app
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function cronRefusal(c: Context, secret: string | null): string | null {
  if (secret === null) return 'CRON_SECRET is not configured; this route is disabled'
  const header = c.req.header('authorization') ?? ''
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1] ?? c.req.header('x-cron-secret') ?? ''
  return timingSafeEqual(bearer.trim(), secret) ? null : 'unauthorized'
}

/** Constant-time compare, so the route does not leak the secret one byte at a time. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Only reachable when the store write failed; keeps `/api/cron/sweep` honest. */
function toStub(run: { chainId: number; agentId: number; score: number; evidenceHash: `0x${string}` }) {
  return {
    chainId: run.chainId,
    agentId: run.agentId,
    probedAt: new Date().toISOString(),
    score: run.score,
    breakdown: { reachability: 0, protocol: 0, latency: 0, capabilities: 0, x402: 0 },
    evidenceHash: run.evidenceHash,
    elapsedMs: 0,
    name: null,
    owner: null,
    cardError: 'record could not be read back from the store',
    primaryEndpoint: null,
    endpointCount: 0,
    scoredCount: 0,
    okCount: 0,
    protocolOkCount: 0,
    failures: {},
    kinds: [],
    latencies: [],
    mcpTools: 0,
    a2aSkills: 0,
    x402: false,
  }
}
