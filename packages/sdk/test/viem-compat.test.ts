/**
 * The SDK types its wallet and receipt parameters structurally. That is only
 * useful if a real viem client still satisfies them, so this file asserts it —
 * at compile time through the assignments, and at run time through the shapes.
 */

import { createPublicClient, createWalletClient, custom, http } from 'viem'
import { bscTestnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import { accountAddress, type AgentWalletClient, type ReceiptWaiter } from '../src/clients.js'
import type { GasPriceReader } from '../src/cost.js'

// A throwaway key. It signs nothing in this file; it only exists so the client
// has an account and therefore the full `WalletClient` type.
const TEST_KEY = `0x${'11'.repeat(32)}` as const

const failingTransport = custom({
  request: async () => {
    throw new Error('no network in tests')
  },
})

describe('viem compatibility', () => {
  it('accepts a real WalletClient as an AgentWalletClient', () => {
    const wallet = createWalletClient({
      account: privateKeyToAccount(TEST_KEY),
      chain: bscTestnet,
      transport: failingTransport,
    })

    const asAgentWallet: AgentWalletClient = wallet
    expect(accountAddress(asAgentWallet)).toBe(privateKeyToAccount(TEST_KEY).address)
    expect(asAgentWallet.chain?.id).toBe(97)
  })

  it('accepts a real PublicClient as a ReceiptWaiter and a GasPriceReader', () => {
    const client = createPublicClient({ chain: bscTestnet, transport: failingTransport })

    const asWaiter: ReceiptWaiter = client
    const asGasReader: GasPriceReader = client
    expect(typeof asWaiter.waitForTransactionReceipt).toBe('function')
    expect(typeof asGasReader.getGasPrice).toBe('function')
  })

  it('accepts a client built over http() too', () => {
    const client = createPublicClient({ chain: bscTestnet, transport: http('https://example.invalid') })
    const asGasReader: GasPriceReader = client
    expect(typeof asGasReader.readContract).toBe('function')
  })

  it('rejects a wallet with no account rather than signing from nowhere', () => {
    const wallet: AgentWalletClient = { chain: { id: 97 }, writeContract: async () => '0x' }
    expect(() => accountAddress(wallet)).toThrow(/no account/)
  })
})
