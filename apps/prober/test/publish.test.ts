import { describe, expect, it } from 'vitest'

import {
  GAS_LIMITS,
  buildPlan,
  clampToUint8,
  createBudgetGuard,
  encodeFeedback,
  findPendingRequest,
  formatPlan,
} from '../src/publish.ts'
import type { RunRecord } from '../src/store.ts'

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    chainId: 97,
    agentId: 2210,
    probedAt: '2026-09-07T12:00:00.000Z',
    score: 84,
    breakdown: { reachability: 35, protocol: 25, latency: 12, capabilities: 7.5, x402: 0 },
    evidenceHash: `0x${'ab'.repeat(32)}`,
    elapsedMs: 431,
    name: 'Hallmark Validator',
    owner: '0x38c6Fc4a5525B37f9545423A7132157f69ce08dA',
    cardError: null,
    primaryEndpoint: 'https://agent.test/mcp',
    endpointCount: 3,
    scoredCount: 3,
    okCount: 2,
    protocolOkCount: 2,
    failures: { 'http-4xx': 1 },
    kinds: ['a2a', 'mcp', 'web'],
    latencies: [120, 340],
    mcpTools: 4,
    a2aSkills: 0,
    x402: false,
    ...overrides,
  }
}

describe('budget guard', () => {
  it('allows a spend inside both ceilings', () => {
    const guard = createBudgetGuard({ perRunWei: 1_000n, totalWei: 10_000n })
    expect(guard.check(500n)).toBe(null)
  })

  it('refuses a spend that would breach the per-run ceiling', () => {
    const guard = createBudgetGuard({ perRunWei: 1_000n, totalWei: 10_000n })
    expect(guard.check(1_001n)).toMatch(/per-run budget exhausted/)
  })

  it('refuses a spend that would breach the all-time ceiling', () => {
    const guard = createBudgetGuard({ perRunWei: 10_000n, totalWei: 1_000n, alreadySpentWei: 900n })
    expect(guard.check(200n)).toMatch(/total budget exhausted/)
  })

  it('counts reservations, so two concurrent writes cannot both squeeze through', () => {
    const guard = createBudgetGuard({ perRunWei: 1_000n, totalWei: 10_000n })
    expect(guard.check(600n)).toBe(null)
    guard.reserve(600n)
    expect(guard.check(600n)).toMatch(/per-run budget exhausted/)
  })

  it('frees a reservation for a write that never went out', () => {
    const guard = createBudgetGuard({ perRunWei: 1_000n, totalWei: 10_000n })
    guard.reserve(900n)
    guard.release(900n)
    expect(guard.check(900n)).toBe(null)
    expect(guard.state().reservedWei).toBe(0n)
  })

  it('charges what was actually spent, not what was reserved', () => {
    const guard = createBudgetGuard({ perRunWei: 1_000n, totalWei: 10_000n })
    guard.reserve(800n)
    guard.settle(800n, 300n)
    const state = guard.state()
    expect(state.spentThisRunWei).toBe(300n)
    expect(state.reservedWei).toBe(0n)
    expect(guard.check(600n)).toBe(null)
  })

  it('accumulates across writes within one run', () => {
    const guard = createBudgetGuard({ perRunWei: 1_000n, totalWei: 10_000n })
    guard.reserve(400n)
    guard.settle(400n, 400n)
    guard.reserve(400n)
    guard.settle(400n, 400n)
    expect(guard.check(300n)).toMatch(/per-run budget exhausted/)
  })

  it('is exact at the boundary', () => {
    const guard = createBudgetGuard({ perRunWei: 1_000n, totalWei: 1_000n })
    expect(guard.check(1_000n)).toBe(null)
    expect(guard.check(1_001n)).not.toBe(null)
  })

  it('refuses a real measured cycle when the ceiling is a fraction of it', () => {
    // 320,000 gas at 0.05 gwei is 1.6e13 wei.
    const guard = createBudgetGuard({ perRunWei: 1_000_000_000_000n, totalWei: 1_000_000_000_000n })
    const cost = GAS_LIMITS.giveFeedback * 50_000_000n
    expect(guard.check(cost)).toMatch(/budget exhausted/)
  })
})

