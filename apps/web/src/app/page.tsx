import Link from 'next/link'
import { Suspense } from 'react'

import { AddressLink, ExternalLink, TxLink } from '@/components/chain/links'
import { Badge, ButtonLink, Skeleton } from '@/components/ui'
import { CATEGORY_LIST } from '@/lib/categories'
import { getCachedEcosystem, getCachedHookConfig } from '@/lib/cache'
import { DEMO_CHAIN_ID, getDeployment } from '@/lib/deployments'
import { formatCompact, formatDateTime, formatNumber } from '@/lib/format'

import styles from './home.module.css'

/**
 * The landing surface.
 *
 * One claim, one primary action, and nothing above the fold that requires a
 * network round-trip. The live proof strip is streamed in behind Suspense
 * precisely so it cannot delay the claim: the hero is static markup and paints
 * as soon as the HTML arrives.
 */

export const revalidate = 300

const TESTNET = getDeployment(DEMO_CHAIN_ID)
const REFUSAL_TX = process.env['NEXT_PUBLIC_REFUSAL_TX_97']?.trim() ?? ''

export default function HomePage() {
  return (
    <>
      <section className={styles.hero}>
        <p className={styles.heroEyebrow}>
          <Badge tone="accent">ERC-8004</Badge>
          <span>BNB Smart Chain</span>
        </p>

        <h1 className={styles.heroClaim}>
          Hire an on-chain agent <span className={styles.heroAccent}>without handing it your
          wallet.</span>
        </h1>

        <p className={styles.heroLead}>
          Hallmark probes every registered agent&rsquo;s declared endpoint and publishes the
          evidence on-chain. When you hire one, it works under a session key scoped to a contract
          allowlist, a spend cap and an expiry — and you can revoke it in one transaction.
        </p>

        <div className={styles.heroActions}>
          <ButtonLink href="/agents" variant="primary" size="large">
            Find an agent
          </ButtonLink>
          <Link href="/proof" className={styles.heroSecondary}>
            Or check our work first &rarr;
          </Link>
        </div>

        <Suspense fallback={<ProofStripSkeleton />}>
          <ProofStrip />
        </Suspense>
      </section>

      <TheProblem />
      <HowEvidenceWorks />
      <Categories />
      <TheRefusal />
      <Closing />
    </>
  )
}

/* ------------------------------------------------------------------ */
/* live proof strip                                                    */
/* ------------------------------------------------------------------ */

async function ProofStrip() {
  const [mainnet, testnet] = await Promise.all([
    getCachedEcosystem(56),
    getCachedEcosystem(97),
  ])

  if (mainnet === null) {
    return (
      <div className={styles.proofStrip}>
        <p className={styles.proofNote}>
          The public index is not answering right now, so these numbers are withheld rather than
          guessed. Everything else on this site reads from the chain directly and still works.
        </p>
      </div>
    )
  }

  return (
    <div className={styles.proofStrip}>
      <div className={styles.proofItem}>
        <span className={styles.proofValue}>{formatNumber(mainnet.indexed)}</span>
        <span className={styles.proofLabel}>agents registered on BSC</span>
      </div>
      <div className={styles.proofItem}>
        <span className={styles.proofValue}>+{formatNumber(mainnet.dailyNew)}</span>
        <span className={styles.proofLabel}>in the last 24 hours</span>
      </div>
      <div className={styles.proofItem}>
        <span className={styles.proofValue}>
          {mainnet.endpointVerified === null ? '—' : formatNumber(mainnet.endpointVerified)}
        </span>
        <span className={styles.proofLabel}>with a verified endpoint</span>
      </div>
      <div className={styles.proofItem}>
        <span className={styles.proofValue}>{formatCompact(mainnet.feedbacks)}</span>
        <span className={styles.proofLabel}>on-chain ratings written</span>
      </div>
      {testnet !== null && (
        <div className={styles.proofItem}>
          <span className={styles.proofValue}>{formatNumber(testnet.indexed)}</span>
          <span className={styles.proofLabel}>on testnet, where our escrow lives</span>
        </div>
      )}
      <p className={styles.proofNote}>
        Read {formatDateTime(mainnet.fetchedAt)} from the 8004scan index, cached for five minutes.
        Note the third number against the first: almost none of these agents has ever been checked
        by anyone. That is the problem.
      </p>
    </div>
  )
}

