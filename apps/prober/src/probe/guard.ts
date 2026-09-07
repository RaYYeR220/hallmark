/**
 * The prober is a service that takes a URL from an untrusted on-chain record
 * and fetches it. That is textbook SSRF, so every URL crosses this file first
 * and nothing else in the package is allowed to call `fetch` directly.
 *
 * Two checks, and both matter:
 *
 *  1. The literal host. `http://127.0.0.1:6379` is refused outright.
 *  2. What the host resolves to. `http://evil.example` whose A record is
 *     `169.254.169.254` is the interesting attack, and only a DNS lookup
 *     catches it. Redirects are re-checked hop by hop for the same reason.
 */

export type GuardVerdict = { allowed: true; url: URL } | { allowed: false; reason: string }

export type DnsResolver = (hostname: string) => Promise<string[]>

export type GuardOptions = {
  /** Resolve the hostname and check every address it points at. Default true. */
  checkDns?: boolean
  resolver?: DnsResolver
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** Suffix match, so `db.internal` and `foo.bar.local` are both caught. */
const PRIVATE_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.intranet',
  '.private',
  '.home.arpa',
  '.lan',
  '.corp',
  '.in-addr.arpa',
  '.ip6.arpa',
]

const PRIVATE_HOSTS = new Set(['localhost', 'local', 'ip6-localhost', 'ip6-loopback', 'broadcasthost'])

/**
 * IPv4 ranges that must never be contacted, as [firstOctetMatch, prefix length].
 * Includes the cloud metadata address (169.254.169.254) via link-local.
 */
const BLOCKED_V4: Array<{ cidr: string; label: string }> = [
  { cidr: '0.0.0.0/8', label: 'this-network' },
  { cidr: '10.0.0.0/8', label: 'private' },
  { cidr: '100.64.0.0/10', label: 'carrier-grade NAT' },
  { cidr: '127.0.0.0/8', label: 'loopback' },
  { cidr: '169.254.0.0/16', label: 'link-local / cloud metadata' },
  { cidr: '172.16.0.0/12', label: 'private' },
  { cidr: '192.0.0.0/24', label: 'IETF protocol assignments' },
  { cidr: '192.0.2.0/24', label: 'documentation' },
  { cidr: '192.168.0.0/16', label: 'private' },
  { cidr: '198.18.0.0/15', label: 'benchmarking' },
  { cidr: '198.51.100.0/24', label: 'documentation' },
  { cidr: '203.0.113.0/24', label: 'documentation' },
  { cidr: '224.0.0.0/4', label: 'multicast' },
  { cidr: '240.0.0.0/4', label: 'reserved' },
]

let cachedResolver: DnsResolver | null | undefined

/** Syntactic checks only. Cheap, synchronous, and enough to reject most junk. */
export function guardUrlSync(input: string): GuardVerdict {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return { allowed: false, reason: `not a URL: ${truncate(input)}` }
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol.toLowerCase())) {
    return { allowed: false, reason: `refusing scheme ${url.protocol.replace(':', '')}; only http and https are probed` }
  }

  if (url.username !== '' || url.password !== '') {
    return { allowed: false, reason: 'refusing a URL carrying inline credentials' }
  }

  const host = normalizeHost(url.hostname)
  if (host === '') return { allowed: false, reason: 'URL has no host' }

  if (PRIVATE_HOSTS.has(host)) {
    return { allowed: false, reason: `refusing private host "${host}"` }
  }
  for (const suffix of PRIVATE_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return { allowed: false, reason: `refusing private host "${host}" (${suffix})` }
    }
  }

  const literal = classifyIpLiteral(host)
  if (literal !== null) {
    if (literal.blocked) {
      return { allowed: false, reason: `refusing ${literal.label} address ${host}` }
    }
  }

  return { allowed: true, url }
}

/** Syntactic checks plus a DNS lookup of every address the host resolves to. */
export async function guardUrl(input: string, opts: GuardOptions = {}): Promise<GuardVerdict> {
  const sync = guardUrlSync(input)
  if (!sync.allowed) return sync

  if (opts.checkDns === false) return sync

  const host = normalizeHost(sync.url.hostname)
  // A literal already went through `classifyIpLiteral`; there is nothing to resolve.
  if (classifyIpLiteral(host) !== null) return sync

  const resolver = opts.resolver ?? (await defaultResolver())
  if (resolver === null) return sync

  let addresses: string[]
  try {
    addresses = await resolver(host)
  } catch (err) {
    return { allowed: false, reason: `DNS lookup failed for ${host}: ${messageOf(err)}` }
  }

  if (addresses.length === 0) {
    return { allowed: false, reason: `DNS lookup returned no addresses for ${host}` }
  }

  for (const address of addresses) {
    const verdict = classifyIpLiteral(normalizeHost(address))
    if (verdict !== null && verdict.blocked) {
      return { allowed: false, reason: `${host} resolves to ${verdict.label} address ${address}` }
    }
  }

  return sync
}

