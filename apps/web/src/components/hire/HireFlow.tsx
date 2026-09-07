'use client'

import Link from 'next/link'
import { useCallback, useMemo, useState } from 'react'
import { encodeAbiParameters, parseUnits, type Address, type Hex } from 'viem'

import { sponsoredHire, type HireStep, type SponsoredHireResult } from '@/app/actions/hire'
import { TxLink } from '@/components/chain/links'
import { Badge, Button, Callout, Card, SourceNote } from '@/components/ui'
import { describeWalletError, useWallet } from '@/components/wallet/WalletProvider'
import {
  erc20Abi,
  hallmarkCommerceAbi,
  SETTLEMENT_GAS_LIMIT,
} from '@/lib/abi'
import { chainLabel, explorerTxUrl } from '@/lib/deployments'

import styles from './hire.module.css'

/**
 * The hire flow, client side.
 *
 * Two paths, and both really run. The wallet path signs five transactions from
 * the visitor's own wallet against the deployed escrow; the sponsored path
 * runs the identical sequence server-side on testnet for someone who has no
 * wallet at all. Neither is a mock, and the sponsored one is labelled as
 * sponsored everywhere it appears.
 *
 * Every transaction is linked the moment it has a hash, including the ones
 * that fail. A step that stops is shown stopped, with what the chain said.
 */

export type HireConfig = {
  chainId: number
  agentId: number
  agentName: string
  provider: Address | null
  commerce: Address | null
  hook: Address | null
  paymentToken: Address | null
  feeBps: number
  hireable: boolean
  escrowDeployed: boolean
  defaultTask: string
  defaultBudgetU: string
  maxSponsoredBudgetU: number
  sponsorAvailable: boolean
  sponsorReason: string | null
  sponsorPerHour: number
}

type RunStatus = 'idle' | 'running' | 'done'

