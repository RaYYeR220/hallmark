/**
 * Opting into ERC-8004 validation.
 *
 * `validationRequest` on the deployed Validation Registry reverts with
 * `Not authorized` unless the caller owns or operates the agent, so a
 * validation is something an agent's owner *asks for* — it can never be
 * pushed onto them. That is the whole point of exposing it here: a third-party
 * developer publishes their agent and then, in one call, invites Hallmark to
 * check it.
 *
 * The request hash is a pure function of the request. Anyone holding the
 * request parameters can recompute it and confirm that the hash on chain is
 * the one that should be there — see `validationRequestPreimage`.
 */

import { createRegistryReader, getChain, txUrl } from '@hallmark/core'
import type { RegistryReaderOptions } from '@hallmark/core'
import { keccak256, toBytes } from 'viem'

import { accountAddress, type AgentWalletClient, type ReceiptWaiter } from './clients.js'
import { UnsupportedChainError } from './errors.js'
import type { Address, Hex } from './types.js'

/**
 * Hallmark's validator key. The same EOA signs validation responses on both
 * networks; only the testnet deployment has been exercised end to end so far.
 */
export const HALLMARK_VALIDATOR: Record<56 | 97, Address> = {
  56: '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab',
  97: '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab',
}

/** Domain separator for the request preimage. Bump it if the layout below ever changes. */
export const REQUEST_HASH_DOMAIN = 'hallmark-validation-request/1'

export type ValidatorRef = 'hallmark' | Address

export function resolveValidator(validator: ValidatorRef, chainId: number): Address {
  if (validator !== 'hallmark') return validator
  const known = HALLMARK_VALIDATOR[chainId as 56 | 97]
  if (known === undefined) {
    throw new UnsupportedChainError(`no Hallmark validator is deployed on chain ${chainId}`)
  }
  return known
}

export type RequestHashInput = {
  chainId: number
  agentId: bigint | number
  validator: ValidatorRef
  /** The `requestUri` written on chain: where the validator should look for evidence. */
  evidenceUrl: string
  /** Distinguishes repeat requests for the same agent. Defaults to 0. */
  nonce?: number
}

/**
 * The exact bytes that get hashed. Newline-separated `key:value` lines, in the
 * order below, addresses lowercased, no trailing newline:
 *
 * ```
 * hallmark-validation-request/1
 * chainId:97
 * registry:0x8004cb1bf31daf7788923b405b754f57aceb4272
 * validator:0x9ff98b99b6b250b3a23961ea932f4ef147b909ab
 * agentId:2210
 * evidence:https://example.com/evidence.json
 * nonce:0
 * ```
 *
 * Reproducible from nothing but the request parameters, which is what lets a
 * third party check that a given `requestHash` on chain really refers to the
 * evidence it claims to.
 */
export function validationRequestPreimage(input: RequestHashInput): string {
  const chain = getChain(input.chainId)
  return [
    REQUEST_HASH_DOMAIN,
    `chainId:${chain.id}`,
    `registry:${chain.contracts.validationRegistry.toLowerCase()}`,
    `validator:${resolveValidator(input.validator, chain.id).toLowerCase()}`,
    `agentId:${BigInt(input.agentId).toString()}`,
    `evidence:${input.evidenceUrl}`,
    `nonce:${input.nonce ?? 0}`,
  ].join('\n')
}

/** keccak256 over the UTF-8 bytes of `validationRequestPreimage`. */
export function computeValidationRequestHash(input: RequestHashInput): Hex {
  return keccak256(toBytes(validationRequestPreimage(input)))
}

export type RequestValidationInput = {
  agentId: bigint | number
  validator?: ValidatorRef
  evidenceUrl: string
  walletClient: AgentWalletClient
  /** Defaults to the wallet client's chain. */
  chainId?: number
  nonce?: number
  /** Pass a public client to block until the transaction is mined. */
  publicClient?: ReceiptWaiter
}

export type RequestValidationResult = {
  chainId: number
  agentId: bigint
  validator: Address
  requestHash: Hex
  preimage: string
  evidenceUrl: string
  nonce: number
  txHash: Hex
  explorerUrl: string
  receiptStatus: string | null
}

