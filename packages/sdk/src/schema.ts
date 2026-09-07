/**
 * Config validation, hand-rolled so the package ships with no runtime
 * dependency beyond viem.
 *
 * The goal is not "is this the right shape" — it is "will this agent actually
 * be hireable, and if not, what exactly does the developer have to change".
 * Every issue therefore carries a path, a stable code and, where there is
 * something concrete to do, a hint.
 */

import { classifyUrl } from './net.js'
import {
  AGENT_CATEGORIES,
  CHAIN_NAMES,
  PRICING_MODELS,
  TRUST_MODELS,
  type Address,
  type AgentConfig,
  type AgentSkill,
  type Pricing,
  type ServiceEndpoints,
  type TrustModel,
  type ValidationConfig,
} from './types.js'

export type Severity = 'error' | 'warning'

export type Issue = {
  path: string
  code: string
  message: string
  severity: Severity
  hint?: string
}

export type ValidationResult =
  | { ok: true; config: AgentConfig; errors: never[]; warnings: Issue[] }
  | { ok: false; config: null; errors: Issue[]; warnings: Issue[] }

/** Cards above this are unusually expensive to store; above `CARD_MAX_BYTES` they are rejected. */
export const CARD_WARN_BYTES = 8 * 1024
export const CARD_MAX_BYTES = 16 * 1024

const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const DECIMAL_AMOUNT = /^\d+(\.\d+)?$/
const SERVICE_KEYS = ['a2a', 'mcp', 'x402', 'web'] as const
const MACHINE_SERVICE_KEYS = ['a2a', 'mcp'] as const

const NAME_MAX = 64
const DESCRIPTION_MIN = 20
const DESCRIPTION_MAX = 1_000

class Collector {
  readonly errors: Issue[] = []
  readonly warnings: Issue[] = []

  error(path: string, code: string, message: string, hint?: string): void {
    this.errors.push(issue(path, code, message, 'error', hint))
  }

  warn(path: string, code: string, message: string, hint?: string): void {
    this.warnings.push(issue(path, code, message, 'warning', hint))
  }
}

function issue(path: string, code: string, message: string, severity: Severity, hint?: string): Issue {
  return hint === undefined ? { path, code, message, severity } : { path, code, message, severity, hint }
}

/**
 * Validate an untrusted object into an `AgentConfig`.
 *
 * `sizeOf` is injected so the size checks can run against the real encoded
 * card without this module importing the encoder (which imports this module
 * for its own types). `validateAgentConfig` wires the real one.
 */
export function checkAgentConfig(
  input: unknown,
  opts: { sizeOf?: (config: AgentConfig) => number } = {},
): ValidationResult {
  const c = new Collector()

  if (!isRecord(input)) {
    c.error('', 'not_an_object', `expected an object, received ${describe(input)}`)
    return { ok: false, config: null, errors: c.errors, warnings: c.warnings }
  }

  const name = readName(input, c)
  const description = readDescription(input, c)
  const category = readEnum(input, 'category', AGENT_CATEGORIES, c)
  const chain = readEnum(input, 'chain', CHAIN_NAMES, c)
  const services = readServices(input['services'], c)
  const skills = readSkills(input['skills'], c)
  const pricing = readPricing(input['pricing'], 'pricing', c)
  const trust = readTrust(input['trust'], c)
  const validation = readValidation(input['validation'], c)
  const image = readImage(input['image'], c)
  const active = readActive(input['active'], c)

  crossCheck({ services, pricing, trust, hasValidation: validation !== undefined }, c)
  warnOnUnknownKeys(input, c)

  if (
    c.errors.length > 0 ||
    name === null ||
    description === null ||
    category === null ||
    chain === null ||
    services === null ||
    skills === null
  ) {
    return { ok: false, config: null, errors: c.errors, warnings: c.warnings }
  }

  const config: AgentConfig = {
    name,
    description,
    category,
    chain,
    services,
    skills,
    ...(image === undefined ? {} : { image }),
    ...(pricing === undefined ? {} : { pricing }),
    ...(trust === undefined ? {} : { trust }),
    ...(validation === undefined ? {} : { validation }),
    ...(active === undefined ? {} : { active }),
  }

  const sizeOf = opts.sizeOf
  if (sizeOf !== undefined) {
    const bytes = sizeOf(config)
    if (bytes > CARD_MAX_BYTES) {
      c.error(
        '',
        'card_too_large',
        `the encoded registration file is ${bytes} bytes, over the ${CARD_MAX_BYTES}-byte ceiling`,
        'Registration stores the card on-chain, so size is gas. Move long schemas behind the A2A card and keep the on-chain file to identity plus endpoints.',
      )
      return { ok: false, config: null, errors: c.errors, warnings: c.warnings }
    }
    if (bytes > CARD_WARN_BYTES) {
      c.warn(
        '',
        'card_large',
        `the encoded registration file is ${bytes} bytes; above ${CARD_WARN_BYTES} the gas cost climbs fast`,
        'A 1 KB card costs about 890k gas. Every extra 32 bytes is roughly another 20k.',
      )
    }
  }

  return { ok: true, config, errors: [], warnings: c.warnings }
}

