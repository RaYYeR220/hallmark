/**
 * The six commands. Each one takes a context, writes to it, and returns an
 * exit code; nothing calls `process.exit`, so every command is callable from a
 * test.
 *
 * `publish` is split so that the dry run cannot broadcast even by mistake: it
 * calls `planPublish`, which has no access to a signer.
 */

import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { getChain } from '@hallmark/core'

import { AgentConfigError, ConfigFileError, HallmarkError, formatIssues } from '../errors.js'
import { estimateRegistrationCost, fetchGasParams } from '../cost.js'
import { loadAgentConfig, type LoadedConfig } from '../loadConfig.js'
import { planPublish, publishAgent, scanLookup, type PublishPlan } from '../publish.js'
import { agentUriBytes, buildRegistrationFile, chainIdOf } from '../registration.js'
import { getAgentStatus } from '../status.js'
import { CHAIN_IDS, type AgentConfig, type Address } from '../types.js'
import { verifyAgent, type VerifyReport } from '../verify.js'
import { EXIT, type Ctx } from './context.js'
import { MARK, bullet, bytes, gas, heading, indent, kv, toJson, truncate, usd } from './render.js'
import { CONFIG_TEMPLATE } from './template.js'
import { createClients, createReadClient, privateKeyFromEnv, promptPrivateKey } from './wallet.js'

const PLACEHOLDER_OWNER = '0x0000000000000000000000000000000000000000' as Address

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

export async function cmdInit(ctx: Ctx): Promise<number> {
  const target = join(ctx.cwd, 'hallmark.config.ts')
  if (existsSync(target) && !ctx.flags.force) {
    return fail(ctx, `${target} already exists. Pass --force to overwrite it.`)
  }

  await writeFile(target, CONFIG_TEMPLATE, 'utf8')

  if (ctx.flags.json) {
    ctx.io.out(toJson({ ok: true, created: target }))
    return EXIT.ok
  }

  ctx.io.out(`Wrote ${target}`)
  ctx.io.out('')
  ctx.io.out('Next:')
  ctx.io.out('  1. fill in name, description and your real endpoints')
  ctx.io.out('  2. hallmark validate      schema check, no network')
  ctx.io.out('  3. hallmark doctor        what a validator would see at those endpoints')
  ctx.io.out('  4. hallmark estimate      what publishing costs')
  ctx.io.out('  5. hallmark publish       dry run by default; add --broadcast to send')
  return EXIT.ok
}

/* ------------------------------------------------------------------ */
/* validate                                                            */
/* ------------------------------------------------------------------ */

export async function cmdValidate(ctx: Ctx): Promise<number> {
  const loaded = await load(ctx)
  if ('exitCode' in loaded) return loaded.exitCode

  const { config, path, warnings } = loaded
  const file = buildRegistrationFile(config)
  const uriBytes = agentUriBytes(file)
  const chainId = chainIdOf(config.chain)

  if (ctx.flags.json) {
    ctx.io.out(
      toJson({
        ok: true,
        path,
        chainId,
        card: { uriBytes, services: file.services.length, skills: config.skills.length },
        warnings,
      }),
    )
    return EXIT.ok
  }

  ctx.io.out(`${MARK.ok} ${path} is a valid agent config`)
  ctx.io.out(heading('agent'))
  ctx.io.out(kv('name', config.name))
  ctx.io.out(kv('category', config.category))
  ctx.io.out(kv('chain', `${config.chain} (${chainId})`))
  ctx.io.out(kv('skills', config.skills.map((skill) => skill.id).join(', ')))
  ctx.io.out(kv('pricing', config.pricing === undefined ? 'not declared' : describePricing(config)))
  ctx.io.out(kv('trust', (config.trust ?? []).join(', ') || 'none declared'))
  ctx.io.out(
    kv(
      'validation',
      config.validation === undefined
        ? 'not requested'
        : `will be requested from ${config.validation.requestFrom}`,
    ),
  )
  ctx.io.out(heading('services'))
  for (const service of file.services) {
    ctx.io.out(kv(service.name, service.endpoint, 8))
  }
  ctx.io.out(heading('registration file'))
  ctx.io.out(kv('tokenURI size', bytes(uriBytes)))
  ctx.io.out(kv('type', file.type))

  if (warnings.length > 0) {
    ctx.io.out(heading(`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`))
    for (const warning of warnings) {
      ctx.io.out(bullet(MARK.warn, `${warning.path === '' ? '' : `${warning.path}: `}${warning.message}`))
      if (warning.hint !== undefined) ctx.io.out(indent(warning.hint))
    }
  }
  return EXIT.ok
}

