/**
 * `hallmark-probe` — the operator surface.
 *
 * Everything here is read-only and offline-safe by default. `sweep`, `probe`,
 * `stats` and `serve` never touch a key; `publish` prints a plan and refuses to
 * sign anything without `--commit`. Every subcommand takes `--json` so the
 * output can be piped somewhere that is not a terminal.
 */

import { parseArgs } from 'node:util'

import { ScanClient, isSupportedChainId, scoreProbe } from '@hallmark/core'
import type { SupportedChainId } from '@hallmark/core'

import { loadConfig } from './config.ts'
import type { ProberConfig } from './config.ts'
import { createLogger } from './log.ts'
import type { Logger } from './log.ts'
import { createProbeContext, probeAgent, sweep } from './probe/index.ts'
import { createFileStore, toRunRecord } from './store.ts'
import type { EvidenceStore, RunRecord } from './store.ts'
import { computeStats, formatStats } from './stats.ts'
import { selectAgents } from './select.ts'
import { canonicalBundleJson } from './evidence.ts'
import { createPublisher, formatPlan, FEEDBACK_TAGS } from './publish.ts'
import type { FeedbackTag } from './publish.ts'
import type { ProbeRun, PublishOutcome } from './types.ts'
import { formatEther } from 'viem'

const USAGE = `hallmark-probe — ERC-8004 liveness prober for BNB Smart Chain

usage
  hallmark-probe sweep    [--chain 56|97] [--sample N | --recent N | --from A --to B | --agent 1,2,3]
                          [--seed S] [--concurrency C] [--max-id N] [--timeout MS] [--json]
  hallmark-probe probe    --agent <id> [--chain 56|97] [--json]
  hallmark-probe publish  [--chain 56|97] [--commit] [--budget-wei N] [--min-score N]
                          [--agent <id>] [--limit N] [--kind reputation|hook|validation|all]
                          [--tag reachable|uptime|responsetime] [--as 0x<sender>] [--json]
  hallmark-probe verify   <0x-evidence-hash | https://…/api/evidence/0x…> [--chain 56|97] [--json]
  hallmark-probe stats    [--chain 56|97] [--json]
  hallmark-probe serve    [--port N]

verify exit codes
  0  the document hashes to its own name and an on-chain record carries that hash
  1  the document does not match its hash, or is not canonical
  2  the document could not be fetched
  3  the document is sound but no ERC-8004 record references it yet

global
  --store <dir>     where evidence and run records live (default $STORE_DIR or ./data)
  --no-store        keep everything in memory; nothing is written to disk
  --verbose         debug logging on stderr
  --quiet           errors only
  --json            machine-readable output on stdout

Nothing is written on chain without --commit. Probes are GET-only, refuse
private hosts, and never send credentials.`

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0]
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }

  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    strict: false,
    options: {
      chain: { type: 'string' },
      agent: { type: 'string' },
      sample: { type: 'string' },
      recent: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      seed: { type: 'string' },
      concurrency: { type: 'string' },
      'max-id': { type: 'string' },
      timeout: { type: 'string' },
      limit: { type: 'string' },
      kind: { type: 'string' },
      tag: { type: 'string' },
      'min-score': { type: 'string' },
      'budget-wei': { type: 'string' },
      'gas-price-wei': { type: 'string' },
      'request-hash': { type: 'string' },
      hash: { type: 'string' },
      as: { type: 'string' },
      store: { type: 'string' },
      port: { type: 'string' },
      commit: { type: 'boolean' },
      json: { type: 'boolean' },
      verbose: { type: 'boolean' },
      quiet: { type: 'boolean' },
      'no-store': { type: 'boolean' },
      'no-dns': { type: 'boolean' },
    },
  })

  const json = values['json'] === true
  const logger = createLogger({
    level: values['quiet'] === true ? 'error' : values['verbose'] === true ? 'debug' : 'info',
    json,
  })

  const config = buildConfig(values, logger)
  const store = await openStore(config, values['no-store'] === true)

  switch (command) {
    case 'sweep':
      return runSweep({ values, config, store, logger, json })
    case 'probe':
      return runProbe({ values, config, store, logger, json })
    case 'publish':
      return runPublish({ values, config, store, logger, json })
    case 'verify':
      return runVerify({ values, config, store, logger, json, positionals })
    case 'stats':
      return runStats({ values, store, json })
    case 'serve':
      return runServe({ config, store, logger })
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}\n`)
      return 2
  }
}

/* ------------------------------------------------------------------ */
/* subcommands                                                         */
/* ------------------------------------------------------------------ */

type Values = Record<string, unknown>

type CommandDeps = {
  values: Values
  config: ProberConfig
  store: EvidenceStore
  logger: Logger
  json: boolean
}

async function runSweep(deps: CommandDeps): Promise<number> {
  const { values, config, store, logger, json } = deps
  const chainId = chainOf(values)
  const ctx = createProbeContext({ config, chainId, logger })
  const scan = new ScanClient(config.scanApiKey === null ? {} : { apiKey: config.scanApiKey })

  const selection = await selectAgents({
    reader: ctx.reader,
    chainId,
    scan,
    ...optionalNumber(values, 'sample', 'sample'),
    ...optionalNumber(values, 'recent', 'recent'),
    ...optionalNumber(values, 'from', 'from'),
    ...optionalNumber(values, 'to', 'to'),
    ...optionalNumber(values, 'max-id', 'maxId'),
    ...(typeof values['seed'] === 'string' ? { seed: values['seed'] } : {}),
    ...(values['agent'] === undefined ? {} : { agentIds: parseIdList(String(values['agent'])) }),
  })

  if (selection.agentIds.length === 0) {
    logger.error('nothing selected', { strategy: selection.strategy, ceiling: selection.ceiling })
    return 1
  }

  logger.info('sweep starting', {
    chain: chainId,
    strategy: selection.strategy,
    agents: selection.agentIds.length,
    ceiling: selection.ceiling,
    seed: selection.seed ?? '-',
    concurrency: config.probe.concurrency,
  })

  const startedAt = Date.now()
  const records: RunRecord[] = []
  let lastTick = 0

  await sweep(ctx, selection.agentIds, {
    onResult: async (run, done, total) => {
      records.push(await store.putRun(run))
      const now = Date.now()
      if (now - lastTick > 2_000 || done === total) {
        lastTick = now
        const rate = done / Math.max(1, (now - startedAt) / 1000)
        logger.info('progress', {
          done: `${done}/${total}`,
          reachable: records.filter((r) => r.okCount > 0).length,
          rate: `${rate.toFixed(1)}/s`,
        })
      }
    },
  })

  const stats = computeStats(records)
  const elapsedMs = Date.now() - startedAt

  if (json) {
    process.stdout.write(`${JSON.stringify({ chainId, selection, elapsedMs, stats }, null, 2)}\n`)
  } else {
    process.stdout.write(
      `\nsweep  chain ${chainId}  ${selection.strategy}${selection.seed === null ? '' : ` seed="${selection.seed}"`}  ceiling ${selection.ceiling}  ${(elapsedMs / 1000).toFixed(1)}s\n\n`,
    )
    process.stdout.write(`${formatStats(stats)}\n`)
  }
  return 0
}

async function runProbe(deps: CommandDeps): Promise<number> {
  const { values, config, store, logger, json } = deps
  const chainId = chainOf(values)
  const agentId = Number(values['agent'])
  if (!Number.isInteger(agentId) || agentId <= 0) {
    process.stderr.write('probe needs --agent <id>\n')
    return 2
  }

  const ctx = createProbeContext({ config, chainId, logger })
  const run = await probeAgent(ctx, agentId)
  await store.putRun(run)

  if (json) {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`)
    return 0
  }

  process.stdout.write(`${formatRun(run)}\n`)
  return 0
}

