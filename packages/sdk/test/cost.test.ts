import { describe, expect, it } from 'vitest'

import {
  COLD_GAS_PER_URI_BYTE,
  MEASURED_REGISTRATION,
  REGISTER_FIXED_GAS,
  estimateRegistrationCost,
  fetchGasParams,
  registerGas,
  setUriGas,
} from '../src/cost.js'
import { buildRegistrationFile } from '../src/registration.js'
import { validConfig } from './fixtures.js'

describe('the gas model', () => {
  it('reproduces the measured 891,730 gas at the measured card size', () => {
    expect(registerGas(MEASURED_REGISTRATION.uriBytes)).toBe(MEASURED_REGISTRATION.gas)
  })

  it('derives its fixed cost from the measurement rather than assuming one', () => {
    expect(REGISTER_FIXED_GAS + BigInt(MEASURED_REGISTRATION.uriBytes) * COLD_GAS_PER_URI_BYTE).toBe(
      MEASURED_REGISTRATION.gas,
    )
  })

  it('is monotonic in card size', () => {
    expect(registerGas(2048)).toBeGreaterThan(registerGas(1024))
    expect(registerGas(1025) - registerGas(1024)).toBe(COLD_GAS_PER_URI_BYTE)
  })

  it('charges a rewrite far less than a first write', () => {
    expect(setUriGas(1024, 1024)).toBeLessThan(registerGas(1024))
  })

  it('charges growth in a rewrite at the cold rate', () => {
    const flat = setUriGas(1024, 1024)
    const grown = setUriGas(1024, 1056)
    expect(grown - flat).toBe(32n * COLD_GAS_PER_URI_BYTE)
  })
})

describe('estimateRegistrationCost', () => {
  const file = buildRegistrationFile(validConfig({ chain: 'bsc' }))

  it('prices both phases and totals them', () => {
    const estimate = estimateRegistrationCost(file, 56)
    expect(estimate.total.gas).toBe(estimate.register.gas + estimate.setAgentURI.gas)
    expect(estimate.uriBytes).toBeGreaterThan(0)
    expect(estimate.finalUriBytes).toBeGreaterThan(estimate.uriBytes)
  })

  it('reproduces the ~$0.024 figure at the measured gas, 0.05 gwei and $540 BNB', () => {
    const measured = (Number(MEASURED_REGISTRATION.gas) * 0.05e9 * 540) / 1e18
    expect(measured).toBeGreaterThan(0.023)
    expect(measured).toBeLessThan(0.025)
  })

  it('uses live inputs when given them', () => {
    const cheap = estimateRegistrationCost(file, 56, { gasPriceWei: 50_000_000n, nativeUsd: 500 })
    const dear = estimateRegistrationCost(file, 56, { gasPriceWei: 3_000_000_000n, nativeUsd: 500 })
    expect(dear.total.usd).toBeGreaterThan(cheap.total.usd)
    expect(cheap.priceSource).toBe('override')
  })

  it('flags that its numbers are defaults when nothing live was supplied', () => {
    const estimate = estimateRegistrationCost(file, 56)
    expect(estimate.priceSource).toBe('default')
    expect(estimate.notes.join(' ')).toMatch(/defaults/)
  })

  it('flags testnet USD as notional', () => {
    const testnet = buildRegistrationFile(validConfig())
    expect(estimateRegistrationCost(testnet, 97).notes.join(' ')).toMatch(/no market value/)
  })

  it('refuses an unsupported chain', () => {
    expect(() => estimateRegistrationCost(file, 1)).toThrow(/Unsupported chain/)
  })
})

describe('fetchGasParams', () => {
  it('uses live reads when both succeed', async () => {
    const params = await fetchGasParams(56, {
      getGasPrice: async () => 123_456_789n,
      readContract: async ({ functionName }) =>
        functionName === 'decimals' ? 8 : [1n, 61_234_567_890n, 0n, 0n, 1n],
    })
    expect(params.gasPriceWei).toBe(123_456_789n)
    expect(params.nativeUsd).toBeCloseTo(612.3456789, 6)
    expect(params.source).toBe('live')
  })

  it('falls back to the documented defaults when the reads fail', async () => {
    const params = await fetchGasParams(56, {
      getGasPrice: async () => {
        throw new Error('rpc down')
      },
      readContract: async () => {
        throw new Error('feed down')
      },
    })
    expect(params.source).toBe('default')
    expect(params.gasPriceWei).toBe(50_000_000n)
  })

  it('ignores a non-positive oracle answer instead of pricing gas at zero', async () => {
    const params = await fetchGasParams(56, {
      getGasPrice: async () => 1n,
      readContract: async ({ functionName }) => (functionName === 'decimals' ? 8 : [1n, 0n, 0n, 0n, 1n]),
    })
    expect(params.nativeUsd).toBe(540)
  })
})
