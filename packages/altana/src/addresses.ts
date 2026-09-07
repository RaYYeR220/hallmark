import { ERC8183_ADDRESSES } from '@altananetwork/sdk'
import type { Address } from 'viem'

import { getAltanaNetwork, type AltanaChainId } from './network.js'

/**
 * The protocol contracts Hallmark's agent categories are allowed to touch.
 *
 * This file is the allowlist's source of truth. Nothing else in the package
 * hard-codes a protocol address, so widening what an agent can do is a diff
 * you can read in one screen.
 */

/**
 * Pseudo-address for the chain's native coin (BNB).
 *
 * Altana's `SpendPermission` omits `token` to mean native. Our `SpendCap`
 * always carries a token so the type has no optional hole, and this sentinel
 * is what we translate to "omitted". It is the de-facto EVM convention.
 */
export const NATIVE_TOKEN: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

export function isNativeToken(token: Address): boolean {
  return token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
}

export type ProtocolAddresses = {
  pancake: {
    /** PancakeSwap v3 NonfungiblePositionManager — LP position lifecycle. */
    positionManager: Address
    /** PancakeSwap v3 SwapRouter — swaps, including multicall-wrapped ones. */
    swapRouter: Address
  }
  venus: {
    comptroller: Address
    vBNB: Address
    vUSDT: Address
  }
  aave: {
    /** Aave V3 Pool. Mainnet only — Aave has no BNB testnet market. */
    pool?: Address
  }
  /** ERC-8183 stack ($U escrow rail), straight from the SDK. */
  erc8183: {
    commerce: Address
    router: Address
    policy: Address
    registry: Address
    paymentToken: Address
  }
  /** The 18-decimal stablecoin our default spend caps are denominated in. */
  defaultStable: Address
}

const erc8183 = (chainId: AltanaChainId) => {
  const a = ERC8183_ADDRESSES[chainId]
  if (!a) throw new Error(`ERC8183_ADDRESSES has no entry for chain ${chainId}`)
  return a
}

export const PROTOCOLS: Record<AltanaChainId, ProtocolAddresses> = {
  56: {
    pancake: {
      positionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
      swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    },
    venus: {
      comptroller: '0xfD36E2c2a6789Db23113685031d7F16329158384',
      vBNB: '0xA07c5b74C9B40447a954e1466938b865b6BBea36',
      vUSDT: '0xfD5840Cd36d94D7229439859C0112a4185BC0255',
    },
    aave: {
      pool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
    },
    erc8183: erc8183(56),
    // USDT on BNB Smart Chain. Eighteen decimals, not six.
    defaultStable: '0x55d398326f99059fF775485246999027B3197955',
  },
  97: {
    pancake: {
      positionManager: '0x427bF5b37357632377eCbEC9de3626C71A5396c1',
      swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    },
    venus: {
      comptroller: '0x94d1820b2D1c7c7452A163983Dc888CEC546b77D',
      vBNB: '0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c',
      vUSDT: '0xb7526572FFE56AB9D7489838Bf2E18e3323b441A',
    },
    aave: {},
    erc8183: erc8183(97),
    // $U (United Stables) — the ERC-8183 payment token. Eighteen decimals.
    defaultStable: erc8183(97).paymentToken,
  },
}

export function getProtocols(chainId: number): ProtocolAddresses {
  return PROTOCOLS[getAltanaNetwork(chainId).chainId]
}

export type KnownToken = { symbol: string; decimals: number }

/**
 * Tokens we know by sight, so `validatePolicy` can catch a cap written
 * against the wrong scale and `describePolicy` can name it. Keyed lowercase.
 *
 * Every `decimals` here is 18 — that is the whole point. On BNB Smart Chain
 * the stablecoins are 18-decimal, and a cap copied from an Ethereum codebase
 * (6 decimals) is off by a factor of a trillion.
 */
export const KNOWN_TOKENS: Readonly<Record<string, KnownToken>> = Object.freeze({
  [NATIVE_TOKEN.toLowerCase()]: { symbol: 'BNB', decimals: 18 },
  '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18 },
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18 },
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB', decimals: 18 },
  [PROTOCOLS[56].erc8183.paymentToken.toLowerCase()]: { symbol: '$U', decimals: 18 },
  [PROTOCOLS[97].erc8183.paymentToken.toLowerCase()]: { symbol: '$U', decimals: 18 },
})

export function knownToken(token: Address): KnownToken | undefined {
  return KNOWN_TOKENS[token.toLowerCase()]
}

export function knownDecimals(token: Address): number | undefined {
  return knownToken(token)?.decimals
}

/** "USDT", or a shortened address when we do not recognise the token. */
export function tokenSymbol(token: Address): string {
  return knownToken(token)?.symbol ?? shortAddress(token)
}

/** `0x46A1…4364` — enough for a human to compare against a block explorer. */
export function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