async function runPublish(deps: CommandDeps): Promise<number> {
  const { values, config, store, logger, json } = deps
  const chainId = chainOf(values)
  const commit = values['commit'] === true
  const kind = String(values['kind'] ?? 'all')
  const minScore = values['min-score'] === undefined ? 1 : Number(values['min-score'])
  const limit = values['limit'] === undefined ? 25 : Number(values['limit'])
  const tag = tagOf(values['tag'])

  const budgetOverride = values['budget-wei'] === undefined ? undefined : BigInt(String(values['budget-wei']))
  const publisher = createPublisher({
    chainId,
    logger,
    store,
    dryRun: !commit,
    minScore,
    feedbackTag: tag,
    ...(values['gas-price-wei'] === undefined ? {} : { gasPriceWei: BigInt(String(values['gas-price-wei'])) }),
    ...(values['as'] === undefined ? {} : { plannerAddress: asAddress(values['as']) }),
    config: {
      ...config,
      budget: {
        perRunWei: budgetOverride ?? config.budget.perRunWei,
        totalWei: budgetOverride ?? config.budget.totalWei,
      },
    },
  })

  const candidates = await pickPublishCandidates(store, chainId, values, minScore, limit)
  if (candidates.length === 0) {
    logger.error('nothing to publish', { chain: chainId, hint: 'run a sweep first, or lower --min-score' })
    return 1
  }

  logger.info(commit ? 'publishing' : 'dry run', {
    chain: chainId,
    agents: candidates.length,
    kinds: kind,
    attestor: publisher.attestor ?? '(unset)',
    validator: publisher.validator ?? '(unset)',
    tag,
  })

  const outcomes: PublishOutcome[] = []
  for (const record of candidates) {
    if (kind === 'all' || kind === 'reputation') outcomes.push(await publisher.publishReputation(record))
    if (kind === 'all' || kind === 'hook') outcomes.push(await publisher.recordProbeOnHook(record))
    if (kind === 'all' || kind === 'validation') {
      const requestHash = values['request-hash'] === undefined ? undefined : (String(values['request-hash']) as `0x${string}`)
      outcomes.push(await publisher.publishValidation(record, requestHash))
    }
  }

  const budget = publisher.budget()
  const planned = outcomes
    .filter((o) => o.status === 'dry-run')
    .reduce((total, o) => total + BigInt(o.plan.costWei), 0n)

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          chainId,
          commit,
          minScore,
          tag,
          outcomes,
          budget: {
            perRunWei: budget.perRunWei.toString(),
            totalWei: budget.totalWei.toString(),
            spentThisRunWei: budget.spentThisRunWei.toString(),
            spentAllTimeWei: budget.spentAllTimeWei.toString(),
          },
          plannedCostWei: planned.toString(),
        },
        null,
        2,
      )}\n`,
    )
    return 0
  }

  process.stdout.write(`\n${commit ? 'PUBLISH' : 'DRY RUN — nothing is signed'}  chain ${chainId}\n\n`)
  for (const outcome of outcomes) {
    process.stdout.write(`${formatPlan(outcome.plan)}\n`)
    switch (outcome.status) {
      case 'dry-run':
        process.stdout.write('  would send\n\n')
        break
      case 'skipped':
        process.stdout.write(`  SKIPPED   ${outcome.reason}\n\n`)
        break
      case 'sent':
        process.stdout.write(
          `  sent      ${outcome.txHash}  gas ${outcome.gasUsed}  verified=${outcome.verified}  ${outcome.verification}\n\n`,
        )
        break
      case 'failed':
        process.stdout.write(`  FAILED    ${outcome.reason}\n\n`)
        break
    }
  }

  const sent = outcomes.filter((o) => o.status === 'sent').length
  const skipped = outcomes.filter((o) => o.status === 'skipped').length
  const failed = outcomes.filter((o) => o.status === 'failed').length
  const wouldSend = outcomes.filter((o) => o.status === 'dry-run').length

  process.stdout.write(
    `summary  would-send ${wouldSend}  sent ${sent}  skipped ${skipped}  failed ${failed}\n` +
      `budget   planned ${planned} wei (${formatEther(planned)} BNB)   spent-this-run ${budget.spentThisRunWei} wei   ceiling ${budget.perRunWei} wei (${formatEther(budget.perRunWei)} BNB)\n`,
  )
  if (!commit && wouldSend > 0) {
    process.stdout.write('\nre-run with --commit to sign and send these transactions.\n')
  }
  return failed > 0 ? 1 : 0
}

async function runVerify(deps: CommandDeps & { positionals: string[] }): Promise<number> {
  const { values, config, store, logger, json, positionals } = deps
  const target = positionals[0] ?? (values['hash'] === undefined ? undefined : String(values['hash']))
  if (target === undefined) {
    process.stderr.write('verify needs an evidence hash or a URL\n')
    return 2
  }

  const chainId = chainOf(values)
  const { createRegistryReader } = await import('@hallmark/core')
  const { verifyEvidence, formatVerifyReport, exitCodeFor } = await import('./verify.ts')
  const reader = createRegistryReader(chainId, { rpcUrl: config.rpcUrls[chainId] })

  const report = await verifyEvidence(target, {
    chainId,
    reader,
    store,
    evidenceBaseUrl: config.evidenceBaseUrl,
    ...(config.scanApiKey === null ? {} : { scan: new ScanClient({ apiKey: config.scanApiKey }) }),
  })

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatVerifyReport(report)}\n`)
  }
  if (report.verdict !== 'ok') logger.warn('verification did not fully pass', { verdict: report.verdict })
  return exitCodeFor(report.verdict)
}

