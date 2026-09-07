import { describe, expect, it } from 'vitest'
import { buildPolicy, venusHealthFactorPolicy, pancakeRebalancePolicy } from '@hallmark/altana'

import { buildApp } from '../src/app.js'
import { cannotBorrow, describeSessions } from '../src/runtime/sessions.js'
import { createMemoryStore } from '../src/runtime/store.js'
import { fakeSession, providerFor, testConfig } from './support/fixtures.js'
import type { SessionHandle } from '../src/runtime/types.js'

/**
 * The authorization surface the marketplace renders.
 *
 * The property worth protecting here is that an *ungranted* agent still
 * publishes the policy a grant would authorise. A sessions page that only
 * lists live keys answers the wrong question: a user wants to know what the
 * thing could do to them before they agree, not after.
 */

const config = testConfig()
const NOW = Math.floor(Date.now() / 1000)

function app(sessions = providerFor(null)) {
  return buildApp({ config, store: createMemoryStore(), sessions })
}

async function sessionsPage(sessions = providerFor(null)) {
  const res = await app(sessions).fetch(new Request('https://agents.test/sessions?chainId=97'))
  return { status: res.status, body: (await res.json()) as Record<string, any> }
}

describe('cannotBorrow', () => {
  it('is true for the selector-scoped health policy', () => {
    expect(cannotBorrow(venusHealthFactorPolicy(97, { now: NOW }))).toBe(true)
  })

  it('is false for a contract-scoped policy, which permits every function', () => {
    // The rebalance policy allowlists two contracts with no selector at all.
    // It cannot claim "no borrow" and this must not pretend otherwise.
    expect(cannotBorrow(pancakeRebalancePolicy(97, { now: NOW }))).toBe(false)
  })

  it('is false once any borrowing selector is added — the negative control', () => {
    const policy = venusHealthFactorPolicy(97, { now: NOW })
    const levered: typeof policy = {
      ...policy,
      calls: [
        ...policy.calls,
        { to: policy.calls[0]!.to!, signature: 'borrow(uint256)', label: 'Borrow' },
      ],
    }
    expect(cannotBorrow(levered)).toBe(false)
  })
})

describe('GET /sessions with nothing granted', () => {
  it('lists every category that can act, with the policy a grant would authorise', async () => {
    const { status, body } = await sessionsPage()
    expect(status).toBe(200)
    expect(body['grantedCount']).toBe(0)
    expect(body['liveCount']).toBe(0)

    const views = body['sessions'] as Array<Record<string, any>>
    // Four agents can act; the security agent is read-only and has no policy.
    expect(views.map((view) => view.agent).sort()).toEqual(['grid', 'health', 'rebalancer', 'yield'])
    expect(views.map((view) => view.agent)).not.toContain('security')

    for (const view of views) {
      expect(view['granted'], view['agent']).toBe(false)
      expect(view['keyId']).toBeNull()
      expect(view['keystore'].valid).toBeNull()
      // The point of the page: an ungranted agent still shows its scope.
      expect((view['policy'].lines as string[]).length).toBeGreaterThan(2)
      expect((view['policy'].allowlist as unknown[]).length).toBeGreaterThan(0)
      expect((view['policy'].caps as unknown[]).length).toBeGreaterThan(0)
    }
  })

  it('names the Keystore so a reader can check for themselves', async () => {
    const { body } = await sessionsPage()
    // BNB Chain testnet Keystore.
    expect(body['keystore']).toBe('0x6b8361C29d05D498b1a12B54A37310f94171E94A')
    expect(body['note']).toContain('isValidKey(wallet, keyId)')
  })

  it('reports the health agent as unable to borrow, and the rebalancer as not', async () => {
    const { body } = await sessionsPage()
    const views = body['sessions'] as Array<Record<string, any>>
    const health = views.find((view) => view.agent === 'health')!
    const rebalancer = views.find((view) => view.agent === 'rebalancer')!
    expect(health['policy'].cannotBorrow).toBe(true)
    expect(rebalancer['policy'].cannotBorrow).toBe(false)
  })

  it('explains that act is read-only rather than implying it is broken', async () => {
    const { body } = await sessionsPage()
    const health = (body['sessions'] as Array<Record<string, any>>).find((v) => v.agent === 'health')!
    expect(health['detail']).toContain('read-only right now')
    expect(health['keystore'].detail).toContain('no key to check')
  })
})

describe('GET /sessions with a session granted', () => {
  const handle: SessionHandle = {
    session: { ...fakeSession('0x330eb8FFc68d549057fC5115218a6590b39e8531'), expiry: NOW + 3_600 },
    policy: buildPolicy('venus-health-factor', 97, { now: NOW }),
    chainId: 97,
  }

  const only = (category: string) => ({
    async get(_chainId: 97 | 56, binding: { category: string }) {
      return binding.category === category ? handle : null
    },
  })

  it('reports the key id, wallet and expiry, and still lists the ungranted ones', async () => {
    const { body } = await sessionsPage(only('venus-health-factor') as never)
    const views = body['sessions'] as Array<Record<string, any>>
    expect(body['grantedCount']).toBe(1)
    expect(views).toHaveLength(4)

    const health = views.find((view) => view.agent === 'health')!
    expect(health['granted']).toBe(true)
    expect(health['wallet']).toBe('0x330eb8FFc68d549057fC5115218a6590b39e8531')
    expect(health['keyId']).toMatch(/^0x[0-9a-f]{64}$/)
    expect(health['expired']).toBe(false)
    expect(health['keystore'].keyUrl).toContain(health['keyId'])
    expect(health['keystore'].accountUrl).toContain(health['wallet'])
  })

  it('says validity is unknown rather than true when the Keystore does not answer', async () => {
    // The fixture key was never registered, so the read either returns false
    // or the node is unreachable from the test runner. Either way the page
    // must never invent a `true`.
    const { body } = await sessionsPage(only('venus-health-factor') as never)
    const health = (body['sessions'] as Array<Record<string, any>>).find((v) => v.agent === 'health')!
    expect(health['keystore'].valid).not.toBe(true)
    expect(typeof health['keystore'].detail).toBe('string')
  })

  it('marks an expired grant as expired and explains that it cannot be extended', async () => {
    const expired: SessionHandle = {
      ...handle,
      session: { ...handle.session, expiry: NOW - 60 },
    }
    const { body } = await sessionsPage({
      async get(_c: never, binding: { category: string }) {
        return binding.category === 'venus-health-factor' ? expired : null
      },
    } as never)
    const health = (body['sessions'] as Array<Record<string, any>>).find((v) => v.agent === 'health')!
    expect(health['expired']).toBe(true)
    expect(health['detail']).toContain('cannot be extended')
  })

  it('survives a session provider that throws', async () => {
    const views = await describeSessions({
      config,
      sessions: {
        async get() {
          throw new Error('keystore unreachable')
        },
      },
      chainId: 97,
      timeoutMs: 500,
    })
    expect(views).toHaveLength(4)
    expect(views.every((view) => view.granted === false)).toBe(true)
  })
})
