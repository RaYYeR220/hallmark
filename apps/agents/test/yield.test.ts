import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { getChain } from '@hallmark/core'
import { buildPolicy } from '@hallmark/altana'

import { analyseYield } from '../src/agents/yield/analyse.js'
import { actYield } from '../src/agents/yield/act.js'
import { poolsForAsset, resetYieldCaches, type LlamaPool } from '../src/chain/yields.js'
import { supplyApyFromRatePerBlock } from '../src/chain/venus.js'
import {
  emptyChain,
  fakeClient,
  fakeSession,
  providerFor,
  readKey,
  testContext,
  type FakeChain,
} from './support/fixtures.js'

const chain = getChain(56)
const NOW = 1_780_000_000
const USDT: Address = '0x55d398326f99059fF775485246999027B3197955'
const ORACLE: Address = '0x0000000000000000000000000000000000004321'

function llamaResponse(pools: Array<Partial<LlamaPool> & { project: string; symbol: string }>) {
  return {
    status: 'success',
    data: pools.map((pool) => ({
      chain: 'BSC',
      tvlUsd: 5_000_000,
      apy: 5,
      apyBase: 5,
      apyReward: 0,
      stablecoin: true,
      ilRisk: 'no',
      exposure: 'single',
      pool: `${pool.project}-${pool.symbol}`,
      ...pool,
    })),
  }
}