/* ------------------------------------------------------------------ */
/* doctor                                                              */
/* ------------------------------------------------------------------ */

export async function cmdDoctor(ctx: Ctx): Promise<number> {
  let report: VerifyReport
  let label: string

  if (ctx.flags.agentId !== undefined) {
    const chainId = resolveChainId(ctx, undefined)
    if (chainId === null) return fail(ctx, 'checking a published agent needs --chain (bsc or bsc-testnet)')
    report = await verifyAgent({
      agentId: BigInt(ctx.flags.agentId),
      chainId,
      ...probeOptions(ctx),
      ...(ctx.flags.rpcUrl === undefined ? {} : { rpcUrl: ctx.flags.rpcUrl }),
    })
    label = `agent ${ctx.flags.agentId} on chain ${chainId}`
  } else {
    const loaded = await load(ctx)
    if ('exitCode' in loaded) return loaded.exitCode
    report = await verifyAgent({ config: loaded.config, ...probeOptions(ctx) })
    label = `${loaded.config.name} (${loaded.path})`
  }

  if (ctx.flags.json) {
    ctx.io.out(toJson(report))
    return report.verdict === 'ready' ? EXIT.ok : EXIT.failed
  }

  ctx.io.out(`Checking ${label}`)
  ctx.io.out('This is what a validator sees. Nothing is written on-chain.')

  ctx.io.out(heading('endpoints'))
  if (report.endpoints.length === 0) {
    ctx.io.out(bullet(MARK.fail, 'no endpoints to check'))
  }
  for (const check of report.endpoints) {
    const mark = check.status === 'ok' ? MARK.ok : check.status === 'refused' ? MARK.skip : MARK.fail
    ctx.io.out(bullet(mark, `${check.kind.padEnd(5)} ${check.declared}`))
    ctx.io.out(indent(`${check.detail}${check.status === 'ok' ? ` (${check.latencyMs}ms)` : ''}`))
  }

  if (report.cardWarnings.length > 0) {
    ctx.io.out(heading('registration file'))
    for (const warning of report.cardWarnings) ctx.io.out(bullet(MARK.warn, warning))
  }

  if (report.findings.length > 0) {
    ctx.io.out(heading('findings'))
    for (const finding of report.findings) {
      const mark = finding.severity === 'error' ? MARK.fail : finding.severity === 'warning' ? MARK.warn : MARK.info
      ctx.io.out(bullet(mark, finding.message))
      if (finding.hint !== undefined) ctx.io.out(indent(finding.hint))
    }
  }

  ctx.io.out(heading('verdict'))
  ctx.io.out(kv('verdict', report.verdict))
  ctx.io.out(kv('score', `${report.score}/100 (the scorer a Hallmark validator runs)`))
  ctx.io.out(kv('meaning', VERDICT_MEANING[report.verdict]))
  return report.verdict === 'ready' ? EXIT.ok : EXIT.failed
}

const VERDICT_MEANING: Record<VerifyReport['verdict'], string> = {
  ready: 'every declared endpoint answered correctly',
  degraded: 'callable, but at least one declared endpoint is wrong',
  unhireable: 'nothing can call this agent',
}

/* ------------------------------------------------------------------ */
/* estimate                                                            */
/* ------------------------------------------------------------------ */

