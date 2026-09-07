/**
 * The measurement engine.
 *
 * One agent in, one evidence bundle out: read the identity record, resolve the
 * registration file, pull the declared endpoints, contact each of them with the
 * handler for its protocol, and score what came back. Nothing here decides
 * anything — it only records what happened, and records the failures with the
 * same care as the successes.
 */

import { createRegistryReader, endpointsOf } from '@hallmark/core'
import type { AgentCard, RegistryReader, ResolvedEndpoint, SupportedChainId } from '@hallmark/core'

import { buildEvidenceBundle } from '../evidence.ts'
import { bundleHash } from '../evidence.ts'
import { scoreRun } from '../score.ts'
import { silentLogger } from '../log.ts'
import type { Logger } from '../log.ts'
import type { ProberConfig } from '../config.ts'
import { rpcUrlFor } from '../config.ts'
import type {
  AgentProvenance,
  ChainObservation,
  EndpointProbe,
  ProbeCapabilities,
  ProbeRun,
  ProtocolOutcome,
} from '../types.ts'

import { guardedFetch } from './http.ts'
import type { HttpOptions } from './http.ts'
import type { DnsResolver } from './guard.ts'
import { probeA2A } from './a2a.ts'
import { probeMcp } from './mcp.ts'
import { probeWeb } from './web.ts'
import { probeX402 } from './x402.ts'

export type ProbeContext = {
  chainId: SupportedChainId
  reader: RegistryReader
  config: ProberConfig
  logger: Logger
  http: HttpOptions
  observe: () => Promise<ChainObservation>
  now: () => Date
}

export type CreateContextOptions = {
  config: ProberConfig
  chainId: SupportedChainId
  logger?: Logger
  reader?: RegistryReader
  fetchImpl?: typeof fetch
  /** Overrides the DNS lookup the guard performs. Tests inject a fake. */
  resolver?: DnsResolver
  now?: () => Date
  observe?: () => Promise<ChainObservation>
}

export function createProbeContext(options: CreateContextOptions): ProbeContext {
  const { config, chainId } = options
  const reader = options.reader ?? createRegistryReader(chainId, { rpcUrl: rpcUrlFor(config, chainId) })
  const http: HttpOptions = {
    timeoutMs: config.probe.timeoutMs,
    maxRedirects: config.probe.maxRedirects,
    maxBodyBytes: config.probe.maxBodyBytes,
    checkDns: config.probe.checkDns,
    userAgent: config.probe.userAgent,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
  }

  return {
    chainId,
    reader,
    config,
    logger: options.logger ?? silentLogger,
    http,
    observe: options.observe ?? createBlockClock(reader),
    now: options.now ?? (() => new Date()),
  }
}

/**
 * Chain head, cached briefly. A 2,000-agent sweep should not make 2,000
 * `eth_getBlockByNumber` calls to stamp the same second onto every bundle.
 */
export function createBlockClock(reader: RegistryReader, maxAgeMs = 5_000): () => Promise<ChainObservation> {
  let cached: { value: ChainObservation; at: number } | null = null
  let inflight: Promise<ChainObservation> | null = null

  return async () => {
    if (cached !== null && Date.now() - cached.at < maxAgeMs) return cached.value
    if (inflight !== null) return inflight

    inflight = (async () => {
      try {
        const block = await reader.client.getBlock({ blockTag: 'latest' })
        const value: ChainObservation = {
          blockNumber: Number(block.number),
          blockTimestamp: Number(block.timestamp),
        }
        cached = { value, at: Date.now() }
        return value
      } catch {
        // A run must still produce a bundle when the RPC blinks; the zeroes
        // say plainly that the chain was not observed, rather than inventing
        // a height.
        const value: ChainObservation = cached?.value ?? { blockNumber: 0, blockTimestamp: 0 }
        return value
      } finally {
        inflight = null
      }
    })()

    return inflight
  }
}

export async function probeAgent(ctx: ProbeContext, agentId: number): Promise<ProbeRun> {
  const startedAt = Date.now()
  const probedAt = ctx.now().toISOString()

  const [agent, observed] = await Promise.all([readAgent(ctx, agentId), ctx.observe()])

  const provenance: AgentProvenance = {
    owner: agent?.owner ?? null,
    tokenUriKind: agent?.card.kind ?? 'unknown',
    name: agent !== null && agent.card.ok ? (agent.card.card.name ?? null) : null,
    cardError: agent === null ? 'agent id is not registered' : agent.card.ok ? null : agent.card.error,
    cardWarnings: agent !== null && agent.card.ok ? agent.card.warnings : [],
  }

  const card: AgentCard | null = agent !== null && agent.card.ok ? agent.card.card : null
  const endpoints = card === null ? [] : dedupeEndpoints(endpointsOf(card))

  const probes = await mapLimit(endpoints, ctx.config.probe.concurrency, (endpoint) => probeEndpoint(ctx, endpoint))
  const capabilities = mergeCapabilities(probes.map((p) => p.capabilities))

  // The card's own x402 claim is recorded, but only a live challenge counts.
  if (capabilities.x402 === undefined) capabilities.x402 = null

  const probe = probes.map((p) => p.probe)
  const bundle = buildEvidenceBundle({
    chainId: ctx.chainId,
    agentId,
    probe,
    capabilities,
    observed,
    agent: provenance,
    probedAt,
  })

  const { score, breakdown } = scoreRun({ probe, capabilities })

  return {
    chainId: ctx.chainId,
    agentId,
    probedAt,
    score,
    breakdown,
    evidenceHash: bundleHash(bundle),
    bundle,
    elapsedMs: Date.now() - startedAt,
  }
}