/* ------------------------------------------------------------------ */
/* field readers                                                       */
/* ------------------------------------------------------------------ */

function readName(input: Record<string, unknown>, c: Collector): string | null {
  const raw = input['name']
  if (typeof raw !== 'string') {
    c.error('name', 'required', `expected a string, received ${describe(raw)}`)
    return null
  }
  const name = raw.trim()
  if (name === '') {
    c.error('name', 'empty', 'must not be blank')
    return null
  }
  if (name.length > NAME_MAX) {
    c.error('name', 'too_long', `is ${name.length} characters, over the ${NAME_MAX}-character limit`)
    return null
  }
  return name
}

function readDescription(input: Record<string, unknown>, c: Collector): string | null {
  const raw = input['description']
  if (typeof raw !== 'string') {
    c.error('description', 'required', `expected a string, received ${describe(raw)}`)
    return null
  }
  const description = raw.trim()
  if (description.length < DESCRIPTION_MIN) {
    c.error(
      'description',
      'too_short',
      `is ${description.length} characters; at least ${DESCRIPTION_MIN} are needed`,
      'This is the only prose a caller sees before hiring the agent. Say what it does and to what.',
    )
    return null
  }
  if (description.length > DESCRIPTION_MAX) {
    c.error('description', 'too_long', `is ${description.length} characters, over the ${DESCRIPTION_MAX}-character limit`)
    return null
  }
  return description
}

function readEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  c: Collector,
): T | null {
  const raw = input[key]
  if (typeof raw !== 'string') {
    c.error(key, 'required', `expected a string, received ${describe(raw)}`, `One of: ${allowed.join(', ')}.`)
    return null
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    c.error(key, 'unknown_value', `"${raw}" is not a known ${key}`, `One of: ${allowed.join(', ')}.`)
    return null
  }
  return raw as T
}