export async function cmdEstimate(ctx: Ctx): Promise<number> {
  const loaded = await load(ctx)
  if ('exitCode' in loaded) return loaded.exitCode

  const chainId = resolveChainId(ctx, loaded.config) ?? chainIdOf(loaded.config.chain)
  const chain = getChain(chainId)
  const file = buildRegistrationFile(loaded.config)

  let pricing = {}
  let source = 'defaults'
  if (!ctx.flags.offline) {
    try {
      const params = await fetchGasParams(chainId, createReadClient(chainId, ctx.flags.rpcUrl))
      pricing = { gasPriceWei: params.gasPriceWei, nativeUsd: params.nativeUsd }
      source = params.source === 'live' ? `live (${chain.rpcUrl}, Chainlink BNB/USD)` : 'defaults'
    } catch (err) {
      source = `defaults (live read failed: ${err instanceof Error ? err.message : String(err)})`
    }
  }

  const estimate = estimateRegistrationCost(file, chainId, pricing)

  if (ctx.flags.json) {
    ctx.io.out(toJson({ ...estimate, priceSourceDetail: source }))
    return EXIT.ok
  }

  ctx.io.out(`Cost of publishing "${loaded.config.name}" on ${chain.name}`)
  ctx.io.out(heading('inputs'))
  ctx.io.out(kv('card size', `${bytes(estimate.uriBytes)} (phase 1) -> ${bytes(estimate.finalUriBytes)} (phase 2)`))
  ctx.io.out(kv('gas price', `${estimate.gasPriceGwei} gwei`))
  ctx.io.out(kv('BNB/USD', `$${estimate.nativeUsd.toFixed(2)}`))
  ctx.io.out(kv('source', source))

  ctx.io.out(heading('cost'))
  ctx.io.out(costRow('phase 1 register', estimate.register))
  ctx.io.out(costRow('phase 2 setAgentURI', estimate.setAgentURI))
  ctx.io.out(costRow('total', estimate.total))

  ctx.io.out(heading('model'))
  ctx.io.out(kv('anchor', `${gas(891_730n)} gas measured for a 1 KiB card on the deployed registry`))
  ctx.io.out(kv('per byte', '641 gas cold (20000/32 SSTORE + 16 calldata), 107 gas on rewrite'))
  for (const note of estimate.notes) ctx.io.out(bullet(MARK.info, note))
  return EXIT.ok
}

/* ------------------------------------------------------------------ */
/* publish                                                             */
/* ------------------------------------------------------------------ */

export async function cmdPublish(ctx: Ctx): Promise<number> {
  const loaded = await load(ctx)
  if ('exitCode' in loaded) return loaded.exitCode

  const chainId = resolveChainId(ctx, loaded.config) ?? chainIdOf(loaded.config.chain)
  const broadcast = ctx.flags.broadcast && !ctx.flags.dryRun

  if (!broadcast) return dryRun(ctx, loaded, chainId)

  const key = privateKeyFromEnv(ctx.env) ?? (await promptPrivateKey())
  const clients = createClients(key, chainId, ctx.flags.rpcUrl)

  const result = await publishAgent({
    config: loaded.config,
    walletClient: ctx.overrides.walletClient ?? clients.walletClient,
    publicClient: ctx.overrides.publicClient ?? clients.publicClient,
    chainId,
    dedupe: ctx.flags.dedupe ? 'scan' : 'none',
    ...(ctx.flags.agentId === undefined ? {} : { agentId: BigInt(ctx.flags.agentId) }),
    ...(ctx.flags.requestValidation === null ? {} : { requestValidation: ctx.flags.requestValidation }),
    ...(ctx.flags.rpcUrl === undefined ? {} : { rpcUrl: ctx.flags.rpcUrl }),
  })

  if (ctx.flags.json) {
    ctx.io.out(toJson(result))
    return EXIT.ok
  }

  ctx.io.out(`${MARK.ok} ${result.action} agent ${result.agentId} on chain ${result.chainId}`)
  ctx.io.out(kv('owner', result.owner))
  if (result.registerTx !== null) ctx.io.out(kv('register', result.explorerUrls.register ?? result.registerTx))
  ctx.io.out(kv('setAgentURI', result.explorerUrls.setAgentURI))
  if (result.validationRequest !== null) {
    ctx.io.out(kv('validation', result.explorerUrls.validationRequest ?? ''))
    ctx.io.out(kv('requestHash', result.validationRequest.requestHash))
  }
  ctx.io.out(kv('agent', result.explorerUrls.agent))
  return EXIT.ok
}

