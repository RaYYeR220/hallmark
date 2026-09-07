/**
 * The on-chain writer.
 *
 * Three rules run through this file and none of them are negotiable.
 *
 *  1. **Dry run by default.** Nothing is signed unless the caller asked for it
 *     with `--commit`. The dry run prints the exact calldata arguments and the
 *     exact cost, so what you approve is what gets sent.
 *
 *  2. **Never silently skip.** Every write that does not happen produces a
 *     `skipped` outcome carrying the reason, and that reason is written to the
 *     store alongside the ones that did happen. A quiet no-op is the worst
 *     possible failure mode for an attestation service.
 *
 *  3. **Trust state, not receipts.** A sibling contract in this repo taught us
 *     the lesson the expensive way: `eth_estimateGas` binary-searches for the
 *     smallest limit under which the OUTER call succeeds, and a `try/catch`
 *     around an inner call means the outer call succeeds even when the inner
 *     one ran out of gas. The transaction then mines with `status: success`
 *     and the write never landed. So every write here sends an explicit gas
 *     limit sized from measurements rather than from an estimate, and every
 *     write is confirmed by reading the resulting state back out of the
 *     contract.
 *
 * Measured on BSC at 0.05 gwei with BNB at $744.57:
 *
 *   giveFeedback         213,948 first write for a client, 132,140 after
 *   validationRequest    210,287
 *   validationResponse   132,366
 *
 * A full validation cycle is about $0.013.
 */

import { createWalletClient, http, formatEther, parseGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Account, Address, PublicClient, WalletClient } from 'viem'

import {
  createRegistryReader,
  getChain,
  reputationRegistryAbi,
  validationRegistryAbi,
} from '@hallmark/core'
import type { RegistryReader, SupportedChainId } from '@hallmark/core'

import { hallmarkHookAbi } from './abi.ts'
import { evidenceUri } from './evidence.ts'
import { silentLogger } from './log.ts'
import type { Logger } from './log.ts'
import { rpcUrlFor } from './config.ts'
import type { ProberConfig } from './config.ts'
import type { EvidenceStore, PublicationRecord, RunRecord } from './store.ts'
import type { PublishKind, PublishOutcome, PublishPlan } from './types.ts'

/**
 * Explicit gas limits with headroom over the measured cost. These are floors,
 * not estimates: `gasLimitFor` takes whichever of this and `eth_estimateGas`
 * is larger, so a heavier-than-measured call still goes through, but a
 * suspiciously cheap estimate can never starve a write.
 */
export const GAS_LIMITS = {
  giveFeedback: 320_000n,
  validationRequest: 320_000n,
  validationResponse: 220_000n,
  recordProbe: 140_000n,
} as const

/** Estimates are inflated by this much before being compared to the floor. */
export const ESTIMATE_HEADROOM_NUMERATOR = 125n
export const ESTIMATE_HEADROOM_DENOMINATOR = 100n

/** BSC has sat at 0.05 gwei for months; anything past this is a fee spike, not a fee. */
export const MAX_ACCEPTABLE_GAS_PRICE = parseGwei('5')

/** ERC-8004's own tag vocabulary for liveness. Nothing invented. */
export const FEEDBACK_TAGS = ['reachable', 'uptime', 'responsetime'] as const
export type FeedbackTag = (typeof FEEDBACK_TAGS)[number]

/** Stamped as `tag2` on every entry so Hallmark's writes are filterable. */
export const HALLMARK_TAG = 'hallmark'

export const DEFAULT_VALIDATION_TAG = 'reachable'

const PROTOCOL_LIVE_REFUSAL =
  'no endpoint is protocol-live (a valid A2A card with skills, an MCP server that enumerated tools, ' +
  'or a decodable x402 challenge); a reachable web page is not an agent. Pass --allow-web-only to override.'

const NO_ATTESTOR = 'no attestor address: set ATTESTOR_PRIVATE_KEY, or pass --as <address> to plan a dry run'
const NO_VALIDATOR = 'no validator address: set VALIDATOR_PRIVATE_KEY, or pass --as <address> to plan a dry run'

export type BudgetState = {
  perRunWei: bigint
  totalWei: bigint
  spentThisRunWei: bigint
  spentAllTimeWei: bigint
  reservedWei: bigint
}

export type BudgetGuard = {
  /** `null` when the spend is allowed; a human reason when it is not. */
  check(costWei: bigint): string | null
  /** Hold the estimate against the ceiling while the write is in flight. */
  reserve(costWei: bigint): void
  /** Replace a reservation with what was actually spent. */
  settle(reservedWei: bigint, actualWei: bigint): void
  /** Drop a reservation for a write that never went out. */
  release(costWei: bigint): void
  state(): BudgetState
}

