/**
 * Publishing an agent to the ERC-8004 Identity Registry.
 *
 * Registration is two-phase and there is no way around it: the registration
 * file has to contain the agent id, and the agent id does not exist until the
 * file has been registered. So:
 *
 *   1. `register(agentURI)` with `registrations: []`
 *   2. recover the new id from the `Transfer` log's `topics[3]`, requiring
 *      `from == address(0)` so a resale can never be mistaken for a mint
 *   3. patch `registrations: [{ agentId, agentRegistry }]` into the file
 *   4. `setAgentURI(agentId, newURI)`
 *
 * Skipping step 4 is the single most common defect in the live registry:
 * agents whose file says `registrations: []` or `"agentId": null` because
 * nobody ran phase two.
 *
 * `register(string)` also writes the `agentWallet` metadata entry pointing at
 * the caller, confirmed by reading `getAgentWallet` straight after, so there
 * is no third call to make.
 */

import { ScanClient, createRegistryReader, findRegisteredAgentId, getChain } from '@hallmark/core'
import type { RegistryReaderOptions } from '@hallmark/core'
import { encodeFunctionData } from 'viem'

import { accountAddress, type AgentWalletClient, type ReceiptWaiter } from './clients.js'
import { estimateRegistrationCost, type EstimateOptions, type RegistrationCostEstimate } from './cost.js'
import { PublishError, UnsupportedChainError } from './errors.js'
import {
  agentUriBytes,
  buildRegistrationFile,
  chainIdOf,
  decodeAgentUri,
  encodeAgentUri,
  withRegistration,
} from './registration.js'
import {
  computeValidationRequestHash,
  requestValidation,
  resolveValidator,
  validationRegistryWriteAbi,
} from './validation.js'
import type { RequestValidationResult } from './validation.js'
import type { Address, AgentConfig, Hex, RegistrationFile } from './types.js'

/**
 * Narrow, single-overload ABI. `@hallmark/core` carries both `register`
 * overloads, which is right for reading but leaves the encoder a choice to
 * make; here there is nothing to choose.
 */
export const identityWriteAbi = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setAgentURI',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'tokenURI', type: 'string' },
    ],
    outputs: [],
  },
] as const

export type ExistingAgentQuery = { owner: Address; name: string; chainId: number }
export type ExistingAgentLookup = (query: ExistingAgentQuery) => Promise<bigint | null>

export type PublishPlanInput = {
  config: AgentConfig
  walletClient: AgentWalletClient
  /** Overrides `config.chain`. Must agree with the wallet's chain when it has one. */
  chainId?: number
  /** Skip the duplicate lookup and update this agent. */
  agentId?: bigint | number
  /**
   * How to avoid minting a second agent for a name the wallet already owns.
   * `'scan'` (default) queries the 8004scan indexer; `'none'` always mints.
   */
  dedupe?: 'scan' | 'none' | ExistingAgentLookup
  /** Passed to `estimateRegistrationCost`. */
  pricing?: EstimateOptions
}

export type PublishPlan = {
  chainId: number
  owner: Address
  action: 'register' | 'update'
  /** Set when `action` is `update`. */
  agentId: bigint | null
  identityRegistry: Address
  /** Phase-one file: the one `register` is called with. */
  file: RegistrationFile
  tokenUri: string
  uriBytes: number
  /**
   * Phase-two file. On the `update` path this is final; on the `register`
   * path the id is not known yet, so it is stamped with `previewAgentId`.
   */
  finalFile: RegistrationFile
  finalTokenUri: string
  previewAgentId: bigint | null
  decodedCard: unknown
  calls: PlannedCall[]
  cost: RegistrationCostEstimate
  validation: PlannedValidation | null
}

export type PlannedCall = {
  phase: 1 | 2 | 3
  label: string
  to: Address
  functionName: string
  data: Hex
  note?: string
}

