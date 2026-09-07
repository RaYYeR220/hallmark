import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Hono } from 'hono'

import { buildApp } from '../src/app.js'
import { loadTimeouts, withDeadline, type Timeouts } from '../src/runtime/deadline.js'

/**
 * The Vercel entry point, and its own Node-to-Web adapter.
 *
 * ## Why this is hand-written
 *
 * `@hono/node-server/vercel`'s `handle` builds the Web `Request` body with
 * `Readable.toWeb(incoming)`. That is correct for a plain Node server and
 * wrong here, because Vercel's Node runtime has *already* read the request
 * body to populate `req.body` before the function is invoked. The stream it
 * hands over is drained, and converting a drained stream gives a body that
 * either yields nothing or — as it did in production — never settles at all.
 *
 * The symptom was precise: every route that reads a body hung, and every route
 * that does not read one worked. `GET` on the cards and the A2A endpoint were
 * fine; an unpaid `POST /x402/...` was fine, because it answers 402 before
 * touching the body; `POST /mcp/{slug}` never answered, because both
 * `initialize` and `tools/list` have to be parsed before anything can happen.
 *
 * So the body is taken from where the platform actually put it — `req.body`,
 * or `req.rawBody`, or the stream only when it is genuinely still unread — and
 * a Request is built from those bytes. Nothing here depends on the stream
 * being in a particular state, which is the property that was missing.
 *
 * ## And why nothing here can hang
 *
 * Every wait is bounded: the body read, the app, and the request as a whole.
 * A deadline produces a 504 that says which stage ran out of time. That is
 * strictly better than holding the socket open, because a prober scores a hang
 * as a dead agent and a 504 as a slow one.
 *
 * ## Caveat worth stating rather than discovering
 *
 * Serverless instances do not share memory, so the default in-memory store
 * gives each invocation its own view. Grid state and `act` idempotency both
 * depend on the store, so a production deployment must set
 * `HALLMARK_STORE_PATH` — or swap in a shared `Store` — before either is
 * relied on.
 */

export const config = { runtime: 'nodejs' }

/** What Vercel's Node runtime adds to a plain `IncomingMessage`. */
type PlatformRequest = IncomingMessage & {
  /** Set by the platform's body parser, which consumes the stream to build it. */
  body?: unknown
  /** Set by some adapters instead of, or alongside, `body`. */
  rawBody?: Buffer | string
}

export type BodyRead =
  | { ok: true; bytes: Buffer; source: 'parsed' | 'raw' | 'stream' | 'empty' }
  | { ok: false; reason: string }

/**
 * The request body, from wherever the platform actually left it.
 *
 * Order matters. `req.body` is checked first because when it exists the stream
 * is already spent, and reading the stream in that state is the bug this
 * function exists to avoid. The stream is only touched when it is genuinely
 * unread, and even then with a deadline.
 */
export async function readBody(req: PlatformRequest, timeoutMs: number): Promise<BodyRead> {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return { ok: true, bytes: Buffer.alloc(0), source: 'empty' }

  // 1. The platform parsed it. The stream is gone; these are the bytes.
  const parsed = req.body
  if (parsed !== undefined && parsed !== null) {
    if (Buffer.isBuffer(parsed)) return { ok: true, bytes: parsed, source: 'parsed' }
    if (typeof parsed === 'string') return { ok: true, bytes: Buffer.from(parsed, 'utf8'), source: 'parsed' }
    if (typeof parsed === 'object') {
      // Vercel JSON-parses `application/json`. Re-serialising round-trips
      // losslessly for every content type this service accepts.
      try {
        return { ok: true, bytes: Buffer.from(JSON.stringify(parsed), 'utf8'), source: 'parsed' }
      } catch {
        return { ok: false, reason: 'the platform-parsed body could not be re-serialised' }
      }
    }
  }

  // 2. Some adapters keep the untouched bytes here.
  const raw = req.rawBody
  if (Buffer.isBuffer(raw)) return { ok: true, bytes: raw, source: 'raw' }
  if (typeof raw === 'string') return { ok: true, bytes: Buffer.from(raw, 'utf8'), source: 'raw' }

  // 3. Nobody kept the bytes and the stream has already ended: there is
  //    nothing to wait for, and waiting is precisely the failure mode.
  if (req.readableEnded || req.complete || req.destroyed) {
    return { ok: true, bytes: Buffer.alloc(0), source: 'empty' }
  }

  // 4. A genuinely unread stream. Drain it, with a deadline.
  const drained = await withDeadline(
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const onData = (chunk: Buffer | string) => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
      }
      const finish = () => {
        req.off('data', onData)
        req.off('end', finish)
        req.off('error', fail)
        resolve(Buffer.concat(chunks))
      }
      const fail = (error: Error) => {
        req.off('data', onData)
        req.off('end', finish)
        req.off('error', fail)
        reject(error)
      }
      req.on('data', onData)
      req.on('end', finish)
      req.on('error', fail)
    }),
    { label: 'request body', timeoutMs },
  ).catch((error: unknown) => ({
    ok: false as const,
    timedOut: true as const,
    label: error instanceof Error ? error.message : 'request body',
    timeoutMs,
  }))

  if (!drained.ok) {
    return { ok: false, reason: `the request body did not arrive within ${timeoutMs}ms` }
  }
  return { ok: true, bytes: drained.value, source: 'stream' }
}

