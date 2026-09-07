import { BNB, BNB_TESTNET, type NetworkConfig } from '@altananetwork/sdk'
import type { Address, Hex } from 'viem'

import { UnsupportedChainError } from './errors.js'

/** The two chains Hallmark ships on. */
export const ALTANA_CHAIN_IDS = [56, 97] as const
export type AltanaChainId = (typeof ALTANA_CHAIN_IDS)[number]

/**
 * Our view of an Altana deployment. Everything the rest of Hallmark needs is
 * here, so no other module has to import the SDK's config constants directly.
 */
export type AltanaNetwork = {
  chainId: AltanaChainId
  /** Human name for UI copy, e.g. "BNB Smart Chain". */
  name: string
  isTestnet: boolean
  /** Native currency symbol — BNB on both chains. */
  nativeSymbol: string
  /** The Keystore registry. Anyone can read it; see `keystore.ts`. */
  keyStore: Address
  /** The Controller that writes to the Keystore (and charges the fee). */
  keyStoreController: Address
  /** Public RPC used for our own permissionless reads. */
  publicRpcUrl: string
  /** Block explorer root, no trailing slash. */
  explorer: string
  /** Altana relay serving this chain. */
  relayUrl: string
  /** Altana Keystore explorer root, no trailing slash. */
  keystoreExplorer: string
  /** The SDK's own config object, for the calls that take one. */
  config: NetworkConfig
}

/**
 * The addresses we built against, pinned here on purpose.
 *
 * `test/network.test.ts` asserts the installed SDK still ships exactly these.
 * A version bump that moves a Keystore silently would otherwise turn every
 * verification read into a quiet `false`, which is the worst possible way for
 * this package to fail.
 */
export const EXPECTED_ALTANA_DEPLOYMENT = {
  56: {
    keyStore: '0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a',
    keyStoreController: '0x0834Ee2C9BdC3E3efF0a2dC34393D4B0e546A555',
    publicRpcUrl: 'https://bsc-rpc.publicnode.com',
    explorer: 'https://bscscan.com',
    relayUrl: 'https://relay.altana.network',
  },
  97: {
    keyStore: '0x6b8361C29d05D498b1a12B54A37310f94171E94A',
    keyStoreController: '0xb530D1971f5453F3359518343F05D0AedFfF7e12',
    publicRpcUrl: 'https://bsc-testnet-rpc.publicnode.com',
    explorer: 'https://testnet.bscscan.com',
    relayUrl: 'https://testnet-relay.altana.network',
  },
} as const satisfies Record<AltanaChainId, Record<string, string>>

/**
 * Native value the relay attaches to each KeyStoreController call, measured on
 * chain 97 against the live deployment: 0.000672595470447577 BNB.
 *
 * `grantSession` with the default `register: true` submits two such calls on a
 * wallet's first admin action, so a grant needs roughly double this. It is a
 * floor, not a quote — read the live figure with
 * `readRegistrationFeeWei(chainId)` when you need to be exact.
 */
export const OBSERVED_KEYSTORE_FEE_WEI = 672_595_470_447_577n

/** Altana's Keystore explorer — the third-party-verifiable view of a grant. */
export const KEYSTORE_EXPLORER = {
  56: 'https://explorer.altana.network',
  97: 'https://testnet.altana.network',
} as const satisfies Record<AltanaChainId, string>

function build(config: NetworkConfig, chainId: AltanaChainId, name: string): AltanaNetwork {
  const relayUrl = config.relayUrl
  if (!relayUrl) {
    // Both of our chains have a relay; a build without one would mean the SDK
    // reshuffled its networks under us.
    throw new UnsupportedChainError(chainId, [])
  }
  return {
    chainId,
    name,
    isTestnet: chainId === 97,
    nativeSymbol: config.chain.nativeCurrency.symbol,
    keyStore: config.keyStore,
    keyStoreController: config.keyStoreController,
    publicRpcUrl: config.publicRpcUrl,
    explorer: config.explorer.replace(/\/+$/, ''),
    relayUrl,
    keystoreExplorer: KEYSTORE_EXPLORER[chainId],
    config,
  }
}

export const ALTANA_NETWORKS: Record<AltanaChainId, AltanaNetwork> = {
  56: build(BNB, 56, 'BNB Smart Chain'),
  97: build(BNB_TESTNET, 97, 'BNB Smart Chain Testnet'),
}

export function isAltanaChainId(chainId: number): chainId is AltanaChainId {
  return chainId === 56 || chainId === 97
}

/** Resolve a chainId to our network record. Throws on anything else. */
export function getAltanaNetwork(chainId: number): AltanaNetwork {
  if (!isAltanaChainId(chainId)) throw new UnsupportedChainError(chainId, ALTANA_CHAIN_IDS)
  return ALTANA_NETWORKS[chainId]
}

/** The SDK config object for a chainId — for SDK calls that take a network. */
export function getNetworkConfig(chainId: number): NetworkConfig {
  return getAltanaNetwork(chainId).config
}

export function txExplorerUrl(chainId: number, txHash: Hex): string {
  return `${getAltanaNetwork(chainId).explorer}/tx/${txHash}`
}

export function addressExplorerUrl(chainId: number, address: Address): string {
  return `${getAltanaNetwork(chainId).explorer}/address/${address}`
}

export { BNB, BNB_TESTNET }
export type { NetworkConfig }
