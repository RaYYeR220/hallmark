import 'server-only'

import { unstable_cache } from 'next/cache'
import type { SupportedChainId } from '@hallmark/core'

import { hallmarkHookAbi, hallmarkHookRecordV2Abi } from './abi'
import { multicallAddressFor, publicClientFor } from './chain'
import { getDeployment } from './deployments'

/**
 * Hallmark's own evidence, read straight off the hook contract.
 *
 * This is the number the escrow itself will act on. `isHireable` is the exact
 * predicate `fund` evaluates, so a "hireable" badge here and a successful
 * `fund` are the same claim, read twice — which is why the hire page preflights
 * with this call rather than with anything the indexer says.
 */

/** viem's `allowFailure: true` entry, flattened so a mixed batch still types. */
type MulticallEntry =
  | { status: 'success'; result: unknown }
  | { status: 'failure'; error: unknown }

export type HallmarkEvidence = {
  chainId: SupportedChainId
  agentId: number
  /** `fund` would pass the evidence gate right now. */
  hireable: boolean
  /** Unix seconds of the freshest evidence, or null if there is none. */
  lastEvidenceAt: number | null
  /** Score attached to that freshest evidence, 0…100. */
  score: number | null
  /** Escrow-earned aggregates. Only jobs that actually settled count here. */
  jobsFunded: number
  jobsCompleted: number
  jobsRejected: number
  jobsExpired: number
  /** Funded, delivered, and then never settled either way. Newer hooks only. */
  jobsStalled: number | null
  /** Mean funding-to-submission time across completed jobs, seconds. */
  averageDeliverySeconds: number | null
}

export type HookConfig = {
  attestor: `0x${string}`
  /** Seconds. Evidence older than this is refused. */
  maxEvidenceAge: number
  /** Minimum score the gate accepts, 0…100. */
  minValidationScore: number
  evidenceBaseUri: string | null
}

/** Read the gate's own parameters, so the UI quotes the contract not a constant. */
export async function readHookConfig(chainId: SupportedChainId): Promise<HookConfig | null> {
  const deployment = getDeployment(chainId)
  if (deployment === null) return null

  const client = publicClientFor(chainId)
  const base = { address: deployment.hook, abi: hallmarkHookAbi } as const

  try {
    const [attestor, maxAge, minScore, baseUri] = await client.multicall({
      contracts: [
        { ...base, functionName: 'attestor' },
        { ...base, functionName: 'maxEvidenceAge' },
        { ...base, functionName: 'minValidationScore' },
        { ...base, functionName: 'evidenceBaseURI' },
      ],
      allowFailure: true,
      multicallAddress: multicallAddressFor(chainId),
    })

    if (attestor.status !== 'success') return null

    return {
      attestor: attestor.result,
      maxEvidenceAge: maxAge.status === 'success' ? Number(maxAge.result) : 86_400,
      minValidationScore: minScore.status === 'success' ? minScore.result : 50,
      evidenceBaseUri:
        baseUri.status === 'success' && baseUri.result !== '' ? baseUri.result : null,
    }
  } catch {
    return null
  }
}

/**
 * The gate's parameters, cached for an hour.
 *
 * `attestor`, `maxEvidenceAge` and `minValidationScore` are owner-settable, so
 * they are read rather than hard-coded — but they change on the order of
 * never, and every page that shows a spend cap or a freshness window needs
 * them. Four calls per page render is a poor trade for a value that has not
 * moved since deployment.
 *
 * Deliberately separate from `readEvidenceBatch`, which is never cached: one
 * of these decides how the UI phrases a sentence, the other decides whether
 * money can move.
 */
export const getCachedHookConfig = unstable_cache(
  async (chainId: SupportedChainId): Promise<HookConfig | null> => readHookConfig(chainId),
  ['hook-config'],
  { revalidate: 3_600, tags: ['hook-config'] },
)

/**
 * Read evidence for many agents in one round-trip.
 *
 * Called with a whole page of the discovery table, so it has to be one
 * multicall rather than N calls. Failures are per-entry: a single reverting
 * agent id degrades to `null` for that row instead of blanking the page.
 */
