/**
 * ERC-8004 registration-file ("agent card") handling.
 *
 * What is actually on BNB Chain today is not what the EIP examples show:
 * tokenURIs come back gzip-compressed inside data URIs, with uppercase
 * schemes, as bare addresses, or as links to pages that never existed. Key
 * casing drifts between agents (`x402Support` / `x402support`,
 * `supportedTrust` / `supportedTrusts`, `services` / `endpoints`). Nothing in
 * here throws: a card either parses into a predictable shape with a list of
 * the compromises made, or it fails with a reason.
 */

export type AgentService = {
  name: string
  endpoint: string
  version?: string
  skills?: string[]
  domains?: string[]
}

export type AgentRegistration = {
  agentId: number | null
  agentRegistry: string
}

export type AgentCard = {
  type?: string
  name?: string
  description?: string
  image?: string
  services: AgentService[]
  x402Support: boolean
  active: boolean
  supportedTrust: string[]
  registrations: AgentRegistration[]
  /** Anything we did not recognise, preserved verbatim. */
  extra: Record<string, unknown>
}

export type TokenUriKind = 'data-json' | 'data-json-gzip' | 'http' | 'ipfs' | 'unknown'

export type ParseResult =
  | { ok: true; kind: TokenUriKind; card: AgentCard; warnings: string[] }
  | { ok: false; kind: TokenUriKind; error: string; raw: string }

export type EndpointKind = 'a2a' | 'mcp' | 'web' | 'x402' | 'oasf' | 'email' | 'ens' | 'did' | 'other'

export type ResolvedEndpoint = {
  kind: EndpointKind
  url: string
  version?: string
}

export type ResolveOptions = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  ipfsGateway?: string
}

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/'
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/
const CID_V1 = /^ba[a-z2-7]{57,}$/

