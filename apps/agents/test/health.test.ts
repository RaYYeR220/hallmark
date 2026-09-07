import { describe, expect, it } from 'vitest'
import { toFunctionSelector, type Address } from 'viem'
import { getChain } from '@hallmark/core'
import { buildPolicy } from '@hallmark/altana'

import { analyseHealth } from '../src/agents/health/analyse.js'
import { actHealth } from '../src/agents/health/act.js'
import {
  buildRepayCall,
  buildSupplyCall,
  liquidationPriceFor,
  planRepay,
  supplyApyFromRatePerBlock,
  BSC_BLOCKS_PER_YEAR,
  LEGACY_COMPOUND_BLOCKS_PER_YEAR,
  type VenusAccount,
} from '../src/chain/venus.js'
import { readChainlinkPrice } from '../src/chain/prices.js'
import {
  emptyChain,
  fakeClient,
  fakeSession,
  providerFor,
  readKey,
  testContext,
  type FakeChain,
} from './support/fixtures.js'

/**
 * The liquidation guard.
 *
 * Two claims are under test, and they are different in kind.
 *
 * The *behavioural* one: this agent refuses to act on a price it cannot
 * trust — stale, wrongly scaled, or disagreeing with the protocol's own
 * oracle — and refuses on a health factor its two derivations disagree about.
 *
 * The *structural* one: even if the code above were replaced, the session key
 * it runs under has no `borrow` in its allowlist. That is covered in
 * refusals.test.ts; the vBNB/ERC-20 signature split is covered here, because
 * getting it wrong is how a repay reverts on the one market that matters most.
 */

const chain = getChain(56)
const NOW = 1_780_000_000
const BORROWER: Address = '0x000000000000000000000000000000000000b055'
const ORACLE: Address = '0x0000000000000000000000000000000000004321'

describe('the vBNB repay signature split', () => {
  it('uses repayBorrow() payable for vBNB and repayBorrow(uint256) elsewhere', () => {
    const native = buildRepayCall({ vToken: chain.defi.venusVBnb, isNative: true, amount: 5n, symbol: 'BNB' })
    const erc20 = buildRepayCall({ vToken: chain.defi.venusVUsdt, isNative: false, amount: 5n, symbol: 'USDT' })

    expect(native.signature).toBe('repayBorrow()')
    expect(erc20.signature).toBe('repayBorrow(uint256)')

    // Measured selectors. Getting these the wrong way round reverts on-chain.
    expect(native.data).toBe('0x4e4d9fea')
    expect(erc20.data.slice(0, 10)).toBe('0x0e752702')
    expect(toFunctionSelector('repayBorrow()')).toBe('0x4e4d9fea')
    expect(toFunctionSelector('repayBorrow(uint256)')).toBe('0x0e752702')
  })

  it('puts the amount in msg.value for vBNB and in calldata for an ERC-20 market', () => {
    const native = buildRepayCall({ vToken: chain.defi.venusVBnb, isNative: true, amount: 777n, symbol: 'BNB' })
    const erc20 = buildRepayCall({ vToken: chain.defi.venusVUsdt, isNative: false, amount: 777n, symbol: 'USDT' })

    expect(native.value).toBe(777n)
    expect(native.data).toHaveLength(10) // selector only: no arguments at all
    expect(erc20.value).toBe(0n)
    expect(BigInt(`0x${erc20.data.slice(10)}`)).toBe(777n)
  })

  it('splits mint() the same way, for the same reason', () => {
    const native = buildSupplyCall({ vToken: chain.defi.venusVBnb, isNative: true, amount: 1n, symbol: 'BNB' })
    const erc20 = buildSupplyCall({ vToken: chain.defi.venusVUsdt, isNative: false, amount: 1n, symbol: 'USDT' })
    expect(native.signature).toBe('mint()')
    expect(erc20.signature).toBe('mint(uint256)')
    expect(native.value).toBe(1n)
    expect(erc20.value).toBe(0n)
  })

  it('is the split the policy allowlist expects, market by market', () => {
    const policy = buildPolicy('venus-health-factor', 56, { now: NOW })
    const forVBnb = policy.calls.filter((rule) => rule.to?.toLowerCase() === chain.defi.venusVBnb.toLowerCase())
    const forVUsdt = policy.calls.filter((rule) => rule.to?.toLowerCase() === chain.defi.venusVUsdt.toLowerCase())

    expect(forVBnb.map((rule) => rule.signature)).toContain('repayBorrow()')
    expect(forVBnb.map((rule) => rule.signature)).not.toContain('repayBorrow(uint256)')
    expect(forVUsdt.map((rule) => rule.signature)).toContain('repayBorrow(uint256)')
    expect(forVUsdt.map((rule) => rule.signature)).not.toContain('repayBorrow()')
  })
})

