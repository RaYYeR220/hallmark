/**
 * Key handling for the CLI.
 *
 * A private key never arrives as a command-line argument: argv is visible in
 * `ps`, lands in shell history and gets scraped into CI logs. Environment or
 * an interactive prompt only, and passing a key-shaped flag is refused with an
 * explanation rather than quietly ignored.
 */

import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'

import { getChain } from '@hallmark/core'
import { createPublicClient, createWalletClient, http } from 'viem'
import type { Account, Chain, PublicClient, Transport, WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { Address, Hex } from '../types.js'

export const PRIVATE_KEY_ENV = 'HALLMARK_PRIVATE_KEY'
export const ADDRESS_ENV = 'HALLMARK_ADDRESS'

const KEY_SHAPED_FLAGS = ['--private-key', '--privatekey', '--key', '--pk', '--secret', '--mnemonic']
const PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/

/** Returns the offending flag if a key was passed on the command line. */
export function keyFlagInArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const name = arg.split('=')[0]?.toLowerCase() ?? ''
    if (KEY_SHAPED_FLAGS.includes(name)) return name
  }
  return null
}

export function normalizePrivateKey(raw: string): Hex {
  const trimmed = raw.trim()
  if (!PRIVATE_KEY.test(trimmed)) {
    throw new Error('not a 32-byte hex private key')
  }
  return (trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as Hex
}

export function privateKeyFromEnv(env: Record<string, string | undefined>): Hex | null {
  const raw = env[PRIVATE_KEY_ENV]
  if (raw === undefined || raw.trim() === '') return null
  return normalizePrivateKey(raw)
}

/** Reads a key from the terminal without echoing it. Rejects when stdin is not a TTY. */
export async function promptPrivateKey(prompt = `${PRIVATE_KEY_ENV} not set. Private key: `): Promise<Hex> {
  if (process.stdin.isTTY !== true) {
    throw new Error(
      `no ${PRIVATE_KEY_ENV} in the environment and stdin is not a terminal, so there is nowhere to ask. ` +
        'Set the environment variable, or run this in an interactive shell.',
    )
  }

  let muted = false
  const output = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      if (!muted) process.stdout.write(chunk)
      callback()
    },
  })

  const rl = createInterface({ input: process.stdin, output, terminal: true })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(prompt, (value) => resolve(value))
      muted = true
    })
    process.stdout.write('\n')
    return normalizePrivateKey(answer)
  } finally {
    rl.close()
  }
}

export type Clients = {
  address: Address
  walletClient: WalletClient<Transport, Chain, Account>
  publicClient: PublicClient<Transport, Chain>
}

export function createClients(privateKey: Hex, chainId: number, rpcUrl?: string): Clients {
  const chain = getChain(chainId)
  const account = privateKeyToAccount(privateKey)
  const transport = http(rpcUrl ?? chain.rpcUrl)
  return {
    address: account.address,
    walletClient: createWalletClient({ account, chain: chain.chain, transport }),
    publicClient: createPublicClient({ chain: chain.chain, transport }),
  }
}

export function createReadClient(chainId: number, rpcUrl?: string): PublicClient<Transport, Chain> {
  const chain = getChain(chainId)
  return createPublicClient({ chain: chain.chain, transport: http(rpcUrl ?? chain.rpcUrl) })
}
