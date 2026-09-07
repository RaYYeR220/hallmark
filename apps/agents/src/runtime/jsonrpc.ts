/**
 * JSON-RPC 2.0, shared by the A2A and MCP faces.
 *
 * Both protocols are JSON-RPC over HTTP POST, so the envelope handling lives
 * once. The error codes below are the reserved JSON-RPC range plus the two
 * application codes this service defines; anything an agent throws becomes
 * `INTERNAL_ERROR` with the message, never a stack trace.
 */

export type JsonRpcId = string | number | null

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: JsonRpcId
  method: string
  params?: unknown
}

export type JsonRpcError = {
  code: number
  message: string
  data?: unknown
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: JsonRpcError }

export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** The skill declined on its own safety rules. Not a transport failure. */
  AGENT_REFUSED: -32000,
  /** The caller has not paid for a priced skill on a face that requires it. */
  PAYMENT_REQUIRED: -32002,
  /** The skill ran past its deadline. Reported rather than waited out. */
  SKILL_TIMEOUT: -32001,
} as const

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }
}

export type ParsedRequest =
  | { ok: true; request: JsonRpcRequest }
  | { ok: false; id: JsonRpcId; response: JsonRpcResponse }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate an envelope.
 *
 * Notifications (no `id`) are legal in both protocols — MCP sends
 * `notifications/initialized` — so a missing id is preserved as `undefined`
 * rather than coerced to null, and the caller decides whether to answer.
 */
export function parseJsonRpc(body: unknown): ParsedRequest {
  if (!isRecord(body)) {
    return {
      ok: false,
      id: null,
      response: rpcError(null, RPC_ERRORS.INVALID_REQUEST, 'Request body must be a JSON object'),
    }
  }

  const rawId = body['id']
  const id: JsonRpcId =
    typeof rawId === 'string' || typeof rawId === 'number' ? rawId : rawId === null ? null : null

  if (body['jsonrpc'] !== '2.0') {
    return {
      ok: false,
      id,
      response: rpcError(
        id,
        RPC_ERRORS.INVALID_REQUEST,
        `"jsonrpc" must be exactly "2.0"; got ${JSON.stringify(body['jsonrpc'])}`,
      ),
    }
  }

  const method = body['method']
  if (typeof method !== 'string' || method.length === 0) {
    return {
      ok: false,
      id,
      response: rpcError(id, RPC_ERRORS.INVALID_REQUEST, '"method" must be a non-empty string'),
    }
  }

  const request: JsonRpcRequest = { jsonrpc: '2.0', method }
  if (rawId !== undefined) request.id = id
  if (body['params'] !== undefined) request.params = body['params']
  return { ok: true, request }
}

/** True for a notification: JSON-RPC forbids a response to one. */
export function isNotification(request: JsonRpcRequest): boolean {
  return request.id === undefined
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
