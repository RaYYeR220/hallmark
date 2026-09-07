import type { SessionPermissions } from '@altananetwork/sdk'
import { describe, expect, it } from 'vitest'

import { NATIVE_TOKEN, PROTOCOLS } from '../src/addresses.js'
import {
  buildPolicy,
  describePolicy,
  fromAltanaPermissions,
  pancakeGridPolicy,
  pancakeRebalancePolicy,
  toAltanaPermissions,
  validatePolicy,
  venusHealthFactorPolicy,
  yieldRoutingPolicy,
  type AgentPolicy,
} from '../src/policy.js'

const NOW = 1_760_000_000 // fixed clock so every assertion is deterministic
const DAY = 86_400
const USDT = PROTOCOLS[56].defaultStable

function policy(overrides: Partial<AgentPolicy> = {}): AgentPolicy {
  return {
    label: 'Test policy',
    calls: [{ to: PROTOCOLS[56].pancake.swapRouter, label: 'PancakeSwap v3 swap router' }],
    spend: [
      { token: USDT, limitAtomic: 250n * 10n ** 18n, decimals: 18, period: 'day' },
      { token: NATIVE_TOKEN, limitAtomic: 5n * 10n ** 16n, decimals: 18, period: 'day' },
    ],
    expiresAt: NOW + 7 * DAY,
    ...overrides,
  }
}

describe('toAltanaPermissions', () => {
  const cases: { name: string; input: AgentPolicy; expected: SessionPermissions }[] = [
    {
      name: 'contract-only rule',
      input: policy(),
      expected: {
        calls: [{ to: PROTOCOLS[56].pancake.swapRouter }],
        spend: [
          { limit: 250n * 10n ** 18n, period: 'day', token: USDT },
          { limit: 5n * 10n ** 16n, period: 'day' },
        ],
      },
    },
    {
      name: 'contract + signature rule',
      input: policy({
        calls: [
          {
            to: PROTOCOLS[56].venus.vUSDT,
            signature: 'repayBorrow(uint256)',
            label: 'Repay USDT debt',
          },
        ],
      }),
      expected: {
        calls: [{ to: PROTOCOLS[56].venus.vUSDT, signature: 'repayBorrow(uint256)' }],
        spend: [
          { limit: 250n * 10n ** 18n, period: 'day', token: USDT },
          { limit: 5n * 10n ** 16n, period: 'day' },
        ],
      },
    },
    {
      name: 'signature-only rule',
      input: policy({
        calls: [{ signature: 'approve(address,uint256)', label: 'Approve any token' }],
      }),
      expected: {
        calls: [{ signature: 'approve(address,uint256)' }],
        spend: [
          { limit: 250n * 10n ** 18n, period: 'day', token: USDT },
          { limit: 5n * 10n ** 16n, period: 'day' },
        ],
      },
    },
    {
      name: 'hourly native-only cap',
      input: policy({
        spend: [
          { token: NATIVE_TOKEN, limitAtomic: 10n ** 17n, decimals: 18, period: 'hour' },
        ],
      }),
      expected: {
        calls: [{ to: PROTOCOLS[56].pancake.swapRouter }],
        spend: [{ limit: 10n ** 17n, period: 'hour' }],
      },
    },
    {
      name: 'empty allowlist becomes an omitted `calls` key (Altana reads that as any contract)',
      input: policy({ calls: [] }),
      expected: {
        spend: [
          { limit: 250n * 10n ** 18n, period: 'day', token: USDT },
          { limit: 5n * 10n ** 16n, period: 'day' },
        ],
      },
    },
  ]

  for (const { name, expected, input } of cases) {
    it(name, () => {
      expect(toAltanaPermissions(input)).toEqual(expected)
    })
  }

  it('refuses a rule that constrains nothing', () => {
    expect(() =>
      toAltanaPermissions(policy({ calls: [{ label: 'Anything at all' }] })),
    ).toThrow(/neither/)
  })
})