export function classifyTokenUri(uri: string): TokenUriKind {
  const trimmed = uri.trim()
  if (trimmed.length === 0) return 'unknown'

  if (/^data:/i.test(trimmed)) {
    const comma = trimmed.indexOf(',')
    const header = comma === -1 ? trimmed.slice(5) : trimmed.slice(5, comma)
    const body = comma === -1 ? '' : trimmed.slice(comma + 1)
    const looksJson = /json/i.test(header) || /^\s*(\{|%7b)/i.test(body)
    if (!looksJson) return 'unknown'
    return isGzipHeader(header) ? 'data-json-gzip' : 'data-json'
  }

  if (/^https?:\/\//i.test(trimmed)) return 'http'
  if (/^ipfs:\/\//i.test(trimmed)) return 'ipfs'
  if (trimmed.startsWith('/ipfs/')) return 'ipfs'
  if (CID_V0.test(trimmed) || CID_V1.test(trimmed)) return 'ipfs'

  return 'unknown'
}

export function parseAgentCardFromTokenUri(uri: string): ParseResult {
  const trimmed = uri.trim()
  const kind = classifyTokenUri(trimmed)

  if (kind === 'http' || kind === 'ipfs') {
    return {
      ok: false,
      kind,
      error: `tokenURI points off-chain (${kind}); use resolveAgentCard() to fetch it`,
      raw: uri,
    }
  }
  if (kind === 'unknown') {
    return { ok: false, kind, error: describeGarbage(trimmed), raw: uri }
  }

  let text: string
  try {
    text = decodeDataUri(trimmed, kind === 'data-json-gzip')
  } catch (err) {
    return { ok: false, kind, error: `failed to decode data URI: ${messageOf(err)}`, raw: uri }
  }

  return parseJsonIntoResult(text, kind, uri)
}

export async function resolveAgentCard(uri: string, opts: ResolveOptions = {}): Promise<ParseResult> {
  const trimmed = uri.trim()
  const kind = classifyTokenUri(trimmed)

  if (kind === 'data-json') return parseAgentCardFromTokenUri(trimmed)

  if (kind === 'data-json-gzip') {
    const sync = parseAgentCardFromTokenUri(trimmed)
    if (sync.ok) return sync
    // No synchronous gunzip in this runtime (browser); fall back to the
    // streams API, which is async but universally available.
    try {
      const payload = dataUriPayload(trimmed)
      const inflated = await inflateAsync(payload)
      return parseJsonIntoResult(new TextDecoder().decode(inflated), kind, uri)
    } catch (err) {
      return { ok: false, kind, error: `failed to decompress data URI: ${messageOf(err)}`, raw: uri }
    }
  }

  if (kind === 'unknown') {
    return { ok: false, kind, error: describeGarbage(trimmed), raw: uri }
  }

  const url = kind === 'ipfs' ? ipfsToHttp(trimmed, opts.ipfsGateway ?? DEFAULT_IPFS_GATEWAY) : trimmed
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { ok: false, kind, error: 'no fetch implementation available', raw: uri }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json, text/plain;q=0.8, */*;q=0.5' },
      redirect: 'follow',
    })
    if (!res.ok) {
      return { ok: false, kind, error: `HTTP ${res.status} fetching ${url}`, raw: uri }
    }
    const text = await res.text()
    return parseJsonIntoResult(text, kind, uri)
  } catch (err) {
    return { ok: false, kind, error: `fetch failed for ${url}: ${messageOf(err)}`, raw: uri }
  } finally {
    clearTimeout(timer)
  }
}

export function normalizeCard(raw: unknown): { card: AgentCard; warnings: string[] } {
  const warnings: string[] = []
  const card: AgentCard = {
    services: [],
    x402Support: false,
    active: true,
    supportedTrust: [],
    registrations: [],
    extra: {},
  }

  if (!isRecord(raw)) {
    warnings.push(`registration file is ${describeType(raw)}, not an object; produced an empty card`)
    return { card, warnings }
  }

  const consumed = new Set<string>()
  const take = (...aliases: string[]): { key: string; value: unknown } | null => {
    for (const alias of aliases) {
      const hit = findKey(raw, alias)
      if (hit === null) continue
      consumed.add(hit)
      return { key: hit, value: raw[hit] }
    }
    return null
  }
  const noteAlias = (hit: { key: string }, canonical: string) => {
    if (hit.key !== canonical) warnings.push(`used "${hit.key}" as "${canonical}"`)
  }

  const typeHit = take('type')
  if (typeHit && typeof typeHit.value === 'string') card.type = typeHit.value

  for (const field of ['name', 'description', 'image'] as const) {
    const hit = take(field)
    if (!hit || hit.value === null || hit.value === undefined) continue
    noteAlias(hit, field)
    if (typeof hit.value === 'string') {
      card[field] = hit.value
    } else {
      warnings.push(`"${field}" was ${describeType(hit.value)}; stringified`)
      card[field] = String(hit.value)
    }
  }

  const servicesHit = take('services', 'endpoints')
  if (servicesHit === null) {
    warnings.push('no "services" or "endpoints" array; agent declares no reachable endpoint')
  } else {
    noteAlias(servicesHit, 'services')
    card.services = normalizeServices(servicesHit.value, warnings)
  }

  const x402Hit = take('x402Support', 'x402_support', 'x402_supported')
  if (x402Hit) {
    noteAlias(x402Hit, 'x402Support')
    card.x402Support = coerceBoolean(x402Hit.value, 'x402Support', warnings) ?? false
  }

  const activeHit = take('active', 'isActive', 'is_active')
  if (activeHit === null) {
    warnings.push('"active" missing; assuming true')
  } else {
    noteAlias(activeHit, 'active')
    card.active = coerceBoolean(activeHit.value, 'active', warnings) ?? true
  }

  const trustHit = take(
    'supportedTrust',
    'supportedTrusts',
    'supported_trust',
    'supportedTrustModels',
    'supported_trust_models',
  )
  if (trustHit) {
    noteAlias(trustHit, 'supportedTrust')
    card.supportedTrust = normalizeStringArray(trustHit.value, 'supportedTrust', warnings)
  }

  const regHit = take('registrations', 'registration')
  if (regHit) {
    noteAlias(regHit, 'registrations')
    card.registrations = normalizeRegistrations(regHit.value, warnings)
  }

  for (const [key, value] of Object.entries(raw)) {
    if (!consumed.has(key)) card.extra[key] = value
  }

  return { card, warnings }
}

export function endpointsOf(card: AgentCard): ResolvedEndpoint[] {
  return card.services.map((service) => {
    const kind = endpointKind(service.name, service.endpoint)
    return service.version === undefined
      ? { kind, url: service.endpoint }
      : { kind, url: service.endpoint, version: service.version }
  })
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function parseJsonIntoResult(text: string, kind: TokenUriKind, raw: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(text))
  } catch (err) {
    return { ok: false, kind, error: `invalid JSON: ${messageOf(err)}`, raw }
  }
  const { card, warnings } = normalizeCard(parsed)
  return { ok: true, kind, card, warnings }
}

function describeGarbage(uri: string): string {
  if (uri.length === 0) return 'tokenURI is empty'
  if (/^0x[0-9a-f]{40}$/i.test(uri)) return 'tokenURI is a bare address, not a registration file'
  if (/^0x[0-9a-f]+$/i.test(uri)) return 'tokenURI is a bare hex string, not a registration file'
  return `unrecognised tokenURI scheme: ${uri.slice(0, 64)}`
}

function isGzipHeader(header: string): boolean {
  return /(^|;)\s*enc\s*=\s*gzip\s*(;|$)/i.test(header) || /(^|;)\s*gzip\s*(;|$)/i.test(header)
}

function dataUriPayload(uri: string): Uint8Array {
  const comma = uri.indexOf(',')
  if (comma === -1) throw new Error('data URI has no comma separator')
  const header = uri.slice(5, comma)
  const body = uri.slice(comma + 1)
  return /;\s*base64/i.test(header) ? base64ToBytes(body) : utf8ToBytes(safeDecodeUriComponent(body))
}

function decodeDataUri(uri: string, gzipped: boolean): string {
  const bytes = dataUriPayload(uri)
  const decoded = gzipped || looksCompressed(bytes) ? inflateSync(bytes) : bytes
  return new TextDecoder().decode(decoded)
}

function looksCompressed(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

type ZlibLike = {
  gunzipSync: (data: Uint8Array) => Uint8Array
  inflateSync: (data: Uint8Array) => Uint8Array
}

function nodeZlib(): ZlibLike | null {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  const mod = proc?.getBuiltinModule?.('node:zlib')
  if (isRecord(mod) && typeof mod['gunzipSync'] === 'function') return mod as unknown as ZlibLike
  return null
}

function inflateSync(bytes: Uint8Array): Uint8Array {
  const zlib = nodeZlib()
  if (zlib === null) {
    throw new Error('gzip tokenURI needs a synchronous inflate; call resolveAgentCard() in this runtime')
  }
  return looksCompressed(bytes) ? zlib.gunzipSync(bytes) : zlib.inflateSync(bytes)
}

// Structural, so the package does not depend on DOM or node stream globals.
type DecompressionStreamCtor = new (format: string) => {
  readable: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } }
  writable: { getWriter: () => { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void> } }
}

async function inflateAsync(bytes: Uint8Array): Promise<Uint8Array> {
  const zlib = nodeZlib()
  if (zlib !== null) return looksCompressed(bytes) ? zlib.gunzipSync(bytes) : zlib.inflateSync(bytes)

  const ctor = (globalThis as { DecompressionStream?: DecompressionStreamCtor }).DecompressionStream
  if (ctor === undefined) throw new Error('no gzip support in this runtime')

  const format = looksCompressed(bytes) ? 'gzip' : 'deflate'
  const stream = new ctor(format)
  const writer = stream.writable.getWriter()
  void writer.write(bytes).then(() => writer.close())

  const chunks: Uint8Array[] = []
  const reader = stream.readable.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      chunks.push(value)
      total += value.length
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function base64ToBytes(input: string): Uint8Array {
  let normalized = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const remainder = normalized.length % 4
  if (remainder === 2) normalized += '=='
  else if (remainder === 3) normalized += '='
  else if (remainder === 1) throw new Error('base64 payload has a truncated final quantum')

  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function utf8ToBytes(input: string): Uint8Array {
  return new TextEncoder().encode(input)
}

function safeDecodeUriComponent(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function ipfsToHttp(uri: string, gateway: string): string {
  const base = gateway.endsWith('/') ? gateway : `${gateway}/`
  if (/^ipfs:\/\//i.test(uri)) {
    const rest = uri.slice(7).replace(/^ipfs\//i, '')
    return base + rest
  }
  if (uri.startsWith('/ipfs/')) return base + uri.slice(6)
  return base + uri
}

function normalizeServices(value: unknown, warnings: string[]): AgentService[] {
  if (!Array.isArray(value)) {
    warnings.push(`"services" was ${describeType(value)}, not an array; dropped`)
    return []
  }

  const services: AgentService[] = []
  value.forEach((entry, index) => {
    if (typeof entry === 'string') {
      warnings.push(`services[${index}] was a bare string; treated as an unnamed endpoint`)
      services.push({ name: 'other', endpoint: entry })
      return
    }
    if (!isRecord(entry)) {
      warnings.push(`services[${index}] was ${describeType(entry)}; dropped`)
      return
    }

    const endpoint = firstString(entry, ['endpoint', 'url', 'uri', 'address', 'href'])
    if (endpoint === null) {
      warnings.push(`services[${index}] has no endpoint/url; dropped`)
      return
    }
    if (endpoint.key !== 'endpoint') {
      warnings.push(`services[${index}] used "${endpoint.key}" as "endpoint"`)
    }

    const name = firstString(entry, ['name', 'type', 'kind', 'protocol'])
    if (name === null) {
      warnings.push(`services[${index}] has no name; labelled "other"`)
    } else if (name.key !== 'name') {
      warnings.push(`services[${index}] used "${name.key}" as "name"`)
    }

    const service: AgentService = {
      name: name?.value ?? 'other',
      endpoint: endpoint.value,
    }

    const version = firstString(entry, ['version'])
    if (version !== null) service.version = version.value

    const skills = entry['skills']
    if (skills !== undefined) {
      service.skills = normalizeStringArray(skills, `services[${index}].skills`, warnings)
    }
    const domains = entry['domains']
    if (domains !== undefined) {
      service.domains = normalizeStringArray(domains, `services[${index}].domains`, warnings)
    }

    services.push(service)
  })

  return services
}

function normalizeRegistrations(value: unknown, warnings: string[]): AgentRegistration[] {
  if (!Array.isArray(value)) {
    warnings.push(`"registrations" was ${describeType(value)}, not an array; dropped`)
    return []
  }

  const registrations: AgentRegistration[] = []
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`registrations[${index}] was ${describeType(entry)}; dropped`)
      return
    }

    const registryHit = firstString(entry, ['agentRegistry', 'registry', 'agent_registry', 'registryAddress'])
    if (registryHit === null) {
      warnings.push(`registrations[${index}] has no agentRegistry; kept with an empty registry`)
    } else if (registryHit.key !== 'agentRegistry') {
      warnings.push(`registrations[${index}] used "${registryHit.key}" as "agentRegistry"`)
    }

    const rawId = entry['agentId'] ?? entry['agent_id'] ?? null
    let agentId: number | null = null
    if (typeof rawId === 'number' && Number.isFinite(rawId)) {
      agentId = Math.trunc(rawId)
    } else if (typeof rawId === 'string' && rawId.trim() !== '') {
      const parsed = Number(rawId.trim())
      if (Number.isFinite(parsed)) {
        agentId = Math.trunc(parsed)
        warnings.push(`registrations[${index}].agentId was the string "${rawId}"; coerced to ${agentId}`)
      } else {
        warnings.push(`registrations[${index}].agentId "${rawId}" is not a number; treated as null`)
      }
    } else if (rawId !== null && rawId !== undefined) {
      warnings.push(`registrations[${index}].agentId was ${describeType(rawId)}; treated as null`)
    }

    registrations.push({ agentId, agentRegistry: registryHit?.value ?? '' })
  })

  return registrations
}

function normalizeStringArray(value: unknown, label: string, warnings: string[]): string[] {
  if (typeof value === 'string') {
    warnings.push(`"${label}" was a single string; wrapped in an array`)
    return [value]
  }
  if (!Array.isArray(value)) {
    warnings.push(`"${label}" was ${describeType(value)}, not an array; dropped`)
    return []
  }
  const out: string[] = []
  value.forEach((item, index) => {
    if (typeof item === 'string') out.push(item)
    else warnings.push(`"${label}"[${index}] was ${describeType(item)}; dropped`)
  })
  return out
}

function coerceBoolean(value: unknown, label: string, warnings: string[]): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y'].includes(lowered)) {
      warnings.push(`"${label}" was the string "${value}"; read as true`)
      return true
    }
    if (['false', '0', 'no', 'n', ''].includes(lowered)) {
      warnings.push(`"${label}" was the string "${value}"; read as false`)
      return false
    }
  }
  if (typeof value === 'number') {
    warnings.push(`"${label}" was the number ${value}; read as ${value !== 0}`)
    return value !== 0
  }
  if (value === null || value === undefined) return null
  warnings.push(`"${label}" was ${describeType(value)}; ignored`)
  return null
}

/** Case-insensitive key lookup so `X402Support` and `x402support` both land. */
function findKey(obj: Record<string, unknown>, alias: string): string | null {
  if (Object.prototype.hasOwnProperty.call(obj, alias)) return alias
  const lowered = alias.toLowerCase()
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === lowered) return key
  }
  return null
}

function firstString(obj: Record<string, unknown>, keys: string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const hit = findKey(obj, key)
    if (hit === null) continue
    const value = obj[hit]
    if (typeof value === 'string' && value.trim() !== '') return { key: hit, value }
  }
  return null
}

function endpointKind(name: string, endpoint: string): EndpointKind {
  const n = name.toLowerCase()
  if (n.includes('a2a')) return 'a2a'
  if (n.includes('mcp')) return 'mcp'
  if (n.includes('x402')) return 'x402'
  if (n.includes('oasf')) return 'oasf'
  if (n.includes('mail')) return 'email'
  if (n === 'ens' || n.includes('ensname')) return 'ens'
  if (n === 'did') return 'did'
  if (n === 'web' || n === 'website' || n === 'homepage') return 'web'

  const e = endpoint.trim()
  if (/^did:/i.test(e)) return 'did'
  if (/^mailto:/i.test(e)) return 'email'
  if (/\.eth$/i.test(e)) return 'ens'
  if (!e.includes('://') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'email'
  return 'other'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