// ---------------------------------------------------------------------------
// Fixture chain state
// ---------------------------------------------------------------------------

type PositionFixture = {
  /** Chainlink answer, 8 decimals. */
  bnbAnswer?: bigint
  bnbUpdatedAt?: number
  bnbDecimals?: number
  /** Venus oracle mantissa for BNB, 1e18 for an 18-decimal underlying. */
  venusBnbMantissa?: bigint
  suppliedBnb?: bigint
  borrowedUsdt?: bigint
  liquidityUsd?: bigint
  shortfallUsd?: bigint
}

function venusChain(fixture: PositionFixture = {}): FakeChain {
  const bnbAnswer = fixture.bnbAnswer ?? 700_00000000n // $700.00
  const venusBnb = fixture.venusBnbMantissa ?? 700n * 10n ** 18n
  const supplied = fixture.suppliedBnb ?? 100n * 10n ** 18n
  const borrowed = fixture.borrowedUsdt ?? 40_000n * 10n ** 18n

  // exchangeRateStored is scaled so `vBalance * rate / 1e18` is the underlying.
  const exchangeRate = 2n * 10n ** 26n
  const vBalance = (supplied * 10n ** 18n) / exchangeRate

  const collateralUsd = (Number(supplied) / 1e18) * (Number(venusBnb) / 1e18) * 0.8
  const borrowUsd = Number(borrowed) / 1e18
  const net = collateralUsd - borrowUsd

  const reads: Record<string, unknown> = {
    [readKey(chain.defi.venusComptroller, 'getAssetsIn', [BORROWER])]: [
      chain.defi.venusVBnb,
      chain.defi.venusVUsdt,
    ],
    [readKey(chain.defi.venusComptroller, 'oracle')]: ORACLE,
    [readKey(chain.defi.venusComptroller, 'getAccountLiquidity', [BORROWER])]: [
      0n,
      fixture.liquidityUsd ?? (net > 0 ? BigInt(Math.round(net * 1e18)) : 0n),
      fixture.shortfallUsd ?? (net < 0 ? BigInt(Math.round(-net * 1e18)) : 0n),
    ],
    [readKey(chain.defi.venusComptroller, 'markets', [chain.defi.venusVBnb])]: [true, 8n * 10n ** 17n, true],
    [readKey(chain.defi.venusComptroller, 'markets', [chain.defi.venusVUsdt])]: [true, 8n * 10n ** 17n, true],

    [readKey(chain.defi.venusVBnb, 'balanceOf', [BORROWER])]: vBalance,
    [readKey(chain.defi.venusVBnb, 'borrowBalanceStored', [BORROWER])]: 0n,
    [readKey(chain.defi.venusVBnb, 'exchangeRateStored')]: exchangeRate,
    [readKey(chain.defi.venusVBnb, 'supplyRatePerBlock')]: 401_551_845n,
    [readKey(chain.defi.venusVBnb, 'symbol')]: 'vBNB',
    [readKey(ORACLE, 'getUnderlyingPrice', [chain.defi.venusVBnb])]: venusBnb,

    [readKey(chain.defi.venusVUsdt, 'balanceOf', [BORROWER])]: 0n,
    [readKey(chain.defi.venusVUsdt, 'borrowBalanceStored', [BORROWER])]: borrowed,
    [readKey(chain.defi.venusVUsdt, 'exchangeRateStored')]: exchangeRate,
    [readKey(chain.defi.venusVUsdt, 'supplyRatePerBlock')]: 401_551_845n,
    [readKey(chain.defi.venusVUsdt, 'symbol')]: 'vUSDT',
    [readKey(chain.defi.venusVUsdt, 'underlying')]: '0x55d398326f99059fF775485246999027B3197955',
    [readKey('0x55d398326f99059fF775485246999027B3197955', 'symbol')]: 'USDT',
    [readKey('0x55d398326f99059fF775485246999027B3197955', 'decimals')]: 18,
    [readKey(ORACLE, 'getUnderlyingPrice', [chain.defi.venusVUsdt])]: 10n ** 18n,

    [readKey(chain.chainlink.bnbUsd, 'latestRoundData')]: [
      1n,
      bnbAnswer,
      BigInt(fixture.bnbUpdatedAt ?? NOW - 20),
      BigInt(fixture.bnbUpdatedAt ?? NOW - 20),
      1n,
    ],
    [readKey(chain.chainlink.bnbUsd, 'decimals')]: fixture.bnbDecimals ?? 8,
  }

  return emptyChain({ reads, blockNumber: 41_000_000n })
}

