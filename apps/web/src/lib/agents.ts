import 'server-only'

import { cache } from 'react'

import { unstable_cache } from 'next/cache'

import {
  createRegistryReader,
  endpointsOf,
  parseAgentCardFromTokenUri,
  resolveAgentCard,
  type AgentCard,
  type FeedbackEntry,
  type ParseResult,
  type ResolvedEndpoint,
  type SupportedChainId,
  type TokenUriKind,
  type ValidationStatus,
} from '@hallmark/core'
import type { ListAgentsParams } from '@hallmark/core'

import { publicClientFor } from './chain'
import {
  classifyByKeyword,
  CATEGORY_DEFINITIONS,
  type CategoryMatch,
  type HallmarkCategory,
} from './categories'
import { getDeployment } from './deployments'
import { rpcUrlFor } from './env'
import {
  classifyEvidence,
  getCachedHookConfig,
  readEvidenceBatch,
  readEvidence,
  readHookConfig,
  type EvidenceVerdict,
  type HallmarkEvidence,
  type HookConfig,
} from './evidence'
import {
  fetchAgentDetail,
  fetchAgentPage,
  fetchFeedbacks,
  fetchSemantic,
  normaliseScanHealth,
  normaliseScanServices,
  withDeadline,
  type ScanAgent,
  type ScanAgentDetail,
  type ScanFeedback,
  type ScanHealth,
  type ScanServiceEntry,
} from './scan'

/**
 * The merge layer: on-chain truth, the public index, and Hallmark's own probe,
 * folded into the two view models the pages render.
 *
 * The ordering rule, applied everywhere: the chain wins. The index is used for
 * the things a chain read cannot give you cheaply — full-text search, semantic
 * search, a global count over 300,000 rows — and for nothing else. Whenever
 * both have an opinion, the chain's is rendered and the index's is shown
 * beside it as a second, attributed source.
 *
 * There is no database. Every number on every page is either read live or
 * cached from a live read with its timestamp attached.
 */

const registryReaders = new Map<number, ReturnType<typeof createRegistryReader>>()

function readerFor(chainId: SupportedChainId) {
  const cached = registryReaders.get(chainId)
  if (cached !== undefined) return cached
  const rpcUrl = rpcUrlFor(chainId)
  const reader = createRegistryReader(chainId, {
    ...(rpcUrl === undefined ? {} : { rpcUrl }),
    batchSize: 40,
  })
  registryReaders.set(chainId, reader)
  return reader
}

/* ------------------------------------------------------------------ */
/* list                                                                */
/* ------------------------------------------------------------------ */

export type ProtocolFilter = 'any' | 'a2a' | 'mcp' | 'x402' | 'web' | 'oasf'
export type SortKey = 'evidence' | 'recent' | 'feedback' | 'score'
export type EvidenceQuery = 'any' | 'reachable' | 'unreachable' | 'unprobed'

export type AgentQuery = {
  chainId: SupportedChainId
  category: HallmarkCategory | null
  protocol: ProtocolFilter
  evidence: EvidenceQuery
  sort: SortKey
  q: string | null
  /** True when `q` should be run through the index's embedding search. */
  semantic: boolean
  page: number
  pageSize: number
}

export const DEFAULT_PAGE_SIZE = 24
const MAX_PAGE_SIZE = 60
/** Bound on how many index pages a fine-grained filter may walk. */
const MAX_FILTER_WALK = 3

/**
 * An index page, cached briefly, carrying the moment it was really read.
 *
 * The upstream index is occasionally slow — a plain `/agents` query that
 * normally answers in 700ms has been seen taking twelve seconds — and a
 * short shared cache turns that from every visitor's problem into one
 * visitor's problem.
 *
 * `readAt` is the load-bearing part. A cache that returned rows without the
 * time behind them would let a minute-old count render as "read just now",
 * which is precisely the dishonesty this product exists to replace. The page
 * prints this timestamp, not the render time.
 */
const cachedAgentPage = unstable_cache(
  async (params: ListAgentsParams) => ({
    page: await fetchAgentPage(params),
    readAt: new Date().toISOString(),
  }),
  ['agent-index-page'],
  { revalidate: 60, tags: ['agent-index'] },
)

/** How long a page render will wait on the index before rendering without it. */
const INDEX_DEADLINE_MS = 12_000

/**
 * Tighter on a detail page, because there the index is strictly supplementary:
 * the registration file, the evidence, the reputation and the validations all
 * come from the chain, and the page is complete and honest without it.
 */
