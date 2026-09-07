/**
 * The only place in the prober that calls `fetch`.
 *
 * Everything a hostile endpoint could do to us is bounded here: the request
 * gets one deadline for the whole redirect chain, the chain has a hop cap and
 * every hop is re-guarded, and the body stops being read at a byte cap rather
 * than at EOF. Failures come back classified instead of as an opaque
 * `TypeError: fetch failed`.
 */

import { guardUrl } from './guard.ts'
import type { DnsResolver } from './guard.ts'
import type { FailureClass, RequestTrace } from '../types.ts'

export type HttpOptions = {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxRedirects?: number
  maxBodyBytes?: number
  fetchImpl?: typeof fetch
  checkDns?: boolean
  resolver?: DnsResolver
  userAgent?: string
}

export type HttpOk = {
  ok: true
  status: number
  headers: Headers
  text: string
  bytes: number
  truncated: boolean
  contentType: string | null
  finalUrl: string
  redirects: number
  latencyMs: number
  trace: RequestTrace
}

export type HttpFail = {
  ok: false
  failure: FailureClass
  detail: string
  status: number | null
  latencyMs: number
  redirects: number
  trace: RequestTrace
  /**
   * Populated when the server actually answered (4xx/5xx). x402 lives entirely
   * inside a 402, so an error status still has to hand back its body.
   */
  headers: Headers | null
  text: string
  contentType: string | null
}

export type HttpResult = HttpOk | HttpFail

export const DEFAULT_TIMEOUT_MS = 5_000
export const DEFAULT_MAX_REDIRECTS = 3
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024
export const DEFAULT_USER_AGENT = 'hallmark-prober/0.1 (+https://github.com/hallmark; ERC-8004 liveness probe)'

/** Transport failures worth one more try; everything else is a settled answer. */
const RETRYABLE: ReadonlySet<FailureClass> = new Set<FailureClass>(['timeout', 'network'])

/**
 * One guarded request, following redirects manually so every hop is checked.
 * Never throws: a failure is a classified result.
 */
export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const method = opts.method ?? 'GET'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const startedAt = now()

  const fail = (failure: FailureClass, detail: string, status: number | null, redirects: number): HttpFail => {
    const latencyMs = Math.round(now() - startedAt)
    return {
      ok: false,
      failure,
      detail,
      status,
      latencyMs,
      redirects,
      headers: null,
      text: '',
      contentType: null,
      trace: {
        url,
        method,
        status,
        latencyMs,
        contentType: null,
        bytes: 0,
        redirects,
        failure,
        detail,
      },
    }
  }

  if (typeof fetchImpl !== 'function') {
    return fail('network', 'no fetch implementation available', null, 0)
  }

  const deadline = startedAt + timeoutMs
  let current = url
  let redirects = 0
  let currentMethod: 'GET' | 'POST' = method
  let currentBody = opts.body

  for (;;) {
    const guard = await guardUrl(current, {
      ...(opts.checkDns === undefined ? {} : { checkDns: opts.checkDns }),
      ...(opts.resolver === undefined ? {} : { resolver: opts.resolver }),
    })
    if (!guard.allowed) {
      return fail(guardFailureClass(guard.reason), guard.reason, null, redirects)
    }

    const remaining = deadline - now()
    if (remaining <= 0) return fail('timeout', `exceeded ${timeoutMs}ms budget`, null, redirects)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remaining)

    let res: Response
    try {
      const init: RequestInit = {
        method: currentMethod,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': opts.userAgent ?? DEFAULT_USER_AGENT,
          'accept-encoding': 'gzip, deflate',
          ...opts.headers,
        },
      }
      if (currentBody !== undefined && currentMethod === 'POST') init.body = currentBody
      res = await fetchImpl(guard.url.toString(), init)
    } catch (err) {
      clearTimeout(timer)
      const classified = classifyTransportError(err, controller.signal.aborted, timeoutMs)
      return fail(classified.failure, classified.detail, null, redirects)
    } finally {
      clearTimeout(timer)
    }

    if (isRedirect(res.status)) {
      const location = res.headers.get('location')
      await res.body?.cancel().catch(() => undefined)
      if (location === null || location.trim() === '') {
        return fail('bad-protocol', `HTTP ${res.status} with no Location header`, res.status, redirects)
      }
      if (redirects >= maxRedirects) {
        return fail('too-many-redirects', `more than ${maxRedirects} redirects`, res.status, redirects)
      }
      let next: string
      try {
        next = new URL(location, guard.url).toString()
      } catch {
        return fail('bad-protocol', `unparseable Location "${truncate(location)}"`, res.status, redirects)
      }
      // Browser semantics: 303 (and, by long convention, 301/302) demote the
      // method to GET and drop the body; 307/308 replay it verbatim.
      if (currentMethod === 'POST' && res.status !== 307 && res.status !== 308) {
        currentMethod = 'GET'
        currentBody = undefined
      }
      current = next
      redirects += 1
      continue
    }

    const body = await readCapped(res, maxBodyBytes, deadline)
    const latencyMs = Math.round(now() - startedAt)
    const contentType = res.headers.get('content-type')

    if (body.error !== null) {
      return fail(body.error === 'too-large' ? 'too-large' : 'network', body.detail, res.status, redirects)
    }

    const trace: RequestTrace = {
      url: guard.url.toString(),
      method,
      status: res.status,
      latencyMs,
      contentType,
      bytes: body.bytes,
      redirects,
      failure: httpFailureFor(res.status),
      detail: null,
    }

    if (res.status >= 400) {
      return {
        ok: false,
        failure: res.status >= 500 ? 'http-5xx' : 'http-4xx',
        detail: `HTTP ${res.status}`,
        status: res.status,
        latencyMs,
        redirects,
        trace,
        headers: res.headers,
        text: body.text,
        contentType,
      }
    }

    return {
      ok: true,
      status: res.status,
      headers: res.headers,
      text: body.text,
      bytes: body.bytes,
      truncated: body.truncated,
      contentType,
      finalUrl: guard.url.toString(),
      redirects,
      latencyMs,
      trace,
    }
  }
}

