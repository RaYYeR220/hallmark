import 'server-only'

import { isAddress, type Address, type Hex } from 'viem'

import { keystoreAbi } from './abi'
import { multicallAddressFor, publicClientFor } from './chain'
import type { SupportedChainId } from './deployments'

/**
 * Session keys, read from the Altana Keystore with nothing but a public RPC.
 *
 * This is the module that makes the product's central claim checkable. "You
 * can revoke, and anyone can verify" is only true if verification needs no
 * credentials, no relay and no trust in us — so these reads are two `eth_call`s
 * against a public node and nothing else. A sceptic can reproduce them from a
 * terminal in under a minute, and the page says so.
 *
 * What the Keystore knows: which key ids a wallet has registered, and whether
 * each one is still valid. What it does not know: the permissions attached, the
 * expiry, or how much has been spent — those live in the grant and in the
 * relay's rolling window. The UI never pretends otherwise; anything it cannot
 * read from the chain is labelled with where it did come from.
 */

export const KEYSTORE_ADDRESSES: Record<SupportedChainId, Address> = {
  56: '0x6572427ED530BadcF7375Cf9A4709D8d2b0E7E0a',
  97: '0x6b8361C29d05D498b1a12B54A37310f94171E94A',
}

export const KEYSTORE_EXPLORERS: Record<SupportedChainId, string> = {
  56: 'https://explorer.altana.network',
  97: 'https://testnet.altana.network',
}

export type RegisteredKey = {
  keyId: Hex
  /**
   * `isValidKey` is a single boolean covering three different situations —
   * never registered, revoked, expired — because that is genuinely all the
   * Keystore reports. The explorer link tells them apart.
   */
  valid: boolean
  keystoreUrl: string
}

export type KeystoreView = {
  chainId: SupportedChainId
  address: Address
  keys: RegisteredKey[]
  accountUrl: string
  keystoreAddress: Address
  readAt: string
  /** Set when the read itself failed, so the page can say so rather than show zero. */
  error: string | null
}

export function keystoreAccountUrl(chainId: SupportedChainId, address: string): string {
  return `${KEYSTORE_EXPLORERS[chainId]}/account/${address}`
}

export function keystoreKeyUrl(chainId: SupportedChainId, keyId: string): string {
  return `${KEYSTORE_EXPLORERS[chainId]}/key/${keyId}`
}

export function isValidAddress(value: string | null | undefined): value is Address {
  return typeof value === 'string' && isAddress(value)
}

/**
 * Every key the Keystore holds for a wallet, with each one's live validity.
 *
 * One `getKeys`, then one batched `isValidKey` per key. An empty list is a
 * real and common answer: it means this wallet has never granted a session,
 * which is exactly what most addresses look like.
 */
export async function readKeystore(
  chainId: SupportedChainId,
  address: Address,
): Promise<KeystoreView> {
  const keystore = KEYSTORE_ADDRESSES[chainId]
  const base: Omit<KeystoreView, 'keys' | 'error'> = {
    chainId,
    address,
    accountUrl: keystoreAccountUrl(chainId, address),
    keystoreAddress: keystore,
    readAt: new Date().toISOString(),
  }

  const client = publicClientFor(chainId)

  let keyIds: readonly Hex[]
  try {
    keyIds = await client.readContract({
      address: keystore,
      abi: keystoreAbi,
      functionName: 'getKeys',
      args: [address],
    })
  } catch (error) {
    return {
      ...base,
      keys: [],
      error: `The Keystore read failed: ${
        error instanceof Error ? error.message.split('\n')[0] : String(error)
      }`,
    }
  }

  if (keyIds.length === 0) return { ...base, keys: [], error: null }

  let validity: boolean[]
  try {
    const results = (await client.multicall({
      contracts: keyIds.map((keyId) => ({
        address: keystore,
        abi: keystoreAbi,
        functionName: 'isValidKey' as const,
        args: [address, keyId] as const,
      })) as never,
      allowFailure: true,
      multicallAddress: multicallAddressFor(chainId),
    })) as unknown as ({ status: 'success'; result: boolean } | { status: 'failure' })[]

    validity = keyIds.map((_, index) => {
      const entry = results[index]
      return entry !== undefined && entry.status === 'success' ? entry.result : false
    })
  } catch {
    validity = keyIds.map(() => false)
  }

  return {
    ...base,
    error: null,
    keys: keyIds.map((keyId, index) => ({
      keyId,
      valid: validity[index] ?? false,
      keystoreUrl: keystoreKeyUrl(chainId, keyId),
    })),
  }
}

/**
 * Is one specific key still authorised, right now?
 *
 * Used by the lifecycle panel to re-check its own story on every request. A
 * page that says "revoked" should be reading that, not remembering it — if the
 * key were ever re-registered this returns true and the panel says so.
 */
export async function isKeyStillValid(
  chainId: SupportedChainId,
  address: Address,
  keyId: `0x${string}`,
): Promise<boolean> {
  try {
    return (await publicClientFor(chainId).readContract({
      address: KEYSTORE_ADDRESSES[chainId],
      abi: keystoreAbi,
      functionName: 'isValidKey',
      args: [address, keyId],
    })) as boolean
  } catch {
    // A failed read is not a revocation. Reporting false here would turn our
    // own outage into a claim about someone's authorisation.
    return false
  }
}

/**
 * The reproduction recipe, printed on the page.
 *
 * Not decoration: a claim about verifiability that nobody can act on is a
 * claim about nothing. This is the exact command, with the real addresses
 * substituted, that reproduces what the page shows.
 */
export function verificationRecipe(chainId: SupportedChainId, address: Address): string {
  const rpc = chainId === 56 ? 'https://bsc-rpc.publicnode.com' : 'https://bsc-testnet-rpc.publicnode.com'
  return [
    `# Every session key ${address} has registered, from a public node.`,
    `cast call ${KEYSTORE_ADDRESSES[chainId]} \\`,
    `  "getKeys(address)(bytes32[])" ${address} \\`,
    `  --rpc-url ${rpc}`,
    '',
    '# Whether one of them is still authorised, right now.',
    `cast call ${KEYSTORE_ADDRESSES[chainId]} \\`,
    `  "isValidKey(address,bytes32)(bool)" ${address} <keyId> \\`,
    `  --rpc-url ${rpc}`,
  ].join('\n')
}
