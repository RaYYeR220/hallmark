import {
  DEFAULT_PAGE_SIZE,
  listAgents,
  type AgentQuery,
  type EvidenceQuery,
  type ProtocolFilter,
  type SortKey,
} from '@/lib/agents'
import { isCategory } from '@/lib/categories'
import type { SupportedChainId } from '@/lib/deployments'

/**
 * `GET /api/agents` — the discovery query, server-side.
 *
 * The reason this exists rather than the browser calling 8004scan directly:
 * our index key raises the rate limit from 180 to 600 requests a minute, and a
 * key in a browser bundle is a key that has leaked. Everything the client needs
 * from the index comes through here.
 *
 * Also useful on its own — the same JSON the pages render from, for anyone who
 * wants to build on top of it.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PROTOCOLS: ProtocolFilter[] = ['any', 'a2a', 'mcp', 'x402', 'web', 'oasf']
const EVIDENCE: EvidenceQuery[] = ['any', 'reachable', 'unreachable', 'unprobed']
const SORTS: SortKey[] = ['evidence', 'recent', 'feedback', 'score']

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const params = url.searchParams

  const chainRaw = params.get('chain') ?? params.get('chainId') ?? '56'
  if (chainRaw !== '56' && chainRaw !== '97') {
    return json(400, {
      error: 'unsupported-chain',
      detail: 'Hallmark reads BNB Smart Chain (56) and BNB testnet (97).',
    })
  }
  const chainId: SupportedChainId = chainRaw === '97' ? 97 : 56

  const protocol = params.get('protocol')
  const evidence = params.get('evidence')
  const sort = params.get('sort')
  const category = params.get('category')
  const q = params.get('q')?.trim() ?? null

  const pageSize = clamp(Number(params.get('limit') ?? DEFAULT_PAGE_SIZE), 1, 60)
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1)

  const query: AgentQuery = {
    chainId,
    category: isCategory(category) ? category : null,
    protocol: PROTOCOLS.includes(protocol as ProtocolFilter)
      ? (protocol as ProtocolFilter)
      : 'any',
    evidence: EVIDENCE.includes(evidence as EvidenceQuery)
      ? (evidence as EvidenceQuery)
      : 'any',
    sort: SORTS.includes(sort as SortKey) ? (sort as SortKey) : 'evidence',
    q: q === '' ? null : q,
    semantic: params.get('mode') === 'semantic',
    page,
    pageSize,
  }

  try {
    const result = await listAgents(query)
    return json(200, {
      query: {
        chainId: query.chainId,
        category: query.category,
        protocol: query.protocol,
        evidence: query.evidence,
        sort: query.sort,
        q: query.q,
        semantic: query.semantic,
        page: result.page,
        pageSize: result.pageSize,
      },
      // `totalIsExact: false` means the index could not count this filter
      // server-side and `total` is a floor. Consumers should say so too.
      total: result.total,
      totalIsExact: result.totalIsExact,
      hasMore: result.hasMore,
      fetchedAt: result.fetchedAt,
      sources: result.sources,
      warning: result.warning,
      agents: result.rows.map((row) => ({
        chainId: row.chainId,
        agentId: row.agentId,
        name: row.name,
        description: row.description,
        image: row.image,
        owner: row.owner,
        protocols: row.protocols,
        x402: row.x402,
        declaresEndpoint: row.declaresEndpoint,
        evidence: {
          status: row.evidence.status,
          label: row.evidence.label,
          source: row.evidence.source,
          observedAt: row.evidence.observedAt,
          detail: row.evidence.detail,
        },
        hallmark: row.hallmark,
        feedbackCount: row.feedbackCount,
        averageFeedbackScore: row.averageFeedbackScore,
        settledJobs: row.settledJobs,
        categories: row.categories.map((match) => match.category),
        registeredAt: row.registeredAt,
        indexUpdatedAt: row.indexUpdatedAt,
        similarity: row.similarity,
        href: `/agents/${row.chainId}/${row.agentId}`,
      })),
    })
  } catch (error) {
    return json(502, {
      error: 'upstream-failed',
      detail: error instanceof Error ? error.message : 'The index did not answer.',
    })
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, bigintSafe, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Freshness is carried in the body as `fetchedAt`; a short shared cache
      // keeps a burst of identical queries off the index without ever letting
      // a consumer mistake a cached read for a live one.
      'cache-control': status === 200 ? 'public, max-age=0, s-maxage=30' : 'no-store',
      'access-control-allow-origin': '*',
    },
  })
}

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}
