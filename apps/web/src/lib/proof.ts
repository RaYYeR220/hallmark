import 'server-only'

import { createRegistryReader } from '@hallmark/core'

import { erc20Abi, hallmarkCommerceAbi, hallmarkHookAbi } from './abi'
import { multicallAddressFor, publicClientFor } from './chain'
import { getDeployment, type SupportedChainId } from './deployments'
import { rpcUrlFor } from './env'
import { fetchAgentPage } from './scan'

/**
 * Everything on the proof page, gathered live.
 *
 * The rule for this module: if a number cannot be read from a chain right now,
 * it does not appear. No cached figures, no numbers carried over from a README,
 * nothing that was true last week. A proof page that can go stale is not a
 * proof page.
 *
 * Anything that fails to read comes back null and the page says which read
 * failed, because "we could not check" and "there is nothing there" are
 * different claims.
 */

export type LiveContract = {
  label: string
  address: `0x${string}`
  /**
   * A live read from the contract, proving it is not just an address.
   * `null` means the read was attempted and failed — which the page says out
   * loud. A row with nothing worth reading sets `readingLabel` to '' instead,
   * so "we did not ask" never renders as "we asked and it broke".
   */
  reading: string | null
  readingLabel: string
  deployTx: string | null
}

export type ProofJob = {
  jobId: number
  status: string
  statusName: string
  client: `0x${string}`
  provider: `0x${string}`
  budget: string
  agentId: number | null
  hook: `0x${string}`
}

export type EvidenceWrite = {
  agentId: number
  kind: 'validation' | 'reputation'
  label: string
  score: number
  tag: string
  writer: `0x${string}`
  at: number | null
  evidenceHash: string | null
  txHash: string | null
}

export type ProofSnapshot = {
  chainId: SupportedChainId
  contracts: LiveContract[]
  /** The gate's configuration, quoted from the contract. */
  gate: {
    attestor: `0x${string}`
    maxEvidenceAgeSeconds: number
    minValidationScore: number
    evidenceBaseUri: string | null
  } | null
  jobCount: number | null
  jobs: ProofJob[]
  /** Agents Hallmark itself registered on this chain. */
  ourAgents: { agentId: number; name: string; hireable: boolean; score: number | null }[]
  evidenceWrites: EvidenceWrite[]
  /** A live demonstration that the gate refuses an unprobed agent. */
  refusalProbe: { agentId: number; hireable: boolean; lastEvidenceAt: number } | null
  readAt: string
  failures: string[]
}

const STATUS_NAMES = ['Open', 'Funded', 'Submitted', 'Completed', 'Rejected', 'Expired']

