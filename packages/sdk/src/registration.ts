/**
 * Compiling an `AgentConfig` into the file that actually goes on-chain.
 *
 * Two properties matter here and both are tested:
 *
 *  1. The output is exactly the ERC-8004 registration-v1 shape. Anything that
 *     is not in the EIP lives under the single namespaced `hallmark` key, so a
 *     generic reader sees a clean file and never has to guess.
 *  2. The encoding is byte-stable. The same config always produces the same
 *     data URI regardless of the order keys happened to be written in, which
 *     is what makes "did this agent change?" a hash comparison rather than a
 *     diff.
 */

import { caip10, canonicalize, getChain } from '@hallmark/core'

import {
  CHAIN_IDS,
  REGISTRATION_TYPE,
  type AgentConfig,
  type ChainName,
  type RegistrationEntry,
  type RegistrationFile,
  type RegistrationService,
  type ServiceKind,
} from './types.js'

/** Service `name` values as they appear in the wild on the deployed registry. */
export const SERVICE_NAMES: Record<ServiceKind, string> = {
  a2a: 'A2A',
  mcp: 'MCP',
  x402: 'x402',
  web: 'web',
}

/** Fixed order, so two builds of the same config produce the same array. */
export const SERVICE_ORDER: readonly ServiceKind[] = ['a2a', 'mcp', 'x402', 'web']

export const A2A_VERSION = '0.3.0'
export const MCP_VERSION = '2025-06-18'
export const X402_VERSION = '1'

export type BuildOptions = {
  /**
   * Phase-2 registrations. Left empty on the first `register()` call, because
   * the agent id does not exist yet; filled in and re-published by
   * `publishAgent`.
   */
  registrations?: RegistrationEntry[]
}

export function chainIdOf(chain: ChainName): 56 | 97 {
  return CHAIN_IDS[chain]
}

/** The exact JSON that gets base64'd into the tokenURI. */
export function buildRegistrationFile(config: AgentConfig, opts: BuildOptions = {}): RegistrationFile {
  const services = buildServices(config)

  const file: RegistrationFile = {
    type: REGISTRATION_TYPE,
    name: config.name,
    description: config.description,
    ...(config.image === undefined ? {} : { image: config.image }),
    services,
    x402Support: config.services.x402 !== undefined || config.pricing?.model === 'x402',
    active: config.active ?? true,
    registrations: opts.registrations ?? [],
    supportedTrust: config.trust ?? [],
    hallmark: {
      version: 1,
      category: config.category,
      skills: config.skills,
      ...(config.pricing === undefined ? {} : { pricing: config.pricing }),
      ...(config.validation === undefined ? {} : { validation: { requestFrom: config.validation.requestFrom } }),
    },
  }

  return file
}

/**
 * Phase 2 of registration: stamp the id the chain just assigned into the file
 * it assigned it to. Without this the registration file does not point back at
 * its own agent, which is how a large share of live agents ended up with
 * `registrations: []`.
 */
export function withRegistration(
  file: RegistrationFile,
  agentId: bigint | number,
  chainId: number,
): RegistrationFile {
  const chain = getChain(chainId)
  const entry: RegistrationEntry = {
    agentId: Number(agentId),
    agentRegistry: caip10(chain.id, chain.contracts.identityRegistry),
  }
  return { ...file, registrations: [entry] }
}

/**
 * Canonical JSON, RFC 8785 style: keys sorted, no insignificant whitespace,
 * non-ASCII escaped. Delegated to `@hallmark/core` so the SDK and the
 * marketplace agree on what "the same card" means, byte for byte.
 */
export function canonicalJson(file: RegistrationFile): string {
  return canonicalize(file)
}

/** `data:application/json;base64,…` — the form the registry stores. */
export function encodeAgentUri(file: RegistrationFile): string {
  const json = canonicalJson(file)
  const base64 = bytesToBase64(new TextEncoder().encode(json))
  return `data:application/json;base64,${base64}`
}

/** Byte length of the encoded tokenURI. This, not the JSON length, is what costs gas. */
export function agentUriBytes(file: RegistrationFile): number {
  // The data URI is pure ASCII, so one character is one byte.
  return encodeAgentUri(file).length
}

/** Round-trip helper for dry runs and tests. Throws on anything that is not one of our URIs. */
export function decodeAgentUri(uri: string): unknown {
  const marker = 'base64,'
  const index = uri.indexOf(marker)
  if (!uri.startsWith('data:application/json') || index === -1) {
    throw new Error(`not a base64 application/json data URI: ${uri.slice(0, 48)}`)
  }
  const json = new TextDecoder().decode(base64ToBytes(uri.slice(index + marker.length)))
  return JSON.parse(json)
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function buildServices(config: AgentConfig): RegistrationService[] {
  const skillIds = config.skills.map((skill) => skill.id)
  // Skill ids ride on the first machine-callable service so a generic ERC-8004
  // reader can see them without knowing anything about Hallmark.
  const skillCarrier: ServiceKind = config.services.a2a !== undefined ? 'a2a' : 'mcp'

  const services: RegistrationService[] = []
  for (const kind of SERVICE_ORDER) {
    const endpoint = config.services[kind]
    if (endpoint === undefined) continue

    const service: RegistrationService = { name: SERVICE_NAMES[kind], endpoint }
    const version = versionFor(kind)
    if (version !== null) service.version = version
    if (kind === skillCarrier && skillIds.length > 0) service.skills = skillIds
    services.push(service)
  }
  return services
}

function versionFor(kind: ServiceKind): string | null {
  switch (kind) {
    case 'a2a':
      return A2A_VERSION
    case 'mcp':
      return MCP_VERSION
    case 'x402':
      return X402_VERSION
    case 'web':
      return null
  }
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Runtime-agnostic: no Buffer, no btoa-on-latin1 surprises. */
function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += BASE64_ALPHABET[b0 >> 2]
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)]
    out += b1 === undefined ? '=' : BASE64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]
    out += b2 === undefined ? '=' : BASE64_ALPHABET[b2 & 0x3f]
  }
  return out
}

function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '').replace(/=+$/, '')
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let accumulator = 0
  let bits = 0
  let offset = 0
  for (const char of clean) {
    const value = BASE64_ALPHABET.indexOf(char)
    if (value === -1) continue
    accumulator = (accumulator << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[offset] = (accumulator >> bits) & 0xff
      offset += 1
    }
  }
  return bytes.subarray(0, offset)
}