function fetchReturning(payload: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

const FAILING_FETCH = (async () => {
  throw new Error('network disabled in this test')
}) as unknown as typeof fetch

type VenusFixture = {
  supplyRatePerBlock?: bigint
  totalSuppliedUnderlying?: bigint
  cash?: bigint
  borrows?: bigint
}

function venusChain(fixture: VenusFixture = {}): FakeChain {
  const exchangeRate = 2n * 10n ** 26n
  const supplied = fixture.totalSuppliedUnderlying ?? 195_000_000n * 10n ** 18n
  const vSupply = (supplied * 10n ** 18n) / exchangeRate

  return emptyChain({
    reads: {
      [readKey(chain.defi.venusComptroller, 'getAllMarkets')]: [chain.defi.venusVUsdt],
      [readKey(chain.defi.venusComptroller, 'oracle')]: ORACLE,
      [readKey(chain.defi.venusComptroller, 'markets', [chain.defi.venusVUsdt])]: [true, 8n * 10n ** 17n, true],
      [readKey(chain.defi.venusVUsdt, 'underlying')]: USDT,
      [readKey(USDT, 'symbol')]: 'USDT',
      [readKey(USDT, 'decimals')]: 18,
      [readKey(chain.defi.venusVUsdt, 'totalSupply')]: vSupply,
      [readKey(chain.defi.venusVUsdt, 'exchangeRateStored')]: exchangeRate,
      // DeFiLlama would report this figure as "TVL"; it is available
      // liquidity, roughly a third of what depositors have supplied.
      [readKey(chain.defi.venusVUsdt, 'getCash')]: fixture.cash ?? 61_600_000n * 10n ** 18n,
      [readKey(chain.defi.venusVUsdt, 'totalBorrows')]: fixture.borrows ?? 130_000_000n * 10n ** 18n,
      [readKey(chain.defi.venusVUsdt, 'supplyRatePerBlock')]: fixture.supplyRatePerBlock ?? 401_551_845n,
      [readKey(chain.defi.venusVUsdt, 'symbol')]: 'vUSDT',
      [readKey(ORACLE, 'getUnderlyingPrice', [chain.defi.venusVUsdt])]: 10n ** 18n,
      [readKey(chain.chainlink.bnbUsd, 'latestRoundData')]: [1n, 700_00000000n, BigInt(NOW - 10), BigInt(NOW - 10), 1n],
      [readKey(chain.chainlink.bnbUsd, 'decimals')]: 8,
    },
    blockNumber: 41_000_000n,
    gasPrice: 1_000_000_000n,
  })
}

describe('pool matching', () => {
  it('matches an asset inside a symbol pair, not just an exact symbol', () => {
    const pools = [
      { symbol: 'USDT', project: 'venus-core-pool' },
      { symbol: 'WBNB-USDT', project: 'pancakeswap-amm-v3' },
      { symbol: 'CAKE', project: 'pancakeswap' },
    ] as LlamaPool[]
    expect(poolsForAsset(pools, 'USDT').map((pool) => pool.symbol)).toEqual(['USDT', 'WBNB-USDT'])
    expect(poolsForAsset(pools, 'usdt')).toHaveLength(2)
    expect(poolsForAsset(pools, 'BTC')).toHaveLength(0)
  })
})

describe('yield analysis', () => {
  it('reads depth on-chain and says how it differs from DeFiLlama TVL', async () => {
    resetYieldCaches()
    const ctx = testContext({
      client: fakeClient(venusChain()),
      now: NOW,
      fetchImpl: fetchReturning(
        llamaResponse([{ project: 'venus-core-pool', symbol: 'USDT', tvlUsd: 61_600_000, apyBase: 4.2, apy: 4.2 }]),
      ),
    })
    const result = await analyseYield({ asset: 'USDT', amount: '5000' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)

    const venus = result.decision.venues.find((venue) => venue.project === 'venus-core-pool')!
    expect(venus.depthSource).toBe('onchain')
    // Deposits are read from totalSupply × exchangeRate, not from Llama's TVL.
    expect(venus.depositsUsd).toBeCloseTo(195_000_000, -4)
    expect(venus.availableLiquidityUsd).toBeCloseTo(61_600_000, -4)
    expect(venus.caveats.join(' ')).toContain('available liquidity')
  })

  it('reconciles the on-chain rate against DeFiLlama and passes when they agree', async () => {
    resetYieldCaches()
    const onchainApy = supplyApyFromRatePerBlock(401_551_845n)
    const ctx = testContext({
      client: fakeClient(venusChain()),
      now: NOW,
      fetchImpl: fetchReturning(
        llamaResponse([
          { project: 'venus-core-pool', symbol: 'USDT', apyBase: onchainApy, apy: onchainApy },
        ]),
      ),
    })
    const result = await analyseYield({ asset: 'USDT', amount: '5000' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    const check = result.decision.checks.find((entry) => entry.label.includes('supply APY'))!
    expect(check.agrees).toBe(true)
    expect(result.decision.checksPass).toBe(true)
  })

  it('fails the reconciliation when the two sources disagree wildly', async () => {
    resetYieldCaches()
    const ctx = testContext({
      client: fakeClient(venusChain()),
      now: NOW,
      fetchImpl: fetchReturning(
        // On-chain says a few percent; Llama here says 90%.
        llamaResponse([{ project: 'venus-core-pool', symbol: 'USDT', apyBase: 90, apy: 90 }]),
      ),
    })
    const result = await analyseYield({ asset: 'USDT', amount: '5000' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.checksPass).toBe(false)
    expect(result.warnings.join(' ')).toContain('bps apart')
  })

  it('excludes impermanent-loss venues unless asked, and flags them when included', async () => {
    resetYieldCaches()
    const pools = llamaResponse([
      { project: 'venus-core-pool', symbol: 'USDT', apyBase: 4, apy: 4 },
      { project: 'pancakeswap-amm-v3', symbol: 'WBNB-USDT', apy: 40, apyBase: 40, ilRisk: 'yes', tvlUsd: 20_000_000 },
    ])

    const excluded = await analyseYield(
      { asset: 'USDT', amount: '5000' },
      testContext({ client: fakeClient(venusChain()), now: NOW, fetchImpl: fetchReturning(pools) }),
      { deep: false },
    )
    if ('error' in excluded) throw new Error(excluded.detail)
    expect(excluded.decision.venues.map((venue) => venue.project)).not.toContain('pancakeswap-amm-v3')

    resetYieldCaches()
    const included = await analyseYield(
      { asset: 'USDT', amount: '5000', includeIlRisk: true },
      testContext({ client: fakeClient(venusChain()), now: NOW, fetchImpl: fetchReturning(pools) }),
      { deep: false },
    )
    if ('error' in included) throw new Error(included.detail)
    const lp = included.decision.venues.find((venue) => venue.project === 'pancakeswap-amm-v3')!
    expect(lp.caveats.join(' ')).toContain('impermanent-loss risk')
    expect(included.decision.risks.join(' ')).toContain('fee income, not')
  })

  it('drops venues below the depth floor', async () => {
    resetYieldCaches()
    const ctx = testContext({
      client: fakeClient(venusChain()),
      now: NOW,
      fetchImpl: fetchReturning(
        llamaResponse([
          { project: 'venus-core-pool', symbol: 'USDT', apyBase: 4, apy: 4 },
          { project: 'tiny-farm', symbol: 'USDT', apy: 900, tvlUsd: 12_000 },
        ]),
      ),
    })
    const result = await analyseYield({ asset: 'USDT', amount: '5000', minTvlUsd: 1_000_000 }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.venues.map((venue) => venue.project)).not.toContain('tiny-farm')
  })

  it('refuses to believe an implausible APY even from a deep venue', async () => {
    resetYieldCaches()
    const ctx = testContext({
      client: fakeClient(venusChain()),
      now: NOW,
      fetchImpl: fetchReturning(
        llamaResponse([
          { project: 'venus-core-pool', symbol: 'USDT', apyBase: 4, apy: 4 },
          { project: 'suspicious', symbol: 'USDT', apy: 99_000, tvlUsd: 9_000_000 },
        ]),
      ),
    })
    const result = await analyseYield({ asset: 'USDT', amount: '5000' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.checksPass).toBe(false)
    expect(
      result.decision.assertions.find((check) => check.label === 'Every quoted APY is plausible')!.holds,
    ).toBe(false)
  })

  it('still answers on-chain when DeFiLlama is unreachable', async () => {
    resetYieldCaches()
    const ctx = testContext({ client: fakeClient(venusChain()), now: NOW, fetchImpl: FAILING_FETCH })
    const result = await analyseYield({ asset: 'USDT', amount: '5000' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(result.warnings.join(' ')).toContain('DeFiLlama unavailable')
    expect(result.decision.venues).toHaveLength(1)
    expect(result.decision.venues[0]!.depthSource).toBe('onchain')
  })

  it('warns when the allocation would be a large share of the venue', async () => {
    resetYieldCaches()
    const ctx = testContext({
      client: fakeClient(venusChain({ totalSuppliedUnderlying: 10_000n * 10n ** 18n })),
      now: NOW,
      fetchImpl: FAILING_FETCH,
    })
    const result = await analyseYield({ asset: 'USDT', amount: '5000' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.best!.shareOfDepositsPct).toBeCloseTo(50, 0)
    expect(result.decision.risks.join(' ')).toContain('of the venue')
  })

  it('prices the move and reports the payback period', async () => {
    resetYieldCaches()
    const ctx = testContext({ client: fakeClient(venusChain()), now: NOW, fetchImpl: FAILING_FETCH })
    const result = await analyseYield({ asset: 'USDT', amount: '5000' }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(Number(result.decision.moveCost.gas)).toBe(615_000)
    expect(result.decision.moveCost.gasCostUsd).toBeGreaterThan(0)
    // Best and current are the same venue here, so there is no delta to earn.
    expect(result.decision.breakEven.apyDeltaPct).toBe(0)
    expect(result.decision.breakEven.detail).toContain('not better than the current one')
  })
})

describe('yield act', () => {
  it('declines to move when the best venue is where the capital already is', async () => {
    resetYieldCaches()
    const ctx = testContext({
      client: fakeClient(venusChain()),
      now: NOW,
      fetchImpl: FAILING_FETCH,
      agentSlug: 'yield',
      binding: { category: 'yield-routing', rationale: 'test' },
    })
    const result = await actYield({ asset: 'USDT', amount: '5000', intentId: 'y-1' }, ctx)
    expect(result.status).toBe('aborted')
    if (result.status !== 'aborted') throw new Error('unreachable')
    expect(result.reason).toBe('nothing-to-do')
  })

  it('refuses to substitute a venue its key cannot reach', async () => {
    resetYieldCaches()
    const ctx = testContext({
      client: fakeClient(venusChain()),
      now: NOW,
      fetchImpl: fetchReturning(
        llamaResponse([
          // Matched to the on-chain rate, so the reconciliation passes and the
          // test is about the allowlist rather than about the rate check.
          {
            project: 'venus-core-pool',
            symbol: 'USDT',
            apyBase: supplyApyFromRatePerBlock(401_551_845n),
            apy: supplyApyFromRatePerBlock(401_551_845n),
          },
          { project: 'somewhere-else', symbol: 'USDT', apy: 12, tvlUsd: 40_000_000 },
        ]),
      ),
      agentSlug: 'yield',
      binding: { category: 'yield-routing', rationale: 'test' },
      sessions: providerFor({
        session: fakeSession(),
        policy: buildPolicy('yield-routing', 56, { now: NOW }),
        chainId: 56,
      }),
    })
    const result = await actYield({ asset: 'USDT', amount: '5000', intentId: 'y-2' }, ctx)
    expect(result.status).toBe('aborted')
    if (result.status !== 'aborted') throw new Error('unreachable')
    expect(result.reason).toBe('not-authorised')
    expect(result.detail).toContain('will not quietly route somewhere else')
  })
})
