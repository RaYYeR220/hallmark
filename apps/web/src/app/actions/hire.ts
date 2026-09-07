'use server'

import { headers } from 'next/headers'
import {
  createWalletClient,
  decodeEventLog,
  http,
  parseUnits,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getChain } from '@hallmark/core'

import {
  erc20Abi,
  hallmarkCommerceAbi,
  SETTLEMENT_GAS_LIMIT,
  uTokenFaucetAbi,
} from '@/lib/abi'
import { publicClientFor } from '@/lib/chain'
import { DEMO_CHAIN_ID, getDeployment } from '@/lib/deployments'
import { env, sponsorStatus } from '@/lib/env'
import { encodeAgentId, preflightHire, U_DECIMALS } from '@/lib/hire'
import { callerKey, consume } from '@/lib/rateLimit'

/**
 * The sponsored demo hire.
 *
 * Someone with no wallet, no testnet BNB and no $U should be able to press one
 * button and watch the entire cycle happen on a public chain, then click every
 * transaction. That is what this does, and it is labelled as sponsored and as
 * testnet everywhere it appears.
 *
 * Three rules it holds without exception:
 *
 *  1. Chain 97 only. The guard is a hard equality check, not a default — a
 *     sponsor key must never be able to sign a mainnet transaction from a
 *     public button.
 *  2. Every write is simulated first. A revert therefore comes back as an
 *     explained step rather than a burnt transaction, and the evidence gate's
 *     refusal is detected without spending anything.
 *  3. Every step reports itself. A run that gets four steps in and stops
 *     renders four successes and one explained stop, never a spinner that
 *     ends in silence.
 */

export type HireStepStatus = 'ok' | 'skipped' | 'refused' | 'failed'

export type HireStep = {
  name: string
  status: HireStepStatus
  detail: string
  txHash: string | null
  /** Gas limit we chose explicitly, when we did. Shown, because it matters. */
  gasLimit: string | null
}

export type SponsoredHireResult = {
  ok: boolean
  /** `refused-by-gate` is a successful demonstration, not a failure. */
  outcome: 'completed' | 'funded' | 'refused-by-gate' | 'unavailable' | 'failed'
  headline: string
  detail: string
  steps: HireStep[]
  jobId: string | null
  chainId: number
  agentId: number
  finishedAt: string
}

const MAX_DESCRIPTION_BYTES = 2_000