function readServices(raw: unknown, c: Collector): ServiceEndpoints | null {
  if (!isRecord(raw)) {
    c.error('services', 'required', `expected an object, received ${describe(raw)}`, `Keys: ${SERVICE_KEYS.join(', ')}.`)
    return null
  }

  const services: ServiceEndpoints = {}
  for (const key of Object.keys(raw)) {
    if (!(SERVICE_KEYS as readonly string[]).includes(key)) {
      c.error(
        `services.${key}`,
        'unknown_service',
        `"${key}" is not a service this SDK knows how to publish`,
        `Known services: ${SERVICE_KEYS.join(', ')}.`,
      )
    }
  }

  for (const key of SERVICE_KEYS) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    const path = `services.${key}`
    if (typeof value !== 'string') {
      c.error(path, 'not_a_string', `expected a URL string, received ${describe(value)}`)
      continue
    }
    const trimmed = value.trim()
    if (trimmed === '') {
      c.error(path, 'empty', 'is blank; drop the key instead of declaring an empty endpoint')
      continue
    }
    const verdict = classifyUrl(trimmed)
    if (!verdict.ok) {
      c.error(
        path,
        'bad_url',
        `"${trimmed}" ${verdict.reason}`,
        verdict.reason.startsWith('scheme')
          ? 'Endpoints are fetched by validators and by other agents. Plain http is not acceptable.'
          : 'Publish an endpoint reachable from the public internet; a validator has no route into your network.',
      )
      continue
    }
    services[key] = verdict.url.toString()
  }

  const machine = MACHINE_SERVICE_KEYS.filter((key) => services[key] !== undefined)
  if (machine.length === 0) {
    c.error(
      'services',
      'no_machine_endpoint',
      'declares no a2a or mcp endpoint',
      'An agent with only a web page cannot be called by another agent. Mainnet agent 42 "Bot Trader" ships no services at all and is unhireable by construction; do not repeat it.',
    )
  }
  if (services.web === undefined) {
    c.warn('services.web', 'no_web', 'no human-facing page declared', 'Listings show it, and reviewers look for it.')
  }

  return services
}

function readSkills(raw: unknown, c: Collector): AgentSkill[] | null {
  if (!Array.isArray(raw)) {
    c.error('skills', 'required', `expected an array, received ${describe(raw)}`)
    return null
  }
  if (raw.length === 0) {
    c.error('skills', 'empty', 'declares no skills', 'A caller needs at least one named, schema-typed thing to invoke.')
    return null
  }

  const skills: AgentSkill[] = []
  const seen = new Map<string, number>()

  raw.forEach((entry, index) => {
    const path = `skills[${index}]`
    if (!isRecord(entry)) {
      c.error(path, 'not_an_object', `expected an object, received ${describe(entry)}`)
      return
    }

    const id = typeof entry['id'] === 'string' ? entry['id'].trim() : null
    if (id === null || id === '') {
      c.error(`${path}.id`, 'required', 'is missing', 'Use a stable, lowercase id: this is what a caller invokes.')
      return
    }
    if (!SKILL_ID.test(id)) {
      c.error(
        `${path}.id`,
        'bad_id',
        `"${id}" is not a usable skill id`,
        'Lowercase letters, digits, dot, dash and underscore; must start with a letter or digit.',
      )
      return
    }
    const previous = seen.get(id)
    if (previous !== undefined) {
      c.error(`${path}.id`, 'duplicate_id', `"${id}" is already used by skills[${previous}]`)
      return
    }
    seen.set(id, index)

    const skillName = typeof entry['name'] === 'string' ? entry['name'].trim() : ''
    if (skillName === '') c.error(`${path}.name`, 'required', 'is missing')

    const skillDescription = typeof entry['description'] === 'string' ? entry['description'].trim() : ''
    if (skillDescription === '') c.error(`${path}.description`, 'required', 'is missing')

    const inputSchema = readSchema(entry['inputSchema'], `${path}.inputSchema`, c)
    const outputSchema = readSchema(entry['outputSchema'], `${path}.outputSchema`, c)
    const skillPricing = readPricing(entry['pricing'], `${path}.pricing`, c)

    if (skillName === '' || skillDescription === '' || inputSchema === null || outputSchema === null) return

    skills.push({
      id,
      name: skillName,
      description: skillDescription,
      inputSchema,
      outputSchema,
      ...(skillPricing === undefined ? {} : { pricing: skillPricing }),
    })
  })

  return skills.length === raw.length ? skills : null
}

function readSchema(raw: unknown, path: string, c: Collector): Record<string, unknown> | null {
  if (raw === undefined || raw === null) {
    c.error(
      path,
      'required',
      'is missing',
      'Callers and validators both read this. A JSON Schema object, even `{ type: "object", properties: {} }`, is enough.',
    )
    return null
  }
  if (!isRecord(raw)) {
    c.error(path, 'not_an_object', `expected a JSON Schema object, received ${describe(raw)}`)
    return null
  }
  if (Object.keys(raw).length === 0) {
    c.error(path, 'empty_schema', 'is an empty object, which describes nothing')
    return null
  }
  if (raw['type'] === undefined && raw['properties'] === undefined && raw['$ref'] === undefined && raw['oneOf'] === undefined && raw['anyOf'] === undefined) {
    c.error(
      path,
      'not_a_schema',
      'has no "type", "properties", "$ref", "oneOf" or "anyOf"; this is not a JSON Schema',
    )
    return null
  }
  return raw
}

