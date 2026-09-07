/**
 * What it costs to put an agent on chain.
 *
 * The model is anchored on a measured registration, not on a guess: a ~1 KB
 * base64 data-URI card cost **891,730 gas** on the deployed BNB Chain identity
 * registry. Everything below is that datapoint plus the parts of the EVM cost
 * that are fixed by the spec, so the shape of the curve is derived rather than
 * fitted:
 *
 *   storing one byte of tokenURI = 20000 gas per 32-byte word (a cold SSTORE
 *   into a zero slot) + 16 gas of calldata = 625 + 16 = **641 gas/byte**
 *
 * At the measured 1024-byte card that variable part is 656,384 gas, leaving
 * **235,346 gas** of fixed cost — the 21,000 intrinsic, the ERC-721 mint, the
 * `agentWallet` metadata write `register(string)` performs on its own, and the
 * four logs the receipt carries. Feeding 1024 bytes back in reproduces
 * 891,730 exactly; that is asserted in the test suite.
 *
 * Phase two (`setAgentURI`) overwrites slots that are already non-zero, which
 * is 2900 gas per word instead of 20000, so bytes that fit inside the original
 * card are charged at 2900/32 + 16 = **107 gas/byte** and only the growth is
 * charged at the cold rate.
 */

import { chainlinkAggregatorAbi, getChain } from '@hallmark/core'
import { formatUnits } from 'viem'

import type { Address } from './types.js'
import { agentUriBytes, withRegistration } from './registration.js'
import type { RegistrationFile } from './types.js'

/** The live measurement this model is anchored on. */
export const MEASURED_REGISTRATION = {
  uriBytes: 1024,
  gas: 891_730n,
  note: 'measured on BNB Chain against the deployed ERC-8004 identity registry',
} as const

/** Cold SSTORE word (20000/32) plus non-zero calldata (16). */
export const COLD_GAS_PER_URI_BYTE = 641n
/** Dirty SSTORE word (2900/32, rounded up) plus non-zero calldata (16). */
export const WARM_GAS_PER_URI_BYTE = 107n

export const REGISTER_FIXED_GAS =
  MEASURED_REGISTRATION.gas - BigInt(MEASURED_REGISTRATION.uriBytes) * COLD_GAS_PER_URI_BYTE

/** Intrinsic gas, the `URIUpdated` log, the length slot and the owner check. */
export const SET_URI_FIXED_GAS = 29_000n

/**
 * Fallbacks used when nothing live is supplied. The mainnet pair reproduces
 * the ~$0.024 figure the gas measurement was taken alongside.
 */
export const DEFAULT_GAS_PRICE_WEI: Record<number, bigint> = {
  56: 50_000_000n, // 0.05 gwei
  97: 100_000_000n, // 0.1 gwei
}
export const DEFAULT_NATIVE_USD: Record<number, number> = { 56: 540, 97: 540 }

/**
 * A plausible agent id used to size the phase-two card before one has been
 * assigned. Six digits is the widest id BNB Chain is anywhere near.
 */
const SIZING_AGENT_ID = 999_999

export type GasParams = {
  gasPriceWei: bigint
  nativeUsd: number
  source: 'default' | 'live' | 'override'
}

export type CostLine = {
  gas: bigint
  wei: bigint
  /** Native amount as a decimal string, 18 decimals. */
  bnb: string
  usd: number
}

export type RegistrationCostEstimate = {
  chainId: number
  /** tokenURI length of the file as given (phase one). */
  uriBytes: number
  /** tokenURI length once the assigned agent id has been stamped in (phase two). */
  finalUriBytes: number
  register: CostLine
  setAgentURI: CostLine
  total: CostLine
  gasPriceWei: bigint
  gasPriceGwei: string
  nativeUsd: number
  priceSource: GasParams['source']
  notes: string[]
}

export type EstimateOptions = {
  gasPriceWei?: bigint
  nativeUsd?: number
  /** Skip the phase-two `setAgentURI` line, e.g. when only re-publishing. */
  registerOnly?: boolean
}

export function registerGas(uriBytes: number): bigint {
  return REGISTER_FIXED_GAS + BigInt(uriBytes) * COLD_GAS_PER_URI_BYTE
}

export function setUriGas(previousBytes: number, nextBytes: number): bigint {
  const overlap = BigInt(Math.min(previousBytes, nextBytes))
  const growth = BigInt(Math.max(0, nextBytes - previousBytes))
  return SET_URI_FIXED_GAS + overlap * WARM_GAS_PER_URI_BYTE + growth * COLD_GAS_PER_URI_BYTE
}

