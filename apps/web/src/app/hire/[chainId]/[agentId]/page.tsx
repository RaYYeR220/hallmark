import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { AddressLink, TxLink } from '@/components/chain/links'
import { HireFlow, type HireConfig } from '@/components/hire/HireFlow'
import { RelativeTime } from '@/components/time/RelativeTime'
import {
  Badge,
  ButtonLink,
  Callout,
  Card,
  Row,
  Rows,
  SectionHeading,
  SourceNote,
} from '@/components/ui'
import { getAgentDetail } from '@/lib/agents'
import { parseAgentId, parseChainId } from '@/lib/chain'
import {
  CATEGORY_DEFINITIONS,
  CATEGORY_LIST,
  isCategory,
  type HallmarkCategory,
} from '@/lib/categories'
import { chainLabel, getDeployment, type SupportedChainId } from '@/lib/deployments'
import { sponsorStatus } from '@/lib/env'
import {
  buildScopePreview,
  DEFAULT_BUDGET_U,
  preflightHire,
  type ScopePreview,
} from '@/lib/hire'
import { formatDateTime, formatDuration } from '@/lib/format'

import layout from '@/components/layout/layout.module.css'
import styles from '@/components/hire/hire.module.css'

/**
 * The money flow.
 *
 * Ordered so the refusal comes first when there is one. A user who cannot hire
 * this agent should learn that at the top of the page, before reading a price
 * and a scope they will never use — and should learn it from the same contract
 * call the escrow will make, not from a cached opinion.
 */

export const dynamic = 'force-dynamic'

