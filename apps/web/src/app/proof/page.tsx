import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'

import { AddressLink, EvidenceLink, ExternalLink, TxLink } from '@/components/chain/links'
import { RelativeTime } from '@/components/time/RelativeTime'
import {
  Badge,
  Callout,
  Card,
  CodeBlock,
  EmptyState,
  SectionHeading,
  Skeleton,
  SourceNote,
  Stat,
  StatGrid,
} from '@/components/ui'
import { getCachedEcosystem } from '@/lib/cache'
import {
  chainLabel,
  DEMO_CHAIN_ID,
  getDeployment,
  registries,
  scanAgentUrl,
} from '@/lib/deployments'
import { formatDateTime, formatDuration, formatNumber, formatUnitsFixed } from '@/lib/format'
import { getProofSnapshot } from '@/lib/proof'

import layout from '@/components/layout/layout.module.css'
import styles from './proof.module.css'

/**
 * The honesty page.
 *
 * Rule for everything on it: if a claim cannot be turned into a link a
 * stranger can click, it does not belong here. Numbers are read live from the
 * chain at request time — a proof page that serves a cached figure is not
 * proving anything, it is quoting itself.
 */

export const metadata: Metadata = {
  title: 'Proof',
  description:
    'Hallmark’s on-chain artifacts: deployed contracts, the evidence we published, the jobs that ' +
    'settled, and a plain statement of what runs on mainnet versus testnet.',
}

export const dynamic = 'force-dynamic'

export default function ProofPage() {
  return (
    <div className={layout.page}>
      <header className={layout.pageHeader}>
        <SectionHeading
          level={1}
          eyebrow="Verify"
          title="Two transactions, one difference"
          lead="A marketplace that asks you to trust its ratings has not solved the problem it claims to solve. Below are the contracts, the evidence and the settled jobs, all read live from BNB Chain as you loaded this page — but start with the pair. Same contract, same function, same arguments except the agent id."
        />
      </header>

      <div className={styles.stack}>
        <Suspense fallback={<PanelSkeleton title="Reading the two transactions…" />}>
          <ProofPair />
        </Suspense>

        <WhatRunsWhere />

        <Suspense fallback={<PanelSkeleton title="Reading the deployed contracts…" />}>
          <Deployment />
        </Suspense>

        <Suspense fallback={<PanelSkeleton title="Reading the escrow…" />}>
          <Jobs />
        </Suspense>

        <Suspense fallback={<PanelSkeleton title="Reading the evidence we published…" />}>
          <Evidence />
        </Suspense>

        <Registries />

        <Suspense fallback={<PanelSkeleton title="Counting the ecosystem…" />}>
          <Census />
        </Suspense>
      </div>
    </div>
  )
}

function PanelSkeleton({ title }: { title: string }) {
  return (
    <Card>
      <SectionHeading title={title} level={2} />
      <Skeleton height="6rem" />
    </Card>
  )
}

/* ------------------------------------------------------------------ */

