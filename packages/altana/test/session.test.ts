import { signerFromPrivateKey, type Session } from '@altananetwork/sdk'
import { keccak256, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import { NATIVE_TOKEN, PROTOCOLS } from '../src/addresses.js'
import { sessionKeyId } from '../src/keystore.js'
import { pancakeGridPolicy, toAltanaPermissions } from '../src/policy.js'
import {
  addressForPrivateKey,
  generateSessionKey,
  persistSession,
  restoreSession,
  restoreSessionFromKey,
} from '../src/session.js'

/**
 * Fixture key. Well-known test vector, never funded, never used anywhere real.
 * The expected keyId below was computed once and pinned: if a viem or SDK
 * change altered how a public key is encoded, the Keystore lookups this
 * package performs would quietly start missing.
 */
const FIXTURE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const FIXTURE_PUBLIC_KEY =
  '0x04ba5734d8f7091719471e7f7ed6b9df170dc70cc661ca05e688601ad984f068b0d67351e5f06073092499336ab0839ef8a521afd334e53807205fa2f08eec74f4' as Hex
const FIXTURE_KEY_ID =
  '0xb8fdf03c6b15dfd781c47a20474745a4ee69d8e1ef92aa886cb57e7ed0906d88' as Hex
const FIXTURE_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

const NOW = 1_760_000_000
const WALLET = '0x000000000000000000000000000000000000bEEF' as const

function fixtureSession(): Session {
  const signer = signerFromPrivateKey(FIXTURE_KEY)
  return {
    walletAddress: WALLET,
    signer,
    publicKey: signer.publicKey,
    permissions: toAltanaPermissions(pancakeGridPolicy(56, { now: NOW })),
    expiry: NOW + 7 * 86_400,
  }
}

describe('sessionKeyId', () => {
  it('is keccak256 of the SEC1 public key', () => {
    expect(signerFromPrivateKey(FIXTURE_KEY).publicKey).toBe(FIXTURE_PUBLIC_KEY)
    expect(sessionKeyId(FIXTURE_PUBLIC_KEY)).toBe(FIXTURE_KEY_ID)
    expect(sessionKeyId(FIXTURE_PUBLIC_KEY)).toBe(keccak256(FIXTURE_PUBLIC_KEY))
  })
})

describe('wallet address', () => {
  it('is the signer’s own EOA — Altana delegates onto it, it is not a new account', () => {
    expect(addressForPrivateKey(FIXTURE_KEY)).toBe(FIXTURE_ADDRESS)
    expect(signerFromPrivateKey(FIXTURE_KEY).address).toBe(FIXTURE_ADDRESS)
    expect(privateKeyToAccount(FIXTURE_KEY).address).toBe(FIXTURE_ADDRESS)
  })

  it('generates usable session keys', () => {
    const key = generateSessionKey()
    expect(key).toMatch(/^0x[0-9a-f]{64}$/)
    expect(addressForPrivateKey(key)).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})

describe('persist / restore', () => {
  it('round-trips permissions exactly', () => {
    const session = fixtureSession()
    const stored = persistSession(session, { chainId: 56, label: 'Grid bot', grantedAt: NOW })

    // JSON is the real storage medium, so prove it survives one.
    const reloaded = JSON.parse(JSON.stringify(stored)) as typeof stored
    const restored = restoreSession(reloaded, signerFromPrivateKey(FIXTURE_KEY))

    expect(restored.permissions).toEqual(session.permissions)
    expect(restored.walletAddress).toBe(session.walletAddress)
    expect(restored.publicKey).toBe(session.publicKey)
    expect(restored.expiry).toBe(session.expiry)
  })

  it('writes no key material', () => {
    const stored = persistSession(fixtureSession(), { chainId: 56, grantedAt: NOW })
    const serialized = JSON.stringify(stored).toLowerCase()
    expect(serialized).not.toContain(FIXTURE_KEY.slice(2).toLowerCase())
    expect(serialized).not.toContain('privatekey')
    expect(stored).not.toHaveProperty('signer')
  })

  it('keeps bigint limits as decimal strings', () => {
    const stored = persistSession(fixtureSession(), { grantedAt: NOW })
    expect(stored.permissions.spend?.map((cap) => cap.limit)).toEqual([
      '250000000000000000000',
      '50000000000000000',
    ])
    // The native cap keeps its "no token" shape all the way through.
    expect(stored.permissions.spend?.[1]).not.toHaveProperty('token')
  })

  it('carries a Hallmark envelope the SDK ignores on restore', () => {
    const stored = persistSession(fixtureSession(), {
      chainId: 56,
      label: 'Grid bot',
      grantedAt: NOW,
      txHash: '0xfeed',
    })
    expect(stored.hallmark).toEqual({
      version: 1,
      chainId: 56,
      keyId: FIXTURE_KEY_ID,
      label: 'Grid bot',
      grantedAt: NOW,
      txHash: '0xfeed',
    })
    expect(() => restoreSession(stored, signerFromPrivateKey(FIXTURE_KEY))).not.toThrow()
  })

  it('rejects a signer that does not match the stored key', () => {
    const stored = persistSession(fixtureSession(), { grantedAt: NOW })
    const wrongKey = generateSessionKey()
    expect(() => restoreSessionFromKey(stored, wrongKey)).toThrow(
      /does not\s+match the stored session/,
    )
  })

  it('restores a native-only policy without inventing a token', () => {
    const session: Session = {
      ...fixtureSession(),
      permissions: { spend: [{ limit: 10n ** 17n, period: 'hour' }] },
    }
    const restored = restoreSessionFromKey(persistSession(session), FIXTURE_KEY)
    expect(restored.permissions.spend).toEqual([{ limit: 10n ** 17n, period: 'hour' }])
  })
})

describe('policy fixtures used above', () => {
  it('the grid policy really is router-scoped with a native cap', () => {
    const permissions = toAltanaPermissions(pancakeGridPolicy(56, { now: NOW }))
    expect(permissions.calls).toEqual([{ to: PROTOCOLS[56].pancake.swapRouter }])
    expect(permissions.spend?.some((cap) => cap.token === undefined)).toBe(true)
    expect(NATIVE_TOKEN.toLowerCase()).not.toBe(PROTOCOLS[56].defaultStable.toLowerCase())
  })
})
