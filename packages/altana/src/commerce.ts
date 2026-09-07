import {
  buildClaimRefundCall,
  encodeErc8183Manifest,
  erc8183Addresses,
  erc8183ManifestHash,
  erc8183SubmitPermissions,
  getErc8183DeliverableUrl,
  getErc8183Job,
  hireErc8183Agent,
  JOB_STATUS,
  settleErc8183Job,
  submitErc8183Deliverable,
  verifyErc8183ManifestText,
  type Call,
  type Erc8183Addresses,
  type Erc8183DeliverableManifest,
  type Erc8183Job,
  type Session,
  type Signer,
  type Wallet,
} from '@altananetwork/sdk'
import type { Address, Hex } from 'viem'

import { outcomeFromThrow, toExecuteOutcome, type ExecuteOutcome } from './execute.js'
import { getAltanaNetwork } from './network.js'

/**
 * Hiring through Altana's canonical ERC-8183 deployment.
 *
 * This is the interoperable rail: a job escrowed in $U on the AgenticCommerce
 * kernel, settled by the optimistic policy, readable by anyone who knows the
 * job id. Hallmark's own hooked deployment is a separate thing and does not
 * belong in this file.
 *
 * Everything here funnels through the same `ExecuteOutcome` the rest of the
 * package uses, so a job funded by a session key that hit its cap reports the
 * refusal in exactly the same shape as a swap that hit its cap.
 */

/** `'OPEN' | 'FUNDED' | 'SUBMITTED' | 'COMPLETED' | 'REJECTED' | 'EXPIRED'` */
export type JobStatus = (typeof JOB_STATUS)[number]

export const JOB_STATUSES: readonly JobStatus[] = JOB_STATUS

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUS as readonly string[]).includes(value)
}

/** The ERC-8183 stack for a chain: commerce, router, policy, registry, $U. */
export function commerceAddresses(chainId: number): Erc8183Addresses {
  return erc8183Addresses(getAltanaNetwork(chainId).chainId)
}

/** $U — 18 decimals, like everything else on BNB Chain. */
export function paymentToken(chainId: number): Address {
  return commerceAddresses(chainId).paymentToken
}

// ---------------------------------------------------------------------------
// Buyer side
// ---------------------------------------------------------------------------

export type HireAgentArgs = {
  chainId: number
  provider: Address
  /** The task text, or an anchored signed quote. Max 4096 bytes. */
  task: string
  /** Budget in raw $U units (18 decimals). */
  budget: bigint
  /** Submission headroom past the policy's dispute window. Default 1800s. */
  deadlineSeconds?: number | undefined
  noWait?: boolean | undefined
} & ({ session: Session } | { wallet: Wallet; adminSigner: Signer })

export type HireAgentOutcome = {
  outcome: ExecuteOutcome
  /** Present once the relay accepted the batch. */
  jobId?: bigint
  provider: Address
  budget: bigint
  expiredAt?: bigint
}

/**
 * Fund a job against a provider in one atomic intent.
 *
 * Five contract calls — createJob, registerJob, setBudget, approve, fund —
 * batched into a single relay intent, so the buyer signs once and the job is
 * either FUNDED or nothing happened.
 */
export async function hireAgent(args: HireAgentArgs): Promise<HireAgentOutcome> {
  const network = getAltanaNetwork(args.chainId)
  const params = {
    provider: args.provider,
    task: args.task,
    budget: args.budget,
    ...(args.deadlineSeconds === undefined ? {} : { deadlineSeconds: args.deadlineSeconds }),
  }
  const opts = {
    network: network.config,
    ...(args.noWait ? { noWait: true } : {}),
  }
  const ctx = {
    chainId: network.chainId,
    address: 'session' in args ? args.session.walletAddress : args.wallet.address,
    ...('session' in args ? { session: args.session } : {}),
  }

  try {
    const result =
      'session' in args
        ? await hireErc8183Agent(args.session, params, opts)
        : await hireErc8183Agent(args.wallet, args.adminSigner, params, opts)

    return {
      outcome: toExecuteOutcome(result, ctx),
      jobId: result.jobId,
      provider: result.provider,
      budget: result.budget,
      expiredAt: result.expiredAt,
    }
  } catch (error) {
    return {
      outcome: outcomeFromThrow(error, ctx),
      provider: args.provider,
      budget: args.budget,
    }
  }
}

export type SettleJobArgs = {
  chainId: number
  jobId: bigint
  /** `approve` releases escrow after the window; `dispute` contests inside it. */
  action?: ('approve' | 'dispute') | undefined
} & ({ session: Session } | { wallet: Wallet; adminSigner: Signer })

/** Release, or contest, a job's escrow. */
export async function settleJob(args: SettleJobArgs): Promise<ExecuteOutcome> {
  const network = getAltanaNetwork(args.chainId)
  const params = { jobId: args.jobId, ...(args.action ? { action: args.action } : {}) }
  const opts = { network: network.config }
  const ctx = {
    chainId: network.chainId,
    address: 'session' in args ? args.session.walletAddress : args.wallet.address,
    ...('session' in args ? { session: args.session } : {}),
  }

  try {
    const result =
      'session' in args
        ? await settleErc8183Job(args.session, params, opts)
        : await settleErc8183Job(args.wallet, args.adminSigner, params, opts)
    return toExecuteOutcome(result, ctx)
  } catch (error) {
    return outcomeFromThrow(error, ctx)
  }
}