export type PlannedValidation = {
  validator: Address
  evidenceUrl: string
  nonce: number
  /** Final only when the agent id is already known. */
  requestHash: Hex | null
}

export type PublishAgentInput = PublishPlanInput & {
  /** Required on the mint path: the agent id is recovered from the receipt. */
  publicClient?: ReceiptWaiter
  /**
   * Send the ERC-8004 validation request after publishing. Defaults to true
   * when the config declares `validation`.
   */
  requestValidation?: boolean
} & RegistryReaderOptions

export type PublishAgentResult = {
  chainId: number
  agentId: bigint
  owner: Address
  action: 'registered' | 'updated'
  registerTx: Hex | null
  setUriTx: Hex
  tokenUri: string
  file: RegistrationFile
  validationRequest: RequestValidationResult | null
  explorerUrls: {
    agent: string
    register: string | null
    setAgentURI: string
    validationRequest: string | null
  }
}

const PREVIEW_AGENT_ID = 999_999n

/**
 * Everything `publishAgent` would do, without touching the wallet.
 *
 * This is what `hallmark publish --dry-run` prints, and it is a separate
 * function on purpose: a dry run structurally cannot broadcast, because the
 * code path that signs is not in it.
 */
export async function planPublish(input: PublishPlanInput): Promise<PublishPlan> {
  const chainId = resolveChainId(input)
  const chain = getChain(chainId)
  const owner = accountAddress(input.walletClient)
  const config = input.config

  const file = buildRegistrationFile(config)
  const tokenUri = encodeAgentUri(file)

  const existing =
    input.agentId !== undefined
      ? BigInt(input.agentId)
      : await lookupExisting(input.dedupe ?? 'scan', { owner, name: config.name, chainId: chain.id })

  const action: PublishPlan['action'] = existing === null ? 'register' : 'update'
  const stampedId = existing ?? PREVIEW_AGENT_ID
  const finalFile = withRegistration(file, stampedId, chain.id)
  const finalTokenUri = encodeAgentUri(finalFile)

  const calls: PlannedCall[] = []
  if (action === 'register') {
    calls.push({
      phase: 1,
      label: 'register(agentURI)',
      to: chain.contracts.identityRegistry,
      functionName: 'register',
      data: encodeFunctionData({ abi: identityWriteAbi, functionName: 'register', args: [tokenUri] }),
      note: 'also sets the agentWallet metadata to the caller',
    })
    calls.push({
      phase: 2,
      label: 'setAgentURI(agentId, agentURI)',
      to: chain.contracts.identityRegistry,
      functionName: 'setAgentURI',
      data: encodeFunctionData({
        abi: identityWriteAbi,
        functionName: 'setAgentURI',
        args: [PREVIEW_AGENT_ID, finalTokenUri],
      }),
      note: `calldata shown with the placeholder id ${PREVIEW_AGENT_ID}; the real id comes from the register receipt`,
    })
  } else {
    calls.push({
      phase: 2,
      label: 'setAgentURI(agentId, agentURI)',
      to: chain.contracts.identityRegistry,
      functionName: 'setAgentURI',
      data: encodeFunctionData({
        abi: identityWriteAbi,
        functionName: 'setAgentURI',
        args: [stampedId, finalTokenUri],
      }),
      note: `updating agent ${stampedId} in place; no new token is minted`,
    })
  }

  const validation = planValidation(config, chain.id, existing)
  if (validation !== null) {
    // The hash covers the agent id, so before phase one this is the calldata
    // for the placeholder id: the right shape, not the final bytes.
    const previewHash = computeValidationRequestHash({
      chainId: chain.id,
      agentId: stampedId,
      validator: validation.validator,
      evidenceUrl: validation.evidenceUrl,
      nonce: validation.nonce,
    })
    calls.push({
      phase: 3,
      label: 'validationRequest(validator, agentId, requestUri, requestHash)',
      to: chain.contracts.validationRegistry,
      functionName: 'validationRequest',
      data: encodeFunctionData({
        abi: validationRegistryWriteAbi,
        functionName: 'validationRequest',
        args: [validation.validator, stampedId, validation.evidenceUrl, previewHash],
      }),
      note:
        validation.requestHash === null
          ? `request hash covers the agent id, so this shows the placeholder id ${stampedId}; reverts with "Not authorized" unless the caller owns or operates the agent`
          : `requestHash ${validation.requestHash}; reverts with "Not authorized" unless the caller owns or operates the agent`,
    })
  }

  const cost = estimateRegistrationCost(file, chain.id, {
    ...(input.pricing ?? {}),
    ...(action === 'update' ? { registerOnly: false } : {}),
  })

  return {
    chainId: chain.id,
    owner,
    action,
    agentId: existing,
    identityRegistry: chain.contracts.identityRegistry,
    file,
    tokenUri,
    uriBytes: agentUriBytes(file),
    finalFile,
    finalTokenUri,
    previewAgentId: existing === null ? PREVIEW_AGENT_ID : existing,
    decodedCard: decodeAgentUri(tokenUri),
    calls,
    cost,
    validation,
  }
}

