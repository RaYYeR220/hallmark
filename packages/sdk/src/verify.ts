/**
 * The preflight.
 *
 * `verifyAgent` fetches an agent's own declared endpoints and reports what a
 * validator would find. It is deliberately the same set of checks Hallmark
 * runs before it signs a validation response, so a developer can fix their
 * agent *before* asking for one rather than learning about it from a low
 * score.
 *
 * Read-only, strictly bounded, and it refuses private or link-local hosts.
 * Nothing here writes to a chain.
 */

import { createEvidenceBundle, createRegistryReader, endpointsOf, scoreEvidence } from '@hallmark/core'
import type { EvidenceBundle, EvidenceCapabilities, ProbeResult, RegistryReaderOptions } from '@hallmark/core'

import { probeA2A, probeMCP, probeWeb, probeX402, type ProbeOptions, type ProbeOutcome } from './probes.js'
import { chainIdOf } from './registration.js'
import type { AgentConfig, ServiceEndpoints, ServiceKind } from './types.js'

export type Finding = {
  severity: 'error' | 'warning' | 'info'
  code: string
  message: string
  hint?: string
}

export type EndpointCheck = ProbeOutcome & {
  kind: ServiceKind
  declared: string
}

export type VerifyVerdict = 'ready' | 'degraded' | 'unhireable'

export type VerifyReport = {
  source: 'registry' | 'config' | 'endpoints'
  chainId: number | null
  agentId: bigint | null
  name: string | null
  owner: string | null
  endpoints: EndpointCheck[]
  findings: Finding[]
  verdict: VerifyVerdict
  /** 0-100, from the same scorer the marketplace prober uses. */
  score: number
  /**
   * The content-addressed evidence bundle a validator would sign over. Only
   * available once there is an agent id to address it to; the score above is
   * computed either way.
   */
  evidence: EvidenceBundle | null
  /** Compromises the card parser had to make. Empty is the good case. */
  cardWarnings: string[]
}

export type VerifyAgentInput = (
  | { agentId: bigint | number; chainId: number }
  | { config: AgentConfig }
  | { endpoints: ServiceEndpoints; chainId?: number }
) &
  ProbeOptions &
  RegistryReaderOptions

const PROBED_KINDS: readonly ServiceKind[] = ['a2a', 'mcp', 'x402', 'web']

export async function verifyAgent(input: VerifyAgentInput): Promise<VerifyReport> {
  if ('agentId' in input) return verifyFromRegistry(input)
  if ('config' in input) {
    return verifyEndpoints({
      source: 'config',
      chainId: chainIdOf(input.config.chain),
      agentId: null,
      owner: null,
      name: input.config.name,
      endpoints: input.config.services,
      cardWarnings: [],
      findings: [],
      opts: input,
    })
  }
  return verifyEndpoints({
    source: 'endpoints',
    chainId: input.chainId ?? null,
    agentId: null,
    owner: null,
    name: null,
    endpoints: input.endpoints,
    cardWarnings: [],
    findings: [],
    opts: input,
  })
}

/* ------------------------------------------------------------------ */