/**
 * Cost of publishing `file` on `chainId`, both phases.
 *
 * Pure and synchronous: pass `gasPriceWei` / `nativeUsd` to price it against
 * live numbers, or call `fetchGasParams` first and hand the result in.
 */
export function estimateRegistrationCost(
  file: RegistrationFile,
  chainId: number,
  opts: EstimateOptions = {},
): RegistrationCostEstimate {
  const chain = getChain(chainId)
  const uriBytes = agentUriBytes(file)
  const finalUriBytes = agentUriBytes(withRegistration(file, SIZING_AGENT_ID, chain.id))

  const gasPriceWei = opts.gasPriceWei ?? DEFAULT_GAS_PRICE_WEI[chain.id] ?? 50_000_000n
  const nativeUsd = opts.nativeUsd ?? DEFAULT_NATIVE_USD[chain.id] ?? 0
  const source: GasParams['source'] =
    opts.gasPriceWei === undefined && opts.nativeUsd === undefined ? 'default' : 'override'

  const register = line(registerGas(uriBytes), gasPriceWei, nativeUsd)
  const setAgentUri =
    opts.registerOnly === true
      ? line(0n, gasPriceWei, nativeUsd)
      : line(setUriGas(uriBytes, finalUriBytes), gasPriceWei, nativeUsd)
  const total = line(register.gas + setAgentUri.gas, gasPriceWei, nativeUsd)

  const notes: string[] = []
  if (source === 'default') {
    notes.push(`gas price and BNB/USD are defaults (${formatGwei(gasPriceWei)} gwei, $${nativeUsd}); pass live values for a real quote`)
  }
  if (chain.testnet) {
    notes.push('testnet BNB has no market value; the USD column is notional')
  }
  if (uriBytes > 8 * 1024) {
    notes.push(`the card is ${uriBytes} bytes; every extra 32 bytes is roughly another 20k gas`)
  }

  return {
    chainId: chain.id,
    uriBytes,
    finalUriBytes,
    register,
    setAgentURI: setAgentUri,
    total,
    gasPriceWei,
    gasPriceGwei: formatGwei(gasPriceWei),
    nativeUsd,
    priceSource: source,
    notes,
  }
}

/**
 * The two reads the live quote needs. Structural rather than viem's
 * `PublicClient` so a test can supply two functions, and so the type does not
 * move when viem does.
 */
export type GasPriceReader = {
  getGasPrice(): Promise<bigint>
  readContract(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[] | undefined
  }): Promise<unknown>
}

/**
 * Live gas price from the RPC and BNB/USD from the chain's Chainlink feed.
 * Either read can fail without failing the call — whatever could not be read
 * falls back to the documented default.
 */
export async function fetchGasParams(chainId: number, client: GasPriceReader): Promise<GasParams> {
  const chain = getChain(chainId)
  let gasPriceWei = DEFAULT_GAS_PRICE_WEI[chain.id] ?? 50_000_000n
  let nativeUsd = DEFAULT_NATIVE_USD[chain.id] ?? 0
  let source: GasParams['source'] = 'default'

  try {
    gasPriceWei = await client.getGasPrice()
    source = 'live'
  } catch {
    // keep the default
  }

  try {
    const [roundRaw, decimalsRaw] = await Promise.all([
      client.readContract({
        address: chain.chainlink.bnbUsd,
        abi: chainlinkAggregatorAbi,
        functionName: 'latestRoundData',
      }),
      client.readContract({
        address: chain.chainlink.bnbUsd,
        abi: chainlinkAggregatorAbi,
        functionName: 'decimals',
      }),
    ])
    const round = roundRaw as readonly [bigint, bigint, bigint, bigint, bigint]
    const decimals = Number(decimalsRaw)
    const answer = round[1]
    if (answer > 0n) {
      nativeUsd = Number(formatUnits(answer, decimals))
      source = 'live'
    }
  } catch {
    // keep the default
  }

  return { gasPriceWei, nativeUsd, source }
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function line(gas: bigint, gasPriceWei: bigint, nativeUsd: number): CostLine {
  const wei = gas * gasPriceWei
  const bnb = formatUnits(wei, 18)
  return { gas, wei, bnb, usd: Number(bnb) * nativeUsd }
}

function formatGwei(wei: bigint): string {
  return trimZeros(formatUnits(wei, 9))
}

function trimZeros(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}
