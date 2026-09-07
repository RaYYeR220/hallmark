import { toJsonSchema } from './schema.js'
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
import type { AgentUrls } from './config.js'

/**
 * The MCP face: `initialize`, `tools/list`, `tools/call` over JSON-RPC.
 *
 * Protocol revision `2025-06-18`. Two details in that revision are easy to get
 * wrong and are handled explicitly here:
 *
 *   - a `tools/call` that fails *inside the tool* is a successful JSON-RPC
 *     response with `isError: true`, not a JSON-RPC error. Only protocol-level
 *     problems (unknown tool, malformed envelope) use the error channel. Client
 *     agents rely on that difference to decide whether to retry;
 *   - the result carries both `content` (text, for a model to read) and
 *     `structuredContent` (the object, for code to use). We always send both,
 *     with the text being the JSON — an agent's output is data, and
 *     paraphrasing it into prose here would lose the numbers.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18'

export type McpDeps = {
  agent: AgentDefinition
  config: RuntimeConfig
  chainId: SupportedChainId
  urls: AgentUrls
  context: SkillContext
}

function toolName(skillId: string): string {
  return skillId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function toolsFor(deps: Pick<McpDeps, 'agent' | 'urls'>): Array<Record<string, unknown>> {
  return deps.agent.skills.map((skill) => ({
    name: toolName(skill.id),
    title: skill.name,
    description:
      `${skill.description}\n\n` +
      (skill.mode === 'write'
        ? 'Sends an on-chain transaction through an Altana session key. The key carries a ' +
          'contract allowlist, a spend cap and an expiry; a call outside them comes back as a ' +
          'structured refusal, not an error, and nothing is sent.'
        : 'Read-only. Performs no transaction.') +
      (skill.price
        ? `\n\nPaid: ${skill.price.display} per call over x402 at ${deps.urls.x402}/${skill.id}.`
        : ''),
    inputSchema: toJsonSchema(skill.input),
    annotations: {
      readOnlyHint: skill.mode === 'read',
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }))
}

/** Handle one MCP JSON-RPC call. Notifications return `null`. */
export async function handleMcp(body: unknown, deps: McpDeps): Promise<JsonRpcResponse | null> {
  const parsed = parseJsonRpc(body)
  if (!parsed.ok) return parsed.response

  const { request } = parsed
  const id = request.id ?? null

  switch (request.method) {
    case 'initialize': {
      const requested =
        typeof request.params === 'object' &&
        request.params !== null &&
        'protocolVersion' in request.params
          ? String((request.params as Record<string, unknown>)['protocolVersion'])
          : undefined
      return rpcResult(id, {
        // The spec says to answer with a version we support. We only speak
        // one, so we name it rather than echoing whatever was asked for —
        // echoing an unsupported version is how a client ends up believing a
        // capability exists.
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: `hallmark-${deps.agent.manifest.slug}`,
          title: deps.agent.manifest.name,
          version: deps.agent.manifest.version,
        },
        instructions:
          `${deps.agent.manifest.description}\n\n` +
          'Read-only tools answer with a decision, the data behind it, its sources and a ' +
          'timestamp. Write tools act only inside a user-granted Altana session key and ' +
          'report a refusal as data.' +
          (requested && requested !== MCP_PROTOCOL_VERSION
            ? `\n\nNote: you asked for protocol ${requested}; this server speaks ${MCP_PROTOCOL_VERSION}.`
            : ''),
      })
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null

    case 'ping':
      return rpcResult(id, {})

    case 'tools/list':
      return rpcResult(id, { tools: toolsFor(deps) })

    case 'resources/list':
      return rpcResult(id, { resources: [] })

    case 'prompts/list':
      return rpcResult(id, { prompts: [] })

    case 'tools/call': {
      const params = request.params
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return rpcError(id, RPC_ERRORS.INVALID_PARAMS, 'tools/call params must be an object')
      }
      const record = params as Record<string, unknown>
      const name = record['name']
      if (typeof name !== 'string') {
        return rpcError(id, RPC_ERRORS.INVALID_PARAMS, 'tools/call requires a string "name"')
      }

      const skill = deps.agent.skills.find((entry) => toolName(entry.id) === name)
      if (!skill) {
        return rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown tool "${name}"`, {
          tools: deps.agent.skills.map((entry) => toolName(entry.id)),
        })
      }

      if (skill.price) {
        const accept = buildAccept({
          skill,
          manifest: deps.agent.manifest,
          chainId: deps.chainId,
          config: deps.config,
          resource: `${deps.urls.x402}/${skill.id}`,
        })
        return rpcResult(id, {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `${skill.name} costs ${skill.price.display} per call and is served over x402. ` +
                `POST ${deps.urls.x402}/${skill.id} — an unpaid request answers 402 with a ` +
                'payment challenge.',
            },
          ],
          structuredContent: {
            paymentRequired: {
              x402Version: 2,
              resource: { url: `${deps.urls.x402}/${skill.id}` },
              accepts: accept ? [accept] : [],
            },
          },
        })
      }

      const result = await invokeSkill(deps.agent, skill.id, record['arguments'] ?? {}, deps.context)

      if (!result.ok) {
        if (result.code === 'unknown-skill') {
          return rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, result.message)
        }
        // Tool-level failure: a result with isError, per the spec, so the
        // calling model sees the reason instead of a transport error.
        const detail =
          result.code === 'invalid-input'
            ? { message: result.message, errors: result.errors }
            : { message: result.message }
        return rpcResult(id, {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }],
          structuredContent: detail,
        })
      }

      return rpcResult(id, {
        isError: false,
        content: [{ type: 'text', text: JSON.stringify(result.output, null, 2) }],
        structuredContent: result.output,
      })
    }

    default:
      return rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown MCP method "${request.method}"`, {
        supported: ['initialize', 'tools/list', 'tools/call', 'ping'],
      })
  }
}
