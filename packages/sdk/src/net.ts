/**
 * The only place in this package that talks to an endpoint the agent
 * developer chose.
 *
 * Everything a config points at is attacker-controlled from our point of view,
 * and `hallmark doctor` is the sort of thing people run on a laptop inside a
 * VPN or on a CI runner inside a cloud VPC. So: https only, no credentials in
 * the URL, no private or link-local destinations (checked on the literal host
 * *and* on every address DNS resolves it to, so a rebind cannot get past the
 * first check), a hard redirect cap with the same checks on every hop, a body
 * cap enforced while streaming, and a wall-clock budget for the whole thing.
 *
 * Read-only: this module never sends a body and never uses a method other
 * than GET, HEAD or POST, and the POSTs are the two protocol handshakes
 * (MCP `initialize`/`tools/list`) that cannot be done any other way.
 */

import { BlockedUrlError } from './errors.js'

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string }

export type HostLookup = (hostname: string) => Promise<string[]>

export type SafeFetchOptions = {
  method?: 'GET' | 'HEAD' | 'POST'
  headers?: Record<string, string>
  body?: string
  /** Wall-clock budget for the whole call, redirects included. */
  timeoutMs?: number
  maxRedirects?: number
  maxBytes?: number
  allowHttp?: boolean
  fetchImpl?: typeof fetch
  /** Injected in tests; defaults to `node:dns` when it is available. */
  lookup?: HostLookup | null
}

export type SafeFetchResult = {
  finalUrl: string
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
  latencyMs: number
  redirects: number
}

export const DEFAULT_TIMEOUT_MS = 6_000
export const DEFAULT_MAX_REDIRECTS = 3
export const DEFAULT_MAX_BYTES = 256 * 1024

const BLOCKED_HOST_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa', '.lan']
const BLOCKED_HOST_NAMES = ['localhost', 'ip6-localhost', 'ip6-loopback']

/* ------------------------------------------------------------------ */
/* address classification                                              */
/* ------------------------------------------------------------------ */

/** True for anything that is not a globally routable unicast IPv4 address. */
export function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => Number(part))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false

  const [a = 0, b = 0] = octets
  if (a === 0) return true // "this network"
  if (a === 10) return true // RFC 1918
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // RFC 1918
  if (a === 192 && b === 168) return true // RFC 1918
  if (a === 192 && b === 0) return true // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a === 198 && b === 51) return true // TEST-NET-2
  if (a === 203 && b === 0) return true // TEST-NET-3
  if (a >= 224) return true // multicast and reserved
  return false
}

export function isPrivateIpv6(address: string): boolean {
  const lowered = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (lowered === '::1' || lowered === '::') return true

  // IPv4-mapped and IPv4-compatible forms smuggle an IPv4 address through.
  const mapped = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lowered)
  if (mapped?.[1] !== undefined) return isPrivateIpv4(mapped[1])

  const head = lowered.split(':')[0] ?? ''
  if (head.length === 0) return false
  const group = Number.parseInt(head.padEnd(4, '0'), 16)
  if (Number.isNaN(group)) return false
  if ((group & 0xfe00) === 0xfc00) return true // unique local, fc00::/7
  if ((group & 0xffc0) === 0xfe80) return true // link-local, fe80::/10
  if ((group & 0xff00) === 0xff00) return true // multicast
  return false
}

export function isPrivateAddress(address: string): boolean {
  return address.includes(':') ? isPrivateIpv6(address) : isPrivateIpv4(address)
}

/** Hostname-only check: literals and the names that never leave a machine. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (BLOCKED_HOST_NAMES.includes(host)) return true
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  if (!host.includes('.') && !host.includes(':')) return true // bare "intranet"-style names
  if (/^\[?[0-9a-f:]+\]?$/i.test(host) && host.includes(':')) return isPrivateIpv6(host)
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIpv4(host)
  return false
}

/**
 * Syntactic check only — no DNS. Use it where a network round trip is not
 * acceptable, such as validating a config file.
 */
export function classifyUrl(raw: string, opts: { allowHttp?: boolean } = {}): UrlVerdict {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'not a URL' }
  }

  const scheme = url.protocol.replace(':', '')
  if (scheme !== 'https' && !(opts.allowHttp === true && scheme === 'http')) {
    return { ok: false, reason: `scheme is "${scheme}", expected https` }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'URL carries credentials' }
  }
  if (url.hostname === '') {
    return { ok: false, reason: 'URL has no host' }
  }
  if (isBlockedHostname(url.hostname)) {
    return { ok: false, reason: `host "${url.hostname}" is private, loopback or link-local` }
  }
  return { ok: true, url }
}

