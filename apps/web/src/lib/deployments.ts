import { CHAINS, getChain, type SupportedChainId } from '@hallmark/core'

/**
 * Where Hallmark's own contracts live, and where they do not.
 *
 * The honest position, stated once here and rendered wherever it matters:
 * the ERC-8004 registries are live on both chains and Hallmark reads them on
 * both. Hallmark's escrow and evidence hook are deployed on testnet only. The
 * app never implies otherwise — an agent on chain 56 shows registry evidence
 * and index evidence, and says plainly that Hallmark has not probed it.
 */

export type HallmarkDeployment = {
  chainId: SupportedChainId
  /** AgenticCommerceHooked — the ERC-8183 escrow jobs settle through. */
  commerce: `0x${string}`
  /** HallmarkHook — the evidence gate and the settlement receipt. */
  hook: `0x${string}`
  /** The only address allowed to call `recordProbe`. */
  attestor: `0x${string}`
  /** $U, the escrow's immutable payment token. 18 decimals. */
  paymentToken: `0x${string}`
  /**
   * The two transactions that are the whole argument, on the same contract
   * with the same call: one agent had evidence, one did not.
   */
  proofPair: {
    refused: { hash: `0x${string}`; agentId: number; error: string }
    settled: { fund: `0x${string}`; complete: `0x${string}`; agentId: number }
  }
  /** Deployment transactions, so every address on /proof is clickable. */
  deployTx: { label: string; hash: `0x${string}` }[]
  deployBlock: number
  /**
   * Agents Hallmark registered itself and probes on every sweep.
   *
   * Configuration, not a fixture: nothing on any page is faked for these,
   * they are read from the same registries and gated by the same hook as
   * anyone else's. They exist here so /proof has a starting point for
   * enumerating our own attestations — the registries offer no way to ask
   * "which agents has this attestor written about?".
   */
  ownAgentIds: number[]
}

const TESTNET_DEPLOYMENT: HallmarkDeployment = {
  chainId: 97,
  commerce: '0x6a2E5EF3255CBbA23D66EF74a731be4605204638',
  hook: '0xcD71a680cAFb5aC1d269B5B6A90Fa0198ad78897',
  attestor: '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab',
  paymentToken: '0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565',
  proofPair: {
    refused: {
      hash: '0x8c8c0ce24880bb4dfc0491fab9ab54e141252589755dd04db5eecfb1003a6270',
      agentId: 2000,
      error: 'NoFreshEvidence(2000, 0)',
    },
    settled: {
      fund: '0xc55ccf99b175d6ecac21f5a601f6305542139260ed222453080a34a90fa35fe9',
      complete: '0xf03c3873d268197d6f405c87e2d6bbfd62d1faec1130583a7391013a643989e1',
      agentId: 2210,
    },
  },
  deployTx: [
    {
      label: 'Deploy AgenticCommerceHooked',
      hash: '0x0fb9211f39cc2ee5b52c1d443c8f40d3fb86ed5794788542dd988f8f8adea229',
    },
    {
      label: 'Deploy HallmarkHook',
      hash: '0x3b9c87e01fe0265c5c4afe9d207f59b99abb62d4fdd86a284141f5cbeab86d8c',
    },
    {
      label: 'Allow-list the hook on the escrow',
      hash: '0x9b7abcf4f812fec3418e8cb74500e66532e690578c22398ca967dd4d5384e411',
    },
    {
      label: 'Set the evidence base URI',
      hash: '0xb5e338062125acf51af17e310aeba9335723467e5e5a8f1f90f5c0a06b2b5970',
    },
  ],
  deployBlock: 129_659_353,
  ownAgentIds: [2210],
}

const DEPLOYMENTS: Partial<Record<SupportedChainId, HallmarkDeployment>> = {
  97: TESTNET_DEPLOYMENT,
}

/** The Hallmark stack for a chain, or null where it is not deployed. */
export function getDeployment(chainId: number): HallmarkDeployment | null {
  if (chainId !== 56 && chainId !== 97) return null
  return DEPLOYMENTS[chainId] ?? null
}

export function hasHallmarkEscrow(chainId: number): boolean {
  return getDeployment(chainId) !== null
}

/** The chain the sponsored demo and every write flow default to. */
export const DEMO_CHAIN_ID = 97 satisfies SupportedChainId

/** Chains the app will read. Ordered as the UI lists them. */
export const CHAIN_IDS: SupportedChainId[] = [56, 97]

export function chainLabel(chainId: number): string {
  if (chainId === 56) return 'BNB Smart Chain'
  if (chainId === 97) return 'BNB Testnet'
  return `Chain ${chainId}`
}

export function chainShortLabel(chainId: number): string {
  if (chainId === 56) return 'Mainnet'
  if (chainId === 97) return 'Testnet'
  return String(chainId)
}

export function explorerTxUrl(chainId: number, hash: string): string {
  return `${getChain(chainId).explorer}/tx/${hash}`
}

export function explorerAddressUrl(chainId: number, address: string): string {
  return `${getChain(chainId).explorer}/address/${address}`
}

export function explorerTokenUrl(chainId: number, address: string): string {
  return `${getChain(chainId).explorer}/token/${address}`
}

/** 8004scan's own page for an agent, so a reader can compare our numbers. */
export function scanAgentUrl(chainId: number, agentId: number | string): string {
  return `https://8004scan.io/agents/${chainId}/${agentId}`
}

/** The registry addresses, re-exported so pages do not import core directly. */
export function registries(chainId: SupportedChainId) {
  return CHAINS[chainId].contracts
}

export { CHAINS, getChain }
export type { SupportedChainId }
