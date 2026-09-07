import type { AgentWalletClient, ReceiptWaiter } from '../clients.js'

export type CliIO = {
  out(line: string): void
  err(line: string): void
}

export type Flags = {
  json: boolean
  help: boolean
  version: boolean
  force: boolean
  offline: boolean
  broadcast: boolean
  dryRun: boolean
  /** `--no-dedupe` turns this off. */
  dedupe: boolean
  requestValidation: boolean | null
  config: string | undefined
  chain: string | undefined
  agentId: string | undefined
  rpcUrl: string | undefined
  from: string | undefined
  timeoutMs: number | undefined
}

export type Overrides = {
  walletClient?: AgentWalletClient
  publicClient?: ReceiptWaiter
  /** Injected in tests so no real key, chain or network is involved. */
  fetchImpl?: typeof fetch
}

export type Ctx = {
  command: string
  positionals: string[]
  flags: Flags
  cwd: string
  env: Record<string, string | undefined>
  io: CliIO
  overrides: Overrides
}

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
} as const
