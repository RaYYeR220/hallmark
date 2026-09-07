import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'

import { AgentFilters } from '@/components/agents/AgentFilters'
import { AgentList, AgentListEmpty, AgentListSkeleton } from '@/components/agents/AgentList'
import { ButtonLink, Callout, SectionHeading, SourceNote } from '@/components/ui'
import { RelativeTime } from '@/components/time/RelativeTime'
import {
  DEFAULT_PAGE_SIZE,
  listAgents,
  type AgentQuery,
  type EvidenceQuery,
  type ProtocolFilter,
  type SortKey,
} from '@/lib/agents'
import { CATEGORY_DEFINITIONS, CATEGORY_LIST, isCategory } from '@/lib/categories'
import { chainLabel, getDeployment } from '@/lib/deployments'
import { formatNumber } from '@/lib/format'
import type { SupportedChainId } from '@/lib/deployments'

import layout from '@/components/layout/layout.module.css'
import styles from '@/components/agents/agents.module.css'

export const metadata: Metadata = {
  title: 'Find an agent',
  description:
    'Every ERC-8004 agent on BNB Smart Chain, filterable by category, protocol and evidence status. ' +
    'Each row shows liveness, when it was last checked, and how many jobs actually settled.',
}

// Filters live in the URL and every combination hits the live index, so this
// page is rendered per request rather than pre-generated.
export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

function one(params: SearchParams, key: string): string | null {
  const value = params[key]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function parseQuery(params: SearchParams): AgentQuery {
  const chainRaw = one(params, 'chain')
  const chainId: SupportedChainId = chainRaw === '97' ? 97 : 56

  const categoryRaw = one(params, 'category')
  const protocolRaw = one(params, 'protocol')
  const evidenceRaw = one(params, 'evidence')
  const sortRaw = one(params, 'sort')
  const pageRaw = one(params, 'page')
  const q = one(params, 'q')?.trim() ?? null

  const protocols: ProtocolFilter[] = ['any', 'a2a', 'mcp', 'x402', 'web', 'oasf']
  const evidences: EvidenceQuery[] = ['any', 'reachable', 'unreachable', 'unprobed']
  const sorts: SortKey[] = ['evidence', 'recent', 'feedback', 'score']

  return {
    chainId,
    category: isCategory(categoryRaw) ? categoryRaw : null,
    protocol: protocols.includes(protocolRaw as ProtocolFilter)
      ? (protocolRaw as ProtocolFilter)
      : 'any',
    evidence: evidences.includes(evidenceRaw as EvidenceQuery)
      ? (evidenceRaw as EvidenceQuery)
      : 'any',
    sort: sorts.includes(sortRaw as SortKey) ? (sortRaw as SortKey) : 'evidence',
    q: q === '' ? null : q,
    semantic: one(params, 'mode') === 'semantic',
    page: Math.max(1, Number(pageRaw ?? '1') || 1),
    pageSize: DEFAULT_PAGE_SIZE,
  }
}

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const query = parseQuery(params)
  const category = query.category === null ? null : CATEGORY_DEFINITIONS[query.category]

  return (
    <div className={`${layout.page} ${layout.pageWide}`}>
      <header className={layout.pageHeader}>
        <SectionHeading
          level={1}
          eyebrow={`${chainLabel(query.chainId)} · ERC-8004`}
          title={category === null ? 'Find an agent' : `${category.label} agents`}
          lead={
            category === null
              ? 'Every registered agent on the chain, with what is actually known about each one. Nothing here is a self-reported rating.'
              : category.jobDescription
          }
        />

        <CategoryRail active={query.category} chainId={query.chainId} />
      </header>

      <AgentFilters />

      <Suspense key={JSON.stringify(params)} fallback={<LoadingResults />}>
        <Results query={query} />
      </Suspense>
    </div>
  )
}

function CategoryRail({
  active,
  chainId,
}: {
  active: string | null
  chainId: SupportedChainId
}) {
  const chainParam = chainId === 56 ? '' : `&chain=${chainId}`
  return (
    <nav className={styles.categoryRail} aria-label="Agent categories">
      <Link
        href={chainId === 56 ? '/agents' : `/agents?chain=${chainId}`}
        className={`${styles.categoryPill} ${active === null ? styles.categoryPillActive : ''}`}
        aria-current={active === null ? 'page' : undefined}
      >
        All agents
      </Link>
      {CATEGORY_LIST.map((definition) => (
        <Link
          key={definition.id}
          href={`/agents?category=${definition.id}${chainParam}`}
          className={`${styles.categoryPill} ${
            active === definition.id ? styles.categoryPillActive : ''
          }`}
          aria-current={active === definition.id ? 'page' : undefined}
          title={definition.summary}
        >
          {definition.label}
        </Link>
      ))}
    </nav>
  )
}