async function runStats(deps: { values: Values; store: EvidenceStore; json: boolean }): Promise<number> {
  const raw = deps.values['chain']
  const chainId = raw === undefined ? undefined : Number(raw)
  const records = await deps.store.listLatest(chainId)
  const stats = computeStats(records)
  process.stdout.write(deps.json ? `${JSON.stringify(stats, null, 2)}\n` : `${formatStats(stats)}\n`)
  return 0
}

async function runServe(deps: { config: ProberConfig; store: EvidenceStore; logger: Logger }): Promise<number> {
  const { createServer } = await import('./server.ts')
  const { serve } = await import('@hono/node-server')
  const app = createServer({ config: deps.config, store: deps.store, logger: deps.logger })
  serve({ fetch: app.fetch, port: deps.config.port }, (info) => {
    deps.logger.info('listening', { port: info.port, evidenceBaseUrl: deps.config.evidenceBaseUrl })
  })
  // `serve` keeps the loop alive; resolve only when the process is torn down.
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve())
    process.once('SIGTERM', () => resolve())
  })
  return 0
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function buildConfig(values: Values, logger: Logger): ProberConfig {
  const overrides: Parameters<typeof loadConfig>[0] = { probe: {} }
  if (typeof values['store'] === 'string') overrides.storeDir = values['store']
  if (values['concurrency'] !== undefined) overrides.probe = { ...overrides.probe, concurrency: Number(values['concurrency']) }
  if (values['timeout'] !== undefined) overrides.probe = { ...overrides.probe, timeoutMs: Number(values['timeout']) }
  if (values['port'] !== undefined) overrides.port = Number(values['port'])
  if (values['no-dns'] === true) {
    logger.warn('DNS checks disabled; a public hostname pointing at private space will not be caught')
    overrides.probe = { ...overrides.probe, checkDns: false }
  }
  return loadConfig(overrides)
}