type PageProps = {
  params: Promise<{ chainId: string; agentId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { chainId, agentId } = await params
  return {
    title: `Hire agent #${agentId}`,
    description:
      `Review the exact contract allowlist, spend cap and expiry an agent on chain ${chainId} ` +
      'would receive, then hire it through an on-chain escrow that refuses stale evidence.',
  }
}

export default async function HirePage({ params, searchParams }: PageProps) {
  const { chainId: chainRaw, agentId: agentRaw } = await params
  const query = await searchParams
  const chainId = parseChainId(chainRaw)
  const agentId = parseAgentId(agentRaw)
  if (chainId === null || agentId === null) notFound()

  const [detail, preflight] = await Promise.all([
    getAgentDetail(chainId, agentId),
    preflightHire(chainId, agentId),
  ])
  if (detail === null) notFound()

  const requested = Array.isArray(query['category']) ? query['category'][0] : query['category']
  // The category picked in the URL wins; otherwise fall back to what the
  // agent's own description suggests, and to rebalancing when it suggests
  // nothing. The choice is always visible and always changeable on the page.
  const category: HallmarkCategory = isCategory(requested)
    ? requested
    : (detail.categories[0]?.category ?? 'rebalancing')
  const definition = CATEGORY_DEFINITIONS[category]
  const scope = buildScopePreview(category, chainId)

  const sponsor = sponsorStatus()
  const deployment = getDeployment(chainId)
  const serverNow = Date.now()

  const config: HireConfig = {
    chainId,
    agentId,
    agentName: detail.name,
    provider: detail.owner,
    commerce: deployment?.commerce ?? null,
    hook: deployment?.hook ?? null,
    paymentToken: deployment?.paymentToken ?? null,
    feeBps: preflight.feeBps,
    hireable: preflight.hireable,
    escrowDeployed: preflight.escrowDeployed,
    defaultTask: definition.exampleTask,
    defaultBudgetU: DEFAULT_BUDGET_U,
    maxSponsoredBudgetU: sponsor.available ? sponsor.maxBudgetU : 0,
    sponsorAvailable: sponsor.available && chainId === 97,
    sponsorReason: sponsor.available
      ? chainId === 97
        ? null
        : 'Sponsored hires run on BNB testnet only — the sponsor key is refused on every other chain.'
      : sponsor.reason,
    sponsorPerHour: sponsor.available ? sponsor.perHour : 0,
  }

  return (
    <div className={`${layout.page} ${layout.pageWide}`}>
      <nav className={layout.breadcrumb} aria-label="Breadcrumb">
        <Link href="/agents">Agents</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/agents/${chainId}/${agentId}`}>{detail.name}</Link>
        <span aria-hidden="true">/</span>
        <span>Hire</span>
      </nav>

      <header className={layout.pageHeader}>
        <SectionHeading
          level={1}
          eyebrow={`${chainLabel(chainId)} · agent #${agentId}`}
          title={`Hire ${detail.name}`}
          lead="Read the scope before you grant it. Everything below is what the chain will actually enforce, not a summary of it."
        />
      </header>

      {preflight.refusal !== null && (
        <div style={{ marginBottom: 'var(--sp-5)' }}>
          <RefusalHero
            preflight={preflight}
            agentId={agentId}
            chainId={chainId}
            serverNow={serverNow}
          />
        </div>
      )}

      <div className={styles.layout}>
        <div className={styles.stack}>
          <Card>
            <h2 className={styles.stepTitle}>2. Review the exact scope</h2>
            <p className={styles.stepLead}>
              Hiring never moves custody. The agent gets a session key that names the contracts it
              may call, caps what it may spend, and expires on its own. These sentences are
              generated from the same policy object that is sent to the chain — they cannot drift
              apart from what is enforced.
            </p>

            <CategoryPicker
              active={category}
              chainId={chainId}
              agentId={agentId}
            />

            <ScopeSentences scope={scope} />

            <div className={styles.callTable}>
              {scope.calls.map((call) => (
                <div key={`${call.to}-${call.signature}`} className={styles.callRow}>
                  <span className={styles.callLabel}>
                    {call.label}
                    {call.signature !== null && (
                      <code className={styles.callSignature}>{call.signature}</code>
                    )}
                  </span>
                  <span>
                    {call.to === null ? (
                      <Badge tone="warn">any contract</Badge>
                    ) : (
                      <AddressLink chainId={chainId} address={call.to} />
                    )}
                  </span>
                </div>
              ))}
            </div>

            {scope.problems.length > 0 && (
              <div style={{ marginTop: 'var(--sp-4)' }}>
                <Callout tone="warn" title="This policy would be rejected before it was granted">
                  <ul style={{ paddingLeft: 'var(--sp-5)', fontSize: 'var(--fs-xs)' }}>
                    {scope.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </Callout>
              </div>
            )}

            <SourceNote>
              Rendered by <code>describePolicy()</code> from{' '}
              <code>@hallmark/altana</code>, over the policy{' '}
              <code>buildPolicy(&apos;{definition.policy}&apos;, {chainId})</code> produces.
            </SourceNote>
          </Card>

          <HireFlow config={config} />
        </div>

        <div className={styles.stack}>
          <Card>
            <SectionHeading eyebrow="The agent" title={detail.name} level={3} />
            <Rows>
              <Row label="Evidence">{detail.evidence.label}</Row>
              <Row label="Last checked">
                <RelativeTime value={detail.evidence.observedAt} serverNow={serverNow} />
              </Row>
              <Row label="Paid to">
                <AddressLink chainId={chainId} address={detail.owner} />
              </Row>
              <Row label="Declared endpoints">{detail.endpoints.length}</Row>
              <Row label="On-chain ratings">{detail.reputation.feedback.length}</Row>
            </Rows>
            <div style={{ marginTop: 'var(--sp-4)' }}>
              <ButtonLink href={`/agents/${chainId}/${agentId}`} size="small">
                Read the full evidence
              </ButtonLink>
            </div>
          </Card>

          <Card muted>
            <SectionHeading eyebrow="What happens on-chain" title="The five calls" level={3} />
            <ol
              style={{
                paddingLeft: 'var(--sp-5)',
                fontSize: 'var(--fs-sm)',
                color: 'var(--text-secondary)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--sp-2)',
              }}
            >
              <li>
                <code>approve(escrow, budget)</code> — for exactly this budget, not unlimited.
              </li>
              <li>
                <code>createJob(provider, evaluator, expiredAt, task, hook)</code> — you are the
                evaluator, so only you can release the money.
              </li>
              <li>
                <code>setBudget(jobId, amount)</code>
              </li>
              <li>
                <code>fund(jobId, amount, abi.encode(agentId))</code> — the evidence gate runs
                here. This is the call that reverts.
              </li>
              <li>
                <code>complete(jobId, reason)</code> — sent with an explicit 450,000 gas limit so
                the ERC-8004 rating actually lands.
              </li>
            </ol>
            {deployment !== null && (
              <SourceNote>
                Escrow <AddressLink chainId={chainId} address={deployment.commerce} /> · hook{' '}
                <AddressLink chainId={chainId} address={deployment.hook} /> · $U{' '}
                <AddressLink chainId={chainId} address={deployment.paymentToken} />
              </SourceNote>
            )}
          </Card>

          <Card muted>
            <SectionHeading eyebrow="Afterwards" title="You keep the leash" level={3} />
            <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
              Every session key you grant shows up on the control panel with a live spend meter, a
              countdown to expiry, its Keystore status read straight off the chain, and a revoke
              button. Refusals appear there too — when the key says no, that is the system working.
            </p>
            <div style={{ marginTop: 'var(--sp-4)' }}>
              <ButtonLink href="/sessions" size="small">
                Open the control panel
              </ButtonLink>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function RefusalHero({
  preflight,
  agentId,
  chainId,
  serverNow,
}: {
  preflight: Awaited<ReturnType<typeof preflightHire>>
  agentId: number
  chainId: SupportedChainId
  serverNow: number
}) {
  const refusal = preflight.refusal
  if (refusal === null) return null
  const refusalTx = process.env['NEXT_PUBLIC_REFUSAL_TX_97']?.trim() ?? ''

  return (
    <div className={styles.refusalCard}>
      <div className={styles.refusalHead}>
        <h2 className={styles.refusalTitle}>{refusal.headline}</h2>
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
          We checked before offering you a button, so this costs you nothing. The check is a
          contract call, not our opinion.
        </p>
      </div>

      <div className={styles.refusalBody}>
        <p>{refusal.detail}</p>

        {refusal.revert !== '' && (
          <code className={styles.revertCode}>
            {`commerce.fund(jobId, budget, abi.encode(${agentId}))\n  ↳ HallmarkHook.beforeAction(fund)\n  ✕ revert ${refusal.revert}`}
          </code>
        )}

        <Rows>
          <Row label="Freshest evidence">
            {preflight.lastEvidenceAt === null ? (
              'none — this agent has never been probed'
            ) : (
              <>
                scored {preflight.score}/100,{' '}
                <RelativeTime
                  value={new Date(preflight.lastEvidenceAt * 1000).toISOString()}
                  serverNow={serverNow}
                />
              </>
            )}
          </Row>
          <Row label="The gate accepts">
            evidence up to {formatDuration(preflight.maxEvidenceAge)} old, scoring at least{' '}
            {preflight.minValidationScore}/100
          </Row>
          {preflight.hook !== null && (
            <Row label="Read from">
              <AddressLink chainId={chainId} address={preflight.hook} label="HallmarkHook" /> at{' '}
              {formatDateTime(preflight.readAt)}
            </Row>
          )}
          {refusalTx !== '' && (
            <Row label="A real refusal">
              <TxLink chainId={97} hash={refusalTx} /> — the same revert, on-chain
            </Row>
          )}
        </Rows>

        <p>
          Most marketplaces would let you pay and find out later.{' '}
          <Link href="/agents?evidence=reachable">
            Browse agents that do have fresh evidence &rarr;
          </Link>
        </p>
      </div>
    </div>
  )
}

function CategoryPicker({
  active,
  chainId,
  agentId,
}: {
  active: string
  chainId: number
  agentId: number
}) {
  return (
    <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap', marginBottom: 'var(--sp-4)' }}>
      {CATEGORY_LIST.map((definition) => (
        <Link
          key={definition.id}
          href={`/hire/${chainId}/${agentId}?category=${definition.id}`}
          style={{
            padding: 'var(--sp-1) var(--sp-3)',
            borderRadius: 'var(--radius-pill)',
            border: `1px solid ${
              active === definition.id ? 'var(--border-accent)' : 'var(--border)'
            }`,
            background:
              active === definition.id ? 'var(--surface-accent-soft)' : 'var(--surface-raised)',
            color: active === definition.id ? 'var(--text-accent)' : 'var(--text-secondary)',
            fontSize: 'var(--fs-sm)',
            textDecoration: 'none',
          }}
          aria-current={active === definition.id ? 'true' : undefined}
        >
          {definition.label}
        </Link>
      ))}
    </div>
  )
}

/**
 * `describePolicy` returns one sentence per line, each beginning with its own
 * verb — "Can call:", "Cannot:", "Revocable:". Rendering the verb as a glyph
 * makes the shape of a permission set readable at a glance without changing a
 * word of what the policy actually says.
 */
function ScopeSentences({ scope }: { scope: ScopePreview }) {
  return (
    <ul className={styles.scopeList}>
      {scope.sentences.map((sentence) => {
        const isCannot = sentence.startsWith('Cannot')
        const isCan = sentence.startsWith('Can ')
        return (
          <li key={sentence} className={styles.scopeItem}>
            <span
              className={`${styles.scopeGlyph} ${
                isCannot ? styles.scopeCannot : isCan ? styles.scopeCan : styles.scopeNeutral
              }`}
              aria-hidden="true"
            >
              {isCannot ? '✕' : isCan ? '✓' : '·'}
            </span>
            <span className={styles.scopeText}>{sentence}</span>
          </li>
        )
      })}
    </ul>
  )
}