function LoadingResults() {
  return (
    <>
      <div className={styles.resultBar}>
        <span>Reading the registry…</span>
      </div>
      <AgentListSkeleton />
    </>
  )
}

async function Results({ query }: { query: AgentQuery }) {
  const result = await listAgents(query)
  const serverNow = Date.now()
  const deployment = getDeployment(query.chainId)

  const from = (result.page - 1) * result.pageSize + 1
  const to = from + result.rows.length - 1

  return (
    <>
      <div className={styles.resultBar}>
        <span>
          {result.rows.length === 0 ? (
            'No matches'
          ) : (
            <>
              <span className={styles.resultCount}>
                {formatNumber(from)}–{formatNumber(to)}
              </span>{' '}
              of {result.totalIsExact ? formatNumber(result.total) : `${formatNumber(result.total)}+`}{' '}
              {/* A floor rather than a total, for two different reasons: either
                  the index cannot count this filter server-side, or the index
                  is down and these came from the chain. The banner above says
                  which, so this stays neutral. */}
              {result.totalIsExact ? '' : '(a floor, not a total) '}
              agents
            </>
          )}
        </span>
        <span>
          Read <RelativeTime value={result.fetchedAt} serverNow={serverNow} /> · sources:{' '}
          {result.sources.join(', ')}
        </span>
      </div>

      {result.warning !== null && (
        <Callout tone="warn" title="Partial results" role="status">
          <p>{result.warning}</p>
          <p>
            The chain is still readable — open any agent directly at{' '}
            <code>/agents/{query.chainId}/&lt;id&gt;</code> and the detail page will render from
            the registry alone.
          </p>
        </Callout>
      )}

      {deployment === null && query.chainId === 56 && (
        <Callout tone="info" role="status">
          <p>
            Hallmark&rsquo;s escrow and evidence hook are deployed on BNB testnet. On mainnet these
            rows show what the ERC-8004 registries and the public index know — real, but not
            enforced by our contract. Switch the chain filter to BNB testnet to see agents behind
            the funding gate.
          </p>
        </Callout>
      )}

      {result.rows.length === 0 ? (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <AgentListEmpty
            hasQuery={query.q !== null}
            evidenceFilter={query.evidence}
            category={query.category}
          />
        </div>
      ) : (
        <AgentList rows={result.rows} serverNow={serverNow} />
      )}

      <Pagination query={query} hasMore={result.hasMore} page={result.page} />

      <SourceNote>
        Rows come from the 8004scan index; the evidence column on BNB testnet is read live from{' '}
        <code>HallmarkHook.isHireable()</code>. Category labels are inferred from each
        agent&rsquo;s own description and are never authoritative — the agent&rsquo;s registration
        file is, and it is shown in full on every detail page.
      </SourceNote>
    </>
  )
}

function Pagination({
  query,
  hasMore,
  page,
}: {
  query: AgentQuery
  hasMore: boolean
  page: number
}) {
  const build = (target: number): string => {
    const next = new URLSearchParams()
    if (query.chainId !== 56) next.set('chain', String(query.chainId))
    if (query.category !== null) next.set('category', query.category)
    if (query.protocol !== 'any') next.set('protocol', query.protocol)
    if (query.evidence !== 'any') next.set('evidence', query.evidence)
    if (query.sort !== 'evidence') next.set('sort', query.sort)
    if (query.q !== null) next.set('q', query.q)
    if (query.semantic) next.set('mode', 'semantic')
    if (target > 1) next.set('page', String(target))
    return next.toString() === '' ? '/agents' : `/agents?${next.toString()}`
  }

  if (page === 1 && !hasMore) return null

  return (
    <nav className={styles.pagination} aria-label="Pagination">
      <span className={styles.pageInfo}>Page {formatNumber(page)}</span>
      <div className={styles.pageLinks}>
        {page > 1 && (
          <ButtonLink href={build(page - 1)} size="small">
            ← Previous
          </ButtonLink>
        )}
        {hasMore && (
          <ButtonLink href={build(page + 1)} size="small">
            Next →
          </ButtonLink>
        )}
      </div>
    </nav>
  )
}