function WhatRunsWhere() {
  const testnet = getDeployment(97)

  return (
    <Card>
      <SectionHeading
        eyebrow="Scope"
        title="What runs on mainnet, and what does not"
        level={2}
        lead="Stated first, in plain language, because a demo that blurs this is telling you something untrue about what it has built."
      />

      <div className={styles.split}>
        <div className={styles.whereItem}>
          <p className={styles.whereTitle}>
            BNB Smart Chain <Badge tone="ok">mainnet, live</Badge>
          </p>
          <p className={styles.whereBody}>
            Everything Hallmark <em>reads</em> is real mainnet data.
          </p>
          <ul className={styles.whereList}>
            <li>All 300,000+ ERC-8004 identities, read from the Identity Registry.</li>
            <li>Every registration file, parsed from the chain, warts included.</li>
            <li>Reputation and validation records written by anyone, not just us.</li>
            <li>The four category surfaces, populated with real mainnet agents.</li>
          </ul>
        </div>

        <div className={styles.whereItem}>
          <p className={styles.whereTitle}>
            BNB testnet <Badge tone="info">chain 97</Badge>
          </p>
          <p className={styles.whereBody}>
            Everything Hallmark <em>writes</em> — the escrow, the evidence gate, the ratings that
            come out of settled jobs.
          </p>
          <ul className={styles.whereList}>
            <li>The ERC-8183 escrow and the evidence hook are deployed here.</li>
            <li>Our probe publishes evidence here and the gate enforces it here.</li>
            <li>Sponsored demo hires run here, and only here.</li>
          </ul>
        </div>
      </div>

      <div style={{ marginTop: 'var(--sp-4)' }}>
        <Callout tone="info" title="Why writes are on testnet">
          <p>
            The evidence gate refuses to fund a job without fresh proof of life, which means the
            prober has to publish on the same chain the escrow reads. Running that continuously on
            mainnet costs real BNB per agent per sweep, on an index of three hundred thousand
            agents. The contracts are chain-agnostic and the addresses are in{' '}
            <code>script/Addresses.sol</code> keyed by <code>block.chainid</code>; the deployment
            is a funding decision, not a technical one.
          </p>
          {testnet !== null && (
            <p>
              Testnet escrow: <AddressLink chainId={97} address={testnet.commerce} full copy />
            </p>
          )}
        </Callout>
      </div>
    </Card>
  )
}

async function Deployment() {
  const snapshot = await getProofSnapshot(DEMO_CHAIN_ID)
  const deployment = getDeployment(DEMO_CHAIN_ID)
  const serverNow = Date.now()

  return (
    <Card id="contracts">
      <SectionHeading
        eyebrow="Deployed contracts"
        title="Read live, not quoted"
        level={2}
        lead="Each row shows the address, a value read from that contract just now, and the transaction that deployed it. If the middle column is empty, the read failed and we say so rather than showing a number from memory."
      />

      <ul className={styles.contracts}>
        {snapshot.contracts.map((contract) => (
          <li key={`${contract.label}-${contract.address}`} className={styles.contract}>
            <div>
              <span className={styles.contractLabel}>{contract.label}</span>
              <span className={styles.contractAddress}>
                <AddressLink
                  chainId={DEMO_CHAIN_ID}
                  address={contract.address}
                  full
                  copy
                />
              </span>
            </div>
            <div className={styles.reading}>
              {contract.reading ?? <em>read failed</em>}
              {contract.readingLabel !== '' && (
                <code className={styles.readingLabel}>{contract.readingLabel}</code>
              )}
            </div>
            <div>
              {contract.deployTx !== null ? (
                <TxLink chainId={DEMO_CHAIN_ID} hash={contract.deployTx} label="deploy tx" />
              ) : (
                <span className={styles.readingLabel}>third-party contract</span>
              )}
            </div>
          </li>
        ))}
      </ul>

      {deployment !== null && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <SourceNote>
            Deployment transactions, in order:{' '}
            {deployment.deployTx.map((entry, index) => (
              <span key={entry.hash}>
                {index > 0 && ' · '}
                <TxLink chainId={DEMO_CHAIN_ID} hash={entry.hash} label={entry.label} />
              </span>
            ))}
            . All in block {formatNumber(deployment.deployBlock)}.
          </SourceNote>
        </div>
      )}

      {snapshot.gate !== null && (
        <div style={{ marginTop: 'var(--sp-5)' }}>
          <SectionHeading
            eyebrow="The gate"
            title="What it actually enforces"
            level={3}
            lead="Owner-settable, so these are read from the contract on every page load rather than written down."
          />
          <StatGrid>
            <Stat
              value={formatDuration(snapshot.gate.maxEvidenceAgeSeconds)}
              label="Maximum evidence age"
              note="maxEvidenceAge()"
            />
            <Stat
              value={`${snapshot.gate.minValidationScore}/100`}
              label="Minimum score accepted"
              note="minValidationScore()"
            />
            <Stat
              value={<AddressLink chainId={DEMO_CHAIN_ID} address={snapshot.gate.attestor} />}
              label="The only address that may record a probe"
              note="attestor()"
              small
            />
          </StatGrid>
        </div>
      )}

      <div style={{ marginTop: 'var(--sp-5)' }}>
        <SectionHeading eyebrow="The refusal" title="Watch it say no" level={3} />
        {snapshot.refusalProbe !== null && !snapshot.refusalProbe.hireable ? (
          <>
            <CodeBlock>
              {[
                `# The same call the escrow makes before it moves a token.`,
                `cast call ${deployment?.hook ?? ''} \\`,
                `  "isHireable(uint256)(bool,uint64,uint8)" ${snapshot.refusalProbe.agentId} \\`,
                `  --rpc-url https://bsc-testnet-rpc.publicnode.com`,
                ``,
                `false ${snapshot.refusalProbe.lastEvidenceAt} 0`,
                `# → funding a job for agent #${snapshot.refusalProbe.agentId} reverts with`,
                `#   NoFreshEvidence(${snapshot.refusalProbe.agentId}, ${snapshot.refusalProbe.lastEvidenceAt})`,
              ].join('\n')}
            </CodeBlock>
            <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginTop: 'var(--sp-3)' }}>
              Read {formatDateTime(snapshot.readAt)} against agent #{snapshot.refusalProbe.agentId}{' '}
              on {chainLabel(DEMO_CHAIN_ID)}. The gate refuses it because nobody has ever published
              evidence for it — which is true of almost every agent in the registry, and is the
              gap this product exists to close.
            </p>
          </>
        ) : (
          <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
            The live refusal probe could not be read right now.
          </p>
        )}

        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Callout tone="info" title="This is the read, not the receipt">
            <p>
              The command above evaluates the gate without spending anything. The transaction
              where someone actually paid gas to be told no is at the top of this page, and it
              is the more interesting artifact: a prediction is cheap, a reverted transaction
              is a fact.
            </p>
          </Callout>
        </div>
      </div>

      {snapshot.failures.length > 0 && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Callout tone="warn" title="Some reads did not answer">
            <ul style={{ paddingLeft: 'var(--sp-5)', fontSize: 'var(--fs-xs)' }}>
              {snapshot.failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          </Callout>
        </div>
      )}

      <SourceNote>
        Every value above was read from {chainLabel(DEMO_CHAIN_ID)}{' '}
        <RelativeTime value={snapshot.readAt} serverNow={serverNow} />. This page is never cached.
      </SourceNote>
    </Card>
  )
}