export function createBudgetGuard(input: {
  perRunWei: bigint
  totalWei: bigint
  alreadySpentWei?: bigint
}): BudgetGuard {
  const alreadySpentWei = input.alreadySpentWei ?? 0n
  let spentThisRunWei = 0n
  let reservedWei = 0n

  const state = (): BudgetState => ({
    perRunWei: input.perRunWei,
    totalWei: input.totalWei,
    spentThisRunWei,
    spentAllTimeWei: alreadySpentWei + spentThisRunWei,
    reservedWei,
  })

  return {
    check(costWei) {
      if (costWei < 0n) return 'negative cost'
      const run = spentThisRunWei + reservedWei + costWei
      if (run > input.perRunWei) {
        return `per-run budget exhausted: ${formatEther(run)} BNB needed, ceiling is ${formatEther(input.perRunWei)} BNB`
      }
      const total = alreadySpentWei + spentThisRunWei + reservedWei + costWei
      if (total > input.totalWei) {
        return `total budget exhausted: ${formatEther(total)} BNB needed across all runs, ceiling is ${formatEther(input.totalWei)} BNB`
      }
      return null
    },
    reserve(costWei) {
      reservedWei += costWei
    },
    settle(reserved, actual) {
      reservedWei -= reserved
      if (reservedWei < 0n) reservedWei = 0n
      spentThisRunWei += actual
    },
    release(costWei) {
      reservedWei -= costWei
      if (reservedWei < 0n) reservedWei = 0n
    },
    state,
  }
}

export type PublisherOptions = {
  chainId: SupportedChainId
  config: ProberConfig
  store: EvidenceStore
  logger?: Logger
  reader?: RegistryReader
  budget?: BudgetGuard
  /** Nothing is signed unless this is explicitly false. */
  dryRun?: boolean
  /** Override the fee, in wei. Otherwise the node's `eth_gasPrice` is used. */
  gasPriceWei?: bigint
  minScore?: number
  /**
   * Publish only agents that pass the strict protocol-live test. Defaults to
   * true, because a `web` face returning HTML is the single largest source of
   * a false "alive" reading and we refuse to put that on chain.
   */
  requireProtocolLive?: boolean
  feedbackTag?: FeedbackTag
  validationTag?: string
  /**
   * Plan as if this address were signing. Dry run only, and only when the
   * matching key is absent — it lets an operator cost and pre-check exactly
   * what the funded key would write without the funded key being anywhere near
   * the machine that is planning.
   */
  plannerAddress?: Address
}

export type Publisher = {
  chainId: SupportedChainId
  dryRun: boolean
  attestor: Address | null
  validator: Address | null
  agentOwner: Address | null
  gasPrice(): Promise<bigint>
  budget(): BudgetState
  /** Unsolicited: works from any address that is not the agent's own controller. */
  publishReputation(record: RunRecord): Promise<PublishOutcome>
  /** Opt-in: only answers a `validationRequest` the agent's owner already made. */
  publishValidation(record: RunRecord, requestHash?: `0x${string}`): Promise<PublishOutcome>
  /** Hallmark's own freshness clock, which the ERC-8004 registries do not provide. */
  recordProbeOnHook(record: RunRecord): Promise<PublishOutcome>
  /** The owner half of the validation cycle, for agents we control. */
  requestValidation(agentId: number, evidenceHash: `0x${string}`, uri: string): Promise<PublishOutcome>
}