/** The call that reclaims escrow from a seller who never delivered. */
export function claimRefundCall(chainId: number, jobId: bigint): Call {
  return buildClaimRefundCall(getAltanaNetwork(chainId).chainId, jobId)
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type JobView = Erc8183Job & {
  statusName: JobStatus
  /** True once the seller has committed a deliverable hash. */
  hasDeliverable: boolean
}

export async function readJob(chainId: number, jobId: bigint): Promise<JobView> {
  const job = await getErc8183Job(getAltanaNetwork(chainId).config, jobId)
  const empty = `0x${'0'.repeat(64)}`
  return {
    ...job,
    statusName: job.statusName as JobStatus,
    hasDeliverable: job.deliverable.toLowerCase() !== empty,
  }
}

/** Where the seller published the manifest, if we can find the event. */
export async function readDeliverableUrl(
  chainId: number,
  jobId: bigint,
  opts: { scanWindow?: bigint | undefined; maxWindows?: number | undefined } = {},
): Promise<string | undefined> {
  return getErc8183DeliverableUrl(getAltanaNetwork(chainId).config, jobId, {
    ...(opts.scanWindow === undefined ? {} : { scanWindow: opts.scanWindow }),
    ...(opts.maxWindows === undefined ? {} : { maxWindows: opts.maxWindows }),
  })
}

// ---------------------------------------------------------------------------
// Seller side
// ---------------------------------------------------------------------------

export type SubmitDeliverableArgs = {
  chainId: number
  jobId: bigint
} & ({ manifest: Erc8183DeliverableManifest; deliverableUrl: string } | {
  deliverable: Hex
  optParams?: Hex
}) &
  ({ session: Session } | { wallet: Wallet; adminSigner: Signer })

export type SubmitDeliverableOutcome = {
  outcome: ExecuteOutcome
  jobId: bigint
  deliverable?: Hex
  /**
   * On the manifest path: the exact bytes to serve at `deliverableUrl`. Serve
   * them verbatim — the buyer hashes what they fetch against the on-chain
   * commitment, so re-serializing breaks verification.
   */
  manifestText?: string
}

export async function submitDeliverable(
  args: SubmitDeliverableArgs,
): Promise<SubmitDeliverableOutcome> {
  const network = getAltanaNetwork(args.chainId)
  const params =
    'manifest' in args
      ? { jobId: args.jobId, manifest: args.manifest, deliverableUrl: args.deliverableUrl }
      : {
          jobId: args.jobId,
          deliverable: args.deliverable,
          ...(args.optParams === undefined ? {} : { optParams: args.optParams }),
        }
  const opts = { network: network.config }
  const ctx = {
    chainId: network.chainId,
    address: 'session' in args ? args.session.walletAddress : args.wallet.address,
    ...('session' in args ? { session: args.session } : {}),
  }

  try {
    const result =
      'session' in args
        ? await submitErc8183Deliverable(args.session, params, opts)
        : await submitErc8183Deliverable(args.wallet, args.adminSigner, params, opts)
    return {
      outcome: toExecuteOutcome(result, ctx),
      jobId: result.jobId,
      deliverable: result.deliverable,
      ...(result.manifestText === undefined ? {} : { manifestText: result.manifestText }),
    }
  } catch (error) {
    return { outcome: outcomeFromThrow(error, ctx), jobId: args.jobId }
  }
}

/**
 * The narrowest possible seller key: `submit` on the commerce kernel and
 * nothing else. Feed it to `fromAltanaPermissions` if you want to show it.
 */
export function sellerSubmitRules(chainId: number) {
  return erc8183SubmitPermissions(getAltanaNetwork(chainId).chainId)
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

export type BuildManifestArgs = {
  chainId: number
  jobId: bigint | number
  content: string
  contentType?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

/** Assemble a v1 deliverable manifest against a chain's deployed addresses. */
export function buildManifest(args: BuildManifestArgs): Erc8183DeliverableManifest {
  const chainId = getAltanaNetwork(args.chainId).chainId
  const { commerce, router, policy } = commerceAddresses(chainId)
  return {
    version: 1,
    job_id: Number(args.jobId),
    chain_id: chainId,
    contracts: { commerce, router, policy },
    response: { content: args.content, content_type: args.contentType ?? 'text/plain' },
    metadata: args.metadata ?? {},
  }
}

/** The canonical text to serve, and the hash the chain will hold. */
export function manifestCommitment(manifest: Erc8183DeliverableManifest): {
  text: string
  hash: Hex
} {
  return { text: encodeErc8183Manifest(manifest), hash: erc8183ManifestHash(manifest) }
}

/**
 * Buyer-side integrity check on the raw fetched bytes.
 *
 * Never re-serialize before calling this: the on-chain hash commits to exact
 * bytes, so a "helpful" JSON round-trip turns a valid deliverable invalid.
 */
export function verifyDeliverableText(text: string, deliverable: Hex): boolean {
  return verifyErc8183ManifestText(text, deliverable)
}

export {
  buildClaimRefundCall,
  encodeErc8183Manifest,
  erc8183ManifestHash,
  JOB_STATUS,
  verifyErc8183ManifestText,
}
export type { Erc8183Addresses, Erc8183DeliverableManifest, Erc8183Job }