export type SweepOptions = {
  concurrency?: number
  onResult?: (run: ProbeRun, index: number, total: number) => void | Promise<void>
}

export async function sweep(ctx: ProbeContext, agentIds: number[], options: SweepOptions = {}): Promise<ProbeRun[]> {
  const concurrency = options.concurrency ?? ctx.config.probe.concurrency
  const total = agentIds.length
  let completed = 0

  return mapLimit(agentIds, concurrency, async (agentId) => {
    const run = await probeAgent(ctx, agentId)
    completed += 1
    if (options.onResult !== undefined) await options.onResult(run, completed, total)
    return run
  })
}

/** Bounded-concurrency map that keeps input order and never rejects early. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const width = Math.max(1, Math.min(limit, items.length))
  const results = new Array<R>(items.length)
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      const item = items[index] as T
      results[index] = await fn(item, index)
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

type EndpointOutcome = { probe: EndpointProbe; capabilities: ProbeCapabilities }

async function readAgent(ctx: ProbeContext, agentId: number) {
  try {
    return await ctx.reader.getAgent(agentId, {
      resolveOffChain: ctx.config.probe.resolveOffChainCards,
      // The registration file is itself an untrusted URL from the chain, so it
      // goes through the same guard as everything else the prober fetches.
      fetchImpl: guardedFetch(ctx.http),
      timeoutMs: ctx.config.probe.timeoutMs,
    })
  } catch (err) {
    ctx.logger.warn('identity read failed', { agentId, error: messageOf(err) })
    return null
  }
}

async function probeEndpoint(ctx: ProbeContext, endpoint: ResolvedEndpoint): Promise<EndpointOutcome> {
  const url = endpoint.url.trim()

  if (!isHttpUrl(url)) {
    return {
      probe: {
        endpoint: url,
        kind: endpoint.kind,
        ok: false,
        latencyMs: 0,
        error: 'not reachable over http(s)',
        failure: 'unsupported-scheme',
        protocolOk: false,
        scored: false,
        requests: [],
      },
      capabilities: {},
    }
  }

  const outcome = await dispatch(ctx, endpoint, url)
  ctx.logger.debug('endpoint probed', {
    kind: endpoint.kind,
    url,
    ok: outcome.ok,
    failure: outcome.failure ?? '-',
    ms: outcome.latencyMs,
  })

  const probe: EndpointProbe = {
    endpoint: url,
    kind: endpoint.kind,
    ok: outcome.ok,
    latencyMs: outcome.latencyMs,
    failure: outcome.ok ? null : (outcome.failure ?? 'network'),
    protocolOk: outcome.protocolOk,
    scored: true,
    requests: outcome.requests,
    ...(outcome.status === null ? {} : { httpStatus: outcome.status }),
    ...(outcome.detail === null ? {} : { error: outcome.detail }),
  }

  return { probe, capabilities: outcome.capabilities }
}

function dispatch(ctx: ProbeContext, endpoint: ResolvedEndpoint, url: string): Promise<ProtocolOutcome> {
  switch (endpoint.kind) {
    case 'a2a':
      return probeA2A(url, ctx.http)
    case 'mcp':
      return probeMcp(url, ctx.http)
    case 'x402':
      return probeX402(url, ctx.http)
    case 'web':
      return probeWeb(url, ctx.http)
    default:
      // An unlabelled endpoint that ends in /mcp or /sse is almost always an
      // MCP server whose card just did not say so.
      return looksLikeMcpPath(url) ? probeMcp(url, ctx.http) : probeWeb(url, ctx.http)
  }
}

function looksLikeMcpPath(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '').toLowerCase()
    return path.endsWith('/mcp') || path.endsWith('/sse') || path.endsWith('/mcp/sse')
  } catch {
    return false
  }
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol.toLowerCase()
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Same URL declared twice under two names is one endpoint, not two. */
function dedupeEndpoints(endpoints: ResolvedEndpoint[]): ResolvedEndpoint[] {
  const seen = new Set<string>()
  const out: ResolvedEndpoint[] = []
  for (const endpoint of endpoints) {
    const key = `${endpoint.kind} ${endpoint.url.trim().toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(endpoint)
  }
  return out
}

function mergeCapabilities(parts: ProbeCapabilities[]): ProbeCapabilities {
  const mcpTools: string[] = []
  const a2aSkills: string[] = []
  let x402: ProbeCapabilities['x402'] = undefined

  for (const part of parts) {
    if (part.mcpTools !== undefined) mcpTools.push(...part.mcpTools)
    if (part.a2aSkills !== undefined) a2aSkills.push(...part.a2aSkills)
    if (part.x402 !== undefined && part.x402 !== null && x402 === undefined) x402 = part.x402
  }

  const merged: ProbeCapabilities = {}
  if (mcpTools.length > 0) merged.mcpTools = [...new Set(mcpTools)].sort()
  if (a2aSkills.length > 0) merged.a2aSkills = [...new Set(a2aSkills)].sort()
  if (x402 !== undefined) merged.x402 = x402
  return merged
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