const INDEX_DETAIL_DEADLINE_MS = 6_000

export type AgentRow = {
  chainId: SupportedChainId
  agentId: number
  name: string
  description: string | null
  image: string | null
  owner: string | null
  /** Protocols the registration file declares, uppercased: A2A, MCP, OASF… */
  protocols: string[]
  x402: boolean
  declaresEndpoint: boolean
  /** Where the agent can actually be reached, when the index knows. */
  primaryEndpoint: string | null
  evidence: EvidenceVerdict
  hallmark: HallmarkEvidence | null
  /** On-chain feedback count, as the index counted it. */
  feedbackCount: number
  averageFeedbackScore: number | null
  /** Jobs settled through Hallmark's escrow. Never a bare listing count. */
  settledJobs: number
  indexScore: number | null
  health: ScanHealth | null
  /** Inferred, never authoritative. Shown with its provenance. */
  categories: CategoryMatch[]
  registeredAt: string | null
  indexUpdatedAt: string | null
  /** Similarity, when the row came from a semantic query. */
  similarity: number | null
}

export type AgentListResult = {
  rows: AgentRow[]
  /**
   * Total matching rows. `exact: false` means the index could not count this
   * filter server-side and the number is a floor, not a total — the UI says so
   * rather than printing a confident wrong figure.
   */
  total: number
  totalIsExact: boolean
  page: number
  pageSize: number
  hasMore: boolean
  /** When these rows were read. Rendered on the page, always. */
  fetchedAt: string
  /** Which sources contributed, so provenance is never implied. */
  sources: string[]
  /** Populated when the index failed and we are showing what we could get. */
  warning: string | null
}

function protocolParams(protocol: ProtocolFilter): Partial<ListAgentsParams> {
  switch (protocol) {
    case 'a2a':
      return { has_a2a: true }
    case 'mcp':
      return { has_mcp: true }
    case 'oasf':
      return { has_oasf: true }
    case 'x402':
      return { x402_supported: true }
    case 'web':
      return { supported_protocol: 'Web' }
    default:
      return {}
  }
}

function evidenceParams(evidence: EvidenceQuery): Partial<ListAgentsParams> {
  // The index only exposes a boolean on endpoint verification. `reachable`
  // maps onto it exactly; the other two are coarse here and refined per row
  // by the post-filter below.
  if (evidence === 'reachable') return { is_endpoint_verified: true }
  if (evidence === 'unreachable' || evidence === 'unprobed') {
    return { is_endpoint_verified: false }
  }
  return {}
}

function sortParams(sort: SortKey): Partial<ListAgentsParams> {
  switch (sort) {
    case 'recent':
      return { sort_by: 'created_at', sort_order: 'desc' }
    case 'feedback':
      return { sort_by: 'total_feedbacks', sort_order: 'desc' }
    case 'score':
    case 'evidence':
      // The index has no notion of Hallmark evidence. `total_score` is its own
      // composite and the closest available proxy; rows are then re-ranked
      // locally by real evidence before render.
      return { sort_by: 'total_score', sort_order: 'desc' }
    default:
      return {}
  }
}

/** Whether a row survives the fine-grained evidence filter. */
function matchesEvidence(row: AgentRow, evidence: EvidenceQuery): boolean {
  if (evidence === 'any') return true
  const status = row.evidence.status
  if (evidence === 'reachable') {
    return (
      status === 'hallmark-fresh' ||
      status === 'index-reachable' ||
      status === 'index-checked'
    )
  }
  if (evidence === 'unreachable') {
    return status === 'index-unreachable' || status === 'hallmark-stale'
  }
  return status === 'never-probed' || status === 'no-endpoint'
}