export function createPublisher(options: PublisherOptions): Publisher {
  const { chainId, config, store } = options
  const logger = options.logger ?? silentLogger
  const chain = getChain(chainId)
  const reader = options.reader ?? createRegistryReader(chainId, { rpcUrl: rpcUrlFor(config, chainId) })
  const client = reader.client as PublicClient
  const dryRun = options.dryRun !== false
  const minScore = options.minScore ?? 1
  const requireProtocolLive = options.requireProtocolLive !== false
  const feedbackTag: FeedbackTag = options.feedbackTag ?? 'reachable'
  const validationTag = options.validationTag ?? DEFAULT_VALIDATION_TAG

  const attestorAccount = accountFrom(config.attestorPrivateKey)
  const validatorAccount = accountFrom(config.validatorPrivateKey)
  const ownerAccount = accountFrom(config.agentOwnerPrivateKey)

  // The hook's funding gate reads validations where `validator == attestor` and
  // reputation entries written by the attestor. Two different keys means the
  // gate silently never opens, so say it out loud once, up front.
  if (
    attestorAccount !== null &&
    validatorAccount !== null &&
    attestorAccount.address.toLowerCase() !== validatorAccount.address.toLowerCase()
  ) {
    logger.error('='.repeat(78))
    logger.error('ATTESTOR AND VALIDATOR ARE DIFFERENT ADDRESSES. THE FUNDING GATE WILL NEVER OPEN.')
    logger.error(`  attestor  ${attestorAccount.address}`)
    logger.error(`  validator ${validatorAccount.address}`)
    logger.error('  HallmarkHook._reputationEvidence reads getSummary(agentId, [attestor], "reachable", "")')
    logger.error('  and HallmarkHook._validationEvidence requires validator == attestor, so evidence written')
    logger.error('  by any other address is invisible to the gate no matter how much of it you publish.')
    logger.error('  Set ATTESTOR_PRIVATE_KEY and VALIDATOR_PRIVATE_KEY to the same key.')
    logger.error('='.repeat(78))
  }

  // A dry run only needs an address to check pre-conditions against; a real
  // send needs the key. Keeping the two apart is what lets planning happen on a
  // machine that holds no funds.
  const plannerAddress = dryRun ? (options.plannerAddress ?? null) : null
  const attestorAddress: Address | null = attestorAccount?.address ?? plannerAddress
  const validatorAddress: Address | null = validatorAccount?.address ?? plannerAddress

  const budget =
    options.budget ??
    createBudgetGuard({ perRunWei: config.budget.perRunWei, totalWei: config.budget.totalWei })

  let cachedGasPrice: bigint | null = options.gasPriceWei ?? null
  const nonces = new Map<string, bigint>()

  async function gasPrice(): Promise<bigint> {
    if (cachedGasPrice !== null) return cachedGasPrice
    cachedGasPrice = await client.getGasPrice()
    return cachedGasPrice
  }

  async function nextNonce(address: Address): Promise<bigint> {
    const key = address.toLowerCase()
    const held = nonces.get(key)
    if (held !== undefined) return held
    const fresh = BigInt(await client.getTransactionCount({ address, blockTag: 'pending' }))
    nonces.set(key, fresh)
    return fresh
  }

  function bumpNonce(address: Address): void {
    const key = address.toLowerCase()
    nonces.set(key, (nonces.get(key) ?? 0n) + 1n)
  }

  function resetNonce(address: Address): void {
    nonces.delete(address.toLowerCase())
  }

  function walletFor(account: Account): WalletClient {
    return createWalletClient({ account, chain: chain.chain, transport: http(rpcUrlFor(config, chainId)) })
  }

  function gasPriceRefusal(price: bigint): string | null {
    if (price > MAX_ACCEPTABLE_GAS_PRICE) {
      return `gas price ${price} wei exceeds the ${MAX_ACCEPTABLE_GAS_PRICE} wei ceiling; refusing to write into a fee spike`
    }
    return null
  }

  async function gasLimitFor(
    floor: bigint,
    estimate: () => Promise<bigint>,
  ): Promise<{ limit: bigint; estimated: bigint | null; note: string }> {
    let estimated: bigint | null = null
    try {
      estimated = await estimate()
    } catch (err) {
      return { limit: floor, estimated: null, note: `estimateGas failed (${messageOf(err)}); using the measured floor` }
    }
    const padded = (estimated * ESTIMATE_HEADROOM_NUMERATOR) / ESTIMATE_HEADROOM_DENOMINATOR
    const limit = padded > floor ? padded : floor
    return {
      limit,
      estimated,
      note: limit === floor ? `estimate ${estimated} below the measured floor ${floor}` : `estimate ${estimated} +25%`,
    }
  }

  async function record(entry: PublicationRecord): Promise<void> {
    try {
      await store.recordPublication(entry)
    } catch (err) {
      logger.warn('could not write the publication log', { error: messageOf(err) })
    }
  }

  /**
   * The one place a transaction is signed. Everything above builds a plan and
   * hands it here; everything below is verification.
   */
  async function send(input: {
    plan: PublishPlan
    account: Account
    reservedWei: bigint
    write: (nonce: bigint, gasLimit: bigint, gasPriceWei: bigint) => Promise<`0x${string}`>
    verify: () => Promise<{ ok: boolean; message: string }>
  }): Promise<PublishOutcome> {
    const { plan, account } = input
    let txHash: `0x${string}`
    try {
      const nonce = await nextNonce(account.address)
      txHash = await withRetry(
        () => input.write(nonce, BigInt(plan.gasLimit), BigInt(plan.gasPriceWei)),
        2,
        (attempt, err) => logger.warn('rpc write failed, retrying', { attempt, error: messageOf(err) }),
      )
      bumpNonce(account.address)
    } catch (err) {
      resetNonce(account.address)
      budget.release(input.reservedWei)
      const reason = `send failed: ${messageOf(err)}`
      logger.error('write not sent', { kind: plan.kind, agentId: plan.agentId, reason })
      await record(publicationOf(plan, 'failed', null, null, reason))
      return { plan, status: 'failed', reason }
    }

    logger.info('write sent', { kind: plan.kind, agentId: plan.agentId, tx: txHash })

    let receipt
    try {
      receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 })
    } catch (err) {
      // The transaction may still land. Charge the reservation rather than
      // pretending nothing was spent.
      budget.settle(input.reservedWei, input.reservedWei)
      const reason = `receipt not observed: ${messageOf(err)}`
      await record(publicationOf(plan, 'failed', txHash, null, reason))
      return { plan, status: 'failed', reason, txHash }
    }

    const spent = receipt.gasUsed * (receipt.effectiveGasPrice ?? BigInt(plan.gasPriceWei))
    budget.settle(input.reservedWei, spent)

    if (receipt.status !== 'success') {
      const reason = `transaction reverted on chain (gas used ${receipt.gasUsed})`
      logger.error('write reverted', { kind: plan.kind, agentId: plan.agentId, tx: txHash })
      await record(publicationOf(plan, 'failed', txHash, receipt.gasUsed.toString(), reason))
      return { plan, status: 'failed', reason, txHash }
    }

    // A successful receipt is not proof the write landed. Read it back.
    const verification = await input.verify().catch((err: unknown) => ({
      ok: false,
      message: `post-condition read failed: ${messageOf(err)}`,
    }))

    if (!verification.ok) {
      logger.error('write mined but the state did not change as expected', {
        kind: plan.kind,
        agentId: plan.agentId,
        tx: txHash,
        detail: verification.message,
      })
    }

    await record({
      ...publicationOf(plan, 'sent', txHash, receipt.gasUsed.toString(), verification.ok ? null : verification.message),
      costWei: spent.toString(),
    })

    return {
      plan,
      status: 'sent',
      txHash,
      gasUsed: receipt.gasUsed.toString(),
      verified: verification.ok,
      verification: verification.message,
    }
  }

  async function skip(plan: PublishPlan, reason: string): Promise<PublishOutcome> {
    logger.warn('write skipped', { kind: plan.kind, agentId: plan.agentId, reason })
    await record(publicationOf(plan, 'skipped', null, null, reason))
    return { plan, status: 'skipped', reason }
  }

  return {
    chainId,
    dryRun,
    attestor: attestorAddress,
    validator: validatorAddress,
    agentOwner: ownerAccount?.address ?? null,
    gasPrice,
    budget: () => budget.state(),

    async publishReputation(runRecord) {
      const uri = evidenceUri(config.evidenceBaseUrl, runRecord.evidenceHash)
      const encoded = encodeFeedback(runRecord, feedbackTag)
      const endpoint = runRecord.primaryEndpoint ?? ''
      const price = await gasPrice()
      const plan = buildPlan({
        kind: 'reputation',
        chainId,
        agentId: runRecord.agentId,
        to: chain.contracts.reputationRegistry,
        from: attestorAddress ?? '(no attestor address)',
        functionName: 'giveFeedback',
        args: [
          String(runRecord.agentId),
          encoded.value.toString(),
          String(encoded.valueDecimals),
          encoded.tag1,
          HALLMARK_TAG,
          endpoint,
          uri,
          runRecord.evidenceHash,
        ],
        gasLimit: GAS_LIMITS.giveFeedback,
        gasPriceWei: price,
        evidenceHash: runRecord.evidenceHash,
        evidenceUri: uri,
        score: runRecord.score,
      })

      if (attestorAddress === null) return skip(plan, NO_ATTESTOR)
      if (runRecord.score < minScore) {
        return skip(plan, `score ${runRecord.score} is below the --min-score floor of ${minScore}`)
      }
      if (requireProtocolLive && !runRecord.protocolLive) {
        return skip(plan, PROTOCOL_LIVE_REFUSAL)
      }
      if (encoded.value <= 0n) {
        return skip(
          plan,
          `encoded feedback value is ${encoded.value}; HallmarkHook requires value > 0 for the "reachable" tag to count as evidence`,
        )
      }
      const priceRefusal = gasPriceRefusal(price)
      if (priceRefusal !== null) return skip(plan, priceRefusal)

      // The registry rejects feedback from the agent's own controller, so
      // check the owner rather than letting the node hand back a bare revert.
      const agent = await reader.getAgent(runRecord.agentId).catch(() => null)
      if (agent === null) return skip(plan, `agent ${runRecord.agentId} is not registered on chain ${chainId}`)
      if (agent.owner.toLowerCase() === attestorAddress.toLowerCase()) {
        return skip(plan, 'the attestor owns this agent; the Reputation Registry rejects self-feedback')
      }

      const budgetRefusal = budget.check(BigInt(plan.costWei))
      if (budgetRefusal !== null) return skip(plan, budgetRefusal)
      // A dry run holds the reservation too, so the plan shows exactly where
      // the ceiling would stop it rather than costing every write in isolation.
      if (dryRun) {
        budget.reserve(BigInt(plan.costWei))
        return { plan, status: 'dry-run' }
      }
      if (attestorAccount === null) return skip(plan, NO_ATTESTOR)

      const gas = await gasLimitFor(GAS_LIMITS.giveFeedback, () =>
        client.estimateContractGas({
          address: chain.contracts.reputationRegistry,
          abi: reputationRegistryAbi,
          functionName: 'giveFeedback',
          args: [
            BigInt(runRecord.agentId),
            encoded.value,
            encoded.valueDecimals,
            encoded.tag1,
            HALLMARK_TAG,
            endpoint,
            uri,
            runRecord.evidenceHash,
          ],
          account: attestorAccount,
        }),
      )
      logger.debug('gas limit chosen', { kind: 'reputation', limit: gas.limit, note: gas.note })
      const finalPlan: PublishPlan = {
        ...plan,
        gasLimit: gas.limit.toString(),
        costWei: (gas.limit * price).toString(),
      }

      const refusalAfterEstimate = budget.check(BigInt(finalPlan.costWei))
      if (refusalAfterEstimate !== null) return skip(finalPlan, refusalAfterEstimate)

      const reservedWei = BigInt(finalPlan.costWei)
      budget.reserve(reservedWei)

      // 1-based, and `getLastIndex` returns the count rather than the newest
      // index. `readFeedback(agentId, client, 0)` reverts.
      const before = (await reader.lastFeedbackIndex(runRecord.agentId, attestorAccount.address)) ?? 0

      return send({
        plan: finalPlan,
        account: attestorAccount,
        reservedWei,
        write: (nonce, gasLimit, gasPriceWei) =>
          walletFor(attestorAccount).writeContract({
            address: chain.contracts.reputationRegistry,
            abi: reputationRegistryAbi,
            functionName: 'giveFeedback',
            args: [
              BigInt(runRecord.agentId),
              encoded.value,
              encoded.valueDecimals,
              encoded.tag1,
              HALLMARK_TAG,
              endpoint,
              uri,
              runRecord.evidenceHash,
            ],
            account: attestorAccount,
            chain: chain.chain,
            gas: gasLimit,
            gasPrice: gasPriceWei,
            nonce: Number(nonce),
          }),
        verify: async () => {
          const after = await reader.lastFeedbackIndex(runRecord.agentId, attestorAccount.address)
          if (after === null) return { ok: false, message: 'getLastIndex could not be read back' }
          if (after !== before + 1) {
            return { ok: false, message: `expected feedback index ${before + 1}, registry reports ${after}` }
          }
          const entry = await reader.readFeedback(runRecord.agentId, attestorAccount.address, after)
          if (entry === null) return { ok: false, message: `readFeedback(${after}) reverted after a successful receipt` }
          if (entry.tag1 !== encoded.tag1 || BigInt(entry.value) !== encoded.value) {
            return {
              ok: false,
              message: `feedback ${after} reads back as ${entry.tag1}=${entry.value}, expected ${encoded.tag1}=${encoded.value}`,
            }
          }
          return { ok: true, message: `feedback index ${after} reads back as ${entry.tag1}=${entry.value}` }
        },
      })
    },

    async publishValidation(runRecord, requestHash) {
      const uri = evidenceUri(config.evidenceBaseUrl, runRecord.evidenceHash)
      const price = await gasPrice()
      const response = clampToUint8(runRecord.score)
      const plan = buildPlan({
        kind: 'validation',
        chainId,
        agentId: runRecord.agentId,
        to: chain.contracts.validationRegistry,
        from: validatorAddress ?? '(no validator address)',
        functionName: 'validationResponse',
        args: [requestHash ?? '(resolved from getAgentValidations)', String(response), uri, runRecord.evidenceHash, validationTag],
        gasLimit: GAS_LIMITS.validationResponse,
        gasPriceWei: price,
        evidenceHash: runRecord.evidenceHash,
        evidenceUri: uri,
        score: runRecord.score,
      })

      if (validatorAddress === null) return skip(plan, NO_VALIDATOR)
      if (runRecord.score < minScore) {
        return skip(plan, `score ${runRecord.score} is below the --min-score floor of ${minScore}`)
      }
      if (requireProtocolLive && !runRecord.protocolLive) {
        return skip(plan, PROTOCOL_LIVE_REFUSAL)
      }
      const priceRefusal = gasPriceRefusal(price)
      if (priceRefusal !== null) return skip(plan, priceRefusal)

      const resolved = requestHash ?? (await findPendingRequest(reader, runRecord.agentId, validatorAddress))
      if (resolved === null) {
        return skip(
          plan,
          `no validationRequest addressed to ${validatorAddress} for agent ${runRecord.agentId}; validation is opt-in and the agent's owner must call validationRequest first`,
        )
      }
      const resolvedPlan: PublishPlan = { ...plan, args: [resolved, String(response), uri, runRecord.evidenceHash, validationTag] }

      const budgetRefusal = budget.check(BigInt(resolvedPlan.costWei))
      if (budgetRefusal !== null) return skip(resolvedPlan, budgetRefusal)
      if (dryRun) {
        budget.reserve(BigInt(resolvedPlan.costWei))
        return { plan: resolvedPlan, status: 'dry-run' }
      }
      if (validatorAccount === null) return skip(resolvedPlan, NO_VALIDATOR)

      const gas = await gasLimitFor(GAS_LIMITS.validationResponse, () =>
        client.estimateContractGas({
          address: chain.contracts.validationRegistry,
          abi: validationRegistryAbi,
          functionName: 'validationResponse',
          args: [resolved, response, uri, runRecord.evidenceHash, validationTag],
          account: validatorAccount,
        }),
      )
      const finalPlan: PublishPlan = {
        ...resolvedPlan,
        gasLimit: gas.limit.toString(),
        costWei: (gas.limit * price).toString(),
      }
      const refusalAfterEstimate = budget.check(BigInt(finalPlan.costWei))
      if (refusalAfterEstimate !== null) return skip(finalPlan, refusalAfterEstimate)

      const reservedWei = BigInt(finalPlan.costWei)
      budget.reserve(reservedWei)

      return send({
        plan: finalPlan,
        account: validatorAccount,
        reservedWei,
        write: (nonce, gasLimit, gasPriceWei) =>
          walletFor(validatorAccount).writeContract({
            address: chain.contracts.validationRegistry,
            abi: validationRegistryAbi,
            functionName: 'validationResponse',
            args: [resolved, response, uri, runRecord.evidenceHash, validationTag],
            account: validatorAccount,
            chain: chain.chain,
            gas: gasLimit,
            gasPrice: gasPriceWei,
            nonce: Number(nonce),
          }),
        verify: async () => {
          const status = await reader.validationStatus(resolved)
          if (status === null) return { ok: false, message: 'getValidationStatus could not be read back' }
          if (status.response !== response) {
            return { ok: false, message: `registry reports response ${status.response}, expected ${response}` }
          }
          if (status.responseHash.toLowerCase() !== runRecord.evidenceHash.toLowerCase()) {
            return {
              ok: false,
              message: `registry reports responseHash ${status.responseHash}, expected ${runRecord.evidenceHash}`,
            }
          }
          return {
            ok: true,
            message: `validation ${resolved} reads back as response=${status.response} tag="${status.tag}" at ${status.lastUpdate}`,
          }
        },
      })
    },

    async recordProbeOnHook(runRecord) {
      const hook = config.hookAddresses[chainId]
      const price = await gasPrice()
      const score = clampToUint8(runRecord.score)
      const plan = buildPlan({
        kind: 'hook',
        chainId,
        agentId: runRecord.agentId,
        to: hook ?? '(HallmarkHook not configured for this chain)',
        from: attestorAddress ?? '(no attestor address)',
        functionName: 'recordProbe',
        args: [String(runRecord.agentId), String(score)],
        gasLimit: GAS_LIMITS.recordProbe,
        gasPriceWei: price,
        evidenceHash: runRecord.evidenceHash,
        evidenceUri: evidenceUri(config.evidenceBaseUrl, runRecord.evidenceHash),
        score: runRecord.score,
      })

      if (hook === null) return skip(plan, `no HallmarkHook address configured for chain ${chainId}`)
      if (attestorAddress === null) return skip(plan, NO_ATTESTOR)
      if (runRecord.score < minScore) {
        return skip(plan, `score ${runRecord.score} is below the --min-score floor of ${minScore}`)
      }
      if (requireProtocolLive && !runRecord.protocolLive) {
        return skip(plan, PROTOCOL_LIVE_REFUSAL)
      }
      const priceRefusal = gasPriceRefusal(price)
      if (priceRefusal !== null) return skip(plan, priceRefusal)

      const configuredAttestor = await client
        .readContract({ address: hook as Address, abi: hallmarkHookAbi, functionName: 'attestor' })
        .catch(() => null)
      if (configuredAttestor === null) return skip(plan, `could not read attestor() from the hook at ${hook}`)
      if (String(configuredAttestor).toLowerCase() !== attestorAddress.toLowerCase()) {
        return skip(
          plan,
          `hook attestor is ${String(configuredAttestor)}, this sender is ${attestorAddress}; recordProbe would revert NotAttestor`,
        )
      }

      const budgetRefusal = budget.check(BigInt(plan.costWei))
      if (budgetRefusal !== null) return skip(plan, budgetRefusal)
      // A dry run holds the reservation too, so the plan shows exactly where
      // the ceiling would stop it rather than costing every write in isolation.
      if (dryRun) {
        budget.reserve(BigInt(plan.costWei))
        return { plan, status: 'dry-run' }
      }
      if (attestorAccount === null) return skip(plan, NO_ATTESTOR)

      const gas = await gasLimitFor(GAS_LIMITS.recordProbe, () =>
        client.estimateContractGas({
          address: hook as Address,
          abi: hallmarkHookAbi,
          functionName: 'recordProbe',
          args: [BigInt(runRecord.agentId), score],
          account: attestorAccount,
        }),
      )
      const finalPlan: PublishPlan = {
        ...plan,
        gasLimit: gas.limit.toString(),
        costWei: (gas.limit * price).toString(),
      }
      const refusalAfterEstimate = budget.check(BigInt(finalPlan.costWei))
      if (refusalAfterEstimate !== null) return skip(finalPlan, refusalAfterEstimate)

      const reservedWei = BigInt(finalPlan.costWei)
      budget.reserve(reservedWei)

      return send({
        plan: finalPlan,
        account: attestorAccount,
        reservedWei,
        write: (nonce, gasLimit, gasPriceWei) =>
          walletFor(attestorAccount).writeContract({
            address: hook as Address,
            abi: hallmarkHookAbi,
            functionName: 'recordProbe',
            args: [BigInt(runRecord.agentId), score],
            account: attestorAccount,
            chain: chain.chain,
            gas: gasLimit,
            gasPrice: gasPriceWei,
            nonce: Number(nonce),
          }),
        verify: async () => {
          const [at, stored] = await Promise.all([
            client.readContract({
              address: hook as Address,
              abi: hallmarkHookAbi,
              functionName: 'lastProbeAt',
              args: [BigInt(runRecord.agentId)],
            }),
            client.readContract({
              address: hook as Address,
              abi: hallmarkHookAbi,
              functionName: 'lastProbeScore',
              args: [BigInt(runRecord.agentId)],
            }),
          ])
          if (BigInt(at) === 0n) return { ok: false, message: 'lastProbeAt is still zero after a successful receipt' }
          if (Number(stored) !== score) {
            return { ok: false, message: `lastProbeScore reads back as ${String(stored)}, expected ${score}` }
          }
          return { ok: true, message: `lastProbeAt=${String(at)} lastProbeScore=${String(stored)}` }
        },
      })
    },

    async requestValidation(agentId, hash, uri) {
      const price = await gasPrice()
      const namedValidator = validatorAddress ?? attestorAddress
      const plan = buildPlan({
        kind: 'validation',
        chainId,
        agentId,
        to: chain.contracts.validationRegistry,
        from: ownerAccount?.address ?? '(no agent owner key)',
        functionName: 'validationRequest',
        args: [namedValidator ?? '(no validator address)', String(agentId), uri, hash],
        gasLimit: GAS_LIMITS.validationRequest,
        gasPriceWei: price,
        evidenceHash: hash,
        evidenceUri: uri,
        score: 0,
      })

      if (ownerAccount === null) {
        return skip(
          plan,
          'AGENT_OWNER_PRIVATE_KEY is not set; validationRequest reverts "Not authorized" unless the caller owns or operates the agent',
        )
      }
      if (namedValidator === null) return skip(plan, 'no validator address available to name in the request')

      const agent = await reader.getAgent(agentId).catch(() => null)
      if (agent === null) return skip(plan, `agent ${agentId} is not registered on chain ${chainId}`)
      if (agent.owner.toLowerCase() !== ownerAccount.address.toLowerCase()) {
        return skip(
          plan,
          `agent ${agentId} is owned by ${agent.owner}, not ${ownerAccount.address}; validationRequest would revert "Not authorized"`,
        )
      }

      const priceRefusal = gasPriceRefusal(price)
      if (priceRefusal !== null) return skip(plan, priceRefusal)
      const budgetRefusal = budget.check(BigInt(plan.costWei))
      if (budgetRefusal !== null) return skip(plan, budgetRefusal)
      // A dry run holds the reservation too, so the plan shows exactly where
      // the ceiling would stop it rather than costing every write in isolation.
      if (dryRun) {
        budget.reserve(BigInt(plan.costWei))
        return { plan, status: 'dry-run' }
      }

      const gas = await gasLimitFor(GAS_LIMITS.validationRequest, () =>
        client.estimateContractGas({
          address: chain.contracts.validationRegistry,
          abi: validationRegistryAbi,
          functionName: 'validationRequest',
          args: [namedValidator, BigInt(agentId), uri, hash],
          account: ownerAccount,
        }),
      )
      const finalPlan: PublishPlan = { ...plan, gasLimit: gas.limit.toString(), costWei: (gas.limit * price).toString() }
      const reservedWei = BigInt(finalPlan.costWei)
      budget.reserve(reservedWei)

      return send({
        plan: finalPlan,
        account: ownerAccount,
        reservedWei,
        write: (nonce, gasLimit, gasPriceWei) =>
          walletFor(ownerAccount).writeContract({
            address: chain.contracts.validationRegistry,
            abi: validationRegistryAbi,
            functionName: 'validationRequest',
            args: [namedValidator, BigInt(agentId), uri, hash],
            account: ownerAccount,
            chain: chain.chain,
            gas: gasLimit,
            gasPrice: gasPriceWei,
            nonce: Number(nonce),
          }),
        verify: async () => {
          const status = await reader.validationStatus(hash)
          if (status === null) return { ok: false, message: 'getValidationStatus could not be read back' }
          if (status.validator.toLowerCase() !== namedValidator.toLowerCase()) {
            return { ok: false, message: `request names ${status.validator}, expected ${namedValidator}` }
          }
          return { ok: true, message: `request ${hash} is open for validator ${status.validator}` }
        },
      })
    },
  }
}

