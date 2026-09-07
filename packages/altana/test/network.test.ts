import {
  BNB,
  BNB_TESTNET,
  ERC8183_ADDRESSES,
  JOB_STATUS,
  PERMIT2_ADDRESS,
} from '@altananetwork/sdk'
import { describe, expect, it } from 'vitest'

import {
  ALTANA_CHAIN_IDS,
  EXPECTED_ALTANA_DEPLOYMENT,
  getAltanaNetwork,
  isAltanaChainId,
  txExplorerUrl,
} from '../src/network.js'
import { UnsupportedChainError } from '../src/errors.js'
import { PROTOCOLS } from '../src/addresses.js'

/**
 * Drift guard.
 *
 * Every address below was read out of the installed SDK and confirmed against
 * a live chain. If a version bump moves one of them, this suite fails loudly
 * here instead of turning every Keystore verification into a silent `false`
 * somewhere in the product.
 */
describe('SDK constants have not drifted', () => {
  it('BNB mainnet config matches what we built against', () => {
    expect(BNB.chainId).toBe(56)
    expect(BNB.keyStore).toBe(EXPECTED_ALTANA_DEPLOYMENT[56].keyStore)
    expect(BNB.keyStoreController).toBe(EXPECTED_ALTANA_DEPLOYMENT[56].keyStoreController)
    expect(BNB.publicRpcUrl).toBe(EXPECTED_ALTANA_DEPLOYMENT[56].publicRpcUrl)
    expect(BNB.explorer).toBe(EXPECTED_ALTANA_DEPLOYMENT[56].explorer)
    expect(BNB.relayUrl).toBe(EXPECTED_ALTANA_DEPLOYMENT[56].relayUrl)
    expect(BNB.chain.id).toBe(56)
  })

  it('BNB testnet config matches what we built against', () => {
    expect(BNB_TESTNET.chainId).toBe(97)
    expect(BNB_TESTNET.keyStore).toBe(EXPECTED_ALTANA_DEPLOYMENT[97].keyStore)
    expect(BNB_TESTNET.keyStoreController).toBe(
      EXPECTED_ALTANA_DEPLOYMENT[97].keyStoreController,
    )
    expect(BNB_TESTNET.publicRpcUrl).toBe(EXPECTED_ALTANA_DEPLOYMENT[97].publicRpcUrl)
    expect(BNB_TESTNET.explorer).toBe(EXPECTED_ALTANA_DEPLOYMENT[97].explorer)
    expect(BNB_TESTNET.relayUrl).toBe(EXPECTED_ALTANA_DEPLOYMENT[97].relayUrl)
    expect(BNB_TESTNET.chain.id).toBe(97)
  })

  it('Permit2 is the canonical cross-chain deployment', () => {
    expect(PERMIT2_ADDRESS).toBe('0x000000000022D473030F116dDEE9F6B43aC78BA3')
  })

  it('ERC-8183 addresses match the deployed stack on 56', () => {
    expect(ERC8183_ADDRESSES[56]).toEqual({
      commerce: '0xEa4DAa3100A767e86FDed867729ae7446476EBA6',
      router: '0x51895229E12F9876011789B04f8698af06cCD6DA',
      policy: '0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5',
      registry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
      paymentToken: '0xcE24439F2D9C6a2289F741120FE202248B666666',
    })
  })

  it('ERC-8183 addresses match the deployed stack on 97', () => {
    expect(ERC8183_ADDRESSES[97]).toEqual({
      commerce: '0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE',
      router: '0xD7d36D66d2F1B608A0F943f722D27e3744f66F25',
      policy: '0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA',
      registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      paymentToken: '0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565',
    })
  })

  it('job status enum keeps its on-chain ordering', () => {
    expect(JOB_STATUS).toEqual([
      'OPEN',
      'FUNDED',
      'SUBMITTED',
      'COMPLETED',
      'REJECTED',
      'EXPIRED',
    ])
  })
})

describe('getAltanaNetwork', () => {
  it('resolves both chains', () => {
    for (const chainId of ALTANA_CHAIN_IDS) {
      const network = getAltanaNetwork(chainId)
      expect(network.chainId).toBe(chainId)
      expect(network.nativeSymbol).toBe(chainId === 56 ? 'BNB' : 'tBNB')
      expect(network.relayUrl).toMatch(/^https:\/\//)
    }
  })

  it('marks 97 as the testnet and points it at the testnet Keystore explorer', () => {
    expect(getAltanaNetwork(97).isTestnet).toBe(true)
    expect(getAltanaNetwork(97).keystoreExplorer).toBe('https://testnet.altana.network')
    expect(getAltanaNetwork(56).isTestnet).toBe(false)
    expect(getAltanaNetwork(56).keystoreExplorer).toBe('https://explorer.altana.network')
  })

  it('rejects a chain we have no deployment for', () => {
    expect(() => getAltanaNetwork(1)).toThrow(UnsupportedChainError)
    expect(isAltanaChainId(1)).toBe(false)
  })

  it('builds explorer links without a double slash', () => {
    expect(txExplorerUrl(56, '0xabc')).toBe('https://bscscan.com/tx/0xabc')
    expect(txExplorerUrl(97, '0xabc')).toBe('https://testnet.bscscan.com/tx/0xabc')
  })
})

describe('protocol address book', () => {
  it('takes the ERC-8183 stack straight from the SDK', () => {
    expect(PROTOCOLS[56].erc8183).toEqual(ERC8183_ADDRESSES[56])
    expect(PROTOCOLS[97].erc8183).toEqual(ERC8183_ADDRESSES[97])
  })

  it('defaults the testnet stable to $U and the mainnet stable to USDT', () => {
    expect(PROTOCOLS[97].defaultStable).toBe(ERC8183_ADDRESSES[97]!.paymentToken)
    expect(PROTOCOLS[56].defaultStable).toBe('0x55d398326f99059fF775485246999027B3197955')
  })

  it('has no Aave pool on testnet', () => {
    expect(PROTOCOLS[56].aave.pool).toBe('0x6807dc923806fE8Fd134338EABCA509979a7e0cB')
    expect(PROTOCOLS[97].aave.pool).toBeUndefined()
  })
})