/** True when the address is one the prober must never contact. */
export function isPrivateAddress(address: string): boolean {
  const verdict = classifyIpLiteral(normalizeHost(address))
  return verdict !== null && verdict.blocked
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function normalizeHost(hostname: string): string {
  let host = hostname.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

type IpVerdict = { blocked: boolean; label: string }

function classifyIpLiteral(host: string): IpVerdict | null {
  // `2130706433`, `0177.0.0.1` and `0x7f000001` are all loopback in disguise.
  // Decoding every legacy inet_aton form correctly is a losing game, so any
  // host that is purely numeric or hex is refused instead of interpreted.
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host) || /^0\d+(\.|$)/.test(host)) {
    return { blocked: true, label: 'obfuscated numeric' }
  }

  const v4 = parseIpv4(host)
  if (v4 !== null) return classifyV4(v4)

  if (!host.includes(':')) return null

  // `::ffff:127.0.0.1` and `::ffff:7f00:1` are loopback wearing a hat.
  const mapped = /^::ffff:(.+)$/i.exec(host)
  if (mapped?.[1] !== undefined) {
    const inner = parseIpv4(mapped[1])
    if (inner !== null) return classifyV4(inner)
  }

  const groups = expandIpv6(host)
  if (groups === null) return { blocked: true, label: 'unparseable IPv6' }

  const first = groups[0] ?? 0
  const isZero = groups.every((g) => g === 0)
  if (isZero) return { blocked: true, label: 'unspecified IPv6' }
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return { blocked: true, label: 'IPv6 loopback' }
  }
  // fc00::/7 unique-local, fe80::/10 link-local.
  if ((first & 0xfe00) === 0xfc00) return { blocked: true, label: 'IPv6 unique-local' }
  if ((first & 0xffc0) === 0xfe80) return { blocked: true, label: 'IPv6 link-local' }
  // ::ffff:0:0/96 with a non-v4 tail, plus the v4-compatible ::a.b.c.d form.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const packed = ((groups[6] ?? 0) << 16) | (groups[7] ?? 0)
    return classifyV4(packed >>> 0)
  }
  if (groups.slice(0, 6).every((g) => g === 0)) {
    const packed = ((groups[6] ?? 0) << 16) | (groups[7] ?? 0)
    return classifyV4(packed >>> 0)
  }
  if (first === 0xff00 || (first & 0xff00) === 0xff00) return { blocked: true, label: 'IPv6 multicast' }

  return { blocked: false, label: 'IPv6 global unicast' }
}

function classifyV4(value: number): IpVerdict {
  for (const range of BLOCKED_V4) {
    if (inCidr(value, range.cidr)) return { blocked: true, label: range.label }
  }
  if (value === 0xffffffff) return { blocked: true, label: 'broadcast' }
  return { blocked: false, label: 'public IPv4' }
}

function inCidr(value: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/')
  const bits = Number(bitsRaw)
  const baseValue = parseIpv4(base ?? '')
  if (baseValue === null || !Number.isInteger(bits)) return false
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0)
}

/** Dotted quad only. Octal and integer forms are refused upstream, not decoded here. */
function parseIpv4(host: string): number | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8) | octet
  }
  return value >>> 0
}

function expandIpv6(host: string): number[] | null {
  const withoutZone = host.split('%')[0] ?? host
  const halves = withoutZone.split('::')
  if (halves.length > 2) return null

  const toGroups = (segment: string): number[] | null => {
    if (segment === '') return []
    const out: number[] = []
    for (const piece of segment.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null
      out.push(Number.parseInt(piece, 16))
    }
    return out
  }

  if (halves.length === 1) {
    const groups = toGroups(withoutZone)
    return groups !== null && groups.length === 8 ? groups : null
  }

  const head = toGroups(halves[0] ?? '')
  const tail = toGroups(halves[1] ?? '')
  if (head === null || tail === null) return null
  const fill = 8 - head.length - tail.length
  if (fill < 0) return null
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail]
}

async function defaultResolver(): Promise<DnsResolver | null> {
  if (cachedResolver !== undefined) return cachedResolver
  try {
    const dns = await import('node:dns/promises')
    cachedResolver = async (hostname: string) => {
      const records = await dns.lookup(hostname, { all: true, verbatim: true })
      return records.map((r) => r.address)
    }
  } catch {
    // Non-Node runtime. The syntactic checks still apply; DNS rebinding is not
    // defensible from here, and the README says so rather than pretending.
    cachedResolver = null
  }
  return cachedResolver
}

function truncate(value: string): string {
  return value.length <= 80 ? value : `${value.slice(0, 77)}...`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