function readPricing(raw: unknown, path: string, c: Collector): Pricing | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) {
    c.error(path, 'not_an_object', `expected an object, received ${describe(raw)}`)
    return undefined
  }

  const rawModel = raw['model']
  if (typeof rawModel !== 'string' || !(PRICING_MODELS as readonly string[]).includes(rawModel)) {
    c.error(
      `${path}.model`,
      'unknown_value',
      `${describe(rawModel)} is not a known pricing model`,
      `One of: ${PRICING_MODELS.join(', ')}.`,
    )
    return undefined
  }
  const model = rawModel as Pricing['model']

  const amount = raw['amount']
  const asset = raw['asset']

  if (model === 'free') {
    if (amount !== undefined) {
      c.warn(`${path}.amount`, 'ignored', 'is set on a free agent and will be ignored')
    }
    return { model }
  }

  if (typeof amount !== 'string' || !DECIMAL_AMOUNT.test(amount.trim())) {
    c.error(
      `${path}.amount`,
      'required',
      `${describe(amount)} is not a decimal amount`,
      'Use a plain decimal string in whole token units, e.g. "0.25". Never a float.',
    )
    return undefined
  }
  if (Number(amount) <= 0) {
    c.error(`${path}.amount`, 'not_positive', `"${amount}" must be greater than zero for a ${model} agent`)
    return undefined
  }
  if (typeof asset !== 'string' || asset.trim() === '') {
    c.error(
      `${path}.asset`,
      'required',
      'is missing',
      'A price without an asset is not a price. Use a symbol such as "$U" or a 0x token address.',
    )
    return undefined
  }

  return { model, amount: amount.trim(), asset: asset.trim() }
}

function readTrust(raw: unknown, c: Collector): TrustModel[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) {
    c.error('trust', 'not_an_array', `expected an array, received ${describe(raw)}`)
    return undefined
  }
  const out: TrustModel[] = []
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string' || !(TRUST_MODELS as readonly string[]).includes(entry)) {
      c.error(
        `trust[${index}]`,
        'unknown_value',
        `${describe(entry)} is not a known trust model`,
        `One of: ${TRUST_MODELS.join(', ')}.`,
      )
      return
    }
    const model = entry as TrustModel
    if (out.includes(model)) {
      c.warn(`trust[${index}]`, 'duplicate', `"${entry}" is listed twice`)
      return
    }
    out.push(model)
  })
  return out
}

function readValidation(raw: unknown, c: Collector): ValidationConfig | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) {
    c.error('validation', 'not_an_object', `expected an object, received ${describe(raw)}`)
    return undefined
  }

  const requestFrom = raw['requestFrom']
  if (typeof requestFrom !== 'string') {
    c.error('validation.requestFrom', 'required', `expected "hallmark" or a 0x address, received ${describe(requestFrom)}`)
    return undefined
  }
  if (requestFrom !== 'hallmark' && !ADDRESS.test(requestFrom)) {
    c.error(
      'validation.requestFrom',
      'bad_validator',
      `"${requestFrom}" is neither "hallmark" nor a 20-byte address`,
      'Only the agent owner or an operator may open a validation request, and the validator must be an address the registry can respond from.',
    )
    return undefined
  }

  const evidenceUrl = raw['evidenceUrl']
  let evidence: string | undefined
  if (evidenceUrl !== undefined && evidenceUrl !== null) {
    if (typeof evidenceUrl !== 'string') {
      c.error('validation.evidenceUrl', 'not_a_string', `expected a URL string, received ${describe(evidenceUrl)}`)
    } else {
      const verdict = classifyUrl(evidenceUrl.trim())
      if (!verdict.ok) c.error('validation.evidenceUrl', 'bad_url', `"${evidenceUrl}" ${verdict.reason}`)
      else evidence = verdict.url.toString()
    }
  }

  const nonce = raw['nonce']
  let parsedNonce: number | undefined
  if (nonce !== undefined && nonce !== null) {
    if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) {
      c.error('validation.nonce', 'bad_nonce', `expected a non-negative safe integer, received ${describe(nonce)}`)
    } else {
      parsedNonce = nonce
    }
  }

  return {
    requestFrom: requestFrom === 'hallmark' ? 'hallmark' : (requestFrom as Address),
    ...(evidence === undefined ? {} : { evidenceUrl: evidence }),
    ...(parsedNonce === undefined ? {} : { nonce: parsedNonce }),
  }
}

