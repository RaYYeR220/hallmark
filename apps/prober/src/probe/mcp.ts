/**
 * MCP endpoint probe: the Streamable HTTP handshake, and nothing else.
 *
 * `initialize` then `tools/list` are both reads, and they are the only two
 * calls the prober is allowed to make. It never calls a tool. Servers answer
 * either a plain JSON body or an SSE-framed one over the same POST, so both
 * framings are parsed here; a server that answers 200 with prose gets
 * classified `bad-protocol` rather than counted as alive.
 */

import { httpRequestWithRetry, isEventStream, looksLikeHtml } from './http.ts'
import type { HttpOptions } from './http.ts'
import type { ProtocolOutcome, RequestTrace } from '../types.ts'

export const MCP_PROTOCOL_VERSION = '2025-06-18'

export const MCP_CLIENT_INFO = {
  name: 'hallmark-prober',
  title: 'Hallmark ERC-8004 liveness prober',
  version: '0.1.0',
} as const

export type JsonRpcResponse = {
  jsonrpc?: string
  id?: number | string | null
  result?: unknown
  error?: { code?: number; message?: string }
}

/**
 * Pull a JSON-RPC response out of either framing.
 *
 * SSE bodies are `event:`/`data:` blocks separated by a blank line, and a
 * single logical frame can be split across several `data:` lines. When `id`
 * is given, the matching frame wins; otherwise the first frame carrying a
 * `result` or `error` does.
 */
export function parseJsonRpcBody(text: string, contentType: string | null, id?: number | string): JsonRpcResponse | null {
  if (isEventStream(contentType) || /^\s*(event|data|id|retry):/m.test(text)) {
    for (const frame of sseFrames(text)) {
      const parsed = tryParse(frame)
      if (parsed === null) continue
      if (id !== undefined && parsed.id !== undefined && parsed.id !== null && parsed.id !== id) continue
      if (parsed.result !== undefined || parsed.error !== undefined) return parsed
    }
    return null
  }

  const direct = tryParse(text)
  if (direct !== null) return direct

  // A few servers answer a batch array even for a single request.
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        const candidate = asResponse(entry)
        if (candidate === null) continue
        if (id !== undefined && candidate.id !== undefined && candidate.id !== null && candidate.id !== id) continue
        return candidate
      }
    }
  } catch {
    return null
  }
  return null
}

/** Split an SSE body into the concatenated payload of each `data:` block. */
export function sseFrames(text: string): string[] {
  const frames: string[] = []
  let buffer: string[] = []

  const flush = () => {
    if (buffer.length > 0) {
      frames.push(buffer.join('\n'))
      buffer = []
    }
  }

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    if (rawLine.trim() === '') {
      flush()
      continue
    }
    if (rawLine.startsWith(':')) continue
    const colon = rawLine.indexOf(':')
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon)
    if (field !== 'data') continue
    let value = colon === -1 ? '' : rawLine.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    buffer.push(value)
  }
  flush()
  return frames
}

export function extractToolNames(result: unknown): string[] {
  if (typeof result !== 'object' || result === null) return []
  const tools = (result as Record<string, unknown>)['tools']
  if (!Array.isArray(tools)) return []
  const names: string[] = []
  for (const tool of tools) {
    if (typeof tool === 'string') {
      names.push(tool)
      continue
    }
    if (typeof tool !== 'object' || tool === null) continue
    const name = (tool as Record<string, unknown>)['name']
    if (typeof name === 'string' && name.trim() !== '') names.push(name)
  }
  return names
}

