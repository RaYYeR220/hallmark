import { keccak256, toBytes } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  HALLMARK_VALIDATOR,
  REQUEST_HASH_DOMAIN,
  computeValidationRequestHash,
  requestValidation,
  resolveValidator,
  validationRequestPreimage,
} from '../src/validation.js'
import { fakePublicClient, fakeWallet } from './fixtures.js'

const BASE = {
  chainId: 97,
  agentId: 2210n,
  validator: 'hallmark' as const,
  evidenceUrl: 'https://example.com/evidence.json',
  nonce: 0,
}

describe('the request hash', () => {
  it('has a preimage anyone can rebuild from the request alone', () => {
    expect(validationRequestPreimage(BASE)).toBe(
      [
        REQUEST_HASH_DOMAIN,
        'chainId:97',
        'registry:0x8004cb1bf31daf7788923b405b754f57aceb4272',
        'validator:0x9ff98b99b6b250b3a23961ea932f4ef147b909ab',
        'agentId:2210',
        'evidence:https://example.com/evidence.json',
        'nonce:0',
      ].join('\n'),
    )
  })

  it('is keccak256 over those exact bytes', () => {
    expect(computeValidationRequestHash(BASE)).toBe(keccak256(toBytes(validationRequestPreimage(BASE))))
  })

  it('is deterministic', () => {
    expect(computeValidationRequestHash(BASE)).toBe(computeValidationRequestHash({ ...BASE }))
  })

  it('accepts a number agent id and a bigint interchangeably', () => {
    expect(computeValidationRequestHash({ ...BASE, agentId: 2210 })).toBe(computeValidationRequestHash(BASE))
  })

  it('changes with the nonce', () => {
    expect(computeValidationRequestHash({ ...BASE, nonce: 1 })).not.toBe(computeValidationRequestHash(BASE))
  })

  it('changes with the agent id', () => {
    expect(computeValidationRequestHash({ ...BASE, agentId: 2211n })).not.toBe(computeValidationRequestHash(BASE))
  })

  it('changes with the chain, so a testnet request cannot be replayed as a mainnet one', () => {
    expect(computeValidationRequestHash({ ...BASE, chainId: 56 })).not.toBe(computeValidationRequestHash(BASE))
  })

  it('changes with the evidence url', () => {
    expect(computeValidationRequestHash({ ...BASE, evidenceUrl: 'https://example.com/other.json' })).not.toBe(
      computeValidationRequestHash(BASE),
    )
  })

  it('changes with the validator', () => {
    expect(
      computeValidationRequestHash({ ...BASE, validator: '0x1234567890123456789012345678901234567890' }),
    ).not.toBe(computeValidationRequestHash(BASE))
  })

  it('defaults the nonce to zero', () => {
    const { nonce: _nonce, ...withoutNonce } = BASE
    expect(computeValidationRequestHash(withoutNonce)).toBe(computeValidationRequestHash(BASE))
  })
})

describe('resolveValidator', () => {
  it('resolves "hallmark" per chain', () => {
    expect(resolveValidator('hallmark', 97)).toBe(HALLMARK_VALIDATOR[97])
    expect(resolveValidator('hallmark', 56)).toBe(HALLMARK_VALIDATOR[56])
  })

  it('passes an explicit address through', () => {
    expect(resolveValidator('0x1234567890123456789012345678901234567890', 56)).toBe(
      '0x1234567890123456789012345678901234567890',
    )
  })

  it('refuses a chain Hallmark does not validate on', () => {
    expect(() => resolveValidator('hallmark', 1)).toThrow(/no Hallmark validator/)
  })
})

describe('requestValidation', () => {
  it('calls validationRequest with the computed hash', async () => {
    const wallet = fakeWallet(97)
    const result = await requestValidation({
      agentId: 2210n,
      evidenceUrl: 'https://example.com/evidence.json',
      walletClient: wallet,
    })

    expect(wallet.writes).toHaveLength(1)
    const write = wallet.writes[0]
    expect(write?.address).toBe('0x8004Cb1BF31DAf7788923b405b754f57acEB4272')
    expect(write?.functionName).toBe('validationRequest')
    expect(write?.args).toEqual([
      HALLMARK_VALIDATOR[97],
      2210n,
      'https://example.com/evidence.json',
      computeValidationRequestHash(BASE),
    ])
    expect(result.requestHash).toBe(computeValidationRequestHash(BASE))
    expect(result.explorerUrl).toMatch(/testnet\.bscscan\.com\/tx\//)
  })

  it('waits for the receipt when a public client is supplied', async () => {
    const wallet = fakeWallet(97)
    const hash = `0x${'0'.repeat(63)}1` as const
    const result = await requestValidation({
      agentId: 1n,
      evidenceUrl: 'https://example.com/e.json',
      walletClient: wallet,
      publicClient: fakePublicClient({ [hash]: { status: 'success', logs: [] } }),
    })
    expect(result.receiptStatus).toBe('success')
  })

  it('validates before signing: a bad chain never reaches the wallet', async () => {
    const wallet = fakeWallet(97)
    await expect(
      requestValidation({
        agentId: 1n,
        evidenceUrl: 'https://example.com/e.json',
        walletClient: wallet,
        chainId: 1,
      }),
    ).rejects.toThrow(/Unsupported chain/)
    expect(wallet.writes).toHaveLength(0)
  })

  it('refuses a wallet with no chain and no explicit chain id', async () => {
    await expect(
      requestValidation({
        agentId: 1n,
        evidenceUrl: 'https://example.com/e.json',
        walletClient: { account: { address: '0x1111111111111111111111111111111111111111' }, writeContract: async () => '0x' },
      }),
    ).rejects.toThrow(/no chain id/)
  })
})
