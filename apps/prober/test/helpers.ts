/**
 * Test scaffolding. The whole suite runs with the network stubbed: a probe
 * that reaches the internet during `vitest run` is a flake, and a flaky
 * liveness prober is a contradiction in terms.
 */

import type { DnsResolver } from '../src/probe/guard.ts'
import type { EndpointProbe, ProbeCapabilities } from '../src/types.ts'

export type StubResponse = {
  status?: number
  headers?: Record<string, string>
  body?: string
  /** Throw instead of answering, to exercise the transport classifier. */
  throws?: Error
  /** Never resolve, so the request hits its deadline. */
  hangs?: boolean
}

export type StubRoute = StubResponse | ((url: string, init: RequestInit | undefined) => StubResponse)

export type FetchStub = {
  fetch: typeof fetch
  calls: Array<{ url: string; method: string; body: string | null; headers: Record<string, string> }>
}

/** Routes are matched by exact URL first, then by substring. */
export function stubFetch(routes: Record<string, StubRoute>, fallback?: StubRoute): FetchStub {
  const calls: FetchStub['calls'] = []

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({
      url,
      method,
      body: typeof init?.body === 'string' ? init.body : null,
      headers: normalizeHeaders(init?.headers),
    })

    const route =
      routes[url] ?? Object.entries(routes).find(([pattern]) => url.includes(pattern))?.[1] ?? fallback
    if (route === undefined) {
      const err = new Error('getaddrinfo ENOTFOUND unrouted.test') as Error & { code: string }
      err.code = 'ENOTFOUND'
      throw err
    }

    const resolved = typeof route === 'function' ? route(url, init) : route
    if (resolved.throws !== undefined) throw resolved.throws
    if (resolved.hangs === true) {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }

    // A 204/205/304 Response must be constructed with a null body, and an
    // empty string is not null as far as the Response constructor cares.
    const body = resolved.body === undefined || resolved.body === '' ? null : resolved.body
    return new Response(body, {
      status: resolved.status ?? 200,
      headers: resolved.headers ?? { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  return { fetch: impl, calls }
}

/** Everything resolves to a public address unless the map says otherwise. */
export function stubResolver(map: Record<string, string[]> = {}): DnsResolver {
  return async (hostname: string) => map[hostname] ?? ['93.184.216.34']
}

export function transportError(code: string, message = code): Error {
  const err = new Error('fetch failed')
  const cause = new Error(message) as Error & { code: string }
  cause.code = code
  ;(err as Error & { cause: unknown }).cause = cause
  return err
}

export function endpointProbe(overrides: Partial<EndpointProbe> = {}): EndpointProbe {
  return {
    endpoint: 'https://agent.test/a2a',
    kind: 'a2a',
    ok: true,
    latencyMs: 100,
    failure: null,
    protocolOk: true,
    scored: true,
    requests: [],
    ...overrides,
  }
}

export function capabilities(overrides: ProbeCapabilities = {}): ProbeCapabilities {
  return { ...overrides }
}

function normalizeHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {}
  if (headers instanceof Headers) {
    const out: Record<string, string> = {}
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value
    })
    return out
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
}
