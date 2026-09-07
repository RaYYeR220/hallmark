import { describe, expect, it } from 'vitest'

import { CHAINS, SUPPORTED_CHAIN_IDS, addressUrl, caip10, getChain, isSupportedChainId, txUrl } from '../src/chains.js'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

describe('CHAINS', () => {
  it('covers exactly BSC mainnet and testnet', () => {
    expect(SUPPORTED_CHAIN_IDS).toEqual([56, 97])
    expect(Object.keys(CHAINS).map(Number).sort((a, b) => a - b)).toEqual([56, 97])
  })

  it('lines the viem chain up with the key', () => {
    expect(CHAINS[56].chain.id).toBe(56)
    expect(CHAINS[97].chain.id).toBe(97)
    expect(CHAINS[56].testnet).toBe(false)
    expect(CHAINS[97].testnet).toBe(true)
  })

  it('holds well-formed addresses everywhere', () => {
    for (const id of SUPPORTED_CHAIN_IDS) {
      const chain = CHAINS[id]
      for (const [name, value] of Object.entries(chain.contracts)) {
        if (value === null) continue
        expect(value, `${id}.contracts.${name}`).toMatch(ADDRESS)
      }
      for (const [name, value] of Object.entries(chain.chainlink)) {
        expect(value, `${id}.chainlink.${name}`).toMatch(ADDRESS)
      }
      for (const [name, value] of Object.entries(chain.defi)) {
        if (value === null) continue
        expect(value, `${id}.defi.${name}`).toMatch(ADDRESS)
      }
    }
  })

  it('carries the $U faucet only where one exists', () => {
    expect(CHAINS[56].contracts.uTokenFaucet).toBeNull()
    expect(CHAINS[97].contracts.uTokenFaucet).toBe('0x86e9197CC0F76E4e4aaa7082180945196bBAb5D3')
  })

  it('models the missing Aave deployment on testnet as null', () => {
    expect(CHAINS[56].defi.aavePool).not.toBeNull()
    expect(CHAINS[56].defi.aaveDataProvider).not.toBeNull()
    expect(CHAINS[97].defi.aavePool).toBeNull()
    expect(CHAINS[97].defi.aaveDataProvider).toBeNull()
  })

  it('shares the contracts that are deployed at the same address on both chains', () => {
    expect(CHAINS[56].defi.multicall3).toBe(CHAINS[97].defi.multicall3)
    expect(CHAINS[56].defi.pancakeV3Factory).toBe(CHAINS[97].defi.pancakeV3Factory)
    expect(CHAINS[56].defi.pancakeV3SwapRouter).toBe(CHAINS[97].defi.pancakeV3SwapRouter)
  })

  it('keeps the ERC-8004 registries distinct per chain', () => {
    expect(CHAINS[56].contracts.identityRegistry).not.toBe(CHAINS[97].contracts.identityRegistry)
    expect(CHAINS[56].contracts.identityRegistry.toLowerCase()).toMatch(/^0x8004a1/)
    expect(CHAINS[97].contracts.identityRegistry.toLowerCase()).toMatch(/^0x8004a8/)
  })

  it('points at https endpoints', () => {
    for (const id of SUPPORTED_CHAIN_IDS) {
      const chain = CHAINS[id]
      for (const url of [chain.rpcUrl, chain.explorer, chain.altanaRelay, chain.altanaExplorer]) {
        expect(url.startsWith('https://')).toBe(true)
        expect(url.endsWith('/')).toBe(false)
      }
    }
  })
})

describe('getChain', () => {
  it('returns the right entry', () => {
    expect(getChain(56).name).toBe('BNB Smart Chain')
    expect(getChain(97).id).toBe(97)
  })

  it('throws on anything else', () => {
    expect(() => getChain(1)).toThrow(/Unsupported chain id 1/)
    expect(() => getChain(0)).toThrow()
    expect(() => getChain(8453)).toThrow(/56, 97/)
  })
})

describe('helpers', () => {
  it('narrows chain ids', () => {
    expect(isSupportedChainId(56)).toBe(true)
    expect(isSupportedChainId(97)).toBe(true)
    expect(isSupportedChainId(1)).toBe(false)
  })

  it('builds explorer links', () => {
    expect(txUrl(56, '0xabc')).toBe('https://bscscan.com/tx/0xabc')
    expect(addressUrl(97, '0xdef')).toBe('https://testnet.bscscan.com/address/0xdef')
  })

  it('builds CAIP-10 ids the way registration files do', () => {
    expect(caip10(56, CHAINS[56].contracts.identityRegistry)).toBe(
      'eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
    )
  })
})