export async function sponsoredHire(input: {
  chainId: number
  agentId: number
  task: string
  budgetU: string
}): Promise<SponsoredHireResult> {
  const finishedAt = () => new Date().toISOString()
  const steps: HireStep[] = []
  const agentId = Math.trunc(Number(input.agentId))

  const bail = (
    outcome: SponsoredHireResult['outcome'],
    headline: string,
    detail: string,
  ): SponsoredHireResult => ({
    ok: outcome === 'completed' || outcome === 'funded' || outcome === 'refused-by-gate',
    outcome,
    headline,
    detail,
    steps,
    jobId: null,
    chainId: input.chainId,
    agentId,
    finishedAt: finishedAt(),
  })

  // --- guards -------------------------------------------------------------

  if (input.chainId !== DEMO_CHAIN_ID) {
    return bail(
      'unavailable',
      'Sponsored hires run on BNB testnet only.',
      `This request named chain ${input.chainId}. The sponsor key is refused on every chain but ` +
        `${DEMO_CHAIN_ID}, by an equality check rather than a default, so no mainnet transaction ` +
        'can ever originate from this button.',
    )
  }

  if (!Number.isSafeInteger(agentId) || agentId <= 0) {
    return bail('failed', 'That is not an agent id.', 'Agent ids are positive integers.')
  }

  const sponsor = sponsorStatus()
  if (!sponsor.available) {
    return bail('unavailable', 'Sponsored hire is not configured here.', sponsor.reason)
  }

  const limit = consume(
    callerKey(await headers(), 'sponsored-hire'),
    env.sponsorRateLimitPerHour,
  )
  if (!limit.allowed) {
    return bail(
      'unavailable',
      'Sponsored hire rate limit reached.',
      `This deployment allows ${env.sponsorRateLimitPerHour} sponsored hires per hour per ` +
        `visitor. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes, or connect a ` +
        'wallet on BNB testnet and run the real path — it is the same contract.',
    )
  }

  let budget: bigint
  try {
    budget = parseUnits(input.budgetU.trim(), U_DECIMALS)
  } catch {
    return bail('failed', 'That budget is not a number.', `Received “${input.budgetU}”.`)
  }
  const ceiling = parseUnits(String(sponsor.maxBudgetU), U_DECIMALS)
  if (budget <= 0n || budget > ceiling) {
    return bail(
      'unavailable',
      'Budget outside the sponsored ceiling.',
      `A sponsored job is capped at ${sponsor.maxBudgetU} $U on testnet. Requested ` +
        `${input.budgetU} $U.`,
    )
  }

  const task = input.task.trim().slice(0, MAX_DESCRIPTION_BYTES)
  if (task === '') {
    return bail('failed', 'The job needs a description.', 'An empty statement of work is not a job.')
  }

  const deployment = getDeployment(DEMO_CHAIN_ID)
  const privateKey = env.sponsorPrivateKey
  if (deployment === null || privateKey === null) {
    // `sponsorStatus()` already vouched for the key above, so reaching here
    // means the deployment record is missing — a configuration error on our
    // side, not something the visitor can fix.
    return bail(
      'unavailable',
      'Sponsored hire is not configured here.',
      'The sponsor key is present but Hallmark has no escrow deployment recorded for chain ' +
        `${DEMO_CHAIN_ID}, so there is nothing to send a transaction to.`,
    )
  }

  // --- the gate, before anything is signed --------------------------------

  const preflight = await preflightHire(DEMO_CHAIN_ID, agentId)
  if (!preflight.hireable) {
    steps.push({
      name: 'Check the evidence gate',
      status: 'refused',
      detail:
        preflight.refusal?.detail ??
        'The hook refused this agent and gave no further reason.',
      txHash: null,
      gasLimit: null,
    })
    return {
      ok: true,
      outcome: 'refused-by-gate',
      headline:
        preflight.refusal?.headline ?? 'The escrow refused to fund a job for this agent.',
      detail:
        `Nothing was signed and nothing was spent. Calling \`fund\` anyway would revert with ` +
        `\`${preflight.refusal?.revert ?? 'NoFreshEvidence(...)'}\`. This is the guard doing its ` +
        'job — the same check runs for anyone who calls the contract directly.',
      steps,
      jobId: null,
      chainId: DEMO_CHAIN_ID,
      agentId,
      finishedAt: finishedAt(),
    }
  }
  steps.push({
    name: 'Check the evidence gate',
    status: 'ok',
    detail:
      `HallmarkHook.isHireable(${agentId}) returned true — freshest evidence scored ` +
      `${preflight.score ?? '?'}/100. The escrow will accept a job for this agent.`,
    txHash: null,
    gasLimit: null,
  })

  // --- signing ------------------------------------------------------------

  const chain = getChain(DEMO_CHAIN_ID)
  const account = privateKeyToAccount(privateKey as Hex)
  const publicClient = publicClientFor(DEMO_CHAIN_ID)
  const wallet = createWalletClient({
    account,
    chain: chain.chain,
    transport: http(env.rpcUrl97 ?? chain.rpcUrl),
  })

  const waitFor = async (hash: Hex): Promise<TransactionReceipt> =>
    publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 })

  const fail = (name: string, error: unknown, hint?: string): SponsoredHireResult => {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    steps.push({
      name,
      status: 'failed',
      detail: `${message ?? 'unknown error'}${hint === undefined ? '' : ` — ${hint}`}`,
      txHash: null,
      gasLimit: null,
    })
    return {
      ok: false,
      outcome: 'failed',
      headline: `The sponsored run stopped at: ${name}.`,
      detail:
        'Every step before this one really happened on chain 97 and its transaction is linked ' +
        'above. Connecting a wallet runs the identical sequence against the identical contracts.',
      steps,
      jobId: null,
      chainId: DEMO_CHAIN_ID,
      agentId,
      finishedAt: finishedAt(),
    }
  }

  // --- who gets paid ------------------------------------------------------

  let provider: `0x${string}`
  try {
    const { createRegistryReader } = await import('@hallmark/core')
    const reader = createRegistryReader(DEMO_CHAIN_ID, {
      ...(env.rpcUrl97 === null ? {} : { rpcUrl: env.rpcUrl97 }),
    })
    const onChain = await reader.getAgent(agentId)
    if (onChain === null) throw new Error(`ownerOf(${agentId}) reverted`)
    provider = onChain.owner
  } catch (error) {
    return fail('Resolve the agent’s owner', error, 'the provider is paid at this address')
  }
  steps.push({
    name: 'Resolve the agent’s owner',
    status: 'ok',
    detail: `Payment on completion goes to ${provider}, read from the Identity Registry.`,
    txHash: null,
    gasLimit: null,
  })

  // --- funds --------------------------------------------------------------

  try {
    const balance = await publicClient.readContract({
      address: deployment.paymentToken,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    })

    if (balance < budget) {
      const faucet = chain.contracts.uTokenFaucet
      if (faucet === null) throw new Error('the sponsor wallet is short of $U and there is no faucet')
      const { request } = await publicClient.simulateContract({
        account,
        address: faucet,
        abi: uTokenFaucetAbi,
        functionName: 'requestTokens',
      })
      const hash = await wallet.writeContract(request)
      await waitFor(hash)
      steps.push({
        name: 'Top the sponsor wallet up from the $U faucet',
        status: 'ok',
        detail: 'The testnet faucet hands out 10 $U per call.',
        txHash: hash,
        gasLimit: null,
      })
    } else {
      steps.push({
        name: 'Check the sponsor’s $U balance',
        status: 'ok',
        detail: 'The sponsor wallet already holds enough $U to escrow this job.',
        txHash: null,
        gasLimit: null,
      })
    }
  } catch (error) {
    return fail('Fund the sponsor wallet', error)
  }

  // --- approve ------------------------------------------------------------

  try {
    const allowance = await publicClient.readContract({
      address: deployment.paymentToken,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, deployment.commerce],
    })

    if (allowance < budget) {
      const { request } = await publicClient.simulateContract({
        account,
        address: deployment.paymentToken,
        abi: erc20Abi,
        functionName: 'approve',
        args: [deployment.commerce, budget],
      })
      const hash = await wallet.writeContract(request)
      await waitFor(hash)
      steps.push({
        name: 'Approve the escrow to pull $U',
        status: 'ok',
        detail: 'A single approval for exactly this job’s budget. Not unlimited.',
        txHash: hash,
        gasLimit: null,
      })
    } else {
      steps.push({
        name: 'Approve the escrow to pull $U',
        status: 'skipped',
        detail: 'An allowance large enough for this job already exists.',
        txHash: null,
        gasLimit: null,
      })
    }
  } catch (error) {
    return fail('Approve the escrow', error)
  }

  // --- create -------------------------------------------------------------

  let jobId: bigint
  try {
    const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 2 * 60 * 60)
    const { request, result } = await publicClient.simulateContract({
      account,
      address: deployment.commerce,
      abi: hallmarkCommerceAbi,
      functionName: 'createJob',
      args: [provider, account.address, expiredAt, task, deployment.hook],
    })
    const hash = await wallet.writeContract(request)
    const receipt = await waitFor(hash)
    jobId = readJobId(receipt, deployment.commerce) ?? (result as bigint)

    steps.push({
      name: 'Create the job',
      status: 'ok',
      detail:
        `Job #${jobId} on the ERC-8183 escrow, carrying HallmarkHook as its policy and expiring ` +
        'in two hours. Past expiry anyone can refund it back to the client — the hook cannot ' +
        'block that.',
      txHash: hash,
      gasLimit: null,
    })
  } catch (error) {
    return fail('Create the job', error)
  }

  // --- budget -------------------------------------------------------------

  try {
    const { request } = await publicClient.simulateContract({
      account,
      address: deployment.commerce,
      abi: hallmarkCommerceAbi,
      functionName: 'setBudget',
      args: [jobId, budget, '0x'],
    })
    const hash = await wallet.writeContract(request)
    await waitFor(hash)
    steps.push({
      name: 'Set the budget',
      status: 'ok',
      detail: `${input.budgetU} $U, held in escrow until the job settles or expires.`,
      txHash: hash,
      gasLimit: null,
    })
  } catch (error) {
    return fail('Set the budget', error)
  }

  // --- fund: the gate runs here -------------------------------------------

  try {
    const { request } = await publicClient.simulateContract({
      account,
      address: deployment.commerce,
      abi: hallmarkCommerceAbi,
      functionName: 'fund',
      args: [jobId, budget, encodeAgentId(agentId)],
    })
    const hash = await wallet.writeContract(request)
    await waitFor(hash)
    steps.push({
      name: 'Fund the job',
      status: 'ok',
      detail:
        `The agent id is declared in optParams here, and HallmarkHook.beforeAction(fund) read ` +
        `agent #${agentId}'s evidence before letting the tokens move. This is the call that ` +
        'reverts when the evidence is missing.',
      txHash: hash,
      gasLimit: null,
    })
  } catch (error) {
    return fail(
      'Fund the job',
      error,
      'if this names NoFreshEvidence, the agent’s evidence went stale between the preflight and ' +
        'the transaction — which is the guard behaving exactly as intended',
    )
  }

  // --- deliver and settle, when the sponsor is also the provider ----------

  const sponsorIsProvider = provider.toLowerCase() === account.address.toLowerCase()

  if (!sponsorIsProvider) {
    return {
      ok: true,
      outcome: 'funded',
      headline: `Job #${jobId} is funded and waiting on the agent.`,
      detail:
        `The escrow now holds ${input.budgetU} $U for agent #${agentId}. Only the provider ` +
        `(${provider}) can submit a deliverable, and only then can the job be completed — so the ` +
        'sponsor cannot fake the rest of the cycle, and does not try to. Watch the job below; if ' +
        'nothing is delivered by expiry, anyone can refund it back to the client.',
      steps,
      jobId: jobId.toString(),
      chainId: DEMO_CHAIN_ID,
      agentId,
      finishedAt: finishedAt(),
    }
  }

  try {
    const deliverable = `0x${'11'.repeat(32)}` as Hex
    const { request } = await publicClient.simulateContract({
      account,
      address: deployment.commerce,
      abi: hallmarkCommerceAbi,
      functionName: 'submit',
      args: [jobId, deliverable, '0x'],
    })
    const hash = await wallet.writeContract(request)
    await waitFor(hash)
    steps.push({
      name: 'Submit the deliverable',
      status: 'ok',
      detail:
        'This demo agent is operated by the same key that sponsored the hire, so it can play the ' +
        'seller side too. The hook records funding-to-submission time from this transaction.',
      txHash: hash,
      gasLimit: null,
    })
  } catch (error) {
    return fail('Submit the deliverable', error)
  }

  try {
    const reason = `0x${'00'.repeat(32)}` as Hex
    const { request } = await publicClient.simulateContract({
      account,
      address: deployment.commerce,
      abi: hallmarkCommerceAbi,
      functionName: 'complete',
      args: [jobId, reason, '0x'],
      // Explicit, and not negotiable. `complete` triggers the hook's ERC-8004
      // reputation write, which is wrapped in try/catch. EIP-150 hands an
      // inner call at most 63/64 of the remaining gas, and a catch turns an
      // inner out-of-gas into an outer success — so eth_estimateGas converges
      // on a limit under which the job settles and the rating silently never
      // lands. The hook's own floor is 250,000, checked after complete's ~66k.
      gas: SETTLEMENT_GAS_LIMIT,
    })
    const hash = await wallet.writeContract(request)
    await waitFor(hash)
    steps.push({
      name: 'Complete and settle',
      status: 'ok',
      detail:
        'Escrow released to the provider, and the hook wrote the outcome into the ERC-8004 ' +
        'Reputation Registry as a `jobcompleted` entry. Sent with an explicit 450,000 gas limit ' +
        'because an estimate would starve that write and lose the rating without failing.',
      txHash: hash,
      gasLimit: SETTLEMENT_GAS_LIMIT.toString(),
    })
  } catch (error) {
    return fail(
      'Complete and settle',
      error,
      'the escrow still holds the budget; it is refundable to the client after expiry by anyone',
    )
  }

  return {
    ok: true,
    outcome: 'completed',
    headline: `Job #${jobId} settled.`,
    detail:
      `The full cycle ran on BNB testnet: the gate checked agent #${agentId}'s evidence, the ` +
      'escrow took the money, the agent delivered, the escrow paid out, and the hook wrote an ' +
      'ERC-8004 rating that now exists because a job actually settled. Every transaction above ' +
      'is a link.',
    steps,
    jobId: jobId.toString(),
    chainId: DEMO_CHAIN_ID,
    agentId,
    finishedAt: finishedAt(),
  }
}

/**
 * Pull the job id out of a `createJob` receipt.
 *
 * `simulateContract` already returns it, but a receipt is the thing that
 * actually happened, so the event wins where both are available.
 */
function readJobId(receipt: TransactionReceipt, commerce: string): bigint | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== commerce.toLowerCase()) continue
    try {
      const decoded = decodeEventLog({
        abi: hallmarkCommerceAbi,
        data: log.data,
        topics: log.topics,
      })
      if (decoded.eventName === 'JobCreated') {
        return (decoded.args as { jobId: bigint }).jobId
      }
    } catch {
      // Not a JobCreated log. Keep looking.
    }
  }
  return null
}

