import { decodeFunctionData } from 'viem'
import { describe, expect, it } from 'vitest'

import { PublishError } from '../src/errors.js'
import { identityWriteAbi, planPublish, publishAgent } from '../src/publish.js'
import { decodeAgentUri } from '../src/registration.js'
import type { RegistrationFile } from '../src/types.js'
import {
  IDENTITY_97,
  OWNER,
  fakePublicClient,
  fakeWallet,
  mintLog,
  resaleLog,
  validConfig,
} from './fixtures.js'

const NEW_AGENT_ID = 2210n

function receiptsFor(logs: Array<{ address: string; topics: readonly string[] }>) {
  const registerHash = `0x${'0'.repeat(63)}1` as const
  const setUriHash = `0x${'0'.repeat(63)}2` as const
  return {
    receipts: {
      [registerHash]: { status: 'success' as const, logs },
      [setUriHash]: { status: 'success' as const, logs: [] },
    },
    registerHash,
    setUriHash,
  }
}

describe('planPublish', () => {
  it('plans a two-phase mint and never touches the wallet', async () => {
    const wallet = fakeWallet(97)
    const plan = await planPublish({ config: validConfig(), walletClient: wallet, dedupe: 'none' })

    expect(plan.action).toBe('register')
    expect(plan.calls.map((call) => call.phase)).toEqual([1, 2, 3].slice(0, plan.calls.length))
    expect(plan.calls[0]?.functionName).toBe('register')
    expect(plan.calls[1]?.functionName).toBe('setAgentURI')
    expect(wallet.writes).toHaveLength(0)
  })

  it('encodes calldata that decodes back to the tokenURI', async () => {
    const plan = await planPublish({ config: validConfig(), walletClient: fakeWallet(97), dedupe: 'none' })
    const call = plan.calls[0]
    if (call === undefined) throw new Error('no call planned')
    const decoded = decodeFunctionData({ abi: identityWriteAbi, data: call.data })
    expect(decoded.functionName).toBe('register')
    expect(decoded.args?.[0]).toBe(plan.tokenUri)
  })

  it('plans a single setAgentURI when the agent id is already known', async () => {
    const plan = await planPublish({
      config: validConfig(),
      walletClient: fakeWallet(97),
      agentId: 42n,
    })
    expect(plan.action).toBe('update')
    expect(plan.calls.filter((call) => call.functionName === 'register')).toHaveLength(0)
    expect(plan.finalFile.registrations[0]?.agentId).toBe(42)
  })

  it('refuses a wallet on the wrong chain', async () => {
    await expect(
      planPublish({ config: validConfig({ chain: 'bsc' }), walletClient: fakeWallet(97), dedupe: 'none' }),
    ).rejects.toThrow(/refusing to publish to the wrong network/)
  })

  it('refuses a wallet with no account', async () => {
    await expect(
      planPublish({
        config: validConfig(),
        walletClient: { chain: { id: 97 }, writeContract: async () => '0x' },
        dedupe: 'none',
      }),
    ).rejects.toThrow(/no account/)
  })

  it('carries a validation plan when the config opts in', async () => {
    const plan = await planPublish({
      config: validConfig({ validation: { requestFrom: 'hallmark' } }),
      walletClient: fakeWallet(97),
      dedupe: 'none',
    })
    expect(plan.validation?.validator).toBe('0x9ff98B99B6B250b3a23961EA932F4ef147B909ab')
    expect(plan.validation?.requestHash).toBeNull()
  })

  it('has no validation plan when the config does not ask for one', async () => {
    const plan = await planPublish({ config: validConfig(), walletClient: fakeWallet(97), dedupe: 'none' })
    expect(plan.validation).toBeNull()
  })
})

