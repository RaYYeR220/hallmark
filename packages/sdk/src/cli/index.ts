/**
 * `hallmark` — the CLI.
 *
 * `runCli` is exported and returns an exit code instead of calling
 * `process.exit`, so the whole surface is testable without spawning a process.
 */

import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

import { AgentConfigError, HallmarkError, formatIssues } from '../errors.js'
import { EXIT, type Ctx, type Flags, type Overrides } from './context.js'
import { cmdDoctor, cmdEstimate, cmdInit, cmdPublish, cmdStatus, cmdValidate } from './commands.js'
import { toJson } from './render.js'
import { keyFlagInArgv } from './wallet.js'

export const CLI_VERSION = '0.1.0'

const USAGE = `hallmark ${CLI_VERSION} — publish an ERC-8004 agent to BNB Chain

Usage
  hallmark <command> [options]

Commands
  init                    write a hallmark.config.ts to the current directory
  validate                schema-check the config; no network
  doctor                  fetch the declared endpoints and report what a validator would see
  estimate                what publishing costs, priced against live gas and BNB/USD
  publish                 publish the agent. Dry run unless --broadcast is passed
  status                  on-chain identity, validation and reputation for an agent

Options
  --json                  machine-readable output
  --config <path>         config file or directory (default: ./hallmark.config.*)
  --chain <name|id>       bsc | bsc-testnet | 56 | 97 (default: the config's chain)
  --agent-id <n>          act on this agent id instead of looking one up
  --from <0x…>            the publishing address, for dry runs and lookups
  --rpc-url <url>         override the chain's default RPC
  --timeout <ms>          per-endpoint timeout for doctor (default 6000)
  --broadcast             publish for real. Without it, publish only prints the plan
  --dry-run               print the plan and stop. This is already the default
  --no-dedupe             mint even if this wallet already owns an agent with this name
  --request-validation    send the ERC-8004 validation request after publishing
  --no-request-validation skip it even though the config asks for it
  --offline               estimate without reading live gas price or BNB/USD
  --force                 overwrite an existing file (init)
  -h, --help              this text
  -v, --version           print the version

Keys
  The private key is read from HALLMARK_PRIVATE_KEY or an interactive prompt.
  It is never read from a command-line argument.
`

type CommandHandler = (ctx: Ctx) => Promise<number>

const COMMANDS: Record<string, CommandHandler> = {
  init: cmdInit,
  validate: cmdValidate,
  doctor: cmdDoctor,
  estimate: cmdEstimate,
  publish: cmdPublish,
  status: cmdStatus,
}

export type RunOptions = Overrides & {
  cwd?: string
  env?: Record<string, string | undefined>
  io?: { out(line: string): void; err(line: string): void }
}

export async function runCli(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const io = options.io ?? {
    out: (line: string) => process.stdout.write(`${line}\n`),
    err: (line: string) => process.stderr.write(`${line}\n`),
  }

  const offending = keyFlagInArgv(argv)
  if (offending !== null) {
    io.err(
      `error: refusing to read a private key from ${offending}. ` +
        'Command-line arguments are visible in the process table and in shell history. ' +
        'Set HALLMARK_PRIVATE_KEY instead, or let the CLI prompt for it.',
    )
    return EXIT.usage
  }

  const { argv: cleaned, negated } = extractNegations(argv)

  let parsed
  try {
    parsed = parseArgs({
      args: [...cleaned],
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        force: { type: 'boolean', default: false },
        offline: { type: 'boolean', default: false },
        broadcast: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'request-validation': { type: 'boolean', default: false },
        config: { type: 'string' },
        chain: { type: 'string' },
        'agent-id': { type: 'string' },
        'rpc-url': { type: 'string' },
        from: { type: 'string' },
        timeout: { type: 'string' },
      },
    })
  } catch (err) {
    io.err(`error: ${err instanceof Error ? err.message : String(err)}`)
    io.err('')
    io.err(USAGE)
    return EXIT.usage
  }

  const values = parsed.values
  if (values.version === true) {
    io.out(CLI_VERSION)
    return EXIT.ok
  }

  const command = parsed.positionals[0]
  if (values.help === true || command === undefined || command === 'help') {
    io.out(USAGE)
    return command === undefined && values.help !== true ? EXIT.usage : EXIT.ok
  }

  const handler = COMMANDS[command]
  if (handler === undefined) {
    io.err(`error: unknown command "${command}"`)
    io.err('')
    io.err(USAGE)
    return EXIT.usage
  }

  if (values.broadcast === true && values['dry-run'] === true) {
    io.err('error: --broadcast and --dry-run contradict each other; pick one')
    return EXIT.usage
  }

  const timeout = values.timeout === undefined ? undefined : Number(values.timeout)
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) {
    io.err('error: --timeout must be a positive number of milliseconds')
    return EXIT.usage
  }

  const flags: Flags = {
    json: values.json === true,
    help: false,
    version: false,
    force: values.force === true,
    offline: values.offline === true,
    broadcast: values.broadcast === true,
    dryRun: values['dry-run'] === true,
    dedupe: !negated.has('dedupe'),
    requestValidation: negated.has('request-validation')
      ? false
      : values['request-validation'] === true
        ? true
        : null,
    config: values.config,
    chain: values.chain,
    agentId: values['agent-id'],
    rpcUrl: values['rpc-url'],
    from: values.from,
    timeoutMs: timeout,
  }

  const ctx: Ctx = {
    command,
    positionals: parsed.positionals.slice(1),
    flags,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    io,
    overrides: {
      ...(options.walletClient === undefined ? {} : { walletClient: options.walletClient }),
      ...(options.publicClient === undefined ? {} : { publicClient: options.publicClient }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    },
  }

  try {
    return await handler(ctx)
  } catch (err) {
    if (err instanceof AgentConfigError) {
      if (flags.json) io.out(toJson({ ok: false, errors: err.issues }))
      else io.err(formatIssues(err.issues))
      return EXIT.failed
    }
    const message = err instanceof Error ? err.message : String(err)
    if (flags.json) io.out(toJson({ ok: false, error: message }))
    else io.err(`error: ${message}`)
    if (!(err instanceof HallmarkError) && !flags.json && process.env['HALLMARK_DEBUG'] === '1') {
      io.err(String(err instanceof Error ? err.stack : ''))
    }
    return EXIT.failed
  }
}

/**
 * Node's `parseArgs` has no notion of `--no-x`, so the negations are lifted out
 * before parsing and handed back as a set.
 */
function extractNegations(argv: readonly string[]): { argv: string[]; negated: Set<string> } {
  const negated = new Set<string>()
  const kept: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('--no-') && !arg.includes('=')) {
      negated.add(arg.slice(5))
      continue
    }
    kept.push(arg)
  }
  return { argv: kept, negated }
}

/** True only when this file is the process entry point, so importing it in a test is inert. */
const isMain = (() => {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
})()

if (isMain) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}
