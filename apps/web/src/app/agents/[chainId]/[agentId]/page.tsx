import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { AgentAvatar } from '@/components/agents/AgentAvatar'
import { EvidenceBadge } from '@/components/agents/EvidenceBadge'
import {
  AddressLink,
  EvidenceLink,
  ExternalLink,
  HashText,
  TxLink,
} from '@/components/chain/links'
import { RelativeTime } from '@/components/time/RelativeTime'
import {
  Badge,
  ButtonLink,
  Callout,
  Card,
  CardHeader,
  ChipRow,
  CodeBlock,
  EmptyState,
  Row,
  Rows,
  SectionHeading,
  SourceNote,
} from '@/components/ui'
import { getAgentDetail, type AgentDetail, type FeedbackWithSource } from '@/lib/agents'
import { parseAgentId, parseChainId } from '@/lib/chain'
import { CATEGORY_DEFINITIONS } from '@/lib/categories'
import {
  chainLabel,
  getDeployment,
  registries,
  scanAgentUrl,
} from '@/lib/deployments'
import {
  countOf,
  formatDateTime,
  formatDuration,
  formatLatency,
  formatNumber,
  oneLine,
  shortAddress,
  truncate,
} from '@/lib/format'

import layout from '@/components/layout/layout.module.css'
import styles from './detail.module.css'

/**
 * One agent, in as much depth as the chain will give.
 *
 * Structured so that a reader who scrolls the whole page has seen every fact
 * that exists about this agent and where each one came from. Nothing is
 * summarised away: a parser warning is printed verbatim, a missing endpoint is
 * stated plainly, an unprobed agent says so in the same place a probed one
 * would show its score.
 */

export const dynamic = 'force-dynamic'

