import { randomUUID } from 'node:crypto'

import { caip10 } from '@hallmark/core'

import type { AgentUrls } from './config.js'

import { describeShape, toJsonSchema } from './schema.js'
import { invokeSkill } from './invoke.js'
import {
  RPC_ERRORS,
  parseJsonRpc,
  rpcError,
  rpcResult,
  type JsonRpcResponse,
} from './jsonrpc.js'
import { buildAccept } from './x402.js'
import type { AgentDefinition, RuntimeConfig, SkillContext } from './types.js'
import type { SupportedChainId } from '@hallmark/core'

/**
 * The A2A face: an agent card at a well-known URL and JSON-RPC at `/a2a`.
 *
 * The card is the part other software reads without asking a human, so it is
 * written to be useful rather than minimal: every skill carries its input
 * schema, its price if it has one, and — for the write skills — the session-key
 * policy that bounds it. An integrator can tell from the card alone that
 * `act` cannot borrow, and that is the point.
 */

export const A2A_PROTOCOL_VERSION = '0.3.0'

/** Kept next to the A2A version because the card advertises both faces. */
const MCP_PROTOCOL_VERSION = '2025-06-18'

export type AgentCardArgs = {
  agent: AgentDefinition
  config: RuntimeConfig
  chainId: SupportedChainId
  /** Absolute URLs for this agent's faces, all built from one origin. */
  urls: AgentUrls
  /** Identity-registry agent id, once registered. */
  agentId?: number | null
  identityRegistry?: string | null
}

/**
 * The A2A AgentCard, extended with the ERC-8004 `services[]` shape the
 * registration file needs.
 *
 * Two audiences, one document: A2A clients read `skills`/`url`/`capabilities`,
 * and the ERC-8004 registry reads `services`/`registrations`/`x402Support`.
 * Keeping them in one file is what makes "the registration points at the live
 * URLs" checkable rather than a claim.
 */