/** `httpRequest` with a single retry on a transient transport failure. */
export async function httpRequestWithRetry(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const first = await httpRequest(url, opts)
  if (first.ok || !RETRYABLE.has(first.failure)) return first
  const second = await httpRequest(url, opts)
  if (second.ok) return second
  return {
    ...second,
    detail: `${second.detail} (retried once after ${first.failure})`,
    trace: { ...second.trace, detail: `${second.detail} (retried once after ${first.failure})` },
  }
}

/** A `fetch`-shaped wrapper so third-party helpers inherit the same guard. */
export function guardedFetch(opts: HttpOptions = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'POST') {
      throw new Error(`hallmark-prober refuses ${method}; probes are read-only`)
    }
    const result = await httpRequest(url, { ...opts, method })
    if (!result.ok) throw new Error(`${result.failure}: ${result.detail}`)
    return new Response(result.text, { status: result.status, headers: result.headers })
  }) as typeof fetch
}

export function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) return false
  const value = contentType.toLowerCase()
  return value.includes('application/json') || value.includes('+json') || value.includes('application/jsonl')
}

export function isEventStream(contentType: string | null): boolean {
  return contentType !== null && contentType.toLowerCase().includes('text/event-stream')
}

export function looksLikeHtml(text: string, contentType: string | null): boolean {
  if (contentType !== null && contentType.toLowerCase().includes('text/html')) return true
  return /^\s*(<!doctype html|<html\b)/i.test(text)
}

/** Classify a transport-level throw from `fetch`. Node buries the real code in `cause`. */
export function classifyTransportError(
  err: unknown,
  aborted: boolean,
  timeoutMs: number,
): { failure: FailureClass; detail: string } {
  if (aborted || isAbort(err)) {
    return { failure: 'timeout', detail: `no response within ${timeoutMs}ms` }
  }

  const code = errorCode(err)
  const message = messageOf(err)
  const haystack = `${code ?? ''} ${message}`.toUpperCase()

  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_NODATA|GETADDRINFO/.test(haystack)) {
    return { failure: 'dns', detail: `DNS lookup failed (${code ?? message})` }
  }
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|EADDRNOTAVAIL/.test(haystack)) {
    return { failure: 'refused', detail: `connection refused or unroutable (${code ?? message})` }
  }
  if (/CERT|SSL|TLS|EPROTO|ERR_TLS|SELF_SIGNED|UNABLE_TO_VERIFY|WRONG_VERSION_NUMBER|DEPTH_ZERO/.test(haystack)) {
    return { failure: 'tls', detail: `TLS handshake failed (${code ?? message})` }
  }
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|TIMEOUT/.test(haystack)) {
    return { failure: 'timeout', detail: `connection timed out (${code ?? message})` }
  }
  return { failure: 'network', detail: code === null ? message : `${code}: ${message}` }
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

type CappedBody = { text: string; bytes: number; truncated: boolean; error: 'too-large' | 'read' | null; detail: string }

async function readCapped(res: Response, maxBytes: number, deadline: number): Promise<CappedBody> {
  const empty: CappedBody = { text: '', bytes: 0, truncated: false, error: null, detail: '' }
  if (res.body === null) {
    // Some fetch mocks return a Response with a string body and no stream.
    try {
      const text = await res.text()
      return { text, bytes: byteLength(text), truncated: false, error: null, detail: '' }
    } catch {
      return empty
    }
  }

  const declared = Number(res.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body.cancel().catch(() => undefined)
    return { ...empty, error: 'too-large', detail: `Content-Length ${declared} exceeds the ${maxBytes} byte cap` }
  }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (now() > deadline) {
        await reader.cancel().catch(() => undefined)
        return { ...empty, error: 'read', detail: 'response body exceeded the request deadline' }
      }
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return { ...empty, error: 'too-large', detail: `body exceeded the ${maxBytes} byte cap` }
      }
      chunks.push(value)
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined)
    return { ...empty, error: 'read', detail: `failed reading body: ${messageOf(err)}` }
  }

  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(joined), bytes: total, truncated: false, error: null, detail: '' }
}

/**
 * The guard refuses for three different reasons and they are not the same
 * failure: a hostname that does not resolve is `dns`, a scheme we do not speak
 * is `unsupported-scheme`, and a host pointing into private space is `blocked`.
 * Collapsing them would make the breakdown lie.
 */
export function guardFailureClass(reason: string): FailureClass {
  if (/^DNS lookup (failed|returned no addresses)/i.test(reason)) return 'dns'
  if (/^refusing scheme|^not a URL|^URL has no host/i.test(reason)) return 'unsupported-scheme'
  return 'blocked'
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function httpFailureFor(status: number): FailureClass | null {
  if (status >= 500) return 'http-5xx'
  if (status >= 400) return 'http-4xx'
  return null
}

function isAbort(err: unknown): boolean {
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return true
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError'
}

function errorCode(err: unknown): string | null {
  let cursor: unknown = err
  for (let depth = 0; depth < 4 && cursor !== null && cursor !== undefined; depth += 1) {
    const code = (cursor as { code?: unknown }).code
    if (typeof code === 'string') return code
    cursor = (cursor as { cause?: unknown }).cause
  }
  return null
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message !== err.message) return `${err.message}: ${cause.message}`
    return err.message
  }
  return String(err)
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function truncate(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`
}

function now(): number {
  return typeof performance === 'object' ? performance.now() : Date.now()
}
