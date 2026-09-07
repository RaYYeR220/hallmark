import { CHAINS } from '@hallmark/core'
import type { Address } from 'viem'

import type { SupportedChainId } from './deployments'

/**
 * The protocol addresses a session-key policy can name.
 *
 * Read from `@hallmark/core`'s chain table rather than re-listed, so there is
 * exactly one place in the repository where "PancakeSwap's router on BSC" is
 * written down. `unlistedPool` is the odd one out: it is deliberately a real
 * protocol that none of the four policies allowlists, used by the scope tester
 * to demonstrate a refusal against something that genuinely exists rather than
 * against a made-up address.
 */

export type ProtocolAddresses = {
  pancakePositionManager: Address
  pancakeSwapRouter: Address
  venusComptroller: Address
  venusVBnb: Address
  venusVUsdt: Address
  /** USDT on mainnet, $U on testnet. Eighteen decimals on both. */
  stable: Address
  /**
   * A real, deployed contract that no Hallmark policy allowlists, on either
   * chain. The PancakeSwap v3 factory qualifies precisely: the policies name
   * the position manager and the swap router, never the factory. Using a real
   * address here rather than a made-up one keeps the scope demonstration
   * honest — the refusal is about the allowlist, not about the address being
   * nonsense.
   */
  unlistedContract: Address
}

export function getProtocolAddresses(chainId: SupportedChainId): ProtocolAddresses {
  const chain = CHAINS[chainId]
  return {
    pancakePositionManager: chain.defi.pancakeV3PositionManager,
    pancakeSwapRouter: chain.defi.pancakeV3SwapRouter,
    venusComptroller: chain.defi.venusComptroller,
    venusVBnb: chain.defi.venusVBnb,
    venusVUsdt: chain.defi.venusVUsdt,
    stable:
      chainId === 56
        ? '0x55d398326f99059fF775485246999027B3197955'
        : chain.contracts.uToken,
    unlistedContract: chain.defi.pancakeV3Factory,
  }
}