async function openStore(config: ProberConfig, memoryOnly: boolean): Promise<EvidenceStore> {
  if (memoryOnly) {
    const { createMemoryStore } = await import('./store.ts')
    return createMemoryStore()
  }
  return createFileStore(config.storeDir)
}

function chainOf(values: Values): SupportedChainId {
  const raw = values['chain'] === undefined ? 97 : Number(values['chain'])
  if (!isSupportedChainId(raw)) {
    throw new Error(`--chain must be 56 or 97, got "${String(values['chain'])}"`)
  }
  return raw
}

/** `--as` plans a dry run against a real sender without holding that sender's key. */
function asAddress(value: unknown): `0x${string}` {
  const raw = String(value ?? '')
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error(`--as must be a 20-byte address, got "${raw}"`)
  return raw as `0x${string}`
}

function tagOf(value: unknown): FeedbackTag {
  const raw = String(value ?? 'reachable')
  if ((FEEDBACK_TAGS as readonly string[]).includes(raw)) return raw as FeedbackTag
  throw new Error(`--tag must be one of ${FEEDBACK_TAGS.join(', ')}`)
}

function optionalNumber(values: Values, key: string, as: string): Record<string, number> {
  const raw = values[key]
  if (raw === undefined) return {}
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`)
  return { [as]: Math.trunc(parsed) }
}

function parseIdList(raw: string): number[] {
  return raw
    .split(/[,\s]+/)
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isInteger(id) && id > 0)
}

async function pickPublishCandidates(
  store: EvidenceStore,
  chainId: number,
  values: Values,
  minScore: number,
  limit: number,
): Promise<RunRecord[]> {
  if (values['agent'] !== undefined) {
    const ids = parseIdList(String(values['agent']))
    const found: RunRecord[] = []
    for (const id of ids) {
      const record = await store.getLatest(chainId, id)
      if (record !== null) found.push(record)
    }
    return found
  }

  const all = await store.listLatest(chainId)
  return all
    .filter((record) => record.score >= minScore)
    .sort((a, b) => b.score - a.score || a.agentId - b.agentId)
    .slice(0, Math.max(0, limit))
}

function formatRun(run: ProbeRun): string {
  const bundle = run.bundle
  const lines: string[] = []
  lines.push(`agent ${run.agentId} on chain ${run.chainId}`)
  lines.push(`  name        ${bundle.agent.name ?? '(none)'}`)
  lines.push(`  owner       ${bundle.agent.owner ?? '(unregistered)'}`)
  lines.push(`  card        ${bundle.agent.tokenUriKind}${bundle.agent.cardError === null ? '' : ` — ${bundle.agent.cardError}`}`)
  if (bundle.agent.cardWarnings.length > 0) {
    for (const warning of bundle.agent.cardWarnings.slice(0, 8)) lines.push(`              ! ${warning}`)
  }
  lines.push(`  observed    block ${bundle.observed.blockNumber} at ${new Date(bundle.observed.blockTimestamp * 1000).toISOString()}`)
  lines.push('')
  lines.push(`  endpoints (${bundle.probe.length})`)
  if (bundle.probe.length === 0) lines.push('    (the registration file declares none)')
  for (const probe of bundle.probe) {
    const verdict = probe.ok ? (probe.protocolOk ? 'ok' : 'reachable, off-protocol') : (probe.failure ?? 'failed')
    lines.push(`    [${probe.kind}] ${probe.endpoint}`)
    lines.push(
      `        ${verdict}  ${probe.httpStatus ?? '-'}  ${probe.latencyMs}ms  endpoint-score ${scoreProbe(probe)}${probe.scored ? '' : '  (not scored)'}`,
    )
    if (probe.error !== undefined) lines.push(`        ${probe.error}`)
    for (const request of probe.requests) {
      lines.push(
        `        → ${request.method} ${request.url} ${request.status ?? '-'} ${request.latencyMs}ms ${request.bytes}B${request.failure === null ? '' : ` ${request.failure}`}`,
      )
    }
  }
  lines.push('')
  const caps = bundle.capabilities
  lines.push(`  mcp tools   ${caps.mcpTools === undefined ? '(none)' : caps.mcpTools.join(', ')}`)
  lines.push(`  a2a skills  ${caps.a2aSkills === undefined ? '(none)' : caps.a2aSkills.join(', ')}`)
  lines.push(
    `  x402        ${caps.x402 === null || caps.x402 === undefined ? '(none)' : `v${caps.x402.x402Version} ${caps.x402.scheme} ${caps.x402.priceAtomic} ${caps.x402.asset} on ${caps.x402.network} to ${caps.x402.payTo}`}`,
  )
  lines.push('')
  lines.push(
    `  score       ${run.score}/100  (reachability ${run.breakdown.reachability} + protocol ${run.breakdown.protocol} + latency ${run.breakdown.latency} + capabilities ${run.breakdown.capabilities} + x402 ${run.breakdown.x402})`,
  )
  lines.push(`  scorer      ${bundle.scorer.name} ${bundle.scorer.version}`)
  lines.push(`  evidence    ${run.evidenceHash}`)
  lines.push(`  bytes       ${canonicalBundleJson(bundle).length}`)
  lines.push(`  elapsed     ${run.elapsedMs}ms`)
  return lines.join('\n')
}

// `toRunRecord` is re-exported so `publish` can cost a run that was never stored.
export { toRunRecord }

// `node src/cli.ts …` runs directly; `bin/hallmark-probe.js` calls `main` itself.
const isEntrypoint = process.argv[1] !== undefined && /(^|[\\/])cli\.ts$/.test(process.argv[1])

if (isEntrypoint) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    })
}