export async function readEvidenceBatch(
  chainId: SupportedChainId,
  agentIds: number[],
): Promise<Map<number, HallmarkEvidence>> {
  const out = new Map<number, HallmarkEvidence>()
  const deployment = getDeployment(chainId)
  if (deployment === null || agentIds.length === 0) return out

  const client = publicClientFor(chainId)
  const base = { address: deployment.hook, abi: hallmarkHookAbi } as const

  const contracts = agentIds.flatMap((agentId) => {
    const id = BigInt(agentId)
    return [
      { ...base, functionName: 'isHireable' as const, args: [id] as const },
      { ...base, functionName: 'agentRecord' as const, args: [id] as const },
      // Same call, six-field decode. The deployed hook returns five fields
      // and the current source returns six; exactly one of these two decodes
      // cleanly, and taking the one that does keeps the numbers right across
      // a redeploy instead of silently reading `jobsStalled` as the delivery
      // total. See the note on `hallmarkHookRecordV2Abi`.
      {
        address: deployment.hook,
        abi: hallmarkHookRecordV2Abi,
        functionName: 'agentRecord' as const,
        args: [id] as const,
      },
      { ...base, functionName: 'averageDeliverySeconds' as const, args: [id] as const },
    ]
  })

  let results: MulticallEntry[]
  try {
    results = (await client.multicall({
      // Three different return shapes in one batch defeats viem's per-entry
      // inference; each decoded value is re-narrowed at its use site below.
      contracts: contracts as never,
      allowFailure: true,
      multicallAddress: multicallAddressFor(chainId),
    })) as unknown as MulticallEntry[]
  } catch {
    return out
  }

  agentIds.forEach((agentId, index) => {
    const hireableEntry = results[index * 4]
    const recordV1Entry = results[index * 4 + 1]
    const recordV2Entry = results[index * 4 + 2]
    const deliveryEntry = results[index * 4 + 3]
    if (hireableEntry === undefined || hireableEntry.status !== 'success') return

    const [ok, lastEvidenceAt, score] = hireableEntry.result as readonly [boolean, bigint, number]

    // Whichever struct shape the deployed hook actually has is the one that
    // decodes; the other comes back as a failed entry.
    const recordEntry =
      recordV2Entry !== undefined && recordV2Entry.status === 'success'
        ? recordV2Entry
        : recordV1Entry
    const record =
      recordEntry !== undefined && recordEntry.status === 'success'
        ? (recordEntry.result as {
            jobsFunded: number
            jobsCompleted: number
            jobsRejected: number
            jobsExpired: number
            jobsStalled?: number
            totalDeliverySeconds: bigint
          })
        : null
    const delivery =
      deliveryEntry !== undefined && deliveryEntry.status === 'success'
        ? Number(deliveryEntry.result as bigint)
        : 0

    const at = Number(lastEvidenceAt)
    out.set(agentId, {
      chainId,
      agentId,
      hireable: ok,
      lastEvidenceAt: at > 0 ? at : null,
      score: at > 0 ? score : null,
      jobsFunded: record?.jobsFunded ?? 0,
      jobsCompleted: record?.jobsCompleted ?? 0,
      jobsRejected: record?.jobsRejected ?? 0,
      jobsExpired: record?.jobsExpired ?? 0,
      jobsStalled: record?.jobsStalled ?? null,
      averageDeliverySeconds: delivery > 0 ? delivery : null,
    })
  })

  return out
}

export async function readEvidence(
  chainId: SupportedChainId,
  agentId: number,
): Promise<HallmarkEvidence | null> {
  const batch = await readEvidenceBatch(chainId, [agentId])
  return batch.get(agentId) ?? null
}

/**
 * The classification the whole product hangs off.
 *
 * Ordered by how much a hiring decision should weigh it. Hallmark's own probe
 * is first because it is the only one the escrow enforces; the index's opinion
 * is real information but nobody is staking money on it.
 */
export type EvidenceStatus =
  | 'hallmark-fresh'
  | 'hallmark-stale'
  | 'index-reachable'
  | 'index-checked'
  | 'index-unreachable'
  | 'never-probed'
  | 'no-endpoint'

export type EvidenceVerdict = {
  status: EvidenceStatus
  /** Two or three words, for a table cell. */
  label: string
  /** A full sentence, for a tooltip or a detail panel. */
  detail: string
  /** Where the claim comes from. Shown next to it, always. */
  source: 'hallmark' | 'index' | 'none'
  tone: 'ok' | 'warn' | 'bad' | 'neutral'
  /** When the underlying observation was made. */
  observedAt: string | null
}

export type EvidenceInputs = {
  hallmark: HallmarkEvidence | null
  /** The indexer's endpoint verification. */
  indexVerified: boolean | null
  indexCheckedAt: string | null
  indexHealthScore: number | null
  /** Whether the registration file declares any reachable endpoint at all. */
  declaresEndpoint: boolean
  /** Seconds the hook accepts evidence for; used for the stale wording. */
  maxEvidenceAge: number
}

