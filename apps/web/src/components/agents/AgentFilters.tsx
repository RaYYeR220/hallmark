'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState, useTransition } from 'react'

import { Button } from '@/components/ui'

import styles from './agents.module.css'

/**
 * The filter bar.
 *
 * State lives in the URL, not in React. Every filtered view is therefore a
 * link someone can send to a colleague, the back button behaves, and the
 * server component does the fetching — no client-side data layer at all.
 *
 * The one piece of local state is the search input, so typing does not fire a
 * request per keystroke; it commits on submit or after a pause.
 */

const PROTOCOLS = [
  { value: 'any', label: 'Any protocol' },
  { value: 'a2a', label: 'A2A' },
  { value: 'mcp', label: 'MCP' },
  { value: 'x402', label: 'x402' },
  { value: 'oasf', label: 'OASF' },
  { value: 'web', label: 'Web' },
] as const

const EVIDENCE = [
  { value: 'any', label: 'Any evidence' },
  { value: 'reachable', label: 'Probed & reachable' },
  { value: 'unreachable', label: 'Probed, unreachable' },
  { value: 'unprobed', label: 'Never probed' },
] as const

const SORTS = [
  { value: 'evidence', label: 'Evidence strength' },
  { value: 'recent', label: 'Recently registered' },
  { value: 'feedback', label: 'Most on-chain ratings' },
  { value: 'score', label: 'Index score' },
] as const

const CHAINS = [
  { value: '56', label: 'BNB Smart Chain' },
  { value: '97', label: 'BNB testnet' },
] as const

export function AgentFilters({ resultSummary }: { resultSummary?: string }) {
  const router = useRouter()
  const params = useSearchParams()
  const [pending, startTransition] = useTransition()

  const [search, setSearch] = useState(params.get('q') ?? '')

  // Keep the box in step when the URL changes underneath us — a category pill
  // or the back button, for instance.
  useEffect(() => {
    setSearch(params.get('q') ?? '')
  }, [params])

  const push = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(params.toString())
      mutate(next)
      // Any filter change invalidates the current page number.
      next.delete('page')
      startTransition(() => {
        router.push(next.toString() === '' ? '/agents' : `/agents?${next.toString()}`, {
          scroll: false,
        })
      })
    },
    [params, router],
  )

  const setParam = useCallback(
    (key: string, value: string, fallback: string) => {
      push((next) => {
        if (value === fallback) next.delete(key)
        else next.set(key, value)
      })
    },
    [push],
  )

  const semantic = params.get('mode') === 'semantic'
  const hasFilters = ['q', 'category', 'protocol', 'evidence', 'sort', 'mode'].some((key) =>
    params.has(key),
  )

  return (
    <form
      className={styles.filters}
      role="search"
      onSubmit={(event) => {
        event.preventDefault()
        setParam('q', search.trim(), '')
      }}
    >
      <div className={styles.searchRow}>
        <div className={styles.searchField}>
          <label className={styles.controlLabel} htmlFor="agent-search">
            Search
          </label>
          <input
            id="agent-search"
            className={styles.input}
            type="search"
            name="q"
            value={search}
            placeholder={
              semantic
                ? 'Describe the job — “keep my LP position in range”'
                : 'Name or description — “grid”, “venus”, “rebalance”'
            }
            onChange={(event) => setSearch(event.target.value)}
            autoComplete="off"
          />
          <div className={styles.searchModes}>
            <label>
              <input
                type="radio"
                name="mode"
                checked={!semantic}
                onChange={() => setParam('mode', 'keyword', 'keyword')}
              />{' '}
              Keyword
            </label>
            <label>
              <input
                type="radio"
                name="mode"
                checked={semantic}
                onChange={() => setParam('mode', 'semantic', 'keyword')}
              />{' '}
              Semantic
            </label>
            <span className={styles.filterHint}>
              Semantic search runs against 8004scan&rsquo;s embeddings — it finds agents that mean
              what you asked for, in different words.
            </span>
          </div>
        </div>

        <div className={styles.control} style={{ alignSelf: 'flex-start' }}>
          <span className={styles.controlLabel} aria-hidden="true">
            &nbsp;
          </span>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Searching…' : 'Search'}
          </Button>
        </div>
      </div>

      <div className={styles.controlRow}>
        <div className={styles.control}>
          <label className={styles.controlLabel} htmlFor="filter-chain">
            Chain
          </label>
          <select
            id="filter-chain"
            className={styles.select}
            value={params.get('chain') ?? '56'}
            onChange={(event) => setParam('chain', event.target.value, '56')}
          >
            {CHAINS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.control}>
          <label className={styles.controlLabel} htmlFor="filter-protocol">
            Protocol
          </label>
          <select
            id="filter-protocol"
            className={styles.select}
            value={params.get('protocol') ?? 'any'}
            onChange={(event) => setParam('protocol', event.target.value, 'any')}
          >
            {PROTOCOLS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.control}>
          <label className={styles.controlLabel} htmlFor="filter-evidence">
            Evidence status
          </label>
          <select
            id="filter-evidence"
            className={styles.select}
            value={params.get('evidence') ?? 'any'}
            onChange={(event) => setParam('evidence', event.target.value, 'any')}
          >
            {EVIDENCE.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.control}>
          <label className={styles.controlLabel} htmlFor="filter-sort">
            Sort by
          </label>
          <select
            id="filter-sort"
            className={styles.select}
            value={params.get('sort') ?? 'evidence'}
            onChange={(event) => setParam('sort', event.target.value, 'evidence')}
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.filterActions}>
          {resultSummary !== undefined && (
            <span className={styles.filterHint} aria-live="polite">
              {resultSummary}
            </span>
          )}
          {hasFilters && (
            <Button
              type="button"
              variant="ghost"
              size="small"
              onClick={() => {
                setSearch('')
                startTransition(() => router.push('/agents', { scroll: false }))
              }}
            >
              Clear all
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}