/* ------------------------------------------------------------------ */
/* pure helpers, exported so the tests can reach them                   */
/* ------------------------------------------------------------------ */

export type EncodedFeedback = { value: bigint; valueDecimals: number; tag1: FeedbackTag }

/**
 * How a probe run becomes `(int128 value, uint8 valueDecimals)` under one of
 * the standard's liveness tags.
 *
 *   reachable      the 0-100 score, no decimals. What HallmarkHook reads.
 *   uptime         the share of endpoints that answered, as a percent
 *                  scaled by 100 — the standard's own "%×100" convention.
 *   responsetime   the median round trip of the endpoints that answered, in ms.
 */
export function encodeFeedback(record: RunRecord, tag: FeedbackTag): EncodedFeedback {
  switch (tag) {
    case 'uptime': {
      const share = record.scoredCount === 0 ? 0 : record.okCount / record.scoredCount
      return { value: BigInt(Math.round(share * 10_000)), valueDecimals: 2, tag1: 'uptime' }
    }
    case 'responsetime': {
      const sorted = [...record.latencies].sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      const value =
        sorted.length === 0
          ? 0
          : sorted.length % 2 === 1
            ? (sorted[mid] ?? 0)
            : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      return { value: BigInt(Math.round(value)), valueDecimals: 0, tag1: 'responsetime' }
    }
    case 'reachable':
    default:
      return { value: BigInt(clampToUint8(record.score)), valueDecimals: 0, tag1: 'reachable' }
  }
}

