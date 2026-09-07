import Link from 'next/link'

import { RelativeTime } from '@/components/time/RelativeTime'
import { Badge, EmptyState, Skeleton } from '@/components/ui'
import type { AgentRow } from '@/lib/agents'
import { CATEGORY_DEFINITIONS } from '@/lib/categories'
import { formatNumber, oneLine, truncate } from '@/lib/format'

import { AgentAvatar } from './AgentAvatar'
import styles from './agents.module.css'
import { EvidenceBadge } from './EvidenceBadge'

/**
 * The discovery list.
 *
 * Every column exists because it changes a hiring decision. There is no
 * "listings" count and no star average sitting on its own: an average with no
 * denominator, or a count with no outcome behind it, is decoration. What is
 * here is liveness, when it was last observed, what the agent can be reached
 * over, how many on-chain ratings exist, and how many jobs actually settled.
 *
 * One markup, two layouts: a five-column grid on a wide screen, stacked with
 * per-cell labels below 68rem. No duplicate render, so what a phone shows and
 * what a laptop shows can never drift apart.
 */

export function AgentList({
  rows,
  serverNow,
}: {
  rows: AgentRow[]
  serverNow: number
}) {
  if (rows.length === 0) return null

  return (
    <>
      <div className={styles.rowHead} aria-hidden="true">
        <span>Agent</span>
        <span>Evidence</span>
        <span>Reachable over</span>
        <span>On-chain ratings</span>
        <span>Settled jobs</span>
      </div>

      <ul className={styles.list}>
        {rows.map((row) => (
          <li key={`${row.chainId}-${row.agentId}`}>
            <AgentRowLink row={row} serverNow={serverNow} />
          </li>
        ))}
      </ul>
    </>
  )
}

function AgentRowLink({ row, serverNow }: { row: AgentRow; serverNow: number }) {
  const category = row.categories[0]
  const observedAt = row.evidence.observedAt

  return (
    <Link href={`/agents/${row.chainId}/${row.agentId}`} className={styles.row}>
      <div className={styles.identity}>
        <AgentAvatar
          src={row.image}
          name={row.name}
          className={styles.avatar}
          fallbackClassName={styles.avatarFallback}
        />

        <div className={styles.identityText}>
          <div className={styles.name}>
            {truncate(row.name, 52)}
            <span className={styles.agentId}>#{row.agentId}</span>
            {category !== undefined && (
              <Badge tone="neutral" title="Category inferred from the agent's own description">
                {CATEGORY_DEFINITIONS[category.category].shortLabel}
              </Badge>
            )}
            {row.similarity !== null && (
              <Badge
                tone="info"
                title="Similarity from the index's embedding search — how close this agent's description is to what you asked for"
              >
                {Math.round(row.similarity * 100)}% match
              </Badge>
            )}
          </div>
          {row.description !== null && row.description.trim() !== '' ? (
            <p className={styles.description}>{truncate(oneLine(row.description), 150)}</p>
          ) : (
            <p className={`${styles.description} ${styles.cellMuted}`}>
              No description in the registration file.
            </p>
          )}
        </div>
      </div>

      <div className={styles.cell}>
        <span className={styles.cellLabel}>Evidence</span>
        <EvidenceBadge verdict={row.evidence} showSource={false} />
        <p className={styles.cellNote}>
          {observedAt !== null ? (
            <RelativeTime value={observedAt} serverNow={serverNow} prefix="checked" />
          ) : row.evidence.source === 'none' ? (
            'no observation'
          ) : (
            // The index's list endpoint carries a health score but not the
            // timestamp behind it. Saying "unknown" would imply nobody knows;
            // the detail page reads it and does.
            'timing on the detail page'
          )}
        </p>
      </div>

      <div className={styles.cell}>
        <span className={styles.cellLabel}>Reachable over</span>
        {row.protocols.length === 0 ? (
          <span className={`${styles.cellValue} ${styles.cellMuted}`}>declares none</span>
        ) : (
          <span className={styles.protocolRow}>
            {row.protocols.slice(0, 3).map((protocol) => (
              <Badge key={protocol}>{protocol}</Badge>
            ))}
            {row.x402 && (
              <Badge tone="accent" title="Advertises paid access over the x402 payment protocol">
                x402
              </Badge>
            )}
          </span>
        )}
      </div>

      <div className={styles.cell}>
        <span className={styles.cellLabel}>On-chain ratings</span>
        {row.feedbackCount === 0 ? (
          <span className={`${styles.cellValue} ${styles.cellMuted}`}>none yet</span>
        ) : (
          <>
            <span className={styles.cellValue}>{formatNumber(row.feedbackCount)}</span>
            {row.averageFeedbackScore !== null && (
              <p className={styles.cellNote}>
                mean {row.averageFeedbackScore.toFixed(0)} across tags
              </p>
            )}
          </>
        )}
      </div>

      <div className={styles.cell}>
        <span className={styles.cellLabel}>Settled jobs</span>
        {row.hallmark === null ? (
          <span
            className={`${styles.cellValue} ${styles.cellMuted}`}
            title="Hallmark's escrow is deployed on BNB testnet only, so mainnet agents have no settled-job history here."
          >
            n/a
          </span>
        ) : row.settledJobs === 0 ? (
          <span className={`${styles.cellValue} ${styles.cellMuted}`}>0</span>
        ) : (
          <>
            <span className={styles.cellValue}>{formatNumber(row.settledJobs)}</span>
            <p className={styles.cellNote}>
              of {formatNumber(row.hallmark.jobsFunded)} funded
            </p>
          </>
        )}
      </div>
    </Link>
  )
}

export function AgentListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className={styles.list} aria-label="Loading agents">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index}>
          <div className={styles.skeletonRow}>
            <Skeleton height="2.25rem" />
            <Skeleton height="1.1rem" width="7rem" />
            <Skeleton height="1.1rem" width="5rem" />
            <Skeleton height="1.1rem" width="4rem" />
            <Skeleton height="1.1rem" width="4rem" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * The empty state.
 *
 * Written to be useful rather than apologetic: it says which part of the query
 * is most likely to be responsible, given that some filters legitimately match
 * almost nothing on a registry where five agents out of three hundred thousand
 * have a verified endpoint.
 */
export function AgentListEmpty({
  hasQuery,
  evidenceFilter,
  category,
}: {
  hasQuery: boolean
  evidenceFilter: string
  category: string | null
}) {
  return (
    <EmptyState title="No agents match this combination.">
      {evidenceFilter === 'reachable' ? (
        <p>
          &ldquo;Probed and reachable&rdquo; is a genuinely narrow filter. On BNB Smart Chain only
          a handful of the registered agents have ever had an endpoint verified by anyone — that
          is the gap Hallmark exists to close, not a bug in the search. Try widening the evidence
          filter and reading the per-row verdict instead.
        </p>
      ) : category !== null ? (
        <p>
          Nothing on this chain matched the {category} category. Categories are inferred from what
          each agent says about itself, so an agent that describes its work vaguely will not be
          found here. Clear the category and search by keyword instead.
        </p>
      ) : hasQuery ? (
        <p>
          No agent&rsquo;s name or description matched. Semantic search finds agents that mean the
          same thing in different words — try switching the search mode above.
        </p>
      ) : (
        <p>
          Nothing came back for this combination of filters. Removing the narrowest one usually
          helps.
        </p>
      )}
    </EmptyState>
  )
}
