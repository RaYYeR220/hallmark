import {
  MCP_PROTOCOL_VERSION,
  RPC_ERRORS,
  VALIDATOR_INSTRUCTIONS,
  VALIDATOR_SERVER_INFO,
  VALIDATOR_SKILLS,
  parseRpc,
  rpcError,
  rpcResult,
  runSkill,
  toolName,
  validatorTools,
} from '@/lib/validator/service'

/**
 * The Hallmark validator's MCP face. Protocol revision `2025-06-18`.
 *
 * Two details of that revision are easy to get wrong and are handled
 * explicitly:
 *
 *   - a `tools/call` that fails *inside the tool* is a successful JSON-RPC
 *     response carrying `isError: true`, not a JSON-RPC error. Only
 *     protocol-level problems — unknown tool, malformed envelope — use the
 *     error channel, and client agents rely on that difference to decide
 *     whether retrying could help;
 *   - the result carries both `content` (text, for a model) and
 *     `structuredContent` (the object, for code). Both are always sent, with
 *     the text being the JSON itself: a validator's output is data, and
 *     paraphrasing it into prose here would lose the numbers.
 *
 * `initialize` answers with the version this server actually speaks rather
 * than echoing whatever was requested — echoing an unsupported version is how
 * a client ends up believing a capability exists.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
} as const

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  })
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS })
}

/**
 * MCP is POST-only, but a GET here should still explain itself.
 *
 * A prober or a curious human arriving with a browser gets the handshake it
 * would need rather than a bare 405 — the endpoint is machine-facing, not
 * secret.
 */
export function GET(): Response {
  return json({
    service: VALIDATOR_SERVER_INFO.name,
    protocol: 'mcp',
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: 'JSON-RPC over HTTP POST',
    tools: VALIDATOR_SKILLS.map((skill) => toolName(skill.id)),
    handshake: {
      method: 'POST',
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION } },
    },
  })
}

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null)
  if (body === null) {
    return json(rpcError(null, RPC_ERRORS.PARSE_ERROR, 'Body must be JSON'), 400)
  }

  const parsed = parseRpc(body)
  if (!parsed.ok) return json(parsed.response, 400)

  const { method, params, id } = parsed

  switch (method) {
    case 'initialize': {
      const requested =
        typeof params === 'object' && params !== null && 'protocolVersion' in params
          ? String((params as Record<string, unknown>)['protocolVersion'])
          : undefined
      return json(
        rpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: VALIDATOR_SERVER_INFO,
          instructions:
            VALIDATOR_INSTRUCTIONS +
            (requested !== undefined && requested !== MCP_PROTOCOL_VERSION
              ? `\n\nNote: you asked for protocol ${requested}; this server speaks ${MCP_PROTOCOL_VERSION}.`
              : ''),
        }),
      )
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      // A notification has no id and takes no response body.
      return new Response(null, { status: 202, headers: CORS })

    case 'ping':
      return json(rpcResult(id, {}))

    case 'tools/list':
      return json(rpcResult(id, { tools: validatorTools() }))

    case 'resources/list':
      return json(rpcResult(id, { resources: [] }))

    case 'prompts/list':
      return json(rpcResult(id, { prompts: [] }))

    case 'tools/call': {
      if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return json(rpcError(id, RPC_ERRORS.INVALID_PARAMS, 'tools/call params must be an object'))
      }
      const record = params as Record<string, unknown>
      const name = record['name']
      if (typeof name !== 'string') {
        return json(rpcError(id, RPC_ERRORS.INVALID_PARAMS, 'tools/call requires a string "name"'))
      }

      const skill = VALIDATOR_SKILLS.find((entry) => toolName(entry.id) === name)
      if (skill === undefined) {
        return json(
          rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown tool "${name}"`, {
            tools: VALIDATOR_SKILLS.map((entry) => toolName(entry.id)),
          }),
        )
      }

      const result = await runSkill(skill.id, record['arguments'] ?? {})
      if (!result.ok) {
        const detail = { message: result.message, code: result.code }
        return json(
          rpcResult(id, {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }],
            structuredContent: detail,
          }),
        )
      }

      return json(
        rpcResult(id, {
          isError: false,
          content: [{ type: 'text', text: JSON.stringify(result.output, null, 2) }],
          structuredContent: result.output,
        }),
      )
    }

    default:
      return json(
        rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown MCP method "${method}"`, {
          supported: ['initialize', 'tools/list', 'tools/call', 'ping'],
        }),
      )
  }
}