async function analyse(fixture: PositionFixture = {}, input: Record<string, unknown> = {}) {
  const ctx = testContext({ client: fakeClient(venusChain(fixture)), now: NOW })
  return analyseHealth({ borrower: BORROWER, ...input }, ctx, { deep: false })
}

describe('health analysis against fixture chain state', () => {
  it('computes health from the markets and reconciles it against getAccountLiquidity', async () => {
    const result = await analyse()
    if ('error' in result) throw new Error(result.detail)

    // 100 BNB at $700, 80% collateral factor = $56,000 adjusted against
    // $40,000 borrowed.
    expect(result.decision.healthFactor).toBeCloseTo(1.4, 6)
    expect(result.decision.totals.adjustedCollateralUsd).toBeCloseTo(56_000, 3)
    expect(result.decision.totals.borrowedUsd).toBeCloseTo(40_000, 3)
    const netCheck = result.decision.checks.find((check) => check.label === 'Account net liquidity')
    expect(netCheck?.agrees).toBe(true)
    expect(result.decision.checksPass).toBe(true)
  })

  it('holds above the trigger and says how far the liquidation price is', async () => {
    const result = await analyse()
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.action).toBe('hold')
    expect(result.decision.liquidation.ok).toBe(true)
    if (!result.decision.liquidation.ok) throw new Error('unreachable')
    // HF = 1 at 40000 / (100 * 0.8) = $500.
    expect(result.decision.liquidation.liquidationPriceUsd).toBeCloseTo(500, 6)
    expect(result.decision.liquidation.direction).toBe('fall')
    expect(result.decision.liquidation.moveToLiquidationPct).toBeCloseTo(-28.571, 2)
  })

  it('repays once health crosses the trigger, sized to hit the target exactly', async () => {
    // $560 per BNB: adjusted collateral $44,800 against $40,000 → HF 1.12.
    const result = await analyse({
      bnbAnswer: 560_00000000n,
      venusBnbMantissa: 560n * 10n ** 18n,
    })
    if ('error' in result) throw new Error(result.detail)

    expect(result.decision.healthFactor).toBeCloseTo(1.12, 6)
    expect(result.decision.action).toBe('repay')
    expect(result.decision.urgency).toBe('now')
    expect(result.decision.repay?.ok).toBe(true)
    if (!result.decision.repay?.ok) throw new Error('unreachable')
    // repay = borrows − adjustedCollateral / target = 40000 − 44800/1.6 = 12000.
    expect(result.decision.repay.repayUsd).toBeCloseTo(12_000, 0)
    expect(result.decision.repay.projectedHealthFactor).toBeCloseTo(1.6, 3)
    expect(result.decision.repay.market.underlyingSymbol).toBe('USDT')
  })

  it('reports a position already in shortfall as liquidatable', async () => {
    const result = await analyse({
      bnbAnswer: 400_00000000n,
      venusBnbMantissa: 400n * 10n ** 18n,
    })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.liquidatable).toBe(true)
    expect(result.decision.urgency).toBe('liquidatable')
    expect(result.decision.totals.shortfallUsd).toBeGreaterThan(0)
  })

  it('rejects a target at or below the trigger, which would loop forever', async () => {
    const result = await analyse({}, { triggerHealthFactor: 1.5, targetHealthFactor: 1.4 })
    expect('error' in result).toBe(true)
    if (!('error' in result)) throw new Error('unreachable')
    expect(result.error).toBe('invalid-thresholds')
  })
})