async function verifyFromRegistry(
  input: { agentId: bigint | number; chainId: number } & ProbeOptions & RegistryReaderOptions,
): Promise<VerifyReport> {
  const { agentId, chainId, ...rest } = input
  const reader = createRegistryReader(chainId, readerOptions(rest))
  const id = BigInt(agentId)
  const agent = await reader.getAgent(id, { resolveOffChain: true })

  if (agent === null) {
    return empty({
      source: 'registry',
      chainId,
      agentId: id,
      findings: [
        {
          severity: 'error',
          code: 'not_registered',
          message: `agent ${id} does not exist on chain ${chainId}`,
        },
      ],
    })
  }

  if (!agent.card.ok) {
    return empty({
      source: 'registry',
      chainId,
      agentId: id,
      owner: agent.owner,
      findings: [
        {
          severity: 'error',
          code: 'card_unreadable',
          message: `the registration file could not be read: ${agent.card.error}`,
          hint: 'A validator cannot check endpoints it cannot find. Re-publish with `hallmark publish`.',
        },
      ],
    })
  }

  const card = agent.card.card
  const findings: Finding[] = []
  const endpoints: ServiceEndpoints = {}

  for (const resolved of endpointsOf(card)) {
    if ((PROBED_KINDS as readonly string[]).includes(resolved.kind)) {
      const kind = resolved.kind as ServiceKind
      if (endpoints[kind] === undefined) endpoints[kind] = resolved.url
    } else {
      findings.push({
        severity: 'info',
        code: 'unprobed_service',
        message: `declares a "${resolved.kind}" service (${resolved.url}) which this check does not exercise`,
      })
    }
  }

  if (card.services.length === 0) {
    findings.push({
      severity: 'error',
      code: 'no_services',
      message: 'the registration file declares no services at all, so nothing can hire this agent',
      hint: 'Mainnet agent 42 "Bot Trader" is the canonical example: a name, a description, and no way to call it.',
    })
  }
  if (!card.active) {
    findings.push({
      severity: 'warning',
      code: 'inactive',
      message: 'the registration file sets "active": false',
    })
  }
  if (card.registrations.length === 0) {
    findings.push({
      severity: 'warning',
      code: 'no_self_registration',
      message: 'the registration file does not name its own agent id, so phase two of registration was never run',
      hint: 'Re-publish with `hallmark publish`; it patches `registrations` and calls setAgentURI for you.',
    })
  } else if (!card.registrations.some((entry) => entry.agentId === Number(id))) {
    findings.push({
      severity: 'warning',
      code: 'registration_mismatch',
      message: `the registration file claims agent id ${card.registrations.map((entry) => String(entry.agentId)).join(', ')} but is served by agent ${id}`,
    })
  }

  return verifyEndpoints({
    source: 'registry',
    chainId,
    agentId: id,
    owner: agent.owner,
    name: card.name ?? null,
    endpoints,
    cardWarnings: agent.card.warnings,
    findings,
    opts: input,
  })
}

async function verifyEndpoints(args: {
  source: VerifyReport['source']
  chainId: number | null
  agentId: bigint | null
  owner: string | null
  name: string | null
  endpoints: ServiceEndpoints
  cardWarnings: string[]
  findings: Finding[]
  opts: ProbeOptions
}): Promise<VerifyReport> {
  const probeOpts = probeOptions(args.opts)
  const declared = PROBED_KINDS.filter((kind) => args.endpoints[kind] !== undefined)

  const checks = await Promise.all(
    declared.map(async (kind): Promise<EndpointCheck> => {
      const url = args.endpoints[kind] as string
      const outcome = await runProbe(kind, url, probeOpts)
      return { kind, declared: url, ...outcome }
    }),
  )

  const findings = [...args.findings, ...deriveFindings(checks, declared)]
  const verdict = decideVerdict(checks, declared)
  const { probe, capabilities } = toEvidenceInput(checks)

  return {
    source: args.source,
    chainId: args.chainId,
    agentId: args.agentId,
    name: args.name,
    owner: args.owner,
    endpoints: checks,
    findings,
    verdict,
    score: scoreEvidence({ probe, capabilities }),
    evidence:
      args.chainId === null || args.agentId === null
        ? null
        : createEvidenceBundle({
            chainId: args.chainId,
            agentId: Number(args.agentId),
            probe,
            capabilities,
          }),
    cardWarnings: args.cardWarnings,
  }
}

function runProbe(kind: ServiceKind, url: string, opts: ProbeOptions): Promise<ProbeOutcome> {
  switch (kind) {
    case 'a2a':
      return probeA2A(url, opts)
    case 'mcp':
      return probeMCP(url, opts)
    case 'x402':
      return probeX402(url, opts)
    case 'web':
      return probeWeb(url, opts)
  }
}

