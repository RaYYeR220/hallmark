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
  commerce: '0x3b1069ebaa1422038d5596a27c7B4a8ED4404d5C',
  hook: '0xbD79F8d38EBBf2C8cA9a40D27af04a05BD91eFf0',
  attestor: '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab',
  paymentToken: '0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565',
  deployTx: [
    {
      label: 'Deploy AgenticCommerceHooked',
      hash: '0xae07d7119883ab34419931fe1a1b3d8372ff4dba0239db43827c06a061492858',
    },
    {
      label: 'Deploy HallmarkHook',
      hash: '0x97a8cfab9522989c3b06cb2a06d4e28895dca1943dfee950fa5b40afeeba6421',
    },
    {
      label: 'Allow-list the hook on the escrow',
      hash: '0x23cc9d7e39e25af8e410face4a51c478e32afe62e19fe531c052fb6f83954d67',
    },
    {
      label: 'Set the evidence base URI',
      hash: '0x043d94ffba5ca73aadb208ce0b047379de02528c96f83fde20e4ab494c8dbff3',
    },
  ],
  deployBlock: 129_626_606,
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
