import {
  createPublicClient,
  http,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import { getAltanaNetwork } from './network.js'

/**
 * Permissionless verification of an Altana session key.
 *
 * Deliberately built on nothing but viem and a public RPC: no Altana client, no
 * relay, no API key, no funds. Anyone auditing Hallmark's claim that "the user
 * can revoke and anyone can check" should be able to reproduce these reads from
 * a fresh terminal against a public node — that is the point of the module.
 */

export const KEYSTORE_ABI = [
  {
    name: 'isValidKey',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'keyId', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'getKeys',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'bytes32[]' }],
  },
  {
    name: 'getPublicKey',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'keyId', type: 'bytes32' },
    ],
    outputs: [{ type: 'bytes' }],
  },
] as const

export const KEYSTORE_CONTROLLER_ABI = [
  {
    name: 'getRegistrationFeeInWei',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
] as const

/**
 * The Keystore's key identifier: `keccak256(publicKey)` over the SEC1
 * uncompressed bytes (`0x04 || x || y`) exactly as the signer reports them.
 */
export function sessionKeyId(publicKey: Hex): Hex {
  return keccak256(publicKey)
}

export type ReadOptions = {
  /** Override the public RPC (rate limits, private nodes, tests). */
  rpcUrl?: string | undefined
  /** Bring your own viem client instead. */
  publicClient?: PublicClient | undefined
}

function readerFor(chainId: number, opts: ReadOptions = {}): PublicClient {
  if (opts.publicClient) return opts.publicClient
  const network = getAltanaNetwork(chainId)
  return createPublicClient({
    chain: network.config.chain,
    transport: http(opts.rpcUrl ?? network.publicRpcUrl),
  }) as PublicClient
}

/**
 * Is this session key still authorised for this wallet, right now?
 *
 * One `eth_call`. False covers all three ways a key stops counting — never
 * registered, revoked, expired — because that is what the Keystore reports;
 * use the Keystore explorer's key page to tell revoked from expired.
 */
export async function isSessionValid(
  chainId: number,
  walletAddress: Address,
  sessionPublicKey: Hex,
  opts: ReadOptions = {},
): Promise<boolean> {
  return isKeyIdValid(chainId, walletAddress, sessionKeyId(sessionPublicKey), opts)
}

export async function isKeyIdValid(
  chainId: number,
  walletAddress: Address,
  keyId: Hex,
  opts: ReadOptions = {},
): Promise<boolean> {
  const network = getAltanaNetwork(chainId)
  return (await readerFor(chainId, opts).readContract({
    address: network.keyStore,
    abi: KEYSTORE_ABI,
    functionName: 'isValidKey',
    args: [walletAddress, keyId],
  })) as boolean
}

/** Every key id the Keystore holds for a wallet. Empty = nothing registered. */
export async function listRegisteredKeys(
  chainId: number,
  walletAddress: Address,
  opts: ReadOptions = {},
): Promise<readonly Hex[]> {
  const network = getAltanaNetwork(chainId)
  return (await readerFor(chainId, opts).readContract({
    address: network.keyStore,
    abi: KEYSTORE_ABI,
    functionName: 'getKeys',
    args: [walletAddress],
  })) as readonly Hex[]
}

/** The stored public-key bytes for a key id, or `0x` when there are none. */
export async function readRegisteredPublicKey(
  chainId: number,
  walletAddress: Address,
  keyId: Hex,
  opts: ReadOptions = {},
): Promise<Hex> {
  const network = getAltanaNetwork(chainId)
  return (await readerFor(chainId, opts).readContract({
    address: network.keyStore,
    abi: KEYSTORE_ABI,
    functionName: 'getPublicKey',
    args: [walletAddress, keyId],
  })) as Hex
}

/**
 * The live Keystore registration fee, in wei.
 *
 * `grantSession` attaches this to each Controller call it makes, so a wallet
 * needs roughly `fee x 2` on a first grant (admin key + session key) plus gas.
 * Reading it beats hard-coding a number that moves.
 */
export async function readRegistrationFeeWei(
  chainId: number,
  opts: ReadOptions = {},
): Promise<bigint> {
  const network = getAltanaNetwork(chainId)
  return (await readerFor(chainId, opts).readContract({
    address: network.keyStoreController,
    abi: KEYSTORE_CONTROLLER_ABI,
    functionName: 'getRegistrationFeeInWei',
  })) as bigint
}

/**
 * What a grant will cost in native coin, read live.
 *
 * The relay attaches the Keystore fee to every Controller call in the intent.
 * A first grant makes two — `initialRegisterKey` for the admin, `registerKey`
 * for the session — so the wallet needs about twice the fee, plus ordinary gas.
 * `register: false` still pays once for the admin registration; it does not
 * make the grant free.
 *
 * The fee is not a constant: measured within a minute of each other it read
 * 672226504916037 wei on chain 56 and 671306333258348 on chain 97, so quote it
 * rather than hard-coding it.
 */
export async function estimateGrantCostWei(
  chainId: number,
  opts: ReadOptions & { register?: boolean | undefined } = {},
): Promise<bigint> {
  const fee = await readRegistrationFeeWei(chainId, opts)
  return opts.register === false ? fee : fee * 2n
}

/** Altana Keystore explorer page for a wallet — shareable as evidence. */
export function keystoreExplorerUrl(chainId: number, address: Address): string {
  return `${getAltanaNetwork(chainId).keystoreExplorer}/account/${address}`
}

/** Altana Keystore explorer page for one key: active, revoked, or expired. */
export function keystoreKeyUrl(chainId: number, keyId: Hex): string {
  return `${getAltanaNetwork(chainId).keystoreExplorer}/key/${keyId}`
}

export type SessionVerification = {
  chainId: number
  walletAddress: Address
  keyId: Hex
  valid: boolean
  /** All keys the wallet has registered, for context. */
  registeredKeys: readonly Hex[]
  accountUrl: string
  keyUrl: string
  /** A sentence a judge can read without opening anything. */
  summary: string
}

/**
 * The whole verification story in one call: the boolean, the sibling keys and
 * the two URLs that let someone else reach the same conclusion.
 */
export async function verifySession(
  chainId: number,
  walletAddress: Address,
  sessionPublicKey: Hex,
  opts: ReadOptions = {},
): Promise<SessionVerification> {
  const keyId = sessionKeyId(sessionPublicKey)
  const [valid, registeredKeys] = await Promise.all([
    isKeyIdValid(chainId, walletAddress, keyId, opts),
    listRegisteredKeys(chainId, walletAddress, opts),
  ])
  const network = getAltanaNetwork(chainId)
  return {
    chainId,
    walletAddress,
    keyId,
    valid,
    registeredKeys,
    accountUrl: keystoreExplorerUrl(chainId, walletAddress),
    keyUrl: keystoreKeyUrl(chainId, keyId),
    summary: valid
      ? `Key ${keyId} is authorised for ${walletAddress} in the ${network.name} Keystore ` +
        `(${network.keyStore}). Verified with one eth_call, no credentials.`
      : `Key ${keyId} is NOT authorised for ${walletAddress} in the ${network.name} Keystore ` +
        `(${network.keyStore}) — never registered, revoked, or expired.`,
  }
}