async function dryRun(ctx: Ctx, loaded: LoadedConfig, chainId: number): Promise<number> {
  const { owner, note } = dryRunOwner(ctx)
  const walletClient = ctx.overrides.walletClient ?? {
    account: { address: owner },
    chain: { id: chainId },
    // A dry run never signs. If anything ever reaches this, that is a bug and
    // it should be loud rather than silent.
    writeContract: () => {
      throw new HallmarkError('dry run attempted to broadcast; this is a bug')
    },
  }

  let plan: PublishPlan
  try {
    plan = await planPublish({
      config: loaded.config,
      walletClient,
      chainId,
      dedupe: ctx.flags.dedupe && owner !== PLACEHOLDER_OWNER ? 'scan' : 'none',
      ...(ctx.flags.agentId === undefined ? {} : { agentId: BigInt(ctx.flags.agentId) }),
    })
  } catch (err) {
    return fail(ctx, err instanceof Error ? err.message : String(err))
  }

  if (ctx.flags.json) {
    ctx.io.out(toJson({ dryRun: true, broadcast: false, ...plan }))
    return EXIT.ok
  }

  const chain = getChain(chainId)
  ctx.io.out(`DRY RUN — nothing is signed and nothing is sent.`)
  ctx.io.out(`Add --broadcast to publish "${loaded.config.name}" on ${chain.name}.`)
  if (note !== null) ctx.io.out(bullet(MARK.info, note))

  ctx.io.out(heading('plan'))
  ctx.io.out(kv('action', plan.action === 'register' ? 'mint a new agent (two phases)' : `update agent ${plan.agentId} in place`))
  ctx.io.out(kv('owner', plan.owner))
  ctx.io.out(kv('registry', plan.identityRegistry))
  ctx.io.out(kv('card size', `${bytes(plan.uriBytes)} -> ${bytes(plan.finalTokenUri.length)}`))

  ctx.io.out(heading('calls'))
  for (const call of plan.calls) {
    ctx.io.out(bullet(MARK.info, `phase ${call.phase}  ${call.label}`))
    ctx.io.out(indent(`to     ${call.to}`))
    ctx.io.out(indent(`data   ${truncate(call.data, 138)}`))
    if (call.note !== undefined) ctx.io.out(indent(`note   ${call.note}`))
  }

  ctx.io.out(heading('decoded registration file'))
  ctx.io.out(indent(JSON.stringify(plan.decodedCard, null, 2), 2))

  ctx.io.out(heading('cost'))
  ctx.io.out(costRow('phase 1 register', plan.cost.register))
  ctx.io.out(costRow('phase 2 setAgentURI', plan.cost.setAgentURI))
  ctx.io.out(costRow('total', plan.cost.total))
  for (const item of plan.cost.notes) ctx.io.out(bullet(MARK.info, item))

  if (plan.validation !== null) {
    ctx.io.out(heading('validation request'))
    ctx.io.out(kv('validator', plan.validation.validator))
    ctx.io.out(kv('evidence', plan.validation.evidenceUrl))
    ctx.io.out(kv('nonce', String(plan.validation.nonce)))
    ctx.io.out(kv('requestHash', plan.validation.requestHash ?? 'derived once the agent id exists'))
    ctx.io.out(
      bullet(
        MARK.info,
        'validationRequest reverts with "Not authorized" unless the caller owns or operates the agent, so only you can open this.',
      ),
    )
  }
  return EXIT.ok
}