/** The absolute URL Hono needs, from the headers a proxy actually sets. */
export function absoluteUrl(req: PlatformRequest): string {
  const path = req.url ?? '/'
  if (/^https?:\/\//i.test(path)) return path

  const header = (name: string): string | undefined => {
    const value = req.headers[name]
    return Array.isArray(value) ? value[0] : value
  }
  const forwardedProto = header('x-forwarded-proto')?.split(',')[0]?.trim()
  const proto =
    forwardedProto ??
    ((req.socket as { encrypted?: boolean } | undefined)?.encrypted === true ? 'https' : 'http')
  const host = header('x-forwarded-host') ?? header('host') ?? 'localhost'
  return `${proto}://${host}${path.startsWith('/') ? path : `/${path}`}`
}

function headersFrom(req: PlatformRequest): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    // Pseudo-headers from HTTP/2 are not valid Web header names.
    if (key.startsWith(':')) continue
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry)
    } else {
      headers.set(key, value)
    }
  }
  return headers
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer())

  const setCookie =
    typeof (response.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (response.headers as { getSetCookie: () => string[] }).getSetCookie()
      : []

  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === 'set-cookie') continue
    res.setHeader(key, value)
  }
  if (setCookie.length > 0) res.setHeader('set-cookie', setCookie)
  res.setHeader('content-length', String(body.byteLength))

  res.statusCode = response.status
  res.end(body)
}

function problem(res: ServerResponse, status: number, error: string, message: string): void {
  const body = Buffer.from(JSON.stringify({ error, message }), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.setHeader('content-length', String(body.byteLength))
  res.end(body)
}

export type HandlerDeps = { app?: Hono; timeouts?: Timeouts }

export function createHandler(deps: HandlerDeps = {}) {
  const app = deps.app ?? buildApp()
  const timeouts = deps.timeouts ?? loadTimeouts()

  return async function handler(req: PlatformRequest, res: ServerResponse): Promise<void> {
    const startedAt = Date.now()

    try {
      const body = await readBody(req, timeouts.body)
      if (!body.ok) {
        problem(res, 400, 'bad-request', body.reason)
        return
      }

      const method = (req.method ?? 'GET').toUpperCase()
      const request = new Request(absoluteUrl(req), {
        method,
        headers: headersFrom(req),
        // A Buffer is a Uint8Array, but only the latter is a `BodyInit`.
        ...(method === 'GET' || method === 'HEAD' || body.bytes.byteLength === 0
          ? {}
          : { body: new Uint8Array(body.bytes) }),
      })

      const remaining = Math.max(1_000, timeouts.request - (Date.now() - startedAt))
      const answered = await withDeadline(Promise.resolve(app.fetch(request)), {
        label: `${method} ${req.url ?? '/'}`,
        timeoutMs: remaining,
      })

      if (!answered.ok) {
        problem(
          res,
          504,
          'timeout',
          `This service did not finish ${answered.label} within ${answered.timeoutMs}ms and ` +
            'stopped waiting rather than hold the connection open. Nothing was left half-done: ' +
            'every write goes through an idempotent intent, so a retry with the same intentId ' +
            'is safe.',
        )
        return
      }

      await writeResponse(res, answered.value)
    } catch (error) {
      if (res.headersSent) {
        res.end()
        return
      }
      problem(
        res,
        500,
        'internal',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

export default createHandler()