describe('publishAgent — minting', () => {
  it('recovers the agent id from the Transfer log and re-publishes the patched file', async () => {
    const wallet = fakeWallet(97)
    const { receipts } = receiptsFor([mintLog(IDENTITY_97, OWNER, NEW_AGENT_ID)])

    const result = await publishAgent({
      config: validConfig(),
      walletClient: wallet,
      publicClient: fakePublicClient(receipts),
      dedupe: 'none',
    })

    expect(result.action).toBe('registered')
    expect(result.agentId).toBe(NEW_AGENT_ID)
    expect(wallet.writes.map((write) => write.functionName)).toEqual(['register', 'setAgentURI'])

    const phaseOne = decodeAgentUri(wallet.writes[0]?.args?.[0] as string) as RegistrationFile
    expect(phaseOne.registrations).toEqual([])

    const phaseTwo = decodeAgentUri(wallet.writes[1]?.args?.[1] as string) as RegistrationFile
    expect(phaseTwo.registrations).toEqual([
      { agentId: 2210, agentRegistry: `eip155:97:${IDENTITY_97}` },
    ])
    expect(wallet.writes[1]?.args?.[0]).toBe(NEW_AGENT_ID)
  })

  it('rejects a Transfer whose "from" is not the zero address', async () => {
    const wallet = fakeWallet(97)
    const { receipts } = receiptsFor([
      resaleLog(IDENTITY_97, '0x9999999999999999999999999999999999999999', OWNER, NEW_AGENT_ID),
    ])

    await expect(
      publishAgent({
        config: validConfig(),
        walletClient: wallet,
        publicClient: fakePublicClient(receipts),
        dedupe: 'none',
      }),
    ).rejects.toThrow(PublishError)

    // The mint failed to resolve, so phase two must not have run.
    expect(wallet.writes.map((write) => write.functionName)).toEqual(['register'])
  })

  it('ignores a Transfer emitted by some other contract in the same receipt', async () => {
    const wallet = fakeWallet(97)
    const { receipts } = receiptsFor([
      mintLog('0x000000000000000000000000000000000000dEaD', OWNER, 999n),
      mintLog(IDENTITY_97, OWNER, NEW_AGENT_ID),
    ])
    const result = await publishAgent({
      config: validConfig(),
      walletClient: wallet,
      publicClient: fakePublicClient(receipts),
      dedupe: 'none',
    })
    expect(result.agentId).toBe(NEW_AGENT_ID)
  })

  it('ignores a mint to somebody else in the same receipt', async () => {
    const wallet = fakeWallet(97)
    const { receipts } = receiptsFor([
      mintLog(IDENTITY_97, '0x8888888888888888888888888888888888888888', 5n),
      mintLog(IDENTITY_97, OWNER, NEW_AGENT_ID),
    ])
    const result = await publishAgent({
      config: validConfig(),
      walletClient: wallet,
      publicClient: fakePublicClient(receipts),
      dedupe: 'none',
    })
    expect(result.agentId).toBe(NEW_AGENT_ID)
  })

  it('refuses to mint without a public client, because the id would be lost', async () => {
    await expect(
      publishAgent({ config: validConfig(), walletClient: fakeWallet(97), dedupe: 'none' }),
    ).rejects.toThrow(/needs a publicClient/)
  })

  it('fails loudly when register reverts', async () => {
    const wallet = fakeWallet(97)
    const registerHash = `0x${'0'.repeat(63)}1` as const
    await expect(
      publishAgent({
        config: validConfig(),
        walletClient: wallet,
        publicClient: fakePublicClient({ [registerHash]: { status: 'reverted', logs: [] } }),
        dedupe: 'none',
      }),
    ).rejects.toThrow(/register reverted/)
  })
})

describe('publishAgent — idempotence', () => {
  it('updates in place when the wallet already owns an agent with this name', async () => {
    const wallet = fakeWallet(97)
    const setUriHash = `0x${'0'.repeat(63)}1` as const

    const result = await publishAgent({
      config: validConfig(),
      walletClient: wallet,
      publicClient: fakePublicClient({ [setUriHash]: { status: 'success', logs: [] } }),
      dedupe: async ({ owner, name, chainId }) => {
        expect(owner).toBe(OWNER)
        expect(name).toBe('Venus Health Guard')
        expect(chainId).toBe(97)
        return 314n
      },
    })

    expect(result.action).toBe('updated')
    expect(result.agentId).toBe(314n)
    expect(result.registerTx).toBeNull()
    expect(wallet.writes.map((write) => write.functionName)).toEqual(['setAgentURI'])
  })

  it('mints once and then updates: republishing does not create a second agent', async () => {
    const first = fakeWallet(97)
    const { receipts } = receiptsFor([mintLog(IDENTITY_97, OWNER, NEW_AGENT_ID)])
    const minted = await publishAgent({
      config: validConfig(),
      walletClient: first,
      publicClient: fakePublicClient(receipts),
      dedupe: 'none',
    })

    const second = fakeWallet(97)
    const setUriHash = `0x${'0'.repeat(63)}1` as const
    const republished = await publishAgent({
      config: validConfig(),
      walletClient: second,
      publicClient: fakePublicClient({ [setUriHash]: { status: 'success', logs: [] } }),
      dedupe: async () => minted.agentId,
    })

    expect(republished.agentId).toBe(minted.agentId)
    expect(second.writes.some((write) => write.functionName === 'register')).toBe(false)
  })

  it('surfaces a lookup failure instead of guessing', async () => {
    await expect(
      planPublish({
        config: validConfig(),
        walletClient: fakeWallet(97),
        dedupe: async () => {
          throw new PublishError('indexer unavailable')
        },
      }),
    ).rejects.toThrow(/indexer unavailable/)
  })
})

describe('publishAgent — validation request', () => {
  it('opens a validation request when the config declares one', async () => {
    const wallet = fakeWallet(97)
    const { receipts } = receiptsFor([mintLog(IDENTITY_97, OWNER, NEW_AGENT_ID)])
    receipts[`0x${'0'.repeat(63)}3`] = { status: 'success', logs: [] }

    const result = await publishAgent({
      config: validConfig({ validation: { requestFrom: 'hallmark' } }),
      walletClient: wallet,
      publicClient: fakePublicClient(receipts),
      dedupe: 'none',
    })

    expect(wallet.writes.map((write) => write.functionName)).toEqual([
      'register',
      'setAgentURI',
      'validationRequest',
    ])
    expect(result.validationRequest?.validator).toBe('0x9ff98B99B6B250b3a23961EA932F4ef147B909ab')
    expect(result.validationRequest?.requestHash).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('can be switched off even when the config asks for it', async () => {
    const wallet = fakeWallet(97)
    const { receipts } = receiptsFor([mintLog(IDENTITY_97, OWNER, NEW_AGENT_ID)])
    await publishAgent({
      config: validConfig({ validation: { requestFrom: 'hallmark' } }),
      walletClient: wallet,
      publicClient: fakePublicClient(receipts),
      dedupe: 'none',
      requestValidation: false,
    })
    expect(wallet.writes.map((write) => write.functionName)).toEqual(['register', 'setAgentURI'])
  })
})