function dryRunOwner(ctx: Ctx): { owner: Address; note: string | null } {
  const override = ctx.overrides.walletClient?.account?.address
  if (override !== undefined && override !== null) return { owner: override, note: null }

  const flag = ctx.flags.from ?? ctx.env['HALLMARK_ADDRESS']
  if (flag !== undefined && /^0x[0-9a-fA-F]{40}$/.test(flag)) return { owner: flag as Address, note: null }

  const key = privateKeyFromEnv(ctx.env)
  if (key !== null) {
    // Deriving an address does not sign anything.
    const clients = createClients(key, 56)
    return { owner: clients.address, note: null }
  }

  return {
    owner: PLACEHOLDER_OWNER,
    note: 'no publisher address known, so the owner shown is a placeholder and the duplicate check is skipped. Pass --from 0x… or set HALLMARK_ADDRESS.',
  }
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

export async function cmdStatus(ctx: Ctx): Promise<number> {
  let config: AgentConfig | null = null
  if (ctx.flags.agentId === undefined || ctx.flags.chain === undefined) {
    const loaded = await load(ctx, { optional: true })
    if ('exitCode' in loaded) return loaded.exitCode
    config = loaded.config
  }

  const chainId = resolveChainId(ctx, config ?? undefined)
  if (chainId === null) return fail(ctx, 'status needs --chain (bsc or bsc-testnet) or a config that names one')

  let agentId: bigint
  if (ctx.flags.agentId !== undefined) {
    agentId = BigInt(ctx.flags.agentId)
  } else {
    const owner = ctx.flags.from ?? ctx.env['HALLMARK_ADDRESS']
    if (config === null || owner === undefined) {
      return fail(ctx, 'status needs --agent-id, or a config plus --from 0x… so the agent can be looked up by owner and name')
    }
    const found = await scanLookup({ owner: owner as Address, name: config.name, chainId })
    if (found === null) return fail(ctx, `${owner} owns no agent called "${config.name}" on chain ${chainId}`)
    agentId = found
  }

  const report = await getAgentStatus({
    agentId,
    chainId,
    resolveOffChain: true,
    ...(ctx.flags.rpcUrl === undefined ? {} : { rpcUrl: ctx.flags.rpcUrl }),
  })

  if (ctx.flags.json) {
    ctx.io.out(toJson(report))
    return report.exists ? EXIT.ok : EXIT.failed
  }

  const chain = getChain(chainId)
  ctx.io.out(`Agent ${report.agentId} on ${chain.name}`)
  ctx.io.out(heading('identity'))
  if (!report.exists) {
    ctx.io.out(bullet(MARK.fail, report.cardError ?? 'not registered'))
    return EXIT.failed
  }
  ctx.io.out(kv('owner', report.owner ?? 'unknown'))
  ctx.io.out(kv('tokenURI', `${report.tokenUriKind ?? 'unknown'} (${bytes(report.tokenUriBytes ?? 0)})`))
  ctx.io.out(kv('explorer', report.explorerUrls.agent))

  if (report.card === null) {
    ctx.io.out(bullet(MARK.fail, `registration file unreadable: ${report.cardError ?? 'unknown reason'}`))
  } else {
    ctx.io.out(kv('name', report.card.name ?? '(none)'))
    ctx.io.out(kv('active', String(report.card.active)))
    ctx.io.out(kv('x402Support', String(report.card.x402Support)))
    ctx.io.out(
      kv(
        'registrations',
        report.card.registrations.length === 0
          ? 'none — phase two of registration was never run'
          : report.card.registrations.map((entry) => `${entry.agentId} @ ${entry.agentRegistry}`).join(', '),
      ),
    )
    ctx.io.out(heading('services'))
    if (report.card.services.length === 0) {
      ctx.io.out(bullet(MARK.fail, 'declares no services at all, so nothing can hire it'))
    }
    for (const service of report.card.services) {
      ctx.io.out(kv(service.name, service.endpoint, 10))
    }
    if (report.cardWarnings.length > 0) {
      ctx.io.out(heading('registration file warnings'))
      for (const warning of report.cardWarnings) ctx.io.out(bullet(MARK.warn, warning))
    }
  }

  ctx.io.out(heading('validation'))
  const validation = report.validation
  if (validation === null || validation.requestCount === 0) {
    ctx.io.out(bullet(MARK.info, 'no validation requests. The registry accepts one only from the owner or an operator.'))
  } else {
    ctx.io.out(kv('requests', String(validation.requestCount)))
    ctx.io.out(kv('responded', String(validation.respondedCount)))
    ctx.io.out(kv('average', validation.averageResponse === null ? 'n/a' : `${validation.averageResponse}/100`))
    for (const record of validation.validations) {
      const mark = record.state === 'responded' ? MARK.ok : MARK.info
      ctx.io.out(
        bullet(
          mark,
          `${record.requestHash.slice(0, 18)}…  validator ${record.validator}  ${record.state === 'responded' ? `score ${record.response}` : 'pending'}${record.tag === '' ? '' : `  tag "${record.tag}"`}`,
        ),
      )
    }
  }

  ctx.io.out(heading('reputation'))
  if (report.reputation === null) {
    ctx.io.out(bullet(MARK.info, 'no feedback yet'))
  } else {
    ctx.io.out(kv('clients', String(report.reputation.clients)))
    ctx.io.out(kv('feedbacks', String(report.reputation.count)))
    ctx.io.out(
      kv('score', `${report.reputation.score} (raw value ${report.reputation.value}, ${report.reputation.valueDecimals} decimals)`),
    )
  }
  return EXIT.ok
}

/* ------------------------------------------------------------------ */
/* shared                                                              */
/* ------------------------------------------------------------------ */

type LoadFailure = { exitCode: number }

async function load(ctx: Ctx, opts: { optional?: boolean } = {}): Promise<LoadedConfig | LoadFailure> {
  try {
    return await loadAgentConfig(ctx.flags.config, ctx.cwd)
  } catch (err) {
    if (err instanceof AgentConfigError) {
      if (ctx.flags.json) {
        ctx.io.out(toJson({ ok: false, errors: err.issues }))
      } else {
        ctx.io.err(formatIssues(err.issues))
      }
      return { exitCode: EXIT.failed }
    }
    if (err instanceof ConfigFileError) {
      if (opts.optional === true) return { exitCode: fail(ctx, err.message) }
      return { exitCode: fail(ctx, err.message) }
    }
    throw err
  }
}

function resolveChainId(ctx: Ctx, config: AgentConfig | undefined): number | null {
  const flag = ctx.flags.chain
  if (flag !== undefined) {
    if (flag === '56' || flag === '97') return Number(flag)
    const known = CHAIN_IDS[flag as keyof typeof CHAIN_IDS]
    if (known === undefined) return null
    return known
  }
  return config === undefined ? null : chainIdOf(config.chain)
}

function probeOptions(ctx: Ctx): { timeoutMs?: number; fetchImpl?: typeof fetch } {
  return {
    ...(ctx.flags.timeoutMs === undefined ? {} : { timeoutMs: ctx.flags.timeoutMs }),
    ...(ctx.overrides.fetchImpl === undefined ? {} : { fetchImpl: ctx.overrides.fetchImpl }),
  }
}

function costRow(label: string, line: { gas: bigint; bnb: string; usd: number }): string {
  return kv(label, `${gas(line.gas).padStart(13)} gas   ${line.bnb.padStart(18)} BNB   ${usd(line.usd).padStart(9)}`)
}

function describePricing(config: AgentConfig): string {
  const pricing = config.pricing
  if (pricing === undefined) return 'not declared'
  if (pricing.model === 'free') return 'free'
  return `${pricing.amount} ${pricing.asset} via ${pricing.model}`
}

function fail(ctx: Ctx, message: string): number {
  if (ctx.flags.json) ctx.io.out(toJson({ ok: false, error: message }))
  else ctx.io.err(`error: ${message}`)
  return EXIT.failed
}