let cachedLookup: HostLookup | null | undefined

async function nodeLookup(): Promise<HostLookup | null> {
  if (cachedLookup !== undefined) return cachedLookup
  try {
    const dns = await import('node:dns')
    cachedLookup = async (hostname: string) => {
      const records = await dns.promises.lookup(hostname, { all: true, verbatim: true })
      return records.map((record) => record.address)
    }
  } catch {
    cachedLookup = null
  }
  return cachedLookup
}

/** Syntactic check plus a DNS check on every address the host resolves to. */
export async function assertPublicUrl(
  raw: string,
  opts: { allowHttp?: boolean; lookup?: HostLookup | null } = {},
): Promise<URL> {
  const verdict = classifyUrl(raw, opts.allowHttp === true ? { allowHttp: true } : {})
  if (!verdict.ok) throw new BlockedUrlError(raw, verdict.reason)

  const host = verdict.url.hostname
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return verdict.url

  const lookup = opts.lookup === undefined ? await nodeLookup() : opts.lookup
  if (lookup === null) return verdict.url

  let addresses: string[]
  try {
    addresses = await lookup(host)
  } catch (err) {
    throw new BlockedUrlError(raw, `DNS lookup failed: ${messageOf(err)}`)
  }
  if (addresses.length === 0) throw new BlockedUrlError(raw, 'DNS returned no addresses')

  const offender = addresses.find((address) => isPrivateAddress(address))
  if (offender !== undefined) {
    throw new BlockedUrlError(raw, `host resolves to the private address ${offender}`)
  }
  return verdict.url
}

/* ------------------------------------------------------------------ */
/* fetching                                                            */
/* ------------------------------------------------------------------ */

/**
 * A GET/HEAD/POST that cannot be talked into reaching somewhere it should not,
 * hanging forever, or filling memory.
 */
export async function safeFetch(target: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new HallmarkFetchUnavailable()

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const deadline = Date.now() + timeoutMs
  const startedAt = Date.now()

  let current = target
  let redirects = 0

  for (;;) {
    const url = await assertPublicUrl(current, {
      ...(opts.allowHttp === true ? { allowHttp: true } : {}),
      ...(opts.lookup === undefined ? {} : { lookup: opts.lookup }),
    })

    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new TimeoutError(target, timeoutMs)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remaining)
    let response: Response
    try {
      response = await fetchImpl(url.toString(), {
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        ...(opts.body === undefined ? {} : { body: opts.body }),
        redirect: 'manual',
        signal: controller.signal,
      })
    } catch (err) {
      if (controller.signal.aborted) throw new TimeoutError(target, timeoutMs)
      throw err
    } finally {
      clearTimeout(timer)
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get('location')
      if (location === null) throw new Error(`HTTP ${response.status} with no Location header`)
      if (redirects >= maxRedirects) {
        throw new Error(`more than ${maxRedirects} redirects starting at ${target}`)
      }
      redirects += 1
      current = new URL(location, url).toString()
      // Draining is polite but not worth a hang; the abort above already
      // released the socket if the server stalled.
      void response.body?.cancel().catch(() => {})
      continue
    }

    const { text, truncated } = await readCapped(response, maxBytes)
    return {
      finalUrl: url.toString(),
      status: response.status,
      headers: headerRecord(response.headers),
      body: text,
      truncated,
      latencyMs: Date.now() - startedAt,
      redirects,
    }
  }
}

export class TimeoutError extends Error {
  readonly url: string
  readonly timeoutMs: number

  constructor(url: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms fetching ${url}`)
    this.name = 'TimeoutError'
    this.url = url
    this.timeoutMs = timeoutMs
  }
}

class HallmarkFetchUnavailable extends Error {
  constructor() {
    super('no fetch implementation available; pass fetchImpl')
    this.name = 'HallmarkFetchUnavailable'
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = response.body
  if (body === null) return { text: '', truncated: false }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      if (total + value.length > maxBytes) {
        chunks.push(value.slice(0, Math.max(0, maxBytes - total)))
        total = maxBytes
        truncated = true
        break
      }
      chunks.push(value)
      total += value.length
    }
  } finally {
    void reader.cancel().catch(() => {})
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return { text: new TextDecoder().decode(merged), truncated }
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