/**
 * The full two-phase publish. Idempotent: if the wallet already owns an agent
 * with this name on this chain, the agent is updated in place instead of a
 * second one being minted.
 */
export async function publishAgent(input: PublishAgentInput): Promise<PublishAgentResult> {
  const plan = await planPublish(input)
  const chain = getChain(plan.chainId)
  const wallet = input.walletClient

  let agentId: bigint
  let registerTx: Hex | null = null

  if (plan.action === 'register') {
    if (input.publicClient === undefined) {
      throw new PublishError(
        'publishAgent needs a publicClient on the mint path: the new agent id is only available from the register receipt',
      )
    }

    registerTx = await wallet.writeContract({
      address: chain.contracts.identityRegistry,
      abi: identityWriteAbi,
      functionName: 'register',
      args: [plan.tokenUri],
      account: wallet.account,
      chain: wallet.chain,
    })

    const receipt = await input.publicClient.waitForTransactionReceipt({ hash: registerTx })
    if (receipt.status !== undefined && receipt.status !== 'success') {
      throw new PublishError(`register reverted (${registerTx})`)
    }

    const recovered = findRegisteredAgentId(receipt.logs, chain.contracts.identityRegistry, plan.owner)
    if (recovered === null) {
      throw new PublishError(
        `register succeeded (${registerTx}) but no mint was found in the receipt: expected a Transfer log from ${chain.contracts.identityRegistry} with from == address(0) and to == ${plan.owner}`,
      )
    }
    agentId = recovered
  } else {
    if (plan.agentId === null) throw new PublishError('internal: update path without an agent id')
    agentId = plan.agentId
  }

  const finalFile = withRegistration(plan.file, agentId, chain.id)
  const finalTokenUri = encodeAgentUri(finalFile)

  const setUriTx = await wallet.writeContract({
    address: chain.contracts.identityRegistry,
    abi: identityWriteAbi,
    functionName: 'setAgentURI',
    args: [agentId, finalTokenUri],
    account: wallet.account,
    chain: wallet.chain,
  })

  if (input.publicClient !== undefined) {
    const receipt = await input.publicClient.waitForTransactionReceipt({ hash: setUriTx })
    if (receipt.status !== undefined && receipt.status !== 'success') {
      throw new PublishError(
        `setAgentURI reverted (${setUriTx}); agent ${agentId} exists but its registration file does not name it`,
      )
    }
  }

  const wantsValidation = input.requestValidation ?? input.config.validation !== undefined
  let validationResult: RequestValidationResult | null = null
  if (wantsValidation && plan.validation !== null) {
    validationResult = await requestValidation({
      agentId,
      validator: plan.validation.validator,
      evidenceUrl: plan.validation.evidenceUrl,
      walletClient: wallet,
      chainId: chain.id,
      nonce: plan.validation.nonce,
      ...(input.publicClient === undefined ? {} : { publicClient: input.publicClient }),
    })
  }

  return {
    chainId: chain.id,
    agentId,
    owner: plan.owner,
    action: plan.action === 'register' ? 'registered' : 'updated',
    registerTx,
    setUriTx,
    tokenUri: finalTokenUri,
    file: finalFile,
    validationRequest: validationResult,
    explorerUrls: {
      agent: `${chain.explorer}/token/${chain.contracts.identityRegistry}?a=${agentId}`,
      register: registerTx === null ? null : `${chain.explorer}/tx/${registerTx}`,
      setAgentURI: `${chain.explorer}/tx/${setUriTx}`,
      validationRequest: validationResult === null ? null : validationResult.explorerUrl,
    },
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function resolveChainId(input: { config: AgentConfig; chainId?: number; walletClient?: AgentWalletClient }): number {
  const wanted = input.chainId ?? chainIdOf(input.config.chain)
  const walletChain = input.walletClient?.chain?.id
  if (walletChain !== undefined && walletChain !== null && walletChain !== wanted) {
    throw new UnsupportedChainError(
      `config targets chain ${wanted} but the wallet client is on chain ${walletChain}; refusing to publish to the wrong network`,
    )
  }
  return wanted
}

function planValidation(config: AgentConfig, chainId: number, agentId: bigint | null): PlannedValidation | null {
  if (config.validation === undefined) return null

  const evidenceUrl = config.validation.evidenceUrl ?? config.services.a2a ?? config.services.web ?? config.services.mcp
  if (evidenceUrl === undefined) return null

  const validator = resolveValidator(config.validation.requestFrom, chainId)
  const nonce = config.validation.nonce ?? 0
  return {
    validator,
    evidenceUrl,
    nonce,
    requestHash:
      agentId === null ? null : computeValidationRequestHash({ chainId, agentId, validator, evidenceUrl, nonce }),
  }
}

async function lookupExisting(
  strategy: 'scan' | 'none' | ExistingAgentLookup,
  query: ExistingAgentQuery,
): Promise<bigint | null> {
  if (strategy === 'none') return null
  if (typeof strategy === 'function') return strategy(query)
  return scanLookup(query)
}

/**
 * Duplicate detection via the 8004scan indexer.
 *
 * The identity registry is not ERC-721 Enumerable, so "which agents does this
 * wallet own" cannot be answered from the chain without walking every id.
 * If the indexer cannot be reached we refuse to guess: minting a duplicate
 * agent is not recoverable, so the caller is told to pass `--agent-id` or
 * `--no-dedupe` and decide for themselves.
 */
export async function scanLookup(query: ExistingAgentQuery): Promise<bigint | null> {
  const client = new ScanClient()
  let page
  try {
    page = await client.agentsByWallet(query.owner, { limit: 100 })
  } catch (err) {
    throw new PublishError(
      `could not check whether ${query.owner} already owns an agent called "${query.name}" (${err instanceof Error ? err.message : String(err)}). ` +
        'Re-run with an explicit agent id to update a known agent, or disable the duplicate check to mint a new one.',
    )
  }

  const wanted = query.name.trim().toLowerCase()
  const match = page.items.find(
    (agent) => agent.chain_id === query.chainId && (agent.name ?? '').trim().toLowerCase() === wanted,
  )
  if (match === undefined) return null

  const tokenId = Number(match.token_id)
  if (!Number.isFinite(tokenId)) return null
  return BigInt(match.token_id)
}

/** Owner of an agent, or null if the id has never been minted. Used by `hallmark status`. */
export async function agentOwner(
  agentId: bigint | number,
  chainId: number,
  options: RegistryReaderOptions = {},
): Promise<Address | null> {
  const reader = createRegistryReader(chainId, options)
  const agent = await reader.getAgent(agentId)
  return agent === null ? null : agent.owner
}