async function Jobs() {
  const snapshot = await getProofSnapshot(DEMO_CHAIN_ID)

  return (
    <Card id="jobs">
      <SectionHeading
        eyebrow="Settled jobs"
        title="Money that actually moved"
        level={2}
        lead="Every job here passed the evidence gate before its tokens were escrowed. The counter cannot be inflated by a listing — only by a funded transaction."
      />

      {snapshot.jobCount === null ? (
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
          The escrow&rsquo;s job count could not be read.
        </p>
      ) : snapshot.jobCount === 0 ? (
        <EmptyState title="No jobs yet.">
          <p>
            <code>jobCount()</code> on the escrow returns 0. Nobody has funded a job through this
            deployment, and rather than showing a demo row we show the zero — a marketplace that
            invents its own volume is exactly the thing this page exists to be the opposite of.
          </p>
          <p>
            Hire an agent with fresh evidence and this table fills up:{' '}
            <Link href="/agents?chain=97&evidence=reachable">testnet agents with evidence →</Link>
          </p>
        </EmptyState>
      ) : (
        <div className="scroll-x">
          <table className={styles.jobTable}>
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Agent</th>
                <th>Budget</th>
                <th>Client</th>
                <th>Provider</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.jobs.map((job) => (
                <tr key={job.jobId}>
                  <td>#{job.jobId}</td>
                  <td>
                    <Badge
                      tone={
                        job.statusName === 'Completed'
                          ? 'ok'
                          : job.statusName === 'Rejected' || job.statusName === 'Expired'
                            ? 'warn'
                            : 'neutral'
                      }
                    >
                      {job.statusName}
                    </Badge>
                  </td>
                  <td>
                    {job.agentId === null ? (
                      <span style={{ color: 'var(--text-faint)' }}>—</span>
                    ) : (
                      <Link href={`/agents/${DEMO_CHAIN_ID}/${job.agentId}`}>#{job.agentId}</Link>
                    )}
                  </td>
                  <td>{formatUnitsFixed(BigInt(job.budget), 18)} $U</td>
                  <td>
                    <AddressLink chainId={DEMO_CHAIN_ID} address={job.client} />
                  </td>
                  <td>
                    <AddressLink chainId={DEMO_CHAIN_ID} address={job.provider} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SourceNote>
        Read from <code>getJob()</code> on the escrow and <code>jobAgent()</code> on the hook,{' '}
        {formatDateTime(snapshot.readAt)}.
      </SourceNote>
    </Card>
  )
}

async function Evidence() {
  const snapshot = await getProofSnapshot(DEMO_CHAIN_ID)
  const serverNow = Date.now()

  return (
    <Card id="evidence">
      <SectionHeading
        eyebrow="Published evidence"
        title="Attestations we wrote, and the documents behind them"
        level={2}
        lead="Each one is an ERC-8004 record on BNB testnet. The hash beside it names a canonical document served at a public URL — fetch it, hash it, and you should get the same value back."
      />

      {snapshot.evidenceWrites.length === 0 ? (
        <EmptyState title="No attestations to show from this reader.">
          <p>
            The Validation Registry returned nothing for the agents this page could enumerate. That
            does not mean none exist — the prober writes them continuously and any agent&rsquo;s
            own page reads its records directly.
          </p>
          <p>
            The worked example:{' '}
            <Link href="/agents/97/2210">agent #2210 on testnet</Link> carries a validation scored
            92 under the tag <code>liveness</code>, plus reputation entries for{' '}
            <code>reachable</code> and <code>responsetime</code>, each with its transaction.
          </p>
        </EmptyState>
      ) : (
        <ul className={styles.writes}>
          {snapshot.evidenceWrites.map((write) => (
            <li key={`${write.kind}-${write.agentId}-${write.evidenceHash}`} className={styles.write}>
              <span className={styles.writeScore}>{write.score}</span>
              <div>
                <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)' }}>
                  {write.label}
                  {write.tag !== '' && (
                    <>
                      {' '}
                      <Badge>{write.tag}</Badge>
                    </>
                  )}
                </span>
                <div className={styles.writeMeta}>
                  <span>
                    by <AddressLink chainId={DEMO_CHAIN_ID} address={write.writer} />
                  </span>
                  {write.at !== null && (
                    <span>
                      <RelativeTime
                        value={new Date(write.at * 1000).toISOString()}
                        serverNow={serverNow}
                      />
                    </span>
                  )}
                  {write.evidenceHash !== null && (
                    <span>
                      evidence <EvidenceLink hash={write.evidenceHash} />
                    </span>
                  )}
                  <span>
                    <Link href={`/agents/${DEMO_CHAIN_ID}/${write.agentId}`}>agent page</Link>
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div style={{ marginTop: 'var(--sp-4)' }}>
        <Callout tone="accent" title="How to check one">
          <p>
            An evidence bundle is content-addressed: its name is the keccak256 of its own canonical
            JSON, and that hash is what goes on-chain as <code>responseHash</code> or{' '}
            <code>feedbackHash</code>. Fetch the bytes from <code>/api/evidence/&lt;hash&gt;</code>
            , canonicalise, hash, compare. If it does not match, the attestation is worthless and
            you have just proved it.
          </p>
          <p>
            The route serves the stored bytes verbatim and refuses to serve a document that fails
            its own integrity check, so a mismatch means the chain and the document disagree — not
            that the server reformatted something.
          </p>
        </Callout>
      </div>
    </Card>
  )
}

function Registries() {
  return (
    <Card id="registries">
      <SectionHeading
        eyebrow="ERC-8004"
        title="The registries everything is read from"
        level={2}
        lead="Not ours. These are the canonical deployments on BNB Chain, and Hallmark is one of many readers."
      />

      <div className={styles.split}>
        {([56, 97] as const).map((chainId) => {
          const contracts = registries(chainId)
          return (
            <div key={chainId} className={styles.whereItem}>
              <p className={styles.whereTitle}>
                {chainLabel(chainId)}
                <Badge tone={chainId === 56 ? 'ok' : 'info'}>chain {chainId}</Badge>
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
                <span className={styles.whereBody}>
                  Identity{' '}
                  <AddressLink chainId={chainId} address={contracts.identityRegistry} full />
                </span>
                <span className={styles.whereBody}>
                  Reputation{' '}
                  <AddressLink chainId={chainId} address={contracts.reputationRegistry} full />
                </span>
                <span className={styles.whereBody}>
                  Validation{' '}
                  <AddressLink chainId={chainId} address={contracts.validationRegistry} full />
                </span>
              </div>
            </div>
          )
        })}
      </div>

      <SourceNote>
        The Identity Registry is ERC-721 based but not Enumerable — there is no{' '}
        <code>totalSupply()</code> and ids are not dense, so Hallmark finds the highest minted id
        by bisecting <code>ownerOf</code> rather than iterating.
      </SourceNote>
    </Card>
  )
}

async function Census() {
  const [mainnet, testnet] = await Promise.all([getCachedEcosystem(56), getCachedEcosystem(97)])
  const serverNow = Date.now()

  if (mainnet === null && testnet === null) {
    return (
      <Card>
        <SectionHeading eyebrow="Census" title="The ecosystem, counted" level={2} />
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
          The public index did not answer. Everything else on this page is a direct chain read and
          is unaffected.
        </p>
      </Card>
    )
  }

  return (
    <Card id="census">
      <SectionHeading
        eyebrow="Census"
        title="The ecosystem, counted"
        level={2}
        lead="The gap between the first number and the third is the entire thesis."
      />

      {([mainnet, testnet] as const).map(
        (snapshot) =>
          snapshot !== null && (
            <div key={snapshot.chainId} style={{ marginBottom: 'var(--sp-5)' }}>
              <p
                style={{
                  fontSize: 'var(--fs-sm)',
                  fontWeight: 'var(--fw-medium)',
                  marginBottom: 'var(--sp-3)',
                }}
              >
                {chainLabel(snapshot.chainId)}
              </p>
              <div className={styles.census}>
                <Stat value={formatNumber(snapshot.indexed)} label="agents registered" />
                <Stat value={`+${formatNumber(snapshot.dailyNew)}`} label="in the last 24h" />
                <Stat
                  value={
                    snapshot.endpointVerified === null
                      ? '—'
                      : formatNumber(snapshot.endpointVerified)
                  }
                  label="with a verified endpoint"
                />
                <Stat value={formatNumber(snapshot.feedbacks)} label="on-chain ratings" />
                <Stat value={formatNumber(snapshot.a2aAgents)} label="declaring A2A" />
                <Stat value={formatNumber(snapshot.mcpAgents)} label="declaring MCP" />
              </div>
            </div>
          ),
      )}

      <SourceNote>
        From{' '}
        <ExternalLink href="https://8004scan.io/api/v1/stats/global">
          8004scan&rsquo;s global stats
        </ExternalLink>
        , cached five minutes, read{' '}
        <RelativeTime value={mainnet?.fetchedAt ?? new Date().toISOString()} serverNow={serverNow} />
        . Cross-check any single agent against{' '}
        <ExternalLink href={scanAgentUrl(56, 1)}>their page for the same agent</ExternalLink>.
      </SourceNote>
    </Card>
  )
}


/* ------------------------------------------------------------------ */
/* the pair                                                            */
/* ------------------------------------------------------------------ */

/**
 * The lead.
 *
 * Every other section on this page is evidence that the machinery exists.
 * This one is evidence that it *bites*, and it is the only argument on the
 * site that cannot be made with a screenshot: two transactions to the same
 * address, carrying the same four-byte selector, differing in one argument.
 * One burned 85,520 gas and moved nothing. The other paid an agent and wrote
 * a rating that is still readable.
 */
async function ProofPair() {
  const deployment = getDeployment(DEMO_CHAIN_ID)
  if (deployment === null) return null

  const { refused, settled } = deployment.proofPair
  const snapshot = await getProofSnapshot(DEMO_CHAIN_ID)
  const receipt = snapshot.settlementReceipt

  // Read the settled agent's evidence rather than restating it.
  //
  // This block used to carry a hard-coded "score 92, tag liveness, within
  // 24h". All three drifted the moment the agent was re-probed, and a proof
  // page that quotes a number the chain no longer holds is worse than one that
  // quotes nothing. Everything here now comes from the same read the rest of
  // the page renders.
  const settledEvidence = snapshot.evidenceWrites
    .filter((write) => write.agentId === settled.agentId && write.kind === 'validation')
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0]
  const settledScore =
    settledEvidence?.score ??
    snapshot.ourAgents.find((agent) => agent.agentId === settled.agentId)?.score ??
    null
  const window =
    snapshot.gate === null ? null : formatDuration(snapshot.gate.maxEvidenceAgeSeconds)

  return (
    <Card id="pair">
      <SectionHeading
        eyebrow="The whole argument"
        title="One agent had evidence. One did not."
        level={2}
        lead="Both of these are calls to fund() on the same escrow, with the same selector 0xd2e13f50, made by the same address, minutes apart. The only thing that differs is which ERC-8004 agent the job declared."
      />

      <div className={styles.pair}>
        <div className={`${styles.pairSide} ${styles.pairRefused}`}>
          <div className={`${styles.pairHead} ${styles.pairHeadRefused}`}>
            <span className={`${styles.pairVerdict} ${styles.pairVerdictRefused}`}>
              <span aria-hidden="true">✕</span> Reverted
            </span>
            <span className={styles.pairAgent}>
              Agent #{refused.agentId} — a real third-party agent nobody has ever validated
            </span>
          </div>
          <div className={styles.pairBody}>
            <code className={`${styles.pairCode} ${styles.pairCodeBad}`}>
              {`fund(jobId, budget, abi.encode(${refused.agentId}))
  ↳ HallmarkHook.beforeAction(fund)
  ✕ revert ${refused.error}`}
            </code>
            <div className={styles.pairRow}>
              <span className={styles.pairKey}>Status</span>
              <span className={styles.pairValue}>0x0 — reverted</span>
            </div>
            <div className={styles.pairRow}>
              <span className={styles.pairKey}>Gas burned</span>
              <span className={styles.pairValue}>85,520</span>
            </div>
            <div className={styles.pairRow}>
              <span className={styles.pairKey}>Tokens moved</span>
              <span className={styles.pairValue}>none — the escrow never opened</span>
            </div>
            <div className={styles.pairRow}>
              <span className={styles.pairKey}>Error selector</span>
              <span className={styles.pairValue}>
                <code>0x8b12be6b</code>
              </span>
            </div>
          </div>
          <div className={styles.pairFooter}>
            <span>The refusal:</span>
            <TxLink chainId={DEMO_CHAIN_ID} hash={refused.hash} />
          </div>
        </div>

        <div className={`${styles.pairSide} ${styles.pairSettled}`}>
          <div className={`${styles.pairHead} ${styles.pairHeadSettled}`}>
            <span className={`${styles.pairVerdict} ${styles.pairVerdictSettled}`}>
              <span aria-hidden="true">✓</span> Funded, delivered, settled
            </span>
            <span className={styles.pairAgent}>
              Agent #{settled.agentId} — validated
              {settledScore === null ? '' : `, score ${settledScore}`}
              {settledEvidence === undefined ? null : (
                <>
                  , tag <code>{settledEvidence.tag}</code>
                </>
              )}
            </span>
          </div>
          <div className={styles.pairBody}>
            <code className={styles.pairCode}>
              {`fund(jobId, budget, abi.encode(${settled.agentId}))
  ↳ HallmarkHook.beforeAction(fund)
  ✓ evidence ${settledScore ?? '?'}/100, within ${window ?? 'the gate’s window'}
  ↳ escrow funded
complete(jobId, reason)
  ↳ HallmarkHook.afterAction(complete)
  ✓ giveFeedback(${settled.agentId}, 100, "jobcompleted")`}
            </code>
            <div className={styles.pairRow}>
              <span className={styles.pairKey}>Status</span>
              <span className={styles.pairValue}>0x1 — both transactions succeeded</span>
            </div>
            <div className={styles.pairRow}>
              <span className={styles.pairKey}>Settlement gas</span>
              <span className={styles.pairValue}>
                285,280 used, 450,000 sent
              </span>
            </div>
            <div className={styles.pairRow}>
              <span className={styles.pairKey}>Result</span>
              <span className={styles.pairValue}>
                provider paid, ERC-8004 rating written by the hook
              </span>
            </div>
          </div>
          <div className={styles.pairFooter}>
            <span>Fund:</span>
            <TxLink chainId={DEMO_CHAIN_ID} hash={settled.fund} />
            <span>Settle:</span>
            <TxLink chainId={DEMO_CHAIN_ID} hash={settled.complete} />
          </div>
        </div>
      </div>

      <div className={styles.sameness}>
        <strong>What is identical, so you can rule it out:</strong>
        <ul className={styles.samenessList}>
          <li>
            Same contract — <code>{deployment.commerce}</code>
          </li>
          <li>
            Same function selector — <code>0xd2e13f50</code>, which is{' '}
            <code>fund(uint256,uint256,bytes)</code>
          </li>
          <li>
            Same caller — <AddressLink chainId={DEMO_CHAIN_ID} address={deployment.attestor} />
          </li>
          <li>
            Same hook attached to both jobs —{' '}
            <AddressLink chainId={DEMO_CHAIN_ID} address={deployment.hook} />
          </li>
          <li>
            Different <code>agentId</code> in <code>optParams</code>. That is the entire
            difference, and it decided whether money could move.
          </li>
        </ul>
      </div>

      {receipt !== null && (
        <div className={styles.receipt}>
          {receipt.error !== null ? (
            <Callout tone="warn" title="The rating could not be re-read just now">
              <p>{receipt.error}</p>
              <p>
                The settlement transaction above is still a receipt; this is only the live
                cross-check failing, and it says so rather than asserting a number it did not get.
              </p>
            </Callout>
          ) : receipt.count > 0 ? (
            <Callout tone="ok" title="And the rating is still there — read a moment ago">
              <p>
                <code>
                  getSummary({receipt.agentId}, [hook], &quot;jobcompleted&quot;, &quot;&quot;)
                </code>{' '}
                returns <strong>({receipt.count}, {receipt.value}, 0)</strong> on the ERC-8004
                Reputation Registry, and the hook&rsquo;s own address appears in{' '}
                <code>getClients({receipt.agentId})</code>
                {receipt.hookIsClient ? '' : ' — except it does not right now, which is worth investigating'}
                .
              </p>
              <p>
                That is the point of the whole exercise: this rating exists because a job settled,
                not because anyone typed it. Nobody can write one without first passing the gate on
                the left.
              </p>
            </Callout>
          ) : (
            <Callout tone="warn" title="The registry reports no rating from the hook">
              <p>
                <code>getSummary({receipt.agentId}, [hook], &quot;jobcompleted&quot;, &quot;&quot;)</code>{' '}
                returned a count of zero. The settlement transaction is still linked above; if this
                persists, the receipt did not land and the page will keep saying so.
              </p>
            </Callout>
          )}
        </div>
      )}

      <SourceNote>
        Transaction hashes are configuration — a receipt does not change. The rating beside them is
        re-read from the Reputation Registry on every request, so if it ever disappears this page
        stops claiming it.
      </SourceNote>
    </Card>
  )
}
