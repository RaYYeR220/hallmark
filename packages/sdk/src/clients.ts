/**
 * The smallest shapes this package needs from a viem client.
 *
 * Typing the parameters structurally rather than as `WalletClient<…>` keeps
 * the public API stable across viem minors, and it means a test can hand in a
 * seven-line fake instead of standing up a chain. `test/viem-compat.test.ts`
 * asserts that a real `createWalletClient` result still satisfies these.
 */

import type { Address, Hex } from './types.js'

export type WriteRequest = {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args?: readonly unknown[] | undefined
  account?: unknown
  chain?: unknown
  gas?: bigint | undefined
}

export type TransactionReceiptLike = {
  status?: 'success' | 'reverted' | string
  blockNumber?: bigint
  gasUsed?: bigint
  transactionHash?: Hex
  logs: ReadonlyArray<{ address: string; topics: readonly string[] }>
}

/** A wallet that can sign and send one contract call. */
export type AgentWalletClient = {
  account?: { address: Address } | undefined | null
  chain?: { id: number } | undefined | null
  writeContract(request: WriteRequest): Promise<Hex>
}

/** A read-only client that can wait for a receipt. */
export type ReceiptWaiter = {
  waitForTransactionReceipt(args: { hash: Hex }): Promise<TransactionReceiptLike>
}

export function accountAddress(client: AgentWalletClient): Address {
  const address = client.account?.address
  if (address === undefined || address === null) {
    throw new Error('the wallet client has no account; create it with `createWalletClient({ account, … })`')
  }
  return address
}