export function HireFlow({ config }: { config: HireConfig }) {
  const wallet = useWallet()

  const [task, setTask] = useState(config.defaultTask)
  const [budget, setBudget] = useState(config.defaultBudgetU)
  const [status, setStatus] = useState<RunStatus>('idle')
  const [current, setCurrent] = useState<string | null>(null)
  const [steps, setSteps] = useState<HireStep[]>([])
  const [summary, setSummary] = useState<SponsoredHireResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)

  const quote = useMemo(() => {
    try {
      const atomic = parseUnits(budget.trim(), 18)
      if (atomic <= 0n) return null
      const fee = (atomic * BigInt(config.feeBps)) / 10_000n
      return {
        atomic,
        fee,
        net: atomic - fee,
      }
    } catch {
      return null
    }
  }, [budget, config.feeBps])

  const reset = () => {
    setSteps([])
    setSummary(null)
    setError(null)
    setJobId(null)
    setCurrent(null)
  }

  /* --- sponsored ------------------------------------------------------- */

  const runSponsored = useCallback(async () => {
    reset()
    setStatus('running')
    setCurrent('Running the whole cycle on BNB testnet…')
    try {
      const result = await sponsoredHire({
        chainId: config.chainId,
        agentId: config.agentId,
        task,
        budgetU: budget,
      })
      setSteps(result.steps)
      setSummary(result)
      setJobId(result.jobId)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The sponsored run failed before it reported anything.',
      )
    } finally {
      setStatus('done')
      setCurrent(null)
    }
  }, [budget, config.agentId, config.chainId, task])

  /* --- wallet ---------------------------------------------------------- */

  const runWallet = useCallback(async () => {
    reset()

    if (config.commerce === null || config.hook === null || config.paymentToken === null) {
      setError('Hallmark’s escrow is not deployed on this chain, so there is nothing to sign.')
      return
    }
    if (config.provider === null) {
      setError('The agent’s owner could not be read, and that is who gets paid.')
      return
    }
    if (quote === null) {
      setError('That budget is not a number the escrow can hold.')
      return
    }

    const client = wallet.getWalletClient(config.chainId)
    if (client === null || wallet.address === null) {
      setError('Connect a wallet first.')
      return
    }
    if (wallet.chainId !== config.chainId) {
      const switched = await wallet.switchChain(config.chainId)
      if (!switched) {
        setError(`Switch your wallet to ${chainLabel(config.chainId)} and try again.`)
        return
      }
    }

    const account = wallet.address
    const commerce = config.commerce
    const paymentToken = config.paymentToken
    const collected: HireStep[] = []
    const record = (step: HireStep) => {
      collected.push(step)
      setSteps([...collected])
    }

    setStatus('running')
    try {
      setCurrent('Approving the escrow to pull $U…')
      const approveHash = await client.writeContract({
        account,
        chain: null,
        address: paymentToken,
        abi: erc20Abi,
        functionName: 'approve',
        args: [commerce, quote.atomic],
      })
      record({
        name: 'Approve the escrow to pull $U',
        status: 'ok',
        detail: 'An approval for exactly this job’s budget. Not unlimited.',
        txHash: approveHash,
        gasLimit: null,
      })

      setCurrent('Creating the job…')
      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 2 * 60 * 60)
      const createHash = await client.writeContract({
        account,
        chain: null,
        address: commerce,
        abi: hallmarkCommerceAbi,
        functionName: 'createJob',
        // The client is also the evaluator here, which is what makes a
        // one-person demo able to settle. In production the evaluator is a
        // third party or the optimistic policy contract.
        args: [config.provider, account, expiredAt, task.slice(0, 2000), config.hook],
      })
      record({
        name: 'Create the job',
        status: 'ok',
        detail:
          'Created on the ERC-8183 escrow carrying HallmarkHook as its policy, expiring in two ' +
          'hours. After expiry anyone can refund it to you — the hook cannot block that.',
        txHash: createHash,
        gasLimit: null,
      })

      setCurrent(
        'Waiting for the job id, then setting the budget. Confirm the next two prompts in your wallet.',
      )

      // The job id comes from the receipt, so the reader has to wait for it.
      // Everything after this point needs it, and guessing would be worse.
      const jobIdValue = await readJobIdFromReceipt(config.chainId, createHash)
      if (jobIdValue === null) {
        record({
          name: 'Read the job id',
          status: 'failed',
          detail:
            'The createJob transaction was sent but its receipt did not carry a JobCreated ' +
            'event we could decode. Nothing was escrowed. Open the transaction to see what ' +
            'happened.',
          txHash: createHash,
          gasLimit: null,
        })
        setStatus('done')
        setCurrent(null)
        return
      }
      setJobId(jobIdValue.toString())

      const budgetHash = await client.writeContract({
        account,
        chain: null,
        address: commerce,
        abi: hallmarkCommerceAbi,
        functionName: 'setBudget',
        args: [jobIdValue, quote.atomic, '0x'],
      })
      record({
        name: 'Set the budget',
        status: 'ok',
        detail: `${budget} $U, held in escrow until the job settles or expires.`,
        txHash: budgetHash,
        gasLimit: null,
      })

      setCurrent('Funding the job. This is the call the evidence gate runs on.')
      const fundHash = await client.writeContract({
        account,
        chain: null,
        address: commerce,
        abi: hallmarkCommerceAbi,
        functionName: 'fund',
        args: [
          jobIdValue,
          quote.atomic,
          encodeAbiParameters([{ type: 'uint256' }], [BigInt(config.agentId)]),
        ],
      })
      record({
        name: 'Fund the job',
        status: 'ok',
        detail:
          `The agent id travels in optParams, and HallmarkHook.beforeAction(fund) reads agent ` +
          `#${config.agentId}'s evidence before the tokens move. If the evidence had gone stale, ` +
          'this is where it would have reverted.',
        txHash: fundHash,
        gasLimit: null,
      })

      setSummary({
        ok: true,
        outcome: 'funded',
        headline: `Job #${jobIdValue} is funded and waiting on the agent.`,
        detail:
          'Only the provider can submit a deliverable. Once they do, you are the evaluator on ' +
          'this job and can complete it — Hallmark sends that call with an explicit 450,000 gas ' +
          'limit so the ERC-8004 rating actually lands.',
        steps: collected,
        jobId: jobIdValue.toString(),
        chainId: config.chainId,
        agentId: config.agentId,
        finishedAt: new Date().toISOString(),
      })
    } catch (cause) {
      const message = describeWalletError(cause)
      const isRefusal = /NoFreshEvidence/i.test(String(cause))
      record({
        name: current ?? 'Transaction',
        status: isRefusal ? 'refused' : 'failed',
        detail: isRefusal
          ? 'The escrow reverted with NoFreshEvidence. Nothing was spent — the guard bit before ' +
            'the tokens moved, which is exactly what it is for.'
          : message,
        txHash: null,
        gasLimit: null,
      })
      setError(message)
    } finally {
      setStatus('done')
      setCurrent(null)
    }
  }, [config, current, quote, task, budget, wallet])

  /* --- settle ---------------------------------------------------------- */

  const settle = useCallback(async () => {
    if (jobId === null || config.commerce === null) return
    const client = wallet.getWalletClient(config.chainId)
    if (client === null || wallet.address === null) {
      setError('Connect the wallet that created this job — only its evaluator can settle it.')
      return
    }
    setStatus('running')
    setCurrent('Settling…')
    try {
      const hash = await client.writeContract({
        account: wallet.address,
        chain: null,
        address: config.commerce,
        abi: hallmarkCommerceAbi,
        functionName: 'complete',
        args: [BigInt(jobId), `0x${'00'.repeat(32)}` as Hex, '0x'],
        // Not an estimate. `complete` triggers the hook's ERC-8004 reputation
        // write, wrapped in try/catch; EIP-150 gives an inner call at most
        // 63/64 of the remaining gas and the catch turns an inner out-of-gas
        // into an outer success, so eth_estimateGas converges on a limit under
        // which the job settles and the rating silently never lands.
        gas: SETTLEMENT_GAS_LIMIT,
      })
      setSteps((previous) => [
        ...previous,
        {
          name: 'Complete and settle',
          status: 'ok',
          detail:
            'Escrow released to the provider, and the hook wrote the outcome into the ERC-8004 ' +
            'Reputation Registry. Sent with an explicit 450,000 gas limit.',
          txHash: hash,
          gasLimit: SETTLEMENT_GAS_LIMIT.toString(),
        },
      ])
    } catch (cause) {
      setError(describeWalletError(cause))
    } finally {
      setStatus('done')
      setCurrent(null)
    }
  }, [config.chainId, config.commerce, jobId, wallet])

  const busy = status === 'running'

  return (
    <div className={styles.stack}>
      <Card>
        <h2 className={styles.stepTitle}>1. Describe the job</h2>
        <p className={styles.stepLead}>
          This text is written into the escrow as the statement of work. It is public and
          permanent.
        </p>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="hire-task">
            What should {config.agentName} do?
          </label>
          <textarea
            id="hire-task"
            className={styles.textarea}
            value={task}
            onChange={(event) => setTask(event.target.value)}
            maxLength={2000}
          />
          <span className={styles.hint}>{task.length} / 2000 characters</span>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="hire-budget">
            Budget
          </label>
          <div className={styles.numberField}>
            <input
              id="hire-budget"
              className={styles.number}
              type="number"
              min="0.1"
              step="0.1"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            />
            <span className={styles.unit}>$U</span>
          </div>
          <span className={styles.hint}>
            Held in escrow the moment the job is funded. It goes to the agent on completion, back
            to you on rejection, and back to you after expiry if nothing is delivered — that last
            path is permissionless and the hook cannot block it.
          </span>
        </div>

        <div className={styles.priceRows}>
          <div className={styles.priceRow}>
            <span className={styles.priceLabel}>Escrowed</span>
            <span>{budget} $U</span>
          </div>
          <div className={styles.priceRow}>
            <span className={styles.priceLabel}>
              Platform fee ({(config.feeBps / 100).toFixed(2)}%, charged only on completion)
            </span>
            <span>{quote === null ? '—' : formatU(quote.fee)} $U</span>
          </div>
          <div className={`${styles.priceRow} ${styles.priceRowTotal}`}>
            <span>The agent receives</span>
            <span>{quote === null ? '—' : formatU(quote.net)} $U</span>
          </div>
        </div>
      </Card>

      <Card>
        <h2 className={styles.stepTitle}>3. Run it</h2>
        <p className={styles.stepLead}>
          Two ways in, both against the same deployed contracts on {chainLabel(config.chainId)}.
        </p>

        <div className={styles.paths}>
          <div className={`${styles.path} ${wallet.status === 'connected' ? styles.pathActive : ''}`}>
            <span className={styles.pathTitle}>
              Connect your wallet
              <Badge tone="neutral">the real path</Badge>
            </span>
            <p className={styles.pathBody}>
              You sign four transactions: approve, create, set the budget, fund. The escrow holds
              your $U and you are the evaluator, so only you can release it.
            </p>
            {!config.escrowDeployed ? (
              <Callout tone="info">
                <p>
                  Hallmark&rsquo;s escrow is deployed on BNB testnet. Switch the chain on the agent
                  page to run this against a live contract.
                </p>
              </Callout>
            ) : wallet.status !== 'connected' ? (
              <Button variant="primary" onClick={() => void wallet.connect()} disabled={busy}>
                Connect a wallet
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void runWallet()}
                disabled={busy || !config.hireable || quote === null}
              >
                {busy ? 'Waiting on your wallet…' : 'Hire with my wallet'}
              </Button>
            )}
          </div>

          <div className={styles.path}>
            <span className={styles.pathTitle}>
              Sponsored demo hire
              <Badge tone="warn">sponsored</Badge>
              <Badge tone="info">testnet</Badge>
            </span>
            <p className={styles.pathBody}>
              We pay, on BNB testnet, so you can watch the whole cycle without a wallet. Capped at{' '}
              {config.maxSponsoredBudgetU} $U and {config.sponsorPerHour} runs per hour. Real
              transactions on a public chain — every one of them linked below.
            </p>
            {config.sponsorAvailable ? (
              <Button
                onClick={() => void runSponsored()}
                disabled={busy || !config.escrowDeployed || quote === null}
              >
                {busy ? 'Running…' : 'Run the sponsored hire'}
              </Button>
            ) : (
              <Callout tone="info">
                <p>
                  {config.sponsorReason ??
                    'Sponsored hires are not configured on this deployment.'}
                </p>
              </Callout>
            )}
          </div>
        </div>

        {!config.hireable && config.escrowDeployed && (
          <div style={{ marginTop: 'var(--sp-4)' }}>
            <Callout tone="bad" title="Both paths would revert right now" role="status">
              <p>
                The evidence gate refuses this agent, so neither button will produce a funded job.
                The sponsored run will report the refusal without spending anything; a wallet run
                would revert at <code>fund</code>. Nothing here hides that from you.
              </p>
            </Callout>
          </div>
        )}

        {busy && (
          <p className={styles.hint} style={{ marginTop: 'var(--sp-4)' }} aria-live="polite">
            <span className={styles.spinner} aria-hidden="true" /> {current ?? 'Working…'}
          </p>
        )}

        {error !== null && (
          <div style={{ marginTop: 'var(--sp-4)' }}>
            <Callout tone="bad" title="It stopped here" role="alert">
              <p>{error}</p>
            </Callout>
          </div>
        )}

        {steps.length > 0 && (
          <>
            <ul className={styles.runLog}>
              {steps.map((step, index) => (
                <li key={`${step.name}-${index}`} className={styles.runStep}>
                  <span
                    className={`${styles.runGlyph} ${
                      step.status === 'ok'
                        ? styles.runOk
                        : step.status === 'refused'
                          ? styles.runRefused
                          : step.status === 'failed'
                            ? styles.runFailed
                            : styles.runSkipped
                    }`}
                    aria-hidden="true"
                  >
                    {step.status === 'ok'
                      ? '✓'
                      : step.status === 'refused'
                        ? '⦸'
                        : step.status === 'failed'
                          ? '✕'
                          : '–'}
                  </span>
                  <div>
                    <span className={styles.runName}>{step.name}</span>
                    <p className={styles.runDetail}>{step.detail}</p>
                    {(step.txHash !== null || step.gasLimit !== null) && (
                      <div className={styles.runLinks}>
                        {step.txHash !== null && (
                          <span>
                            <TxLink chainId={config.chainId} hash={step.txHash} />
                          </span>
                        )}
                        {step.gasLimit !== null && (
                          <span>gas limit sent: {Number(step.gasLimit).toLocaleString('en-GB')}</span>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {summary !== null && (
              <div style={{ marginTop: 'var(--sp-4)' }}>
                <Callout
                  tone={
                    summary.outcome === 'refused-by-gate'
                      ? 'warn'
                      : summary.ok
                        ? 'ok'
                        : 'bad'
                  }
                  title={summary.headline}
                  role="status"
                >
                  <p>{summary.detail}</p>
                  {summary.jobId !== null && (
                    <p>
                      Job #{summary.jobId} ·{' '}
                      <Link href={`/proof#jobs`}>see it on the proof page</Link>
                    </p>
                  )}
                </Callout>
              </div>
            )}

            {jobId !== null && wallet.status === 'connected' && (
              <div style={{ marginTop: 'var(--sp-4)' }}>
                <Button onClick={() => void settle()} disabled={busy}>
                  Complete job #{jobId} and release the escrow
                </Button>
                <p className={styles.hint} style={{ marginTop: 'var(--sp-2)' }}>
                  Only works once the provider has submitted a deliverable. Sent with an explicit
                  450,000 gas limit — an estimate would settle the job and silently drop the
                  ERC-8004 rating.
                </p>
              </div>
            )}
          </>
        )}

        <SourceNote>
          Contracts:{' '}
          {config.commerce === null ? (
            'not deployed on this chain'
          ) : (
            <>
              escrow{' '}
              <a
                href={explorerTxUrl(config.chainId, '').replace('/tx/', `/address/${config.commerce}`)}
                target="_blank"
                rel="noreferrer noopener"
              >
                {config.commerce.slice(0, 10)}…
              </a>
              , hook {config.hook?.slice(0, 10)}…
            </>
          )}
        </SourceNote>
      </Card>
    </div>
  )
}

function formatU(atomic: bigint): string {
  const whole = atomic / 10n ** 18n
  const fraction = (atomic % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '')
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`
}

/**
 * Read the job id out of a `createJob` receipt, client-side.
 *
 * Goes through our own route handler rather than a browser RPC call: the RPC
 * URL may be a keyed provider, and that key has no business in a bundle.
 */
async function readJobIdFromReceipt(chainId: number, hash: string): Promise<bigint | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`/api/jobs/${chainId}/by-tx/${hash}`, { cache: 'no-store' })
      if (response.ok) {
        const body = (await response.json()) as { jobId?: string }
        if (typeof body.jobId === 'string') return BigInt(body.jobId)
      }
    } catch {
      // Receipt not mined yet, or a transient network failure. Retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  return null
}