describe('feedback encoding', () => {
  it('puts the 0-100 score under the standard "reachable" tag with no decimals', () => {
    expect(encodeFeedback(record({ score: 84 }), 'reachable')).toEqual({
      value: 84n,
      valueDecimals: 0,
      tag1: 'reachable',
    })
  })

  it('encodes uptime as a percent scaled by 100, per the standard convention', () => {
    const encoded = encodeFeedback(record({ okCount: 3, scoredCount: 4 }), 'uptime')
    expect(encoded).toEqual({ value: 7_500n, valueDecimals: 2, tag1: 'uptime' })
  })

  it('encodes responsetime as the median round trip in milliseconds', () => {
    expect(encodeFeedback(record({ latencies: [100, 200, 900] }), 'responsetime')).toEqual({
      value: 200n,
      valueDecimals: 0,
      tag1: 'responsetime',
    })
  })

  it('never produces a value the hook would ignore for a scoring agent', () => {
    // HallmarkHook._reputationEvidence requires count > 0 AND value > 0.
    expect(encodeFeedback(record({ score: 1 }), 'reachable').value).toBeGreaterThan(0n)
  })

  it('produces zero for a dead agent, which the publisher then refuses to write', () => {
    expect(encodeFeedback(record({ score: 0 }), 'reachable').value).toBe(0n)
    expect(encodeFeedback(record({ okCount: 0, scoredCount: 3 }), 'uptime').value).toBe(0n)
  })

  it('clamps a score into uint8 range', () => {
    expect(clampToUint8(101)).toBe(101)
    expect(clampToUint8(-4)).toBe(0)
    expect(clampToUint8(9_000)).toBe(255)
    expect(clampToUint8(Number.NaN)).toBe(0)
  })
})

describe('validation request discovery', () => {
  const validator = '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab' as const
  const other = '0x0000000000000000000000000000000000000001' as const

  function fakeReader(entries: Array<{ hash: string; validator: string; agentId: number; lastUpdate: bigint }>) {
    return {
      agentValidations: async () => entries.map((e) => e.hash as `0x${string}`),
      validationStatus: async (hash: `0x${string}`) => {
        const entry = entries.find((e) => e.hash === hash)
        if (entry === undefined) return null
        return {
          validator: entry.validator as `0x${string}`,
          agentId: BigInt(entry.agentId),
          response: 0,
          responseHash: `0x${'0'.repeat(64)}` as `0x${string}`,
          tag: '',
          lastUpdate: entry.lastUpdate,
        }
      },
    } as never
  }

  it('returns null when nothing is addressed to this validator', async () => {
    const reader = fakeReader([{ hash: `0x${'1'.repeat(64)}`, validator: other, agentId: 2210, lastUpdate: 0n }])
    expect(await findPendingRequest(reader, 2210, validator)).toBe(null)
  })

  it('returns null when the agent has no validations at all', async () => {
    expect(await findPendingRequest(fakeReader([]), 2210, validator)).toBe(null)
  })

  it('prefers a request that has never been answered', async () => {
    const answered = `0x${'2'.repeat(64)}`
    const pending = `0x${'3'.repeat(64)}`
    const reader = fakeReader([
      { hash: answered, validator, agentId: 2210, lastUpdate: 1_700_000_000n },
      { hash: pending, validator, agentId: 2210, lastUpdate: 0n },
    ])
    expect(await findPendingRequest(reader, 2210, validator)).toBe(pending)
  })

  it('falls back to the most recently touched request', async () => {
    const older = `0x${'4'.repeat(64)}`
    const newer = `0x${'5'.repeat(64)}`
    const reader = fakeReader([
      { hash: older, validator, agentId: 2210, lastUpdate: 100n },
      { hash: newer, validator, agentId: 2210, lastUpdate: 200n },
    ])
    expect(await findPendingRequest(reader, 2210, validator)).toBe(newer)
  })

  it('ignores records that belong to a different agent', async () => {
    const reader = fakeReader([{ hash: `0x${'6'.repeat(64)}`, validator, agentId: 999, lastUpdate: 0n }])
    expect(await findPendingRequest(reader, 2210, validator)).toBe(null)
  })
})

