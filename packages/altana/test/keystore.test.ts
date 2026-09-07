import type { PublicClient } from 'viem'
import { describe, expect, it } from 'vitest'

import { UnsupportedChainError } from '../src/errors.js'
import {
  estimateGrantCostWei,
  isSessionValid,
  KEYSTORE_ABI,
  keystoreExplorerUrl,
  keystoreKeyUrl,
  listRegisteredKeys,
  sessionKeyId,
  verifySession,
} from '../src/keystore.js'
import { ALTANA_NETWORKS } from '../src/network.js'

const WALLET = '0x000000000000000000000000000000000000bEEF' as const
const PUBLIC_KEY = `0x04${'11'.repeat(64)}` as const
const KEY_ID = sessionKeyId(PUBLIC_KEY)

type ReadArgs = { address: string; functionName: string; args?: readonly unknown[] }

/**
 * A viem stand-in that records what was read. The point of these tests is the
 * *call* we make — right contract, right function, right arguments — because
 * the whole verification claim rests on hitting the real Keystore.
 */
function stubClient(answers: Record<string, unknown>) {
  const reads: ReadArgs[] = []
  const client = {
    readContract: async (params: ReadArgs) => {
      reads.push(params)
      return answers[params.functionName]
    },
  } as unknown as PublicClient
  return { client, reads }
}

describe('isSessionValid', () => {
  it('reads isValidKey on the chain’s Keystore with keccak256(publicKey)', async () => {
    const { client, reads } = stubClient({ isValidKey: true })
    await expect(isSessionValid(56, WALLET, PUBLIC_KEY, { publicClient: client })).resolves.toBe(
      true,
    )
    expect(reads).toEqual([
      {
        address: ALTANA_NETWORKS[56].keyStore,
        abi: KEYSTORE_ABI,
        functionName: 'isValidKey',
        args: [WALLET, KEY_ID],
      },
    ])
  })

  it('uses the testnet Keystore for chain 97', async () => {
    const { client, reads } = stubClient({ isValidKey: false })
    await expect(isSessionValid(97, WALLET, PUBLIC_KEY, { publicClient: client })).resolves.toBe(
      false,
    )
    expect(reads[0]?.address).toBe(ALTANA_NETWORKS[97].keyStore)
  })

  it('refuses a chain with no Altana deployment', async () => {
    await expect(isSessionValid(1, WALLET, PUBLIC_KEY)).rejects.toThrow(UnsupportedChainError)
  })
})

describe('listRegisteredKeys', () => {
  it('returns the wallet’s key ids', async () => {
    const { client, reads } = stubClient({ getKeys: [KEY_ID] })
    await expect(listRegisteredKeys(56, WALLET, { publicClient: client })).resolves.toEqual([
      KEY_ID,
    ])
    expect(reads[0]?.functionName).toBe('getKeys')
    expect(reads[0]?.args).toEqual([WALLET])
  })
})

describe('estimateGrantCostWei', () => {
  it('quotes two Keystore fees for a registering grant', async () => {
    const { client, reads } = stubClient({ getRegistrationFeeInWei: 672_226_504_916_037n })
    await expect(estimateGrantCostWei(56, { publicClient: client })).resolves.toBe(
      1_344_453_009_832_074n,
    )
    expect(reads[0]?.address).toBe(ALTANA_NETWORKS[56].keyStoreController)
  })

  it('quotes one for `register: false` — which is cheaper, not free', async () => {
    const { client } = stubClient({ getRegistrationFeeInWei: 671_306_333_258_348n })
    await expect(
      estimateGrantCostWei(97, { publicClient: client, register: false }),
    ).resolves.toBe(671_306_333_258_348n)
  })
})

describe('verifySession', () => {
  it('bundles the answer with the evidence someone else can check', async () => {
    const { client } = stubClient({ isValidKey: true, getKeys: [KEY_ID] })
    const verification = await verifySession(97, WALLET, PUBLIC_KEY, { publicClient: client })
    expect(verification).toMatchObject({
      chainId: 97,
      walletAddress: WALLET,
      keyId: KEY_ID,
      valid: true,
      registeredKeys: [KEY_ID],
      accountUrl: `https://testnet.altana.network/account/${WALLET}`,
      keyUrl: `https://testnet.altana.network/key/${KEY_ID}`,
    })
    expect(verification.summary).toContain(ALTANA_NETWORKS[97].keyStore)
    expect(verification.summary).toContain('no credentials')
  })

  it('says why a key is not valid without pretending to know which reason', async () => {
    const { client } = stubClient({ isValidKey: false, getKeys: [] })
    const verification = await verifySession(56, WALLET, PUBLIC_KEY, { publicClient: client })
    expect(verification.valid).toBe(false)
    expect(verification.summary).toMatch(/never registered, revoked, or expired/)
  })
})

describe('explorer links', () => {
  it('points at the right Keystore explorer per chain', () => {
    expect(keystoreExplorerUrl(56, WALLET)).toBe(
      `https://explorer.altana.network/account/${WALLET}`,
    )
    expect(keystoreExplorerUrl(97, WALLET)).toBe(
      `https://testnet.altana.network/account/${WALLET}`,
    )
    expect(keystoreKeyUrl(56, KEY_ID)).toBe(`https://explorer.altana.network/key/${KEY_ID}`)
  })
})