type PageProps = { params: Promise<{ chainId: string; agentId: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { chainId: chainRaw, agentId: agentRaw } = await params
  const chainId = parseChainId(chainRaw)
  const agentId = parseAgentId(agentRaw)
  if (chainId === null || agentId === null) return { title: 'Agent not found' }

  const detail = await getAgentDetail(chainId, agentId).catch(() => null)
  if (detail === null) return { title: `Agent #${agentId} not found` }

  return {
    title: `${detail.name} · agent #${agentId}`,
    description:
      detail.description === null
        ? `ERC-8004 agent #${agentId} on ${chainLabel(chainId)}. ${detail.evidence.detail}`
        : truncate(oneLine(detail.description), 180),
  }
}

export default async function AgentDetailPage({ params }: PageProps) {
  const { chainId: chainRaw, agentId: agentRaw } = await params
  const chainId = parseChainId(chainRaw)
  const agentId = parseAgentId(agentRaw)
  if (chainId === null || agentId === null) notFound()

  const detail = await getAgentDetail(chainId, agentId)
  if (detail === null) notFound()

  const serverNow = Date.now()
  const deployment = getDeployment(chainId)

  return (
    <div className={`${layout.page} ${layout.pageWide}`}>
      <nav className={layout.breadcrumb} aria-label="Breadcrumb">
        <Link href="/agents">Agents</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/agents?chain=${chainId}`}>{chainLabel(chainId)}</Link>
        <span aria-hidden="true">/</span>
        <span>#{agentId}</span>
      </nav>

      <Header detail={detail} serverNow={serverNow} />

      {detail.notices.map((notice) => (
        <div key={notice} style={{ marginBottom: 'var(--sp-4)' }}>
          <Callout tone="warn" role="status">
            <p>{notice}</p>
          </Callout>
        </div>
      ))}

      <div className={styles.columns}>
        <div className={styles.stack}>
          <EvidencePanel detail={detail} serverNow={serverNow} />
          <ServicesPanel detail={detail} />
          <ReputationPanel detail={detail} serverNow={serverNow} />
          <ValidationPanel detail={detail} serverNow={serverNow} />
          <RegistrationPanel detail={detail} />
        </div>

        <div className={styles.stack}>
          <FactsPanel detail={detail} serverNow={serverNow} />
          <EscrowPanel detail={detail} />
          <IndexPanel detail={detail} serverNow={serverNow} />
          {deployment === null && (
            <Card muted>
              <CardHeader title="Where Hallmark's guard runs" />
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
                Hallmark&rsquo;s escrow and evidence hook are deployed on BNB testnet (97). On{' '}
                {chainLabel(chainId)} this page shows what the ERC-8004 registries and the public
                index know — real data, written by whoever wrote it, but not gated by our contract.
              </p>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginTop: 'var(--sp-3)' }}>
                <Link href="/proof">See exactly what runs where →</Link>
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* header                                                              */
/* ------------------------------------------------------------------ */

function Header({ detail, serverNow }: { detail: AgentDetail; serverNow: number }) {
  const canHire = getDeployment(detail.chainId) !== null

  return (
    <header className={styles.header}>
      <div className={styles.identity}>
        <AgentAvatar
          src={detail.image}
          name={detail.name}
          className={styles.avatar}
          fallbackClassName={styles.avatarFallback}
        />

        <div className={styles.identityText}>
          <h1 className={styles.name}>{detail.name}</h1>

          <div className={styles.subline}>
            <Badge tone="neutral">#{detail.agentId}</Badge>
            <Badge tone={detail.chainId === 56 ? 'neutral' : 'info'}>
              {chainLabel(detail.chainId)}
            </Badge>
            <EvidenceBadge verdict={detail.evidence} />
            {!detail.active && (
              <Badge tone="warn" title="The registration file marks this agent inactive">
                marked inactive
              </Badge>
            )}
            {detail.x402 && <Badge tone="accent">x402</Badge>}
            {detail.categories.slice(0, 2).map((match) => (
              <Badge
                key={match.category}
                title={`Inferred from the description: ${match.terms.join(', ')}`}
              >
                {CATEGORY_DEFINITIONS[match.category].shortLabel}
              </Badge>
            ))}
          </div>

          {detail.description !== null && detail.description.trim() !== '' ? (
            <p className={styles.description}>{detail.description}</p>
          ) : (
            <p className={styles.description} style={{ color: 'var(--text-faint)' }}>
              The registration file carries no description. There is nothing here that says what
              this agent does — which is itself worth knowing before hiring it.
            </p>
          )}
        </div>
      </div>

      <div className={styles.headerActions}>
        {canHire ? (
          <>
            <ButtonLink
              href={`/hire/${detail.chainId}/${detail.agentId}`}
              variant="primary"
              size="large"
            >
              Hire this agent
            </ButtonLink>
            <p className={styles.headerNote}>
              {detail.evidence.status === 'hallmark-fresh'
                ? 'The escrow will accept a job for this agent right now.'
                : 'The escrow will refuse to fund a job for this agent. The hire page shows why, before you sign.'}
            </p>
          </>
        ) : (
          <>
            <ButtonLink href={`/hire/${detail.chainId}/${detail.agentId}`} size="large">
              Review the hire scope
            </ButtonLink>
            <p className={styles.headerNote}>
              Hallmark&rsquo;s escrow is on BNB testnet. On mainnet you can still review exactly
              what a session key would grant.
            </p>
          </>
        )}
        <p className={styles.headerNote}>
          <RelativeTime value={detail.fetchedAt} serverNow={serverNow} prefix="read" />
        </p>
      </div>
    </header>
  )
}

/* ------------------------------------------------------------------ */
/* evidence                                                            */
/* ------------------------------------------------------------------ */

type TimelineEntry = {
  key: string
  at: string | null
  title: string
  detail: string
  tone: 'ok' | 'bad' | 'accent' | 'neutral'
  txHash: string | null
  evidenceHash: string | null
  method: FeedbackWithSource['method']
  endpoint: string | null
}

function buildTimeline(detail: AgentDetail): TimelineEntry[] {
  const entries: TimelineEntry[] = []

  for (const validation of detail.validations) {
    const at = new Date(Number(validation.lastUpdate) * 1000).toISOString()
    entries.push({
      key: `validation-${validation.requestHash}`,
      at,
      title: `Validation scored ${validation.response}/100`,
      detail:
        `Written to the Validation Registry by ${shortAddress(validation.validator)}` +
        (validation.tag === '' ? '' : ` under the tag “${validation.tag}”`) +
        '. The registry stamps its own timestamp, so this record is self-dating.',
      tone: validation.response >= 50 ? 'ok' : 'bad',
      txHash: null,
      evidenceHash: validation.responseHash,
      method: null,
      endpoint: null,
    })
  }

  for (const feedback of detail.reputation.feedback) {
    const isLatency = feedback.tag1 === 'responsetime'
    const isReach = feedback.tag1 === 'reachable' || feedback.tag1 === 'uptime'
    const isJob = feedback.tag1 === 'jobcompleted' || feedback.tag1 === 'jobrejected'

    const title = isLatency
      ? `Latency measured at ${formatLatency(feedback.score)}`
      : isReach
        ? feedback.score > 0
          ? 'Endpoint answered'
          : 'Endpoint did not answer'
        : isJob
          ? feedback.tag1 === 'jobcompleted'
            ? 'Escrow job settled in the agent’s favour'
            : 'Escrow job rejected'
          : `Rated ${feedback.score}${feedback.tag1 === '' ? '' : ` for “${feedback.tag1}”`}`

    entries.push({
      key: `feedback-${feedback.client}-${feedback.index}`,
      at: feedback.submittedAt,
      title,
      detail:
        `ERC-8004 feedback #${feedback.index} from ${shortAddress(feedback.client)}, value ` +
        `${feedback.value}${feedback.valueDecimals > 0 ? ` scaled by 10^${feedback.valueDecimals}` : ''}` +
        `${feedback.tag2 === '' ? '' : `, tagged “${feedback.tag2}”`}` +
        `${feedback.isRevoked ? '. This entry has since been revoked by its author.' : '.'}`,
      tone: feedback.isRevoked
        ? 'neutral'
        : isJob
          ? 'accent'
          : feedback.score > 0
            ? 'ok'
            : 'bad',
      txHash: feedback.txHash,
      evidenceHash: feedback.evidenceHash,
      method: feedback.method,
      endpoint: feedback.endpoint,
    })
  }

  return entries.sort((a, b) => {
    if (a.at === null) return 1
    if (b.at === null) return -1
    return Date.parse(b.at) - Date.parse(a.at)
  })
}