export async function listAgents(query: AgentQuery): Promise<AgentListResult> {
  const pageSize = Math.min(Math.max(query.pageSize, 1), MAX_PAGE_SIZE)
  const page = Math.max(query.page, 1)
  const sources = new Set<string>(['8004scan index'])
  let warning: string | null = null

  // Semantic and category discovery return a small, precise result set that is
  // paginated locally; everything else pages through the index directly.
  const isDiscovery = query.category !== null || (query.semantic && query.q !== null)

  let scanRows: (ScanAgent & { similarity?: number })[] = []
  let total = 0
  let totalIsExact = true
  let hasMore = false
  // Overwritten with the moment the index rows were really read, which may
  // be older than this render when a cached page served them.
  let readAt = new Date().toISOString()

  try {
    if (isDiscovery) {
      const discovered = await discover(query)
      sources.add('8004scan semantic search')
      total = discovered.length
      const start = (page - 1) * pageSize
      scanRows = discovered.slice(start, start + pageSize)
      hasMore = start + pageSize < discovered.length
    } else {
      const needsPostFilter = query.evidence === 'unreachable' || query.evidence === 'unprobed'
      const params: ListAgentsParams = {
        chain_id: query.chainId,
        limit: needsPostFilter ? MAX_PAGE_SIZE : pageSize,
        offset: needsPostFilter ? 0 : (page - 1) * pageSize,
        ...protocolParams(query.protocol),
        ...evidenceParams(query.evidence),
        ...sortParams(query.sort),
        ...(query.q === null ? {} : { search: query.q }),
      }

      if (needsPostFilter) {
        // The index cannot express "declares an endpoint but was not verified"
        // in a query, so the coarse filter runs upstream and the fine one runs
        // here. The offsets are known in advance, so the pages are fetched
        // together rather than discovered one round-trip at a time — walking
        // them sequentially turned this filter into a forty-second page.
        const offsets = Array.from(
          { length: MAX_FILTER_WALK },
          (_, index) => index * MAX_PAGE_SIZE,
        )
        const chunks = await Promise.all(
          offsets.map((offset) =>
            withDeadline(
              cachedAgentPage({ ...params, offset }).catch(() => null),
              INDEX_DEADLINE_MS,
              null,
            ),
          ),
        )

        const kept: ScanAgent[] = []
        let seen = 0
        let upstreamTotal = 0
        for (const chunk of chunks) {
          if (chunk === null) continue
          readAt = chunk.readAt
          upstreamTotal = chunk.page.total
          seen += chunk.page.items.length
          for (const item of chunk.page.items) {
            const declares = item.supported_protocols.length > 0
            if (query.evidence === 'unreachable' ? declares : !declares) kept.push(item)
          }
        }

        // The walk is bounded, so the count is a floor unless we happened to
        // reach the end of the upstream result set. The UI renders it as
        // "N+" when it is a floor rather than pretending to a total.
        const exhausted = seen >= upstreamTotal
        total = kept.length
        totalIsExact = exhausted
        const start = (page - 1) * pageSize
        scanRows = kept.slice(start, start + pageSize)
        hasMore = kept.length > start + pageSize
      } else {
        const result = await withDeadline(cachedAgentPage(params), INDEX_DEADLINE_MS, null)
        if (result === null) {
          warning =
            'The public index did not answer this query within twelve seconds. Some of its ' +
            'filters are slow over three hundred thousand rows; the query is not wrong, it ' +
            'is just taking longer than a page should wait. Reload and it will usually be ' +
            'warm.'
        } else {
          readAt = result.readAt
          scanRows = result.page.items
          total = result.page.total
          hasMore = (page - 1) * pageSize + result.page.items.length < result.page.total
        }
      }
    }
  } catch (error) {
    warning =
      'The public index did not answer this query. ' +
      (error instanceof Error ? error.message : 'Unknown error.')
    scanRows = []
  }

  const agentIds = scanRows
    .map((item) => Number(item.token_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0)

  const [evidenceMap, hookConfig] = await Promise.all([
    // Evidence is never cached: it is what decides whether money can move.
    readEvidenceBatch(query.chainId, agentIds),
    // The gate's own parameters are owner-settable but change rarely, so an
    // hour-old read is honest and saves four calls on every page.
    getCachedHookConfig(query.chainId),
  ])
  if (getDeployment(query.chainId) !== null) sources.add('HallmarkHook on-chain')

  let rows = scanRows.map((item) =>
    toRow(query.chainId, item, evidenceMap, hookConfig, item.similarity ?? null, {
      // Only true when the index was asked for verified endpoints and answered
      // with this row: then verification is a property of the query, not a guess
      // about a field the list endpoint never returns.
      indexVerified: query.evidence === 'reachable' ? true : null,
    }),
  )

  // The index cannot rank by Hallmark evidence, so that ordering is applied
  // after the merge. Every other sort is the index's own and is left alone.
  if (query.sort === 'evidence') {
    rows = [...rows].sort(compareByEvidence)
  }

  if (isDiscovery && query.evidence !== 'any') {
    rows = rows.filter((row) => matchesEvidence(row, query.evidence))
  }

  return {
    rows,
    total,
    totalIsExact,
    page,
    pageSize,
    hasMore,
    fetchedAt: readAt,
    sources: [...sources],
    warning,
  }
}

const EVIDENCE_RANK: Record<EvidenceVerdict['status'], number> = {
  'hallmark-fresh': 0,
  'index-reachable': 1,
  'index-checked': 2,
  'hallmark-stale': 3,
  'index-unreachable': 4,
  'never-probed': 5,
  'no-endpoint': 6,
}

function compareByEvidence(a: AgentRow, b: AgentRow): number {
  const rank = EVIDENCE_RANK[a.evidence.status] - EVIDENCE_RANK[b.evidence.status]
  if (rank !== 0) return rank
  if (a.settledJobs !== b.settledJobs) return b.settledJobs - a.settledJobs
  if (a.feedbackCount !== b.feedbackCount) return b.feedbackCount - a.feedbackCount
  return (b.indexScore ?? 0) - (a.indexScore ?? 0)
}

function toRow(
  chainId: SupportedChainId,
  item: ScanAgent,
  evidenceMap: Map<number, HallmarkEvidence>,
  hookConfig: HookConfig | null,
  similarity: number | null,
  known: { indexVerified: boolean | null } = { indexVerified: null },
): AgentRow {
  const agentId = Number(item.token_id)
  const hallmark = evidenceMap.get(agentId) ?? null
  const protocols = item.supported_protocols.map((protocol) => protocol.toUpperCase())
  const declaresEndpoint = protocols.length > 0
  const health = normaliseScanHealth(item.health_score, item.health_score)

  const evidence = classifyEvidence({
    hallmark,
    indexVerified: known.indexVerified,
    indexCheckedAt: null,
    indexHealthScore: item.health_score,
    declaresEndpoint,
    maxEvidenceAge: hookConfig?.maxEvidenceAge ?? 86_400,
  })

  return {
    chainId,
    agentId,
    name: item.name ?? `Agent #${item.token_id}`,
    description: item.description,
    image: item.image_url,
    owner: item.owner_address,
    protocols,
    x402: item.x402_supported,
    declaresEndpoint,
    primaryEndpoint: null,
    evidence,
    hallmark,
    feedbackCount: item.total_feedbacks,
    // An average of zero across zero-valued entries is noise, not information.
    averageFeedbackScore:
      item.total_feedbacks > 0 && item.average_score > 0 ? item.average_score : null,
    settledJobs: hallmark?.jobsCompleted ?? 0,
    indexScore: item.total_score > 0 ? item.total_score : null,
    health,
    categories: classifyByKeyword(item.name, item.description),
    registeredAt: item.created_at,
    indexUpdatedAt: item.updated_at,
    similarity,
  }
}

/**
 * Category discovery, cached.
 *
 * A category page is identical for every visitor and its inputs change on the
 * order of hours, while the four upstream queries behind it cost six to nine
 * seconds — the embedding search alone is usually six. Serving that uncached
 * would make the most important navigation in the product the slowest thing in
 * it.
 *
 * Only the *discovery* is cached. Evidence for the resulting rows is still read
 * live from the hook on every request, so a cached category page never shows a
 * stale liveness verdict — and the page prints the read time either way.
 */
const discoverCategory = unstable_cache(
  async (category: HallmarkCategory, chainId: SupportedChainId) =>
    discoverUncached({
      chainId,
      category,
      protocol: 'any',
      evidence: 'any',
      sort: 'evidence',
      q: null,
      semantic: false,
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    }),
  ['agent-category-discovery'],
  { revalidate: 600, tags: ['discovery'] },
)

async function discover(
  query: AgentQuery,
): Promise<(ScanAgent & { similarity?: number })[]> {
  // A free-text semantic query is per-visitor and cannot be cached usefully.
  if (query.category === null) return discoverUncached(query)
  return discoverCategory(query.category, query.chainId)
}

/**
 * Category and semantic discovery.
 *
 * Runs the embedding query and the keyword queries in parallel and unions the
 * results. The embedding query is precise but recalls little; the keyword
 * queries recall a lot and are imprecise. Neither alone is a usable category
 * page, and the union is deduplicated by token id with the semantic score kept
 * where both matched.
 */
async function discoverUncached(
  query: AgentQuery,
): Promise<(ScanAgent & { similarity?: number })[]> {
  const definition = query.category === null ? null : CATEGORY_DEFINITIONS[query.category]
  const semanticQuery = definition?.semanticQuery ?? query.q
  const keywordQueries = definition?.searchTerms ?? (query.q === null ? [] : [query.q])

  const tasks: Promise<(ScanAgent & { similarity?: number })[]>[] = []

  if (semanticQuery !== null && semanticQuery.trim() !== '') {
    tasks.push(
      withDeadline(
        fetchSemantic(semanticQuery, query.chainId, 30, 0.6)
          .then((page) =>
            page.items.map((item) => ({
              ...(item as unknown as ScanAgent),
              similarity: item.similarity_score,
            })),
          )
          .catch(() => [] as (ScanAgent & { similarity?: number })[]),
        INDEX_DEADLINE_MS,
        [],
      ),
    )
  }

  for (const term of keywordQueries.slice(0, 3)) {
    tasks.push(
      withDeadline(
        fetchAgentPage({
          chain_id: query.chainId,
          search: term,
          limit: 30,
          sort_by: 'total_score',
          sort_order: 'desc',
        })
          .then((page) => page.items as (ScanAgent & { similarity?: number })[])
          .catch(() => [] as (ScanAgent & { similarity?: number })[]),
        INDEX_DEADLINE_MS,
        [],
      ),
    )
  }

  const settled = await Promise.all(tasks)
  const byId = new Map<string, ScanAgent & { similarity?: number }>()
  for (const batch of settled) {
    for (const item of batch) {
      const existing = byId.get(item.token_id)
      if (existing === undefined) {
        byId.set(item.token_id, item)
      } else if (item.similarity !== undefined && existing.similarity === undefined) {
        byId.set(item.token_id, { ...existing, similarity: item.similarity })
      }
    }
  }

  const rows = [...byId.values()]

  // Keyword-only hits are noisy on a query like "grid"; require a category
  // keyword to actually appear before a non-semantic row is kept.
  const filtered =
    definition === null
      ? rows
      : rows.filter((item) => {
          if (item.similarity !== undefined) return true
          return classifyByKeyword(item.name, item.description).some(
            (match) => match.category === definition.id,
          )
        })

  return filtered.sort((a, b) => {
    const sa = a.similarity ?? 0
    const sb = b.similarity ?? 0
    if (sa !== sb) return sb - sa
    return b.total_score - a.total_score
  })
}

/* ------------------------------------------------------------------ */
/* detail                                                              */
/* ------------------------------------------------------------------ */

export type FeedbackWithSource = FeedbackEntry & {
  /** Transaction that wrote this entry, when the index could find it. */
  txHash: string | null
  submittedAt: string | null
  /** keccak256 of the evidence document this rating commits to. */
  evidenceHash: string | null
  /** Where the writer said that document lives. */
  evidenceUri: string | null
  /** The endpoint the rating was measured against. */
  endpoint: string | null
  /**
   * The reviewer's own account of how they measured, when they inlined it as
   * a data URI. Third-party probers on BNB Chain do this and it is the most
   * informative thing on the page — it names their method and their known
   * defects, in their words.
   */
  method: FeedbackMethod | null
}

export type FeedbackMethod = {
  reasoning: string | null
  measuredBy: string | null
  protocol: string | null
  probes: number | null
  answered: number | null
  windowDays: number | null
  medianMs: number | null
  knownDefects: string[]
}

export type ValidationRecord = ValidationStatus & { requestHash: `0x${string}` }

export type AgentDetail = {
  chainId: SupportedChainId
  agentId: number
  /** Null when `ownerOf` reverts, i.e. the agent id was never minted. */
  owner: `0x${string}` | null
  tokenUri: string | null
  cardKind: TokenUriKind
  card: AgentCard | null
  /** Every compromise the parser made, verbatim. Rendered, not hidden. */
  cardWarnings: string[]
  cardError: string | null
  name: string
  description: string | null
  image: string | null
  endpoints: ResolvedEndpoint[]
  declaresEndpoint: boolean
  x402: boolean
  supportedTrust: string[]
  active: boolean

  evidence: EvidenceVerdict
  hallmark: HallmarkEvidence | null
  hookConfig: HookConfig | null

  /** Per-tag reputation, because a blended average across tags means nothing. */
  reputation: {
    clients: `0x${string}`[]
    feedback: FeedbackWithSource[]
    byTag: { tag: string; count: number; mean: number; values: number[] }[]
  }
  validations: ValidationRecord[]

  index: {
    detail: ScanAgentDetail | null
    services: ScanServiceEntry[]
    health: ScanHealth | null
    endpointVerified: boolean | null
    endpointVerifiedDomain: string | null
    endpointCheckedAt: string | null
    endpointError: string | null
    parseWarnings: string[]
    createdTxHash: string | null
  }

  categories: CategoryMatch[]
  fetchedAt: string
  /** Non-fatal problems, so a partial page can say what is missing. */
  notices: string[]
}

/**
 * One agent, everything about it.
 *
 * Wrapped in React's `cache` so `generateMetadata` and the page body share a
 * single read per request instead of doing the whole on-chain + index fetch
 * twice. Per-request only — nothing is carried between requests, because
 * liveness is the one thing on this page that must never be stale.
 */
export const getAgentDetail = cache(async function getAgentDetail(
  chainId: SupportedChainId,
  agentId: number,
): Promise<AgentDetail | null> {
  const reader = readerFor(chainId)
  const notices: string[] = []

  // The chain is the source of truth and answers in milliseconds; the index is
  // a convenience that supplies the transaction hashes and the endpoint
  // verification. So the index gets a deadline and the chain does not — when
  // the index is sick (it returns 500s under load, and a failing call costs ten
  // seconds before the client crosses over to its second base) the page still
  // renders everything that matters, and says the index is missing rather than
  // making the reader wait forty seconds for a second opinion.
  const [onChain, scanDetail, hallmark, hookConfig] = await Promise.all([
    reader.getAgent(agentId).catch(() => null),
    withDeadline(
      fetchAgentDetail(chainId, agentId).catch(() => null),
      INDEX_DETAIL_DEADLINE_MS,
      null,
    ),
    readEvidence(chainId, agentId).catch(() => null),
    readHookConfig(chainId).catch(() => null),
  ])

  if (scanDetail === null) {
    notices.push(
      'The public index did not answer for this agent in time, so this page is built from the ' +
        'chain alone. Everything below is still real — what is missing is the index’s own ' +
        'endpoint check and the transaction hashes beside each rating, which it is the only ' +
        'source for.',
    )
  }

  // The chain decides whether this agent exists. The index can be ahead or
  // behind; it is never the arbiter.
  if (onChain === null && scanDetail === null) return null

  let card: ParseResult | null = onChain?.card ?? null
  // A tokenURI that lives off-chain parses to a failure synchronously. Follow
  // it once, server-side, so an http/ipfs registration file still renders.
  if (card !== null && !card.ok && (card.kind === 'http' || card.kind === 'ipfs')) {
    card = await resolveAgentCard(onChain?.tokenUri ?? '', { timeoutMs: 6_000 }).catch(() => card)
  }
  if (card === null && scanDetail?.raw_metadata?.offchain_uri) {
    card = parseAgentCardFromTokenUri(scanDetail.raw_metadata.offchain_uri)
    notices.push(
      'The on-chain read failed, so this registration file came from the index. ' +
        'Treat it as second-hand until the chain read recovers.',
    )
  }

  const parsedCard = card !== null && card.ok ? card.card : null
  const endpoints = parsedCard === null ? [] : endpointsOf(parsedCard)
  const services = normaliseScanServices(scanDetail?.services)

  // The index sees endpoints the chain read can miss when a registration file
  // is hosted off-chain and the fetch timed out.
  const declaresEndpoint = endpoints.length > 0 || services.some((s) => s.endpoint !== null)

  const evidence = classifyEvidence({
    hallmark,
    indexVerified: scanDetail?.is_endpoint_verified ?? null,
    indexCheckedAt: scanDetail?.endpoint_last_checked_at ?? null,
    indexHealthScore: scanDetail?.health_score ?? null,
    declaresEndpoint,
    maxEvidenceAge: hookConfig?.maxEvidenceAge ?? 86_400,
  })

  const [clients, validationHashes, indexedFeedback] = await Promise.all([
    reader.feedbackClients(agentId).catch(() => null),
    reader.agentValidations(agentId).catch(() => null),
    // Same treatment: the values and tags come from the registry above, and
    // this only adds the transaction that wrote each one.
    withDeadline(
      fetchFeedbacks(chainId, String(agentId)).catch(() => null),
      INDEX_DETAIL_DEADLINE_MS,
      null,
    ),
  ])

  const [feedback, validations] = await Promise.all([
    clients !== null && clients.length > 0
      ? reader.allFeedback(agentId, [], '', '', true).catch(() => null)
      : Promise.resolve([]),
    validationHashes !== null && validationHashes.length > 0
      ? Promise.all(
          validationHashes.slice(0, 24).map(async (hash) => {
            const status = await reader.validationStatus(hash).catch(() => null)
            return status === null ? null : { ...status, requestHash: hash }
          }),
        ).then((rows) => rows.filter((row): row is ValidationRecord => row !== null))
      : Promise.resolve([] as ValidationRecord[]),
  ])

  const name =
    parsedCard?.name ??
    scanDetail?.name ??
    (onChain !== null ? `Agent #${agentId}` : `Agent #${agentId}`)

  const enriched = enrichFeedback(feedback ?? [], indexedFeedback?.items ?? [])

  return {
    chainId,
    agentId,
    owner: onChain?.owner ?? (scanDetail?.owner_address as `0x${string}` | undefined) ?? null,
    tokenUri: onChain?.tokenUri ?? scanDetail?.raw_metadata?.offchain_uri ?? null,
    cardKind: card?.kind ?? 'unknown',
    card: parsedCard,
    cardWarnings: card !== null && card.ok ? card.warnings : [],
    cardError: card !== null && !card.ok ? card.error : null,
    name,
    description: parsedCard?.description ?? scanDetail?.description ?? null,
    image: parsedCard?.image ?? scanDetail?.image_url ?? null,
    endpoints,
    declaresEndpoint,
    x402: parsedCard?.x402Support ?? scanDetail?.x402_supported ?? false,
    supportedTrust: parsedCard?.supportedTrust ?? scanDetail?.supported_trust_models ?? [],
    active: parsedCard?.active ?? scanDetail?.is_active ?? true,

    evidence,
    hallmark,
    hookConfig,

    reputation: {
      clients: clients ?? [],
      feedback: enriched,
      byTag: groupByTag(enriched),
    },
    validations,

    index: {
      detail: scanDetail,
      services,
      health: normaliseScanHealth(
        scanDetail?.health_status ?? null,
        scanDetail?.health_score ?? null,
      ),
      endpointVerified: scanDetail?.is_endpoint_verified ?? null,
      endpointVerifiedDomain: scanDetail?.endpoint_verified_domain ?? null,
      endpointCheckedAt: scanDetail?.endpoint_last_checked_at ?? null,
      endpointError: scanDetail?.endpoint_verification_error ?? null,
      parseWarnings: [
        ...(scanDetail?.parse_status?.warnings ?? []).map((note) => note.message),
        ...(scanDetail?.parse_status?.errors ?? []).map((note) => note.message),
      ],
      createdTxHash: scanDetail?.created_tx_hash ?? null,
    },

    categories: classifyByKeyword(
      name,
      parsedCard?.description ?? scanDetail?.description ?? null,
      endpoints.map((endpoint) => endpoint.kind),
    ),
    fetchedAt: new Date().toISOString(),
    notices,
  }
})

/**
 * Attach the writing transaction and the evidence document to each on-chain
 * feedback entry.
 *
 * `readFeedback` returns the value and the tags but not the `fileuri` and
 * `filehash` — those are only in the `NewFeedback` event, which means either
 * an unbounded `eth_getLogs` walk or asking an indexer that already did it.
 * We ask the indexer, and match on `(client, index)`, which is the registry's
 * own primary key.
 *
 * Everything that comes back this way is attributed to the index on screen.
 * When the index has not caught up the link is simply absent — never guessed.
 */
function enrichFeedback(
  entries: FeedbackEntry[],
  indexed: ScanFeedback[],
): FeedbackWithSource[] {
  const byKey = new Map<string, ScanFeedback>()
  for (const row of indexed) {
    byKey.set(`${row.user_address.toLowerCase()}:${row.feedback_index}`, row)
  }

  return entries.map((entry) => {
    const match = byKey.get(`${entry.client.toLowerCase()}:${entry.index}`)
    return {
      ...entry,
      txHash: match?.transaction_hash ?? null,
      submittedAt: match?.submitted_at ?? null,
      evidenceHash: match?.feedback_hash ?? null,
      evidenceUri: match?.feedback_uri ?? null,
      endpoint: match?.endpoint === '' ? null : (match?.endpoint ?? null),
      method: decodeFeedbackMethod(match?.feedback_uri ?? null),
    }
  })
}

/**
 * Pull a reviewer's stated methodology out of an inlined evidence document.
 *
 * Only `data:` URIs are read, and only synchronously: fetching an arbitrary
 * http URL named by a third party, from our server, on every page render, is
 * an SSRF surface and a latency problem for no gain. An off-site document gets
 * a link instead, which is the honest treatment anyway.
 */
function decodeFeedbackMethod(uri: string | null): FeedbackMethod | null {
  if (uri === null || !uri.startsWith('data:')) return null

  const comma = uri.indexOf(',')
  if (comma === -1) return null
  const header = uri.slice(5, comma)
  const body = uri.slice(comma + 1)

  let text: string
  try {
    text = /;\s*base64/i.test(header)
      ? Buffer.from(body, 'base64').toString('utf8')
      : decodeURIComponent(body)
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const record = parsed as Record<string, unknown>
  const method = (record['method'] ?? {}) as Record<string, unknown>
  const str = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value : null
  const num = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null

  const defects = Array.isArray(method['knownDefects'])
    ? (method['knownDefects'] as unknown[]).filter(
        (item): item is string => typeof item === 'string',
      )
    : []

  const result: FeedbackMethod = {
    reasoning: str(record['reasoning']),
    measuredBy: str(method['measuredBy']),
    protocol: str(method['protocol']),
    probes: num(method['probes']),
    answered: num(method['answered']),
    windowDays: num(method['windowDays']),
    medianMs: num(method['medianMs']),
    knownDefects: defects,
  }

  const hasContent =
    result.reasoning !== null ||
    result.measuredBy !== null ||
    result.probes !== null ||
    defects.length > 0
  return hasContent ? result : null
}

function groupByTag(
  entries: FeedbackWithSource[],
): { tag: string; count: number; mean: number; values: number[] }[] {
  const groups = new Map<string, number[]>()
  for (const entry of entries) {
    if (entry.isRevoked) continue
    const tag = entry.tag1 === '' ? '(untagged)' : entry.tag1
    const bucket = groups.get(tag)
    if (bucket === undefined) groups.set(tag, [entry.score])
    else bucket.push(entry.score)
  }
  return [...groups.entries()]
    .map(([tag, values]) => ({
      tag,
      count: values.length,
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      values,
    }))
    .sort((a, b) => b.count - a.count)
}

/* ------------------------------------------------------------------ */
/* index-wide numbers                                                  */
/* ------------------------------------------------------------------ */

export type EcosystemSnapshot = {
  chainId: SupportedChainId
  /** Agents the registry has minted, as the index counts them. */
  indexed: number
  /** New registrations in the last 24h. */
  dailyNew: number
  /** On-chain feedback entries written against agents on this chain. */
  feedbacks: number
  mcpAgents: number
  a2aAgents: number
  oasfAgents: number
  averageFeedbackScore: number | null
  /** Endpoints the public index has verified as reachable. */
  endpointVerified: number | null
  /** Agents Hallmark has probed and published evidence for. Testnet only. */
  hallmarkProbed: number | null
  fetchedAt: string
}

export async function getEcosystemSnapshot(
  chainId: SupportedChainId,
): Promise<EcosystemSnapshot | null> {
  const { fetchGlobalStats } = await import('./scan')
  try {
    const stats = await fetchGlobalStats()
    const row = stats.chain_stats.find((entry) => entry.chain_id === chainId)
    if (row === undefined) return null

    const verified = await fetchAgentPage({
      chain_id: chainId,
      is_endpoint_verified: true,
      limit: 1,
    })
      .then((page) => page.total)
      .catch(() => null)

    return {
      chainId,
      indexed: row.total_agents,
      dailyNew: row.daily_new_agents,
      feedbacks: row.total_feedbacks,
      mcpAgents: row.mcp_agents,
      a2aAgents: row.a2a_agents,
      oasfAgents: row.oasf_agents,
      averageFeedbackScore: row.average_feedback_score,
      endpointVerified: verified,
      hallmarkProbed: null,
      fetchedAt: new Date().toISOString(),
    }
  } catch {
    return null
  }
}

/** The highest agent id the registry has minted, read from the chain itself. */
export async function getHighestAgentId(
  chainId: SupportedChainId,
  hint?: number,
): Promise<number | null> {
  try {
    const reader = readerFor(chainId)
    const highest = await reader.highestAgentId(
      hint === undefined ? {} : { hint: BigInt(hint) },
    )
    return Number(highest)
  } catch {
    return null
  }
}

export { publicClientFor }