export function buildAgentCard(args: AgentCardArgs): Record<string, unknown> {
  const { agent, chainId, urls } = args
  const { manifest } = agent

  const skills = agent.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: [...manifest.tags, ...skill.tags, skill.mode === 'write' ? 'on-chain' : 'read-only'],
    ...(skill.examples ? { examples: skill.examples } : {}),
    inputModes: ['application/json'],
    outputModes: ['application/json'],
    // Not part of the A2A skill object, but harmless there and the single
    // most useful thing a caller can be handed up front.
    inputSchema: toJsonSchema(skill.input),
    ...(skill.price
      ? {
          pricing: {
            protocol: 'x402',
            amountAtomic: skill.price.amountAtomic,
            asset: skill.price.asset,
            decimals: skill.price.decimals,
            symbol: skill.price.symbol,
            display: skill.price.display,
            endpoint: `${urls.x402}/${skill.id}`,
          },
        }
      : {}),
  }))

  const paidSkill = agent.skills.find((skill) => skill.price !== undefined)

  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    type: 'AgentCard',
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    url: urls.a2a,
    preferredTransport: 'JSONRPC',
    provider: {
      organization: 'Hallmark',
      url: urls.web,
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json'],
    skills,
    additionalInterfaces: [
      { transport: 'JSONRPC', url: urls.a2a },
      { transport: 'MCP', url: urls.mcp },
    ],
    securitySchemes: {},
    security: [],
    supportsAuthenticatedExtendedCard: false,

    // --- ERC-8004 registration file ----------------------------------------
    services: [
      {
        name: 'A2A',
        endpoint: urls.a2a,
        version: A2A_PROTOCOL_VERSION,
        skills: agent.skills.map((skill) => skill.id),
      },
      { name: 'MCP', endpoint: urls.mcp, version: MCP_PROTOCOL_VERSION },
      ...(paidSkill
        ? [{ name: 'x402', endpoint: `${urls.x402}/${paidSkill.id}`, version: '1' }]
        : []),
      { name: 'web', endpoint: urls.web },
      { name: 'agent-card', endpoint: urls.card },
    ],
    x402Support: paidSkill !== undefined,
    active: true,
    supportedTrust: ['reputation', 'crypto-economic'],
    registrations:
      args.agentId != null && args.identityRegistry
        ? [{ agentId: args.agentId, agentRegistry: caip10(chainId, args.identityRegistry) }]
        : [],

    // --- Hallmark's own metadata -------------------------------------------
    'x-hallmark': {
      slug: manifest.slug,
      category: manifest.category,
      categoryLabel: manifest.categoryLabel,
      chainId,
      chains: manifest.chains,
      custody: 'none',
      authorization: manifest.policy
        ? {
            model: 'altana-session-key',
            policyCategory: manifest.policy.category,
            rationale: manifest.policy.rationale,
          }
        : { model: 'read-only', rationale: 'This agent never sends a transaction.' },
      skillInputs: Object.fromEntries(
        agent.skills.map((skill) => [skill.id, describeShape(skill.input)]),
      ),
    },
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'data'; data: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Pull the skill and its input out of an A2A message.
 *
 * A2A carries an arbitrary payload in message parts, so a convention is
 * needed. Ours: a `data` part shaped `{ skill, input }`. For callers driving
 * this by hand we also accept `{ skillId, input }` directly on `params`, which
 * costs nothing and saves an envelope.
 */
export function extractInvocation(
  params: unknown,
): { ok: true; skill: string; input: unknown } | { ok: false; message: string } {
  if (!isRecord(params)) {
    return { ok: false, message: '"params" must be an object' }
  }

  if (typeof params['skillId'] === 'string') {
    return { ok: true, skill: params['skillId'], input: params['input'] ?? {} }
  }

  const message = params['message']
  if (!isRecord(message)) {
    return {
      ok: false,
      message:
        'expected params.message (A2A) or params.skillId. Send a data part shaped ' +
        '{ "kind": "data", "data": { "skill": "analyse", "input": { ... } } }',
    }
  }

  const parts = message['parts']
  if (!Array.isArray(parts)) {
    return { ok: false, message: 'params.message.parts must be an array' }
  }

  for (const part of parts) {
    if (!isRecord(part) || part['kind'] !== 'data') continue
    const data = part['data']
    if (!isRecord(data)) continue
    const skill = data['skill'] ?? data['skillId']
    if (typeof skill === 'string') {
      return { ok: true, skill, input: data['input'] ?? {} }
    }
  }

  return {
    ok: false,
    message:
      'no data part named a skill. Include { "kind": "data", "data": { "skill": "...", ' +
      '"input": { ... } } } in params.message.parts',
  }
}

export type A2AHandlerDeps = {
  agent: AgentDefinition
  config: RuntimeConfig
  chainId: SupportedChainId
  urls: AgentUrls
  context: SkillContext
}

/**
 * Handle one A2A JSON-RPC call.
 *
 * `message/send` runs synchronously and answers with a Message rather than a
 * Task: every skill here completes in one round trip, and inventing a task
 * lifecycle for work that is already done would be ceremony a client has to
 * poll through.
 */
export async function handleA2A(body: unknown, deps: A2AHandlerDeps): Promise<JsonRpcResponse> {
  const parsed = parseJsonRpc(body)
  if (!parsed.ok) return parsed.response

  const { request } = parsed
  const id = request.id ?? null

  switch (request.method) {
    case 'agent/getAuthenticatedExtendedCard':
    case 'agent/card':
      return rpcResult(
        id,
        buildAgentCard({
          agent: deps.agent,
          config: deps.config,
          chainId: deps.chainId,
          urls: deps.urls,
        }),
      )

    case 'agent/skills':
      return rpcResult(
        id,
        deps.agent.skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          mode: skill.mode,
          inputSchema: toJsonSchema(skill.input),
          ...(skill.price ? { price: skill.price } : {}),
        })),
      )

    case 'message/send':
    case 'message/stream': {
      if (request.method === 'message/stream') {
        return rpcError(
          id,
          RPC_ERRORS.METHOD_NOT_FOUND,
          'This agent does not advertise streaming; use message/send.',
        )
      }

      const invocation = extractInvocation(request.params)
      if (!invocation.ok) {
        return rpcError(id, RPC_ERRORS.INVALID_PARAMS, invocation.message, {
          skills: deps.agent.skills.map((skill) => skill.id),
        })
      }

      const skill = deps.agent.skills.find((entry) => entry.id === invocation.skill)
      if (skill?.price) {
        // Paid skills are served over the x402 face, where a payment can
        // actually be presented. Saying so beats silently serving for free.
        const resource = `${deps.urls.x402}/${skill.id}`
        const accept = buildAccept({
          skill,
          manifest: deps.agent.manifest,
          chainId: deps.chainId,
          config: deps.config,
          resource,
        })
        return rpcError(
          id,
          RPC_ERRORS.PAYMENT_REQUIRED,
          `${skill.name} is a paid skill: call it over x402 at ${resource}`,
          { x402Version: 2, resource: { url: resource }, accepts: accept ? [accept] : [] },
        )
      }

      const result = await invokeSkill(deps.agent, invocation.skill, invocation.input, deps.context)
      if (!result.ok) {
        const code =
          result.code === 'unknown-skill'
            ? RPC_ERRORS.METHOD_NOT_FOUND
            : result.code === 'invalid-input'
              ? RPC_ERRORS.INVALID_PARAMS
              : result.code === 'timeout'
                ? RPC_ERRORS.SKILL_TIMEOUT
                : RPC_ERRORS.INTERNAL_ERROR
        return rpcError(id, code, result.message, result.code === 'invalid-input' ? result.errors : undefined)
      }

      const parts: MessagePart[] = [
        { kind: 'data', data: { skill: invocation.skill, result: result.output } },
      ]
      return rpcResult(id, {
        kind: 'message',
        role: 'agent',
        messageId: randomUUID(),
        parts,
        metadata: { agent: deps.agent.manifest.slug, skill: invocation.skill },
      })
    }

    case 'tasks/get':
      return rpcError(
        id,
        RPC_ERRORS.METHOD_NOT_FOUND,
        'This agent completes every skill in one round trip and creates no tasks.',
      )

    default:
      return rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown A2A method "${request.method}"`, {
        supported: ['message/send', 'agent/card', 'agent/skills'],
      })
  }
}

// ---------------------------------------------------------------------------
// The on-chain registration file
// ---------------------------------------------------------------------------

/**
 * The lean card that goes into `tokenURI`, as distinct from the full card
 * served at the endpoint.
 *
 * ERC-8004 stores the registration file in contract storage, so every byte is
 * paid for once at registration and again on every update. The full A2A card
 * carries JSON Schema for every skill and runs to about fourteen kilobytes —
 * fine over HTTP, absurd in storage, and about ten million gas to write.
 *
 * What actually has to be on-chain is the part a reader cannot get anywhere
 * else: who this agent is, where its faces are, and which registry entry it
 * claims. Everything else lives behind the `agent-card` service, which is the
 * separation the standard is built around. Skills are named but not schema'd —
 * enough for a marketplace to filter on, with the detail one fetch away.
 */
export function buildRegistrationFile(args: AgentCardArgs): Record<string, unknown> {
  const { agent, chainId, urls } = args
  const { manifest } = agent
  const paidSkill = agent.skills.find((skill) => skill.price !== undefined)

  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: manifest.name,
    description: manifest.description.split('. ').slice(0, 2).join('. ').slice(0, 240),
    services: [
      { name: 'A2A', endpoint: urls.a2a, version: A2A_PROTOCOL_VERSION },
      { name: 'MCP', endpoint: urls.mcp, version: MCP_PROTOCOL_VERSION },
      ...(paidSkill ? [{ name: 'x402', endpoint: `${urls.x402}/${paidSkill.id}`, version: '2' }] : []),
      { name: 'agent-card', endpoint: urls.card },
      { name: 'web', endpoint: urls.web },
    ],
    skills: agent.skills.map((skill) => skill.id),
    x402Support: paidSkill !== undefined,
    active: true,
    supportedTrust: ['reputation', 'crypto-economic'],
    registrations:
      args.agentId != null && args.identityRegistry
        ? [{ agentId: args.agentId, agentRegistry: caip10(chainId, args.identityRegistry) }]
        : [],
    'x-hallmark': {
      slug: manifest.slug,
      category: manifest.category,
      chainId,
      custody: 'none',
      authorization: manifest.policy?.category ?? 'read-only',
    },
  }
}