/**
 * A note on `indexVerified: null`.
 *
 * The index's list endpoint does not carry endpoint verification — only its
 * detail endpoint does, and fetching that per row would cost a round-trip per
 * agent. So on the discovery list `indexVerified` is genuinely unknown rather
 * than false, and the classifier below never reports "unreachable" from an
 * absence. `indexHealthScore` is the weaker signal the list row does carry:
 * non-null means the index ran a health check, which is not the same as
 * verifying an endpoint but is more than nothing.
 */

export function classifyEvidence(inputs: EvidenceInputs): EvidenceVerdict {
  const { hallmark, indexVerified, indexCheckedAt, declaresEndpoint, maxEvidenceAge } = inputs

  if (hallmark !== null && hallmark.lastEvidenceAt !== null) {
    const observedAt = new Date(hallmark.lastEvidenceAt * 1000).toISOString()
    if (hallmark.hireable) {
      return {
        status: 'hallmark-fresh',
        label: 'Probed, live',
        detail:
          `Hallmark probed this agent's declared endpoint and scored it ${hallmark.score}/100. ` +
          'The escrow will accept a job for it right now.',
        source: 'hallmark',
        tone: 'ok',
        observedAt,
      }
    }
    return {
      status: 'hallmark-stale',
      label: 'Evidence stale',
      detail:
        `The last Hallmark probe scored ${hallmark.score}/100, and the escrow only accepts ` +
        `evidence from the last ${Math.round(maxEvidenceAge / 3600)} hours above the minimum score. ` +
        'Funding a job for this agent reverts.',
      source: 'hallmark',
      tone: 'bad',
      observedAt,
    }
  }

  if (!declaresEndpoint) {
    return {
      status: 'no-endpoint',
      label: 'No endpoint',
      detail:
        'The registration file declares no service endpoint, so there is nothing to probe. ' +
        'This agent cannot be reached, hired or verified by anyone.',
      source: 'none',
      tone: 'neutral',
      observedAt: null,
    }
  }

  if (indexVerified === true) {
    return {
      status: 'index-reachable',
      label: 'Reachable',
      detail:
        'The public 8004scan index reached this endpoint and verified the domain. ' +
        'Hallmark has not probed it itself, so no escrow guard is backing this.',
      source: 'index',
      tone: 'ok',
      observedAt: indexCheckedAt,
    }
  }

  if (indexVerified === false && indexCheckedAt !== null) {
    return {
      status: 'index-unreachable',
      label: 'Unreachable',
      detail:
        'The public index checked this endpoint and could not verify it. ' +
        'That is not proof the agent is dead, but nobody has evidence that it is alive.',
      source: 'index',
      tone: 'warn',
      observedAt: indexCheckedAt,
    }
  }

  // The list row carries a health score but no verification flag, so this is
  // what "the index has looked at it and we cannot say more from here" looks
  // like. Reporting "unreachable" from a missing field would be inventing a
  // negative out of an absence.
  const health = inputs.indexHealthScore
  if (health !== null) {
    return {
      status: 'index-checked',
      label: `Index-checked ${Math.round(health)}`,
      detail:
        `The public index health-checked this agent and scored it ${Math.round(health)}/100. ` +
        'That covers owner activity and domain reachability rather than a protocol ' +
        'handshake, and Hallmark has not probed it — open the agent to see exactly what ' +
        'the index checked.',
      source: 'index',
      tone: health >= 70 ? 'ok' : 'warn',
      observedAt: indexCheckedAt,
    }
  }

  return {
    status: 'never-probed',
    label: 'Never probed',
    detail:
      'Nobody has checked this endpoint — not Hallmark, not the public index. ' +
      'It declares somewhere to be reached; whether anything answers is unknown.',
    source: 'none',
    tone: 'neutral',
    observedAt: null,
  }
}

export const EVIDENCE_FILTERS = [
  { value: 'any', label: 'Any evidence' },
  { value: 'reachable', label: 'Probed and reachable' },
  { value: 'unreachable', label: 'Probed, not reachable' },
  { value: 'unprobed', label: 'Never probed' },
] as const

export type EvidenceFilter = (typeof EVIDENCE_FILTERS)[number]['value']

export function isEvidenceFilter(value: string | null | undefined): value is EvidenceFilter {
  return EVIDENCE_FILTERS.some((filter) => filter.value === value)
}