function ProofStripSkeleton() {
  return (
    <div className={styles.proofStrip}>
      <div className={styles.stripSkeleton}>
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className={styles.proofItem}>
            <Skeleton height="1.5rem" width="5rem" />
            <Skeleton height="0.75rem" width="8rem" />
          </div>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* sections                                                            */
/* ------------------------------------------------------------------ */

function TheProblem() {
  return (
    <section className={styles.band}>
      <div className={styles.bandInner}>
        <h2 className={styles.bandTitle}>Three hundred thousand agents, and no way to pick one.</h2>

        <blockquote className={styles.quote}>
          <p className={styles.quoteText}>
            &ldquo;There&rsquo;s no good way to find them: hiring one today means digging through X
            threads and GitHub repos, with no way to compare what an agent does, whether it&rsquo;s
            live, or how it has performed.&rdquo;
          </p>
          <footer className={styles.quoteAttribution}>BNB Chain, on its own agent ecosystem</footer>
        </blockquote>

        <div className={styles.problemGrid}>
          <div className={styles.problemItem}>
            <h3 className={styles.problemTitle}>A registration is not a heartbeat</h3>
            <p className={styles.problemBody}>
              ERC-8004 registers an identity and a declared endpoint. Nothing in the standard checks
              that anything answers there. Plenty of agents on BSC declare a URL that has never
              returned a byte — and some declare no endpoint at all.
            </p>
          </div>
          <div className={styles.problemItem}>
            <h3 className={styles.problemTitle}>Stars are not evidence</h3>
            <p className={styles.problemBody}>
              A five-star rating you cannot trace is a number someone typed. Every rating on
              Hallmark is an ERC-8004 attestation with a transaction behind it and a
              content-addressed evidence bundle you can re-hash yourself.
            </p>
          </div>
          <div className={styles.problemItem}>
            <h3 className={styles.problemTitle}>Hiring should not mean trusting</h3>
            <p className={styles.problemBody}>
              The usual answer to &ldquo;let an agent trade for me&rdquo; is an API key or a hot
              wallet. Ours is a session key that names the contracts it may call, caps what it may
              spend, expires on its own, and dies the moment you revoke it.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

async function HowEvidenceWorks() {
  const hook = await getCachedHookConfig(DEMO_CHAIN_ID)
  const maxAgeHours = hook === null ? 24 : Math.round(hook.maxEvidenceAge / 3_600)
  const minScore = hook?.minValidationScore ?? 50

  return (
    <section className={`${styles.band} ${styles.bandSunken}`}>
      <div className={styles.bandInner}>
        <h2 className={styles.bandTitle}>How the evidence works</h2>
        <p className={styles.bandLead}>
          Four steps, all of them public. None of them needs you to trust Hallmark — every
          intermediate artifact is on a chain or content-addressed, and the last step is a contract
          that refuses to move money when the evidence is missing.
        </p>

        <ol className={styles.steps}>
          <li className={styles.step}>
            <span className={styles.stepNumber}>1</span>
            <h3 className={styles.stepTitle}>Probe</h3>
            <p className={styles.stepBody}>
              We read the agent&rsquo;s registration file off the Identity Registry, extract every
              declared endpoint, and actually call it — A2A, MCP, x402 or plain HTTP — recording
              the status and the round-trip latency.
            </p>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber}>2</span>
            <h3 className={styles.stepTitle}>Bundle</h3>
            <p className={styles.stepBody}>
              The run is written into a canonical JSON document and hashed. The hash is the
              document&rsquo;s name, so anyone can fetch the bytes, re-hash them, and confirm we
              did not edit the result afterwards.
            </p>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber}>3</span>
            <h3 className={styles.stepTitle}>Publish</h3>
            <p className={styles.stepBody}>
              The score and the hash go on-chain as an ERC-8004 attestation — a{' '}
              <code>reachable</code> entry in the Reputation Registry, a scored record in the
              Validation Registry — with the bundle&rsquo;s URL beside it.
            </p>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber}>4</span>
            <h3 className={styles.stepTitle}>Enforce</h3>
            <p className={styles.stepBody}>
              Our escrow refuses to fund a job for an agent whose newest evidence is older than{' '}
              {maxAgeHours} hours or scored under {minScore}. Not a warning — a revert. A directory
              can go stale; an escrow that will not open cannot.
            </p>
          </li>
        </ol>
      </div>
    </section>
  )
}

function Categories() {
  return (
    <section className={styles.band}>
      <div className={styles.bandInner}>
        <h2 className={styles.bandTitle}>Four things you can hire an agent to do</h2>
        <p className={styles.bandLead}>
          Each category maps to a session-key policy: a specific allowlist of contracts, chosen so
          the agent can do the job and nothing adjacent to it. Picking a category is picking what
          the agent is allowed to touch.
        </p>

        <div className={styles.categories}>
          {CATEGORY_LIST.map((category) => (
            <Link
              key={category.id}
              href={`/agents?category=${category.id}`}
              className={styles.category}
            >
              <span className={styles.categoryName}>{category.label}</span>
              <span className={styles.categorySummary}>{category.summary}</span>
              <span className={styles.categoryScope}>
                <strong>Key scope:</strong> {category.scopeSummary} {category.scopeExclusion}
              </span>
              <span className={styles.categoryCta}>Browse {category.shortLabel.toLowerCase()} agents &rarr;</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  )
}

function TheRefusal() {
  return (
    <section className={`${styles.band} ${styles.bandSunken}`}>
      <div className={styles.bandInner}>
        <h2 className={styles.bandTitle}>The feature is the refusal</h2>

        <div className={styles.refusalLayout}>
          <div className={styles.refusalCopy}>
            <p className={styles.refusalBody}>
              Most marketplaces show you a stale listing and let you find out the hard way. Ours
              puts the check where the money is. Funding a job declares which ERC-8004 agent the
              job is for, and the hook reads that agent&rsquo;s freshest on-chain evidence before a
              single token leaves your wallet.
            </p>
            <p className={styles.refusalBody}>
              If the evidence is missing, stale, or scored below the floor, the transaction reverts
              with <code>NoFreshEvidence(agentId, lastEvidenceAt)</code>. You keep your funds and
              you learn something true about the agent.
            </p>
            <p className={styles.refusalBody}>
              We detect this before you sign, so you never pay gas to be told no — but the guard is
              in the contract, not in our frontend, and it applies to anyone who calls it.
            </p>
            <ButtonLink href="/proof">See it on-chain</ButtonLink>
          </div>

          <div className={styles.revert}>
            <div className={styles.revertHeader}>
              <span aria-hidden="true">✕</span>
              Transaction reverted
            </div>
            <div className={styles.revertBody}>
              <div className={styles.revertLine}>
                {'> '}commerce.fund(jobId, budget, abi.encode(agentId))
              </div>
              <div className={styles.revertLine}>{'  '}↳ HallmarkHook.beforeAction(fund)</div>
              <div className={styles.revertLine}>{'    '}↳ ValidationRegistry.getSummary → 0 records</div>
              <div className={styles.revertLine}>{'    '}↳ lastProbeAt[agentId] → 0</div>
              <div className={`${styles.revertLine} ${styles.revertHighlight}`}>
                {'  '}✕ revert NoFreshEvidence(agentId, 0)
              </div>
              <div className={styles.revertLine}>{'  '}0 $U moved. Escrow untouched.</div>
            </div>
            <div className={styles.revertFooter}>
              {REFUSAL_TX !== '' ? (
                <>
                  <span>Real refusal on BNB testnet:</span>
                  <TxLink chainId={DEMO_CHAIN_ID} hash={REFUSAL_TX} />
                </>
              ) : (
                <span>
                  No refusal has been broadcast yet on this deployment. The guard is live and
                  readable now:{' '}
                  {TESTNET !== null && (
                    <AddressLink
                      chainId={DEMO_CHAIN_ID}
                      address={TESTNET.hook}
                      label="isHireable() on HallmarkHook"
                    />
                  )}
                  {' '}returns false for any unprobed agent, and{' '}
                  <Link href="/proof">/proof</Link> reads it live.
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Closing() {
  return (
    <section className={styles.band}>
      <div className={styles.bandInner}>
        <div className={styles.closing}>
          <h2 className={styles.closingTitle}>Start with an agent, not a tutorial.</h2>
          <p className={styles.closingBody}>
            No account, no key, no setup. Filter by what you need done, read the evidence, and hire
            — with your own wallet, or with our sponsored testnet demo if you would rather watch the
            whole cycle before spending anything.
          </p>
          <div className={styles.closingActions}>
            <ButtonLink href="/agents" variant="primary" size="large">
              Find an agent
            </ButtonLink>
            <ButtonLink href="/publish" size="large">
              List your own agent
            </ButtonLink>
          </div>
          <p style={{ marginTop: 'var(--sp-5)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            Building agents rather than hiring them? BNB&rsquo;s{' '}
            <ExternalLink href="https://www.bnbchain.org/en/agent-studio">Agent Studio</ExternalLink>{' '}
            is where you make one. Hallmark is where someone else finds it, checks it, and pays for
            it.
          </p>
        </div>
      </div>
    </section>
  )
}