describe('dry run', () => {
  /**
   * Regression: a dry run used to cost every write in isolation, so a plan for
   * ten agents would happily report "would send" ten times while blowing past
   * a ceiling that only allowed three. The plan has to run the budget down as
   * it goes, or it is not a plan.
   */
  async function planner(perRunWei: bigint) {
    const { createPublisher } = await import('../src/publish.ts')
    const { createMemoryStore } = await import('../src/store.ts')
    const { loadConfig } = await import('../src/config.ts')

    const reader = {
      client: {},
      getAgent: async (agentId: bigint | number) => ({
        agentId: BigInt(agentId),
        owner: '0x1111111111111111111111111111111111111111' as const,
        tokenUri: '',
        card: { ok: false as const, kind: 'unknown' as const, error: 'n/a', raw: '' },
      }),
    } as never

    return createPublisher({
      chainId: 97,
      config: loadConfig({ env: {}, budget: { perRunWei, totalWei: perRunWei } }),
      store: createMemoryStore(),
      reader,
      dryRun: true,
      gasPriceWei: 100_000_000n,
      plannerAddress: '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab',
    })
  }

  it('spends the budget down across a plan instead of costing each write alone', async () => {
    // One giveFeedback at 320,000 gas and 0.1 gwei is 3.2e13 wei. Room for one.
    const publisher = await planner(50_000_000_000_000n)

    const first = await publisher.publishReputation(record({ agentId: 1 }))
    const second = await publisher.publishReputation(record({ agentId: 2 }))

    expect(first.status).toBe('dry-run')
    expect(second.status).toBe('skipped')
    if (second.status === 'skipped') expect(second.reason).toMatch(/per-run budget exhausted/)
  })

  it('plans without any private key when given a sender address', async () => {
    const publisher = await planner(10_000_000_000_000_000n)
    const outcome = await publisher.publishReputation(record())
    expect(outcome.status).toBe('dry-run')
    expect(outcome.plan.from).toBe('0x9ff98B99B6B250b3a23961EA932F4ef147B909ab')
    expect(publisher.dryRun).toBe(true)
  })

  it('refuses to write feedback for an agent the attestor owns', async () => {
    const { createPublisher } = await import('../src/publish.ts')
    const { createMemoryStore } = await import('../src/store.ts')
    const { loadConfig } = await import('../src/config.ts')

    const owner = '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab'
    const publisher = createPublisher({
      chainId: 97,
      config: loadConfig({ env: {} }),
      store: createMemoryStore(),
      reader: {
        client: {},
        getAgent: async (agentId: bigint | number) => ({
          agentId: BigInt(agentId),
          owner,
          tokenUri: '',
          card: { ok: false as const, kind: 'unknown' as const, error: 'n/a', raw: '' },
        }),
      } as never,
      dryRun: true,
      gasPriceWei: 100_000_000n,
      plannerAddress: owner,
    })

    const outcome = await publisher.publishReputation(record())
    expect(outcome.status).toBe('skipped')
    if (outcome.status === 'skipped') expect(outcome.reason).toMatch(/self-feedback/)
  })

  it('refuses to write feedback for a dead agent', async () => {
    const publisher = await planner(10_000_000_000_000_000n)
    const outcome = await publisher.publishReputation(record({ score: 0 }))
    expect(outcome.status).toBe('skipped')
    if (outcome.status === 'skipped') expect(outcome.reason).toMatch(/min-score/)
  })

  it('refuses to write into a fee spike', async () => {
    const { createPublisher } = await import('../src/publish.ts')
    const { createMemoryStore } = await import('../src/store.ts')
    const { loadConfig } = await import('../src/config.ts')

    const publisher = createPublisher({
      chainId: 97,
      config: loadConfig({ env: {} }),
      store: createMemoryStore(),
      reader: { client: {}, getAgent: async () => null } as never,
      dryRun: true,
      gasPriceWei: 50_000_000_000n, // 50 gwei, a thousand times the normal fee
      plannerAddress: '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab',
    })

    const outcome = await publisher.publishReputation(record())
    expect(outcome.status).toBe('skipped')
    if (outcome.status === 'skipped') expect(outcome.reason).toMatch(/fee spike/)
  })
})

describe('plans', () => {
  it('costs a write as gasLimit times gasPrice', () => {
    const plan = buildPlan({
      kind: 'reputation',
      chainId: 97,
      agentId: 2210,
      to: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      from: '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab',
      functionName: 'giveFeedback',
      args: ['2210', '84', '0', 'reachable', 'hallmark', '', 'https://x/y', `0x${'ab'.repeat(32)}`],
      gasLimit: GAS_LIMITS.giveFeedback,
      gasPriceWei: 50_000_000n,
      evidenceHash: `0x${'ab'.repeat(32)}`,
      evidenceUri: 'https://x/y',
      score: 84,
    })
    expect(plan.costWei).toBe(String(320_000n * 50_000_000n))
    expect(formatPlan(plan)).toContain('giveFeedback')
    expect(formatPlan(plan)).toContain('0.000016 BNB')
  })

  it('keeps explicit gas floors above the measured first-write cost', () => {
    // giveFeedback's first write for a client measured 213,948 gas on BSC.
    expect(GAS_LIMITS.giveFeedback).toBeGreaterThan(213_948n)
    expect(GAS_LIMITS.validationResponse).toBeGreaterThan(132_366n)
    expect(GAS_LIMITS.validationRequest).toBeGreaterThan(210_287n)
  })
})