describe('fail closed', () => {
  it('refuses on a stale Chainlink answer', async () => {
    const result = await analyse({ bnbUpdatedAt: NOW - 7_200 })
    if ('error' in result) throw new Error(result.detail)

    expect(result.decision.action).toBe('refuse')
    expect(result.decision.failClosed?.reason).toBe('stale-price')
    expect(result.decision.failClosed?.detail).toContain('past the')
    expect(result.decision.feeds[0]!.ok).toBe(false)
  })

  it('acts on the same position with a fresh answer — the negative control', async () => {
    const result = await analyse({ bnbUpdatedAt: NOW - 30, bnbAnswer: 560_00000000n, venusBnbMantissa: 560n * 10n ** 18n })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.failClosed).toBeNull()
    expect(result.decision.action).toBe('repay')
  })

  it('refuses a feed that reports the wrong decimals — the SVR trap', async () => {
    // Some BNB Chain pairs publish a second 18-decimal aggregator at a
    // different address. Reading one as the standard feed is 10^10 out, and
    // the number still looks like a number.
    const result = await analyse({ bnbDecimals: 18 })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.action).toBe('refuse')
    expect(result.decision.failClosed?.reason).toBe('stale-price')
    expect(result.decision.feeds[0]!.detail).toContain('18 decimals, not 8')
    expect(result.decision.feeds[0]!.detail).toContain('SVR')
  })

  it('refuses when Chainlink and the Venus oracle disagree beyond tolerance', async () => {
    // Chainlink says $700; Venus says $560. One of them is wrong and we cannot
    // tell which, so nothing is sent.
    const result = await analyse({ bnbAnswer: 700_00000000n, venusBnbMantissa: 560n * 10n ** 18n })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.action).toBe('refuse')
    expect(result.decision.checksPass).toBe(false)
    const priceCheck = result.decision.checks.find((check) => check.label === 'BNB price')
    expect(priceCheck?.agrees).toBe(false)
    expect(priceCheck!.deviationBps).toBeGreaterThan(200)
  })

  it('accepts a small disagreement, so the check is not vacuous', async () => {
    // A 0.5% gap is ordinary between two oracles; 200 bps is the bound.
    const result = await analyse({ bnbAnswer: 703_00000000n, venusBnbMantissa: 700n * 10n ** 18n })
    if ('error' in result) throw new Error(result.detail)
    const priceCheck = result.decision.checks.find((check) => check.label === 'BNB price')
    expect(priceCheck?.agrees).toBe(true)
    expect(result.decision.failClosed).toBeNull()
  })

  it('refuses when the feed read itself fails', async () => {
    const state = venusChain()
    delete state.reads[readKey(chain.chainlink.bnbUsd, 'latestRoundData')]
    const ctx = testContext({ client: fakeClient(state), now: NOW })
    const result = await analyseHealth({ borrower: BORROWER }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.failClosed?.reason).toBe('read-failed')
    expect(result.decision.action).toBe('refuse')
  })

  it('act returns the evidence rather than a transaction when the feed is stale', async () => {
    const ctx = testContext({
      client: fakeClient(venusChain({ bnbUpdatedAt: NOW - 7_200 })),
      now: NOW,
      sessions: providerFor({
        session: fakeSession(),
        policy: buildPolicy('venus-health-factor', 56, { now: NOW }),
        chainId: 56,
      }),
      executor: async () => {
        throw new Error('act must not reach the executor on a stale feed')
      },
    })
    const result = await actHealth({ borrower: BORROWER, intentId: 'stale-1' }, ctx)
    expect(result.status).toBe('aborted')
    if (result.status !== 'aborted') throw new Error('unreachable')
    expect(result.reason).toBe('stale-price')
    expect(result.evidence['feeds']).toBeTruthy()
  })
})