describe('fromAltanaPermissions', () => {
  it('round-trips a policy through the on-chain shape', () => {
    const original = venusHealthFactorPolicy(56, { now: NOW })
    const permissions = toAltanaPermissions(original)

    const restored = fromAltanaPermissions(permissions, {
      label: original.label,
      expiresAt: original.expiresAt,
      labelOf: (_permission, index) => original.calls[index]!.label,
    })

    expect(restored).toEqual(original)
  })

  it('recovers native caps from an omitted token', () => {
    const restored = fromAltanaPermissions(
      { spend: [{ limit: 42n, period: 'day' }] },
      { label: 'x', expiresAt: NOW },
    )
    expect(restored.spend).toEqual([
      { token: NATIVE_TOKEN, limitAtomic: 42n, decimals: 18, period: 'day' },
    ])
  })

  it('generates readable labels when the caller supplies none', () => {
    const restored = fromAltanaPermissions(
      {
        calls: [
          { to: PROTOCOLS[56].pancake.swapRouter },
          { signature: 'mint()' },
          { to: PROTOCOLS[56].venus.vBNB, signature: 'repayBorrow()' },
        ],
      },
      { label: 'x', expiresAt: NOW },
    )
    expect(restored.calls.map((rule) => rule.label)).toEqual([
      'Any call to 0x1b81…eB14',
      'mint() on any contract',
      'repayBorrow() on 0xA07c…ea36',
    ])
  })

  it('rejects a spend period Hallmark policies do not model', () => {
    expect(() =>
      fromAltanaPermissions(
        { spend: [{ limit: 1n, period: 'month' }] },
        { label: 'x', expiresAt: NOW },
      ),
    ).toThrow(/'day' and 'hour'/)
  })
})

describe('validatePolicy', () => {
  const opts = { now: NOW }

  it('passes a well-formed policy', () => {
    expect(validatePolicy(policy(), opts)).toEqual({ ok: true })
  })

  function problemsOf(p: AgentPolicy): string[] {
    const result = validatePolicy(p, opts)
    expect(result.ok).toBe(false)
    return result.ok ? [] : result.problems
  }

  it('flags an empty allowlist as unrestricted contract access', () => {
    expect(problemsOf(policy({ calls: [] })).join('\n')).toMatch(/any contract/i)
  })

  it('flags an expiry in the past', () => {
    expect(problemsOf(policy({ expiresAt: NOW - 1 })).join('\n')).toMatch(/in the past/)
  })

  it('flags an expiry absurdly far out', () => {
    expect(problemsOf(policy({ expiresAt: NOW + 400 * DAY })).join('\n')).toMatch(
      /permanent grant/,
    )
  })

  it('flags a millisecond timestamp mistaken for seconds', () => {
    expect(problemsOf(policy({ expiresAt: NOW * 1000 })).join('\n')).toMatch(
      /looks like milliseconds/,
    )
  })

  it('flags a missing spend cap', () => {
    expect(problemsOf(policy({ spend: [] })).join('\n')).toMatch(/no spending bound/)
  })

  it('flags a zero cap', () => {
    const problems = problemsOf(
      policy({
        spend: [
          { token: USDT, limitAtomic: 0n, decimals: 18, period: 'day' },
          { token: NATIVE_TOKEN, limitAtomic: 5n * 10n ** 16n, decimals: 18, period: 'day' },
        ],
      }),
    )
    expect(problems.join('\n')).toMatch(/can never execute/)
  })

  it('catches the 6-vs-18 decimals trap: 100 USDT written as 100_000_000n', () => {
    const problems = problemsOf(
      policy({
        spend: [
          { token: USDT, limitAtomic: 100_000_000n, decimals: 18, period: 'day' },
          { token: NATIVE_TOKEN, limitAtomic: 5n * 10n ** 16n, decimals: 18, period: 'day' },
        ],
      }),
    )
    expect(problems.join('\n')).toMatch(/looks like 100 written for a 6-decimal token/)
    expect(problems.join('\n')).toMatch(/multiply the limit by 10\^12/)
  })

  it('catches a cap that declares 6 decimals for an 18-decimal BNB Chain token', () => {
    const problems = problemsOf(
      policy({
        spend: [
          { token: USDT, limitAtomic: 100n * 10n ** 6n, decimals: 6, period: 'day' },
          { token: NATIVE_TOKEN, limitAtomic: 5n * 10n ** 16n, decimals: 18, period: 'day' },
        ],
      }),
    )
    expect(problems.join('\n')).toMatch(/USDT has 18 decimals on BNB Chain/)
  })

  it('flags dust caps that are not the decimals trap', () => {
    const problems = problemsOf(
      policy({
        spend: [
          { token: USDT, limitAtomic: 5n, decimals: 18, period: 'day' },
          { token: NATIVE_TOKEN, limitAtomic: 5n * 10n ** 16n, decimals: 18, period: 'day' },
        ],
      }),
    )
    expect(problems.join('\n')).toMatch(/dust/)
  })

  it('flags a native cap too small to cover the relay fee', () => {
    const problems = problemsOf(
      policy({
        spend: [
          { token: USDT, limitAtomic: 250n * 10n ** 18n, decimals: 18, period: 'day' },
          // 0.0011 BNB: above the dust floor, below two Keystore fees.
          { token: NATIVE_TOKEN, limitAtomic: 1_100_000_000_000_000n, decimals: 18, period: 'day' },
        ],
      }),
    )
    expect(problems.join('\n')).toMatch(/relay fees are charged against it/i)
  })

  it('flags a missing native cap', () => {
    const problems = problemsOf(
      policy({
        spend: [{ token: USDT, limitAtomic: 250n * 10n ** 18n, decimals: 18, period: 'day' }],
      }),
    )
    expect(problems.join('\n')).toMatch(/No native \(BNB\) spend cap/)
  })

  it('flags duplicate caps and duplicate rules', () => {
    const problems = problemsOf(
      policy({
        calls: [
          { to: PROTOCOLS[56].pancake.swapRouter, label: 'Router' },
          { to: PROTOCOLS[56].pancake.swapRouter, label: 'Router again' },
        ],
        spend: [
          { token: USDT, limitAtomic: 10n ** 18n, decimals: 18, period: 'day' },
          { token: USDT, limitAtomic: 10n ** 18n, decimals: 18, period: 'hour' },
          { token: NATIVE_TOKEN, limitAtomic: 5n * 10n ** 16n, decimals: 18, period: 'day' },
        ],
      }),
    )
    expect(problems.join('\n')).toMatch(/Duplicate call rule/)
    expect(problems.join('\n')).toMatch(/Two spend caps for USDT/)
  })

  it('flags a malformed function signature', () => {
    const problems = problemsOf(
      policy({ calls: [{ to: USDT, signature: 'transfer', label: 'Transfer' }] }),
    )
    expect(problems.join('\n')).toMatch(/not a `name\(type,type\)` function signature/)
  })

  it('flags a rule with no label and a policy with no label', () => {
    const problems = problemsOf(
      policy({ label: '  ', calls: [{ to: USDT, label: '' }] }),
    )
    expect(problems.join('\n')).toMatch(/Policy has no label/)
    expect(problems.join('\n')).toMatch(/Call rule 0 has no label/)
  })
})