function readImage(raw: unknown, c: Collector): string | undefined {
  if (raw === undefined || raw === null) {
    c.warn('image', 'no_image', 'no image declared', 'Listings fall back to a placeholder.')
    return undefined
  }
  if (typeof raw !== 'string') {
    c.error('image', 'not_a_string', `expected a URL string, received ${describe(raw)}`)
    return undefined
  }
  const trimmed = raw.trim()
  if (/^(ipfs:\/\/|data:image\/)/i.test(trimmed)) return trimmed
  const verdict = classifyUrl(trimmed)
  if (!verdict.ok) {
    c.error('image', 'bad_url', `"${trimmed}" ${verdict.reason}`, 'Use an https URL, an ipfs:// URI or a data:image/ URI.')
    return undefined
  }
  return verdict.url.toString()
}

function readActive(raw: unknown, c: Collector): boolean | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'boolean') {
    c.error('active', 'not_a_boolean', `expected a boolean, received ${describe(raw)}`)
    return undefined
  }
  return raw
}

/* ------------------------------------------------------------------ */
/* cross-field checks                                                  */
/* ------------------------------------------------------------------ */

function crossCheck(
  input: {
    services: ServiceEndpoints | null
    pricing: Pricing | undefined
    trust: string[] | undefined
    hasValidation: boolean
  },
  c: Collector,
): void {
  const { services, pricing, trust, hasValidation } = input
  if (services === null) return

  if (pricing?.model === 'x402' && services.x402 === undefined) {
    c.error(
      'services.x402',
      'missing_x402_endpoint',
      'pricing.model is "x402" but no x402 endpoint is declared',
      'x402 pricing is a promise that some URL answers 402 with a payment challenge. Declare it, or price the agent another way.',
    )
  }
  if (services.x402 !== undefined && pricing === undefined) {
    c.warn(
      'pricing',
      'x402_without_price',
      'an x402 endpoint is declared but the agent lists no price',
      'Callers filter on price. Set pricing.model to "x402" with an amount and asset.',
    )
  }
  if (trust?.includes('crypto-economic') === true && !hasValidation) {
    c.warn(
      'trust',
      'unbacked_trust_claim',
      '"crypto-economic" is claimed but nothing on-chain backs it',
      'Add `validation: { requestFrom: "hallmark" }` so the claim resolves to a real ERC-8004 validation request.',
    )
  }
}

const KNOWN_ROOT_KEYS = new Set([
  'name',
  'description',
  'image',
  'category',
  'chain',
  'services',
  'skills',
  'pricing',
  'trust',
  'validation',
  'active',
])

function warnOnUnknownKeys(input: Record<string, unknown>, c: Collector): void {
  for (const key of Object.keys(input)) {
    if (!KNOWN_ROOT_KEYS.has(key)) {
      c.warn(key, 'unknown_key', `"${key}" is not a config field and will be dropped`)
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'nothing'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return `the string "${truncate(value)}"`
  if (typeof value === 'number' || typeof value === 'boolean') return `the ${typeof value} ${String(value)}`
  return `a ${typeof value}`
}

function truncate(value: string, max = 48): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