export async function probeMcp(endpoint: string, opts: HttpOptions = {}): Promise<ProtocolOutcome> {
  const requests: RequestTrace[] = []
  const jsonHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }

  const initBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: MCP_CLIENT_INFO,
    },
  })

  const init = await httpRequestWithRetry(endpoint, {
    ...opts,
    method: 'POST',
    headers: jsonHeaders,
    body: initBody,
  })
  requests.push(init.trace)

  if (!init.ok) {
    return {
      ok: false,
      protocolOk: false,
      protocolLive: false,
      failure: init.failure,
      detail: init.detail,
      status: init.status,
      latencyMs: init.latencyMs,
      requests,
      capabilities: {},
    }
  }

  const initResponse = parseJsonRpcBody(init.text, init.contentType, 1)
  if (initResponse !== null && initResponse.result !== undefined && !isInitializeResult(initResponse.result)) {
    // Well-formed JSON-RPC, but the result is not an MCP handshake. Anything
    // can echo `{"jsonrpc":"2.0","id":1,"result":{}}`; only a real server names
    // its protocol version and itself.
    return {
      ok: false,
      protocolOk: false,
      protocolLive: false,
      failure: 'bad-protocol',
      detail:
        'answered JSON-RPC but the initialize result carries no protocolVersion, serverInfo or capabilities, so it is not an MCP server',
      status: init.status,
      latencyMs: init.latencyMs,
      requests,
      capabilities: {},
    }
  }
  if (initResponse === null || initResponse.result === undefined) {
    const html = looksLikeHtml(init.text, init.contentType)
    return {
      ok: false,
      protocolOk: false,
      protocolLive: false,
      failure: html ? 'not-json' : 'bad-protocol',
      detail:
        initResponse?.error !== undefined
          ? `initialize returned JSON-RPC error ${initResponse.error.code ?? '?'}: ${initResponse.error.message ?? ''}`.trim()
          : html
            ? 'returned an HTML page where an MCP server was declared'
            : 'answered 200 but did not return a JSON-RPC initialize result',
      status: init.status,
      latencyMs: init.latencyMs,
      requests,
      capabilities: {},
    }
  }

  const sessionId = init.headers.get('mcp-session-id')
  const followUpHeaders: Record<string, string> = {
    ...jsonHeaders,
    'mcp-protocol-version': protocolVersionOf(initResponse.result) ?? MCP_PROTOCOL_VERSION,
  }
  if (sessionId !== null && sessionId !== '') followUpHeaders['mcp-session-id'] = sessionId

  // Notification, no id, no response expected. The spec requires it before any
  // other request, and strict servers reject `tools/list` without it.
  const notified = await httpRequestWithRetry(endpoint, {
    ...opts,
    method: 'POST',
    headers: followUpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  requests.push(notified.trace)

  const list = await httpRequestWithRetry(endpoint, {
    ...opts,
    method: 'POST',
    headers: followUpHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  })
  requests.push(list.trace)

  // The handshake succeeded, so the endpoint is alive and speaks MCP. A server
  // that then refuses `tools/list` is reported honestly: reachable, but with
  // nothing enumerated.
  const handshake = {
    ok: true,
    protocolOk: true,
    failure: null,
    status: init.status,
    latencyMs: Math.round((init.latencyMs + list.latencyMs) / 2),
    requests,
  } as const

  // The strict census counts an MCP face only when it enumerated at least one
  // tool. A server that greets you and then exposes nothing is reachable and
  // conformant, but there is nothing there to hire.
  if (!list.ok) {
    return {
      ...handshake,
      protocolLive: false,
      detail: `initialize succeeded; tools/list failed (${list.failure})`,
      capabilities: {},
    }
  }

  const listResponse = parseJsonRpcBody(list.text, list.contentType, 2)
  if (listResponse === null || listResponse.result === undefined) {
    const reason =
      listResponse?.error !== undefined
        ? `tools/list returned JSON-RPC error ${listResponse.error.code ?? '?'}`
        : 'tools/list did not return a JSON-RPC result'
    return { ...handshake, protocolLive: false, detail: `initialize succeeded; ${reason}`, capabilities: {} }
  }

  const tools = extractToolNames(listResponse.result)
  return { ...handshake, protocolLive: tools.length > 0, detail: null, capabilities: { mcpTools: tools } }
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

/**
 * A real `initialize` result names the protocol version and the server. An
 * empty object is a JSON-RPC endpoint that happened to answer, not an MCP one.
 */
export function isInitializeResult(result: unknown): boolean {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return false
  const record = result as Record<string, unknown>
  return (
    typeof record['protocolVersion'] === 'string' ||
    isNonEmptyObject(record['serverInfo']) ||
    isNonEmptyObject(record['capabilities'])
  )
}

function isNonEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
}

function protocolVersionOf(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const value = (result as Record<string, unknown>)['protocolVersion']
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function tryParse(text: string): JsonRpcResponse | null {
  try {
    return asResponse(JSON.parse(text))
  } catch {
    return null
  }
}

function asResponse(value: unknown): JsonRpcResponse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as JsonRpcResponse
}