/** Exported so the publish planner can encode the same call for a dry run. */
export const validationRegistryWriteAbi = [
  {
    type: 'function',
    name: 'validationRequest',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'validatorAddress', type: 'address' },
      { name: 'agentId', type: 'uint256' },
      { name: 'requestUri', type: 'string' },
      { name: 'requestHash', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const

/**
 * Ask a validator to look at an agent.
 *
 * Reverts with `Not authorized` if `walletClient` is neither the agent's owner
 * nor a registered operator — that is the registry's rule, not ours.
 */
export async function requestValidation(input: RequestValidationInput): Promise<RequestValidationResult> {
  const chainId = input.chainId ?? input.walletClient.chain?.id
  if (chainId === undefined || chainId === null) {
    throw new UnsupportedChainError('no chain id: pass `chainId` or use a wallet client bound to a chain')
  }
  const chain = getChain(chainId)
  const validator = resolveValidator(input.validator ?? 'hallmark', chain.id)
  const agentId = BigInt(input.agentId)
  const nonce = input.nonce ?? 0

  const hashInput: RequestHashInput = {
    chainId: chain.id,
    agentId,
    validator,
    evidenceUrl: input.evidenceUrl,
    nonce,
  }
  const requestHash = computeValidationRequestHash(hashInput)

  // Touching the wallet is the last thing that happens, so a bad argument
  // fails before anything is signed.
  accountAddress(input.walletClient)

  const txHash = await input.walletClient.writeContract({
    address: chain.contracts.validationRegistry,
    abi: validationRegistryWriteAbi,
    functionName: 'validationRequest',
    args: [validator, agentId, input.evidenceUrl, requestHash],
    account: input.walletClient.account,
    chain: input.walletClient.chain,
  })

  let receiptStatus: string | null = null
  if (input.publicClient !== undefined) {
    const receipt = await input.publicClient.waitForTransactionReceipt({ hash: txHash })
    receiptStatus = receipt.status ?? null
  }

  return {
    chainId: chain.id,
    agentId,
    validator,
    requestHash,
    preimage: validationRequestPreimage(hashInput),
    evidenceUrl: input.evidenceUrl,
    nonce,
    txHash,
    explorerUrl: txUrl(chain.id, txHash),
    receiptStatus,
  }
}

/* ------------------------------------------------------------------ */
/* reading validations back                                            */
/* ------------------------------------------------------------------ */

export type ValidationRecord = {
  requestHash: Hex
  validator: Address
  /** 0-100 as written by the validator. Meaningless while `state` is `pending`. */
  response: number
  responseHash: Hex
  tag: string
  lastUpdate: number
  state: 'responded' | 'pending'
}

export type ValidationStatusReport = {
  chainId: number
  agentId: bigint
  validationRegistry: Address
  requestCount: number
  respondedCount: number
  /** Registry-computed average over responded validations, or null if there are none. */
  averageResponse: number | null
  validations: ValidationRecord[]
}

export type GetValidationStatusInput = {
  agentId: bigint | number
  chainId: number
} & RegistryReaderOptions

/** Everything the Validation Registry knows about one agent. Read-only. */
export async function getValidationStatus(input: GetValidationStatusInput): Promise<ValidationStatusReport> {
  const { agentId, chainId, ...readerOptions } = input
  const chain = getChain(chainId)
  const reader = createRegistryReader(chain.id, readerOptions)
  const id = BigInt(agentId)

  const hashes = (await reader.agentValidations(id)) ?? []
  const records: ValidationRecord[] = []

  for (const requestHash of hashes) {
    const status = await reader.validationStatus(requestHash)
    if (status === null) continue
    const responded = status.tag !== '' || status.response > 0 || !isZeroHash(status.responseHash)
    records.push({
      requestHash,
      validator: status.validator,
      response: status.response,
      responseHash: status.responseHash,
      tag: status.tag,
      lastUpdate: Number(status.lastUpdate),
      state: responded ? 'responded' : 'pending',
    })
  }

  const summary = await reader.validationSummary(id)
  const responded = records.filter((record) => record.state === 'responded')

  return {
    chainId: chain.id,
    agentId: id,
    validationRegistry: chain.contracts.validationRegistry,
    requestCount: hashes.length,
    respondedCount: responded.length,
    averageResponse: summary === null || summary.count === 0 ? null : summary.averageResponse,
    validations: records,
  }
}

function isZeroHash(hash: string): boolean {
  return /^0x0{64}$/i.test(hash)
}