export function clampToUint8(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(255, Math.round(value)))
}

/**
 * Pick the `validationRequest` this validator should answer: the oldest one
 * that has never been answered, else the most recently touched.
 */
export async function findPendingRequest(
  reader: RegistryReader,
  agentId: number,
  validator: Address,
): Promise<`0x${string}` | null> {
  const hashes = await reader.agentValidations(agentId).catch(() => null)
  if (hashes === null || hashes.length === 0) return null

  let unanswered: `0x${string}` | null = null
  let newest: { hash: `0x${string}`; at: bigint } | null = null

  for (const hash of hashes) {
    const status = await reader.validationStatus(hash).catch(() => null)
    if (status === null) continue
    if (status.validator.toLowerCase() !== validator.toLowerCase()) continue
    if (Number(status.agentId) !== agentId) continue
    if (status.lastUpdate === 0n && unanswered === null) unanswered = hash
    if (newest === null || status.lastUpdate > newest.at) newest = { hash, at: status.lastUpdate }
  }

  return unanswered ?? newest?.hash ?? null
}

export function buildPlan(input: {
  kind: PublishKind
  chainId: number
  agentId: number
  to: string
  from: string
  functionName: string
  args: string[]
  gasLimit: bigint
  gasPriceWei: bigint
  evidenceHash: `0x${string}`
  evidenceUri: string
  score: number
}): PublishPlan {
  return {
    kind: input.kind,
    chainId: input.chainId,
    agentId: input.agentId,
    to: input.to,
    from: input.from,
    functionName: input.functionName,
    args: input.args,
    gasLimit: input.gasLimit.toString(),
    gasPriceWei: input.gasPriceWei.toString(),
    costWei: (input.gasLimit * input.gasPriceWei).toString(),
    evidenceHash: input.evidenceHash,
    evidenceUri: input.evidenceUri,
    score: input.score,
  }
}