function EvidencePanel({ detail, serverNow }: { detail: AgentDetail; serverNow: number }) {
  const timeline = buildTimeline(detail)
  const hallmark = detail.hallmark
  const config = detail.hookConfig

  return (
    <Card>
      <SectionHeading
        eyebrow="Evidence"
        title="Every observation, and who made it"
        lead="Each entry below is a transaction on BNB Chain. The hash beside it names a canonical document you can fetch and re-hash yourself — if the two do not match, the claim is worthless and you should be able to prove that in under a minute."
      />

      {hallmark !== null && (
        <div style={{ marginBottom: 'var(--sp-5)' }}>
          <Callout
            tone={hallmark.hireable ? 'ok' : 'bad'}
            title={
              hallmark.hireable
                ? 'The escrow will fund a job for this agent'
                : 'The escrow will refuse to fund a job for this agent'
            }
          >
            <p>
              {hallmark.lastEvidenceAt === null ? (
                <>
                  <code>HallmarkHook.isHireable({detail.agentId})</code> returns false with no
                  evidence timestamp at all: nobody has ever published a probe for this agent.
                </>
              ) : (
                <>
                  Freshest evidence scored <strong>{hallmark.score}/100</strong>,{' '}
                  <RelativeTime
                    value={new Date(hallmark.lastEvidenceAt * 1000).toISOString()}
                    serverNow={serverNow}
                  />
                  .{' '}
                  {config !== null && (
                    <>
                      The gate accepts evidence up to{' '}
                      {formatDuration(config.maxEvidenceAge)} old, scoring at least{' '}
                      {config.minValidationScore}.
                    </>
                  )}
                </>
              )}
            </p>
            <p>
              Read live from{' '}
              <AddressLink
                chainId={detail.chainId}
                address={getDeployment(detail.chainId)?.hook ?? null}
                label="HallmarkHook"
              />
              , not from a cache. This is the same predicate <code>fund()</code> evaluates.
            </p>
          </Callout>
        </div>
      )}

      {timeline.length === 0 ? (
        <EmptyState title="Never probed.">
          <p>
            No validation record and no reputation entry exists for this agent on{' '}
            {chainLabel(detail.chainId)}. That is not a rendering gap — the registries are empty
            for agent #{detail.agentId}.
          </p>
          <p>
            {detail.declaresEndpoint
              ? 'It declares an endpoint, so it can be probed. Nobody has.'
              : 'It declares no endpoint, so there is nothing anybody could probe.'}
          </p>
        </EmptyState>
      ) : (
        <ol className={styles.timeline}>
          {timeline.map((entry) => (
            <li key={entry.key} className={styles.timelineItem}>
              <span
                className={`${styles.timelineMark} ${
                  entry.tone === 'ok'
                    ? styles.timelineMarkOk
                    : entry.tone === 'bad'
                      ? styles.timelineMarkBad
                      : entry.tone === 'accent'
                        ? styles.timelineMarkAccent
                        : ''
                }`}
                aria-hidden="true"
              />
              <div className={styles.timelineBody}>
                <div className={styles.timelineHead}>
                  <span className={styles.timelineTitle}>{entry.title}</span>
                  <span className={styles.timelineTime}>
                    {entry.at === null ? (
                      'time not indexed'
                    ) : (
                      <RelativeTime value={entry.at} serverNow={serverNow} />
                    )}
                  </span>
                </div>
                <p className={styles.timelineDetail}>{entry.detail}</p>

                {entry.method !== null && (
                  <div className={styles.timelineMethod}>
                    {entry.method.reasoning !== null && <p>{entry.method.reasoning}</p>}
                    <div className={styles.timelineMethodStats}>
                      {entry.method.measuredBy !== null && (
                        <span>measured by {entry.method.measuredBy}</span>
                      )}
                      {entry.method.protocol !== null && (
                        <span>over {entry.method.protocol}</span>
                      )}
                      {entry.method.probes !== null && (
                        <span>
                          {entry.method.answered ?? '?'}/{entry.method.probes} probes answered
                        </span>
                      )}
                      {entry.method.medianMs !== null && (
                        <span>median {formatLatency(entry.method.medianMs)}</span>
                      )}
                      {entry.method.windowDays !== null && (
                        <span>over {entry.method.windowDays}d</span>
                      )}
                    </div>
                    {entry.method.knownDefects.length > 0 && (
                      <ul className={styles.defects}>
                        {entry.method.knownDefects.map((defect) => (
                          <li key={defect}>{defect}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                <div className={styles.timelineLinks}>
                  {entry.txHash !== null && (
                    <span>
                      transaction: <TxLink chainId={detail.chainId} hash={entry.txHash} />
                    </span>
                  )}
                  {entry.evidenceHash !== null && (
                    <span>
                      evidence: <EvidenceLink hash={entry.evidenceHash} />
                    </span>
                  )}
                  {entry.endpoint !== null && (
                    <span>
                      endpoint:{' '}
                      <ExternalLink href={entry.endpoint} mono>
                        {truncate(entry.endpoint, 44)}
                      </ExternalLink>
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <SourceNote>
        Values, tags and revocation status are read from the ERC-8004 registries on{' '}
        {chainLabel(detail.chainId)}. Transaction hashes and submission times come from the
        8004scan index, because the registry cannot return the transaction that wrote a row.
      </SourceNote>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* services                                                            */
/* ------------------------------------------------------------------ */

function ServicesPanel({ detail }: { detail: AgentDetail }) {
  const card = detail.card
  const services = card?.services ?? []

  return (
    <Card>
      <SectionHeading
        eyebrow="Declared services"
        title="Where this agent says it can be reached"
        lead="Straight from the ERC-8004 registration file. Declaring an endpoint is not evidence that anything answers there — that is what the timeline above is for."
      />

      {services.length === 0 ? (
        <EmptyState title="Declares no endpoint at all.">
          <p>
            The registration file contains no <code>services</code> or <code>endpoints</code>{' '}
            array. There is no URL, no A2A card, no MCP server — nothing to call.
          </p>
          <p>
            An agent in this state can be registered, owned and transferred, and it can accumulate
            ratings from anyone willing to write one. It cannot be reached, verified, or hired.
            Hallmark shows it rather than filtering it out, because &ldquo;this listing is
            unusable&rdquo; is a useful thing to learn in one glance.
          </p>
        </EmptyState>
      ) : (
        <ul className={styles.services}>
          {services.map((service, index) => {
            const resolved = detail.endpoints[index]
            const indexed = detail.index.services.find(
              (entry) => entry.endpoint === service.endpoint,
            )
            const isUrl = /^https?:\/\//i.test(service.endpoint)

            return (
              <li key={`${service.name}-${service.endpoint}`} className={styles.service}>
                <div className={styles.serviceHead}>
                  <Badge tone="info">{(resolved?.kind ?? service.name).toUpperCase()}</Badge>
                  <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)' }}>
                    {service.name}
                  </span>
                  {service.version !== undefined && <Badge>v{service.version}</Badge>}
                </div>

                {isUrl ? (
                  <ExternalLink href={service.endpoint} mono>
                    {service.endpoint}
                  </ExternalLink>
                ) : (
                  <span className={styles.serviceEndpoint}>{service.endpoint}</span>
                )}

                {(service.skills?.length ?? 0) > 0 && (
                  <div className={styles.skills}>
                    {service.skills?.slice(0, 8).map((skill) => (
                      <Badge key={skill}>{skill.split('/').pop() ?? skill}</Badge>
                    ))}
                    {(service.skills?.length ?? 0) > 8 && (
                      <Badge>+{(service.skills?.length ?? 0) - 8} more</Badge>
                    )}
                  </div>
                )}

                {(service.domains?.length ?? 0) > 0 && (
                  <p className={styles.serviceMeta}>
                    Domains: {service.domains?.join(', ')}
                  </p>
                )}

                {indexed !== undefined && detail.index.endpointVerified !== null && (
                  <p className={styles.serviceMeta}>
                    8004scan{' '}
                    {detail.index.endpointVerified
                      ? `verified this domain${
                          detail.index.endpointVerifiedDomain === null
                            ? ''
                            : ` (${detail.index.endpointVerifiedDomain})`
                        }`
                      : `could not verify it${
                          detail.index.endpointError === null
                            ? ''
                            : `: ${detail.index.endpointError}`
                        }`}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* reputation                                                          */
/* ------------------------------------------------------------------ */

function ReputationPanel({ detail, serverNow }: { detail: AgentDetail; serverNow: number }) {
  const { clients, feedback, byTag } = detail.reputation
  const live = feedback.filter((entry) => !entry.isRevoked)

  return (
    <Card>
      <SectionHeading
        eyebrow="ERC-8004 reputation"
        title="Ratings, per tag"
        lead="The registry's own getSummary blends every tag into one number, which is meaningless when one tag is a percentage and another is milliseconds. These are grouped by tag instead."
      />

      {feedback.length === 0 ? (
        <EmptyState title="No on-chain ratings.">
          <p>
            {clients.length === 0
              ? `The Reputation Registry lists no clients for agent #${detail.agentId}: nobody has ever written feedback about it.`
              : `${countOf(clients.length, 'address has', 'addresses have')} interacted with this agent, but no readable feedback entry came back.`}
          </p>
          <p>
            Note what this does <em>not</em> mean: an agent with no ratings is not a bad agent, it
            is an unmeasured one. Hallmark will not invent a score to fill the gap.
          </p>
        </EmptyState>
      ) : (
        <>
          <div className={styles.tagGrid}>
            {byTag.map((group) => (
              <div key={group.tag} className={styles.tagCell}>
                <span className={styles.tagName}>{group.tag}</span>
                <span className={styles.tagValue}>
                  {group.tag === 'responsetime'
                    ? formatLatency(group.mean)
                    : group.mean.toFixed(group.mean % 1 === 0 ? 0 : 1)}
                </span>
                <span className={styles.tagCount}>
                  mean of {countOf(group.count, 'entry', 'entries')}
                </span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 'var(--sp-5)' }}>
            <Rows>
              <Row label="Reviewers">
                <ChipRow>
                  {clients.map((client) => (
                    <AddressLink key={client} chainId={detail.chainId} address={client} />
                  ))}
                </ChipRow>
              </Row>
              <Row label="Entries">
                {countOf(live.length, 'live entry', 'live entries')}
                {feedback.length !== live.length &&
                  `, ${feedback.length - live.length} revoked by their author`}
              </Row>
              <Row label="Registry">
                <AddressLink
                  chainId={detail.chainId}
                  address={registries(detail.chainId).reputationRegistry}
                  copy
                />
              </Row>
            </Rows>
          </div>

          <SourceNote>
            Read with <code>readAllFeedback</code>, including revoked entries — feedback indices
            are 1-based and <code>getSummary</code> reverts on an empty client list, so the client
            set is resolved first. Every entry appears in the timeline above with its transaction.
            Last read <RelativeTime value={detail.fetchedAt} serverNow={serverNow} />.
          </SourceNote>
        </>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

function ValidationPanel({ detail, serverNow }: { detail: AgentDetail; serverNow: number }) {
  return (
    <Card>
      <SectionHeading
        eyebrow="ERC-8004 validation"
        title="Independent validation"
        lead="A validation is a scored assertion by a named validator, with a hash of the document behind it and a timestamp the registry writes itself."
      />

      {detail.validations.length === 0 ? (
        <EmptyState title="No validation record.">
          <p>
            The Validation Registry holds nothing for agent #{detail.agentId} on{' '}
            {chainLabel(detail.chainId)}.
          </p>
          <p>
            Validations are the self-dating half of Hallmark&rsquo;s evidence: unlike reputation
            entries, the registry stamps <code>lastUpdate</code> on every record, so a validator
            cannot backdate one. An agent with no validation has to rely on a prober&rsquo;s own
            clock instead.
          </p>
        </EmptyState>
      ) : (
        <Rows>
          {detail.validations.map((validation) => (
            <Row
              key={validation.requestHash}
              label={validation.tag === '' ? 'untagged' : validation.tag}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
                <span>
                  <strong>{validation.response}/100</strong> by{' '}
                  <AddressLink chainId={detail.chainId} address={validation.validator} />
                  {' · '}
                  <RelativeTime
                    value={new Date(Number(validation.lastUpdate) * 1000).toISOString()}
                    serverNow={serverNow}
                  />
                </span>
                <span style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-faint)' }}>
                  request <HashText value={validation.requestHash} /> · response{' '}
                  <EvidenceLink hash={validation.responseHash} />
                </span>
              </div>
            </Row>
          ))}
        </Rows>
      )}

      <SourceNote>
        Registry:{' '}
        <AddressLink
          chainId={detail.chainId}
          address={registries(detail.chainId).validationRegistry}
        />
        . The response hash links to the exact bytes it commits to.
      </SourceNote>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

function RegistrationPanel({ detail }: { detail: AgentDetail }) {
  const KIND_LABEL: Record<string, string> = {
    'data-json': 'inline JSON data URI',
    'data-json-gzip': 'gzip-compressed JSON data URI',
    http: 'off-chain HTTP document',
    ipfs: 'IPFS document',
    unknown: 'unrecognised',
  }

  return (
    <Card>
      <SectionHeading
        eyebrow="On-chain registration"
        title="The record, exactly as it is"
        lead="What the Identity Registry actually holds for this token, including every compromise our parser had to make to read it."
      />

      <Rows>
        <Row label="Owner">
          <AddressLink chainId={detail.chainId} address={detail.owner} full copy />
        </Row>
        <Row label="Registry">
          <AddressLink
            chainId={detail.chainId}
            address={registries(detail.chainId).identityRegistry}
            full
            copy
          />
        </Row>
        <Row label="Token id">
          <span className="mono">{detail.agentId}</span>
        </Row>
        <Row label="tokenURI form">{KIND_LABEL[detail.cardKind] ?? detail.cardKind}</Row>
        {detail.supportedTrust.length > 0 && (
          <Row label="Trust models">
            <ChipRow>
              {detail.supportedTrust.map((model) => (
                <Badge key={model}>{model}</Badge>
              ))}
            </ChipRow>
          </Row>
        )}
        {detail.index.createdTxHash !== null && (
          <Row label="Registered in">
            <TxLink chainId={detail.chainId} hash={detail.index.createdTxHash} />
          </Row>
        )}
      </Rows>

      {detail.cardError !== null && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Callout tone="bad" title="The registration file could not be parsed">
            <p>
              <code>{detail.cardError}</code>
            </p>
            <p>
              Everything above that came from the card is therefore missing, not empty. The raw
              value is below — judge it yourself.
            </p>
          </Callout>
        </div>
      )}

      {detail.cardWarnings.length > 0 && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Callout tone="warn" title="The parser had to make allowances">
            <p>
              This registration file does not match the ERC-8004 example exactly. We read it
              anyway rather than dropping the agent, and here is every liberty taken:
            </p>
            <ul className={styles.warningList}>
              {detail.cardWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Callout>
        </div>
      )}

      {detail.index.parseWarnings.length > 0 && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Callout tone="info" title="The public index reported its own parse notes">
            <ul className={styles.warningList}>
              {detail.index.parseWarnings.slice(0, 6).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Callout>
        </div>
      )}

      {detail.tokenUri !== null && (
        <details style={{ marginTop: 'var(--sp-4)' }}>
          <summary className={styles.rawToggle}>
            Raw tokenURI ({formatNumber(detail.tokenUri.length)} characters)
          </summary>
          <CodeBlock wrap>{detail.tokenUri}</CodeBlock>
        </details>
      )}

      {detail.card !== null && (
        <details style={{ marginTop: 'var(--sp-2)' }}>
          <summary className={styles.rawToggle}>Parsed registration file</summary>
          <CodeBlock>{JSON.stringify(detail.card, null, 2)}</CodeBlock>
        </details>
      )}
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* sidebar                                                             */
/* ------------------------------------------------------------------ */

function FactsPanel({ detail, serverNow }: { detail: AgentDetail; serverNow: number }) {
  return (
    <Card>
      <CardHeader title="At a glance" />
      <div>
        <div className={styles.sideStat}>
          <span className={styles.sideStatLabel}>Liveness</span>
          <span className={styles.sideStatValue}>
            <EvidenceBadge verdict={detail.evidence} showSource={false} />
          </span>
        </div>
        <div className={styles.sideStat}>
          <span className={styles.sideStatLabel}>Last checked</span>
          <span className={styles.sideStatValue}>
            <RelativeTime value={detail.evidence.observedAt} serverNow={serverNow} />
          </span>
        </div>
        <div className={styles.sideStat}>
          <span className={styles.sideStatLabel}>Declared endpoints</span>
          <span className={styles.sideStatValue}>{detail.endpoints.length}</span>
        </div>
        <div className={styles.sideStat}>
          <span className={styles.sideStatLabel}>On-chain ratings</span>
          <span className={styles.sideStatValue}>
            {formatNumber(detail.reputation.feedback.length)}
          </span>
        </div>
        <div className={styles.sideStat}>
          <span className={styles.sideStatLabel}>Validations</span>
          <span className={styles.sideStatValue}>{formatNumber(detail.validations.length)}</span>
        </div>
        <div className={styles.sideStat}>
          <span className={styles.sideStatLabel}>Registered</span>
          <span className={styles.sideStatValue}>
            {detail.index.detail === null ? (
              '—'
            ) : (
              <RelativeTime value={detail.index.detail.created_at} serverNow={serverNow} />
            )}
          </span>
        </div>
      </div>

      <div style={{ marginTop: 'var(--sp-4)' }}>
        <ExternalLink href={scanAgentUrl(detail.chainId, detail.agentId)}>
          Compare on 8004scan
        </ExternalLink>
      </div>
    </Card>
  )
}

function EscrowPanel({ detail }: { detail: AgentDetail }) {
  const hallmark = detail.hallmark
  if (hallmark === null) return null

  const funded = hallmark.jobsFunded
  const settled = hallmark.jobsCompleted

  return (
    <Card>
      <CardHeader title="Jobs settled through Hallmark" />
      {funded === 0 ? (
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
          No job has ever been funded against this agent through our escrow. This counter only
          moves when real money passes the evidence gate — it can never be inflated by a listing.
        </p>
      ) : (
        <div>
          <div className={styles.sideStat}>
            <span className={styles.sideStatLabel}>Funded</span>
            <span className={styles.sideStatValue}>{formatNumber(funded)}</span>
          </div>
          <div className={styles.sideStat}>
            <span className={styles.sideStatLabel}>Completed</span>
            <span className={styles.sideStatValue}>{formatNumber(settled)}</span>
          </div>
          <div className={styles.sideStat}>
            <span className={styles.sideStatLabel}>Rejected</span>
            <span className={styles.sideStatValue}>{formatNumber(hallmark.jobsRejected)}</span>
          </div>
          <div className={styles.sideStat}>
            <span className={styles.sideStatLabel}>Expired unclaimed</span>
            <span className={styles.sideStatValue}>{formatNumber(hallmark.jobsExpired)}</span>
          </div>
          {hallmark.averageDeliverySeconds !== null && (
            <div className={styles.sideStat}>
              <span className={styles.sideStatLabel}>Median delivery</span>
              <span className={styles.sideStatValue}>
                {formatDuration(hallmark.averageDeliverySeconds)}
              </span>
            </div>
          )}
        </div>
      )}
      <SourceNote>
        Read from <code>HallmarkHook.agentRecord()</code> on {chainLabel(detail.chainId)}.
      </SourceNote>
    </Card>
  )
}

function IndexPanel({ detail, serverNow }: { detail: AgentDetail; serverNow: number }) {
  const health = detail.index.health
  if (detail.index.detail === null) {
    return (
      <Card muted>
        <CardHeader title="Third-party index" />
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
          8004scan has no row for this agent yet. The chain is the source of truth and everything
          above still holds; the index simply has not caught up.
        </p>
      </Card>
    )
  }

  return (
    <Card muted>
      <CardHeader title="Third-party cross-check" meta="8004scan" />
      <p
        style={{
          fontSize: 'var(--fs-xs)',
          color: 'var(--text-secondary)',
          marginBottom: 'var(--sp-3)',
        }}
      >
        Someone else&rsquo;s opinion of the same agent, shown so you can disagree with ours.
      </p>

      <div>
        <div className={styles.sideStat}>
          <span className={styles.sideStatLabel}>Endpoint verified</span>
          <span className={styles.sideStatValue}>
            {detail.index.endpointVerified === null
              ? 'not reported'
              : detail.index.endpointVerified
                ? 'yes'
                : 'no'}
          </span>
        </div>
        {detail.index.endpointCheckedAt !== null && (
          <div className={styles.sideStat}>
            <span className={styles.sideStatLabel}>Checked</span>
            <span className={styles.sideStatValue}>
              <RelativeTime value={detail.index.endpointCheckedAt} serverNow={serverNow} />
            </span>
          </div>
        )}
        {health?.score !== null && health?.score !== undefined && (
          <div className={styles.sideStat}>
            <span className={styles.sideStatLabel}>Health score</span>
            <span className={styles.sideStatValue}>{health.score}</span>
          </div>
        )}
        <div className={styles.sideStat}>
          <span className={styles.sideStatLabel}>Index score</span>
          <span className={styles.sideStatValue}>
            {detail.index.detail.total_score.toFixed(2)}
          </span>
        </div>
        <div className={styles.sideStat}>
          <span className={styles.sideStatLabel}>Indexed</span>
          <span className={styles.sideStatValue}>
            <RelativeTime value={detail.index.detail.updated_at} serverNow={serverNow} />
          </span>
        </div>
      </div>

      {health !== null && health.services.length > 0 && (
        <ul className={styles.healthList} style={{ marginTop: 'var(--sp-4)' }}>
          {health.services.map((service) => (
            <li key={service.service} className={styles.healthItem}>
              <span className={styles.healthService}>{service.service}</span>
              <span>
                {service.status}
                {service.latencyMs !== null && ` · ${formatLatency(service.latencyMs)}`}
              </span>
              {service.verificationError !== null && (
                <span className={styles.healthNote}>{service.verificationError}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {detail.index.endpointCheckedAt !== null && (
        <SourceNote>
          Their check ran {formatDateTime(detail.index.endpointCheckedAt)} — compare that against
          the evidence timeline. A months-old verification is not liveness.
        </SourceNote>
      )}
    </Card>
  )
}