describe('category policy builders', () => {
  const chains = [56, 97] as const

  it('every builder produces a policy that validates on both chains', () => {
    for (const chainId of chains) {
      for (const category of [
        'pancake-rebalance',
        'pancake-grid',
        'yield-routing',
        'venus-health-factor',
      ] as const) {
        const built = buildPolicy(category, chainId, { now: NOW })
        expect(validatePolicy(built, { now: NOW })).toEqual({ ok: true })
        expect(built.expiresAt).toBe(NOW + 7 * DAY)
      }
    }
  })

  it('pancake rebalance allowlists the position manager and the router', () => {
    for (const chainId of chains) {
      const rules = pancakeRebalancePolicy(chainId, { now: NOW }).calls
      expect(rules.map((rule) => rule.to)).toEqual([
        PROTOCOLS[chainId].pancake.positionManager,
        PROTOCOLS[chainId].pancake.swapRouter,
      ])
    }
    expect(pancakeRebalancePolicy(56, { now: NOW }).calls[0]!.to).toBe(
      '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    )
    expect(pancakeRebalancePolicy(97, { now: NOW }).calls[0]!.to).toBe(
      '0x427bF5b37357632377eCbEC9de3626C71A5396c1',
    )
  })

  it('pancake grid allowlists the router only', () => {
    for (const chainId of chains) {
      const rules = pancakeGridPolicy(chainId, { now: NOW }).calls
      expect(rules).toHaveLength(1)
      expect(rules[0]!.to).toBe('0x1b81D678ffb9C0263b24A97847620C99d213eB14')
    }
  })

  it('yield routing includes Aave on 56 and only Venus on 97', () => {
    expect(yieldRoutingPolicy(56, { now: NOW }).calls.map((rule) => rule.to)).toEqual([
      '0xfD36E2c2a6789Db23113685031d7F16329158384',
      '0xA07c5b74C9B40447a954e1466938b865b6BBea36',
      '0xfD5840Cd36d94D7229439859C0112a4185BC0255',
      '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
    ])
    expect(yieldRoutingPolicy(97, { now: NOW }).calls.map((rule) => rule.to)).toEqual([
      '0x94d1820b2D1c7c7452A163983Dc888CEC546b77D',
      '0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c',
      '0xb7526572FFE56AB9D7489838Bf2E18e3323b441A',
    ])
  })

  it('venus health-factor scoping allows de-risking calls and never `borrow`', () => {
    for (const chainId of chains) {
      const rules = venusHealthFactorPolicy(chainId, { now: NOW }).calls
      expect(rules.every((rule) => rule.signature !== undefined)).toBe(true)
      expect(rules.map((rule) => rule.signature)).toEqual([
        'enterMarkets(address[])',
        'mint()',
        'repayBorrow()',
        'redeemUnderlying(uint256)',
        'mint(uint256)',
        'repayBorrow(uint256)',
        'redeemUnderlying(uint256)',
      ])
      expect(rules.some((rule) => rule.signature?.startsWith('borrow'))).toBe(false)
      const targets = new Set(rules.map((rule) => rule.to))
      expect(targets).toEqual(
        new Set([
          PROTOCOLS[chainId].venus.comptroller,
          PROTOCOLS[chainId].venus.vBNB,
          PROTOCOLS[chainId].venus.vUSDT,
        ]),
      )
    }
  })

  it('denominates default caps in the chain’s 18-decimal stable', () => {
    expect(pancakeGridPolicy(56, { now: NOW }).spend[0]).toEqual({
      token: '0x55d398326f99059fF775485246999027B3197955',
      limitAtomic: 250n * 10n ** 18n,
      decimals: 18,
      period: 'day',
    })
    expect(pancakeGridPolicy(97, { now: NOW }).spend[0]!.token).toBe(
      PROTOCOLS[97].erc8183.paymentToken,
    )
  })

  it('honours overrides', () => {
    const built = pancakeGridPolicy(56, {
      now: NOW,
      ttlSeconds: 3600,
      period: 'hour',
      stableCapAtomic: 10n ** 18n,
      nativeCapWei: 10n ** 17n,
      label: 'Custom',
    })
    expect(built.label).toBe('Custom')
    expect(built.expiresAt).toBe(NOW + 3600)
    expect(built.spend.map((cap) => [cap.period, cap.limitAtomic])).toEqual([
      ['hour', 10n ** 18n],
      ['hour', 10n ** 17n],
    ])
  })
})

describe('describePolicy', () => {
  it('reads as English for a contract-scoped policy', () => {
    expect(describePolicy(pancakeRebalancePolicy(56, { now: NOW }), { now: NOW }))
      .toMatchInlineSnapshot(`
        [
          "Scope: PancakeSwap v3 rebalancing on BNB Smart Chain",
          "Can call: PancakeSwap v3 position manager (0x46A1…4364)",
          "Can call: PancakeSwap v3 swap router (0x1b81…eB14)",
          "Can spend: up to 250 USDT per day",
          "Can spend: up to 0.05 BNB per day (relay fees come out of this too)",
          "Expires: 2025-10-16T08:53:20.000Z (7 days from now)",
          "Cannot: hold your funds, or act on anything outside the list above.",
          "Revocable: one transaction, effective immediately, provable on-chain.",
        ]
      `)
  })

  it('reads as English for a selector-scoped policy', () => {
    expect(describePolicy(venusHealthFactorPolicy(97, { now: NOW }), { now: NOW }))
      .toMatchInlineSnapshot(`
        [
          "Scope: Venus health-factor defence on BNB Smart Chain Testnet",
          "Can call: Enter Venus markets (0x94d1…b77D), only \`enterMarkets(address[])\`",
          "Can call: Supply BNB collateral (0x2E72…e62c), only \`mint()\`",
          "Can call: Repay BNB debt (0x2E72…e62c), only \`repayBorrow()\`",
          "Can call: Withdraw supplied BNB (0x2E72…e62c), only \`redeemUnderlying(uint256)\`",
          "Can call: Supply USDT collateral (0xb752…441A), only \`mint(uint256)\`",
          "Can call: Repay USDT debt (0xb752…441A), only \`repayBorrow(uint256)\`",
          "Can call: Withdraw supplied USDT (0xb752…441A), only \`redeemUnderlying(uint256)\`",
          "Can spend: up to 250 $U per day",
          "Can spend: up to 0.05 BNB per day (relay fees come out of this too)",
          "Expires: 2025-10-16T08:53:20.000Z (7 days from now)",
          "Cannot: hold your funds, or act on anything outside the list above.",
          "Revocable: one transaction, effective immediately, provable on-chain.",
        ]
      `)
  })

  it('says so plainly when a policy bounds nothing', () => {
    expect(
      describePolicy({ label: 'Wide open', calls: [], spend: [], expiresAt: NOW + 3600 }, {
        now: NOW,
      }),
    ).toMatchInlineSnapshot(`
      [
        "Scope: Wide open",
        "Can call: any contract — this policy sets no allowlist.",
        "Can spend: unbounded — this policy sets no cap.",
        "Expires: 2025-10-09T09:53:20.000Z (1 hour from now)",
        "Cannot: hold your funds. Everything else is only bounded by the caps above.",
        "Revocable: one transaction, effective immediately, provable on-chain.",
      ]
    `)
  })
})