function deriveFindings(checks: EndpointCheck[], declared: readonly ServiceKind[]): Finding[] {
  const findings: Finding[] = []
  const machine = declared.filter((kind) => kind === 'a2a' || kind === 'mcp')

  if (machine.length === 0) {
    findings.push({
      severity: 'error',
      code: 'no_machine_endpoint',
      message: 'no A2A or MCP endpoint is declared, so no other agent can call this one',
      hint: 'A web page is not an interface. Publish at least one of a2a or mcp.',
    })
  }

  for (const check of checks) {
    if (check.status === 'ok') continue
    const severity: Finding['severity'] = check.kind === 'web' ? 'warning' : 'error'
    findings.push({
      severity,
      code: `${check.kind}_${check.status}`,
      message: `${check.kind} (${check.declared}): ${check.detail}`,
      ...(check.status === 'refused'
        ? {
            hint: 'A validator runs from the public internet. An endpoint it cannot route to is an endpoint that does not exist.',
          }
        : {}),
    })
  }

  const slow = checks.filter((check) => check.status === 'ok' && check.latencyMs > 3_000)
  for (const check of slow) {
    findings.push({
      severity: 'warning',
      code: `${check.kind}_slow`,
      message: `${check.kind} answered in ${check.latencyMs}ms; callers time out long before that`,
    })
  }

  return findings
}

function decideVerdict(checks: EndpointCheck[], declared: readonly ServiceKind[]): VerifyVerdict {
  const machine = checks.filter((check) => check.kind === 'a2a' || check.kind === 'mcp')
  if (declared.filter((kind) => kind === 'a2a' || kind === 'mcp').length === 0) return 'unhireable'
  if (!machine.some((check) => check.status === 'ok')) return 'unhireable'
  if (checks.some((check) => check.status !== 'ok')) return 'degraded'
  return 'ready'
}

/** Fold the probe results into the shape `@hallmark/core`'s scorer expects. */
function toEvidenceInput(checks: EndpointCheck[]): { probe: ProbeResult[]; capabilities: EvidenceCapabilities } {
  const probe: ProbeResult[] = checks.map((check) => ({
    endpoint: check.declared,
    kind: check.kind,
    ok: check.status === 'ok',
    ...(check.httpStatus === null ? {} : { httpStatus: check.httpStatus }),
    latencyMs: check.latencyMs,
    ...(check.status === 'ok' ? {} : { error: check.detail }),
  }))

  const mcp = checks.find((check) => check.kind === 'mcp' && check.status === 'ok')
  const a2a = checks.find((check) => check.kind === 'a2a' && check.status === 'ok')
  const x402 = checks.find((check) => check.kind === 'x402' && check.status === 'ok')

  return {
    probe,
    capabilities: {
      ...(mcp === undefined ? {} : { mcpTools: asStringArray(mcp.evidence['tools']) }),
      ...(a2a === undefined ? {} : { a2aSkills: asStringArray(a2a.evidence['skills']) }),
      x402:
        x402 === undefined
          ? null
          : {
              priceAtomic: String(x402.evidence['priceAtomic'] ?? ''),
              asset: String(x402.evidence['asset'] ?? ''),
              network: String(x402.evidence['network'] ?? ''),
            },
    },
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function empty(args: {
  source: VerifyReport['source']
  chainId: number | null
  agentId: bigint | null
  owner?: string
  findings: Finding[]
}): VerifyReport {
  return {
    source: args.source,
    chainId: args.chainId,
    agentId: args.agentId,
    name: null,
    owner: args.owner ?? null,
    endpoints: [],
    findings: args.findings,
    verdict: 'unhireable',
    score: 0,
    evidence: null,
    cardWarnings: [],
  }
}

function probeOptions(opts: ProbeOptions): ProbeOptions {
  return {
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.maxRedirects === undefined ? {} : { maxRedirects: opts.maxRedirects }),
    ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    ...(opts.lookup === undefined ? {} : { lookup: opts.lookup }),
    ...(opts.allowHttp === undefined ? {} : { allowHttp: opts.allowHttp }),
  }
}

function readerOptions(opts: RegistryReaderOptions): RegistryReaderOptions {
  return {
    ...(opts.rpcUrl === undefined ? {} : { rpcUrl: opts.rpcUrl }),
    ...(opts.transport === undefined ? {} : { transport: opts.transport }),
    ...(opts.batchSize === undefined ? {} : { batchSize: opts.batchSize }),
  }
}