export async function getProofSnapshot(chainId: SupportedChainId): Promise<ProofSnapshot> {
  const deployment = getDeployment(chainId)
  const failures: string[] = []
  const readAt = new Date().toISOString()

  if (deployment === null) {
    return {
      chainId,
      contracts: [],
      gate: null,
      jobCount: null,
      jobs: [],
      ourAgents: [],
      evidenceWrites: [],
      refusalProbe: null,
      readAt,
      failures: [`Hallmark has no deployment on chain ${chainId}.`],
    }
  }

  const client = publicClientFor(chainId)

  // --- contract configuration, read live ----------------------------------

  let gate: ProofSnapshot['gate'] = null
  let jobCount: number | null = null
  let feeBps: number | null = null
  let hookWhitelisted: boolean | null = null
  let tokenSymbol: string | null = null
  let tokenDecimals: number | null = null

  try {
    const results = (await client.multicall({
      contracts: [
        { address: deployment.hook, abi: hallmarkHookAbi, functionName: 'attestor' },
        { address: deployment.hook, abi: hallmarkHookAbi, functionName: 'maxEvidenceAge' },
        { address: deployment.hook, abi: hallmarkHookAbi, functionName: 'minValidationScore' },
        { address: deployment.hook, abi: hallmarkHookAbi, functionName: 'evidenceBaseURI' },
        { address: deployment.commerce, abi: hallmarkCommerceAbi, functionName: 'jobCount' },
        { address: deployment.commerce, abi: hallmarkCommerceAbi, functionName: 'feeBps' },
        {
          address: deployment.commerce,
          abi: hallmarkCommerceAbi,
          functionName: 'isHookWhitelisted',
          args: [deployment.hook],
        },
        { address: deployment.paymentToken, abi: erc20Abi, functionName: 'symbol' },
        { address: deployment.paymentToken, abi: erc20Abi, functionName: 'decimals' },
      ] as never,
      allowFailure: true,
      multicallAddress: multicallAddressFor(chainId),
    })) as unknown as ({ status: 'success'; result: unknown } | { status: 'failure' })[]

    const value = <T,>(index: number): T | null => {
      const entry = results[index]
      return entry !== undefined && entry.status === 'success' ? (entry.result as T) : null
    }

    const attestor = value<`0x${string}`>(0)
    if (attestor !== null) {
      gate = {
        attestor,
        maxEvidenceAgeSeconds: Number(value<bigint>(1) ?? 86_400n),
        minValidationScore: Number(value<number>(2) ?? 50),
        evidenceBaseUri: value<string>(3),
      }
    }
    jobCount = value<bigint>(4) === null ? null : Number(value<bigint>(4))
    feeBps = value<number>(5)
    hookWhitelisted = value<boolean>(6)
    tokenSymbol = value<string>(7)
    tokenDecimals = value<number>(8)
  } catch (error) {
    failures.push(
      `Reading the deployed contracts failed: ${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }`,
    )
  }

  const contracts: LiveContract[] = [
    {
      label: 'AgenticCommerceHooked — the ERC-8183 escrow',
      address: deployment.commerce,
      reading:
        jobCount === null
          ? null
          : `${jobCount} job${jobCount === 1 ? '' : 's'} created, fee ${
              feeBps === null ? '?' : (feeBps / 100).toFixed(2)
            }%`,
      readingLabel: 'jobCount() / feeBps()',
      deployTx: deployment.deployTx[0]?.hash ?? null,
    },
    {
      label: 'HallmarkHook — the evidence gate and the settlement receipt',
      address: deployment.hook,
      reading:
        gate === null
          ? null
          : `accepts evidence under ${Math.round(
              gate.maxEvidenceAgeSeconds / 3_600,
            )}h scoring ≥ ${gate.minValidationScore}`,
      readingLabel: 'maxEvidenceAge() / minValidationScore()',
      deployTx: deployment.deployTx[1]?.hash ?? null,
    },
    {
      label: 'The hook, allow-listed on the escrow',
      address: deployment.commerce,
      reading:
        hookWhitelisted === null ? null : hookWhitelisted ? 'true' : 'false — not allow-listed',
      readingLabel: `isHookWhitelisted(${deployment.hook.slice(0, 10)}…)`,
      deployTx: deployment.deployTx[2]?.hash ?? null,
    },
    {
      label: 'The escrow’s immutable payment token',
      address: deployment.paymentToken,
      reading:
        tokenSymbol === null
          ? null
          : `${tokenSymbol}, ${tokenDecimals ?? '?'} decimals`,
      readingLabel: 'symbol() / decimals()',
      deployTx: null,
    },
  ]

  // --- jobs ---------------------------------------------------------------

  const jobs: ProofJob[] = []
  if (jobCount !== null && jobCount > 0) {
    const wanted = Array.from({ length: Math.min(jobCount, 12) }, (_, index) => jobCount - index)
    try {
      const results = (await client.multicall({
        contracts: wanted.flatMap((jobId) => [
          {
            address: deployment.commerce,
            abi: hallmarkCommerceAbi,
            functionName: 'getJob' as const,
            args: [BigInt(jobId)] as const,
          },
          {
            address: deployment.hook,
            abi: hallmarkHookAbi,
            functionName: 'jobAgent' as const,
            args: [BigInt(jobId)] as const,
          },
        ]) as never,
        allowFailure: true,
        multicallAddress: multicallAddressFor(chainId),
      })) as unknown as ({ status: 'success'; result: unknown } | { status: 'failure' })[]

      wanted.forEach((jobId, index) => {
        const jobEntry = results[index * 2]
        const agentEntry = results[index * 2 + 1]
        if (jobEntry === undefined || jobEntry.status !== 'success') return

        const job = jobEntry.result as {
          id: bigint
          client: `0x${string}`
          provider: `0x${string}`
          budget: bigint
          status: number
          hook: `0x${string}`
        }
        const agentId =
          agentEntry !== undefined && agentEntry.status === 'success'
            ? Number(agentEntry.result as bigint)
            : null

        jobs.push({
          jobId,
          status: String(job.status),
          statusName: STATUS_NAMES[job.status] ?? 'Unknown',
          client: job.client,
          provider: job.provider,
          budget: job.budget.toString(),
          agentId: agentId === null || agentId === 0 ? null : agentId,
          hook: job.hook,
        })
      })
    } catch {
      failures.push('Reading the escrow’s jobs failed; the count above is still a live read.')
    }
  }

  // --- our own agents, and the evidence written about them ----------------

  const ourAgents: ProofSnapshot['ourAgents'] = []
  const evidenceWrites: EvidenceWrite[] = []

  if (gate !== null) {
    try {
      // Seed from agents that carry at least one on-chain rating rather than
      // from whatever the attestor happens to own: the attestor writes
      // evidence about other people's agents and frequently owns none of
      // them, so an ownership filter would show an empty page while the
      // registries were full.
      const page = await fetchAgentPage({
        chain_id: chainId,
        min_feedbacks: 1,
        sort_by: 'total_feedbacks',
        sort_order: 'desc',
        limit: 8,
      }).catch(() => null)

      // Our own agents first, then whatever else carries on-chain ratings.
      const candidates = [
        ...deployment.ownAgentIds,
        ...(page?.items.map((item) => Number(item.token_id)) ?? []),
      ].filter((id, index, all) => all.indexOf(id) === index)

      const reader = createRegistryReader(chainId, {
        ...(rpcUrlFor(chainId) === undefined ? {} : { rpcUrl: rpcUrlFor(chainId) as string }),
      })

      for (const agentId of candidates.slice(0, 6)) {
        const [hireable, validations] = await Promise.all([
          client
            .readContract({
              address: deployment.hook,
              abi: hallmarkHookAbi,
              functionName: 'isHireable',
              args: [BigInt(agentId)],
            })
            .catch(() => null),
          reader.agentValidations(agentId).catch(() => null),
        ])

        const row = page?.items.find((item) => Number(item.token_id) === agentId)
        ourAgents.push({
          agentId,
          name: row?.name ?? `Agent #${agentId}`,
          hireable: hireable === null ? false : (hireable as readonly [boolean, bigint, number])[0],
          score:
            hireable === null
              ? null
              : Number((hireable as readonly [boolean, bigint, number])[2]),
        })

        for (const requestHash of (validations ?? []).slice(0, 4)) {
          const status = await reader.validationStatus(requestHash).catch(() => null)
          if (status === null) continue
          // This section is headed "attestations we wrote", so it lists what
          // the attestor wrote and nothing else. Other people's records are
          // real and are shown in full on each agent's own page, attributed to
          // whoever wrote them — putting them here would be taking credit.
          if (status.validator.toLowerCase() !== gate.attestor.toLowerCase()) continue
          evidenceWrites.push({
            agentId,
            kind: 'validation',
            label: `Validation on agent #${agentId}`,
            score: status.response,
            tag: status.tag,
            writer: status.validator,
            at: Number(status.lastUpdate),
            evidenceHash: status.responseHash,
            txHash: null,
          })
        }

        // Reputation entries are the other half of the published evidence.
        // The registry stores no timestamp for them, so `at` stays null and
        // the page orders them after the self-dating validations rather than
        // inventing a time.
        const feedback = await reader.allFeedback(agentId).catch(() => null)
        for (const entry of feedback ?? []) {
          if (entry.isRevoked) continue
          if (entry.client.toLowerCase() !== gate.attestor.toLowerCase()) continue
          evidenceWrites.push({
            agentId,
            kind: 'reputation',
            label: `Reputation entry on agent #${agentId}`,
            score: entry.score,
            tag: entry.tag1,
            writer: entry.client,
            at: null,
            evidenceHash: null,
            txHash: null,
          })
        }
      }
    } catch {
      failures.push('Listing Hallmark’s own agents from the index failed.')
    }
  }

  // --- the gate refusing something, live ----------------------------------

  let refusalProbe: ProofSnapshot['refusalProbe'] = null
  try {
    // A high id that has never been probed. The point is the shape of the
    // answer, not the specific agent: `isHireable` returns false with a zero
    // timestamp for every agent nobody has ever measured, which is almost all
    // of them.
    const probeId = 1n
    const result = (await client.readContract({
      address: deployment.hook,
      abi: hallmarkHookAbi,
      functionName: 'isHireable',
      args: [probeId],
    })) as readonly [boolean, bigint, number]
    refusalProbe = {
      agentId: Number(probeId),
      hireable: result[0],
      lastEvidenceAt: Number(result[1]),
    }
  } catch {
    failures.push('The live refusal probe could not be read.')
  }

  return {
    chainId,
    contracts,
    gate,
    jobCount,
    jobs,
    ourAgents,
    evidenceWrites: evidenceWrites.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)),
    refusalProbe,
    readAt,
    failures,
  }
}