describe('venus arithmetic', () => {
  const account: VenusAccount = {
    borrower: BORROWER,
    chainId: 56,
    comptroller: chain.defi.venusComptroller,
    oracle: ORACLE,
    markets: [
      {
        vToken: chain.defi.venusVBnb,
        vTokenSymbol: 'vBNB',
        isNative: true,
        underlying: null,
        underlyingSymbol: 'BNB',
        underlyingDecimals: 18,
        collateralFactor: 0.8,
        supplyUnderlying: 10n * 10n ** 18n,
        borrowUnderlying: 0n,
        priceMantissa: 700n * 10n ** 18n,
        priceUsd: 700,
        supplyUsd: 7_000,
        borrowUsd: 0,
        supplyRatePerBlock: 0n,
      },
      {
        vToken: chain.defi.venusVUsdt,
        vTokenSymbol: 'vUSDT',
        isNative: false,
        underlying: '0x55d398326f99059fF775485246999027B3197955',
        underlyingSymbol: 'USDT',
        underlyingDecimals: 18,
        collateralFactor: 0.8,
        supplyUnderlying: 0n,
        borrowUnderlying: 4_000n * 10n ** 18n,
        priceMantissa: 10n ** 18n,
        priceUsd: 1,
        supplyUsd: 0,
        borrowUsd: 4_000,
        supplyRatePerBlock: 0n,
      },
    ],
    totalSupplyUsd: 7_000,
    totalBorrowUsd: 4_000,
    adjustedCollateralUsd: 5_600,
    healthFactor: 1.4,
    liquidityUsd: 1_600,
    shortfallUsd: 0,
    liquidatable: false,
    blockNumber: 1n,
  }

  it('solves the liquidation price for the collateral asset', () => {
    const result = liquidationPriceFor(account, chain.defi.venusVBnb)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // 4000 / (10 × 0.8) = $500.
    expect(result.liquidationPriceUsd).toBeCloseTo(500, 8)
    expect(result.direction).toBe('fall')
  })

  it('inverts the direction when the volatile asset is borrowed, not supplied', () => {
    const inverted: VenusAccount = {
      ...account,
      markets: [
        { ...account.markets[0]!, supplyUnderlying: 0n, supplyUsd: 0, borrowUnderlying: 5n * 10n ** 18n, borrowUsd: 3_500 },
        { ...account.markets[1]!, supplyUnderlying: 10_000n * 10n ** 18n, supplyUsd: 10_000, borrowUnderlying: 0n, borrowUsd: 0 },
      ],
      totalSupplyUsd: 10_000,
      totalBorrowUsd: 3_500,
      adjustedCollateralUsd: 8_000,
      healthFactor: 8_000 / 3_500,
    }
    const result = liquidationPriceFor(inverted, chain.defi.venusVBnb)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // Borrowing BNB liquidates on a rise: 8000 / 5 = $1,600.
    expect(result.liquidationPriceUsd).toBeCloseTo(1_600, 6)
    expect(result.direction).toBe('rise')
  })

  it('declines to invent a price when exposure nets to zero', () => {
    const flat: VenusAccount = {
      ...account,
      markets: [
        { ...account.markets[0]!, borrowUnderlying: 8n * 10n ** 18n, borrowUsd: 5_600 },
        account.markets[1]!,
      ],
    }
    const result = liquidationPriceFor(flat, chain.defi.venusVBnb)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.detail).toContain('nets to zero')
  })

  it('caps a repay by the wallet balance and says which bound bit', () => {
    const plan = planRepay({
      account,
      vToken: chain.defi.venusVUsdt,
      targetHealthFactor: 4,
      walletBalance: 100n * 10n ** 18n,
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error('unreachable')
    expect(plan.cappedBy).toBe('wallet-balance')
    expect(plan.repayUnderlying).toBe(100n * 10n ** 18n)
  })

  it('caps a repay by what that market actually owes', () => {
    // Debt split across two markets: the plan cannot repay more USDT than the
    // USDT market is owed, however much the target asks for.
    const split: VenusAccount = {
      ...account,
      markets: [
        { ...account.markets[0]!, borrowUnderlying: 4n * 10n ** 18n, borrowUsd: 2_800 },
        { ...account.markets[1]!, borrowUnderlying: 1_200n * 10n ** 18n, borrowUsd: 1_200 },
      ],
      totalBorrowUsd: 4_000,
    }
    const plan = planRepay({ account: split, vToken: chain.defi.venusVUsdt, targetHealthFactor: 10 })
    expect(plan.ok).toBe(true)
    if (!plan.ok) throw new Error('unreachable')
    expect(plan.cappedBy).toBe('outstanding-debt')
    expect(plan.repayUnderlying).toBe(1_200n * 10n ** 18n)
  })

  it('declines to repay a position already above target', () => {
    const plan = planRepay({ account, vToken: chain.defi.venusVUsdt, targetHealthFactor: 1.2 })
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('unreachable')
    expect(plan.reason).toBe('already-healthy')
  })

  it('annualises a per-block rate against the real BNB Chain block time', () => {
    // About 0.45 seconds a block, measured live.
    expect(BSC_BLOCKS_PER_YEAR).toBe(70_080_000)
    expect(LEGACY_COMPOUND_BLOCKS_PER_YEAR).toBe(10_512_000)

    // A live vUSDT read. At the real block time this lands where DeFiLlama
    // independently puts the same market; at the constant every Compound fork
    // copies it is 42 basis points, which no stablecoin market pays.
    const real = supplyApyFromRatePerBlock(401_837_851n)
    const legacy = supplyApyFromRatePerBlock(401_837_851n, LEGACY_COMPOUND_BLOCKS_PER_YEAR)
    expect(real).toBeGreaterThan(2)
    expect(real).toBeLessThan(4)
    expect(legacy).toBeLessThan(1)
    expect(real).toBeGreaterThan(legacy)
  })
})

describe('chainlink reads', () => {
  it('accepts a fresh eight-decimal answer', async () => {
    const read = await readChainlinkPrice({
      client: fakeClient(venusChain()),
      chainId: 56,
      pair: 'bnbUsd',
      now: NOW,
    })
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('unreachable')
    expect(read.priceUsd).toBeCloseTo(700, 8)
    expect(read.decimals).toBe(8)
  })

  it('rejects an answer from an incomplete round', async () => {
    const state = venusChain()
    state.reads[readKey(chain.chainlink.bnbUsd, 'latestRoundData')] = [
      9n,
      700_00000000n,
      BigInt(NOW - 10),
      BigInt(NOW - 10),
      4n, // answeredInRound behind roundId
    ]
    const read = await readChainlinkPrice({ client: fakeClient(state), chainId: 56, pair: 'bnbUsd', now: NOW })
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error('unreachable')
    expect(read.reason).toBe('incomplete-round')
  })

  it('rejects a non-positive answer', async () => {
    const state = venusChain()
    state.reads[readKey(chain.chainlink.bnbUsd, 'latestRoundData')] = [1n, 0n, BigInt(NOW), BigInt(NOW), 1n]
    const read = await readChainlinkPrice({ client: fakeClient(state), chainId: 56, pair: 'bnbUsd', now: NOW })
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error('unreachable')
    expect(read.reason).toBe('non-positive')
  })

  it('rejects an answer timestamped well into the future', async () => {
    const state = venusChain()
    state.reads[readKey(chain.chainlink.bnbUsd, 'latestRoundData')] = [
      1n,
      700_00000000n,
      BigInt(NOW + 3_600),
      BigInt(NOW + 3_600),
      1n,
    ]
    const read = await readChainlinkPrice({ client: fakeClient(state), chainId: 56, pair: 'bnbUsd', now: NOW })
    expect(read.ok).toBe(false)
    if (read.ok) throw new Error('unreachable')
    expect(read.detail).toContain('in the future')
  })
})