export function formatPlan(plan: PublishPlan): string {
  const cost = BigInt(plan.costWei)
  const lines = [
    `${plan.kind.padEnd(10)} agent ${plan.agentId}  score ${plan.score}`,
    `  ${plan.functionName} -> ${plan.to}`,
    `  from      ${plan.from}`,
    ...plan.args.map((arg, index) => `  arg[${index}]   ${truncate(arg)}`),
    `  gas       ${plan.gasLimit} @ ${plan.gasPriceWei} wei`,
    `  cost      ${cost} wei (${formatEther(cost)} BNB)`,
    `  evidence  ${plan.evidenceUri}`,
  ]
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function publicationOf(
  plan: PublishPlan,
  status: PublicationRecord['status'],
  txHash: string | null,
  gasUsed: string | null,
  reason: string | null,
): PublicationRecord {
  return {
    chainId: plan.chainId,
    agentId: plan.agentId,
    kind: plan.kind,
    evidenceHash: plan.evidenceHash,
    txHash,
    costWei: status === 'sent' ? plan.costWei : '0',
    gasUsed,
    status,
    reason,
    at: new Date().toISOString(),
  }
}

function accountFrom(privateKey: string | null): Account | null {
  if (privateKey === null) return null
  const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error('private key must be 32 bytes of hex')
  }
  return privateKeyToAccount(normalized as `0x${string}`)
}

async function withRetry<T>(
  fn: () => Promise<T>,
  attempts: number,
  onRetry: (attempt: number, err: unknown) => void,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      // A revert is a settled answer; only transport failures are worth retrying.
      if (!isTransient(err) || attempt === attempts) throw err
      onRetry(attempt, err)
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
  throw lastError
}

function isTransient(err: unknown): boolean {
  const message = messageOf(err).toLowerCase()
  if (/reverted|insufficient funds|nonce too low|already known|invalid|not authorized/.test(message)) return false
  return /timeout|econnreset|socket|network|fetch failed|502|503|504|rate limit|too many requests/.test(message)
}

function truncate(value: string): string {
  return value.length <= 96 ? value : `${value.slice(0, 93)}...`
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message.split('\n')[0] ?? err.message
  return String(err)
}
