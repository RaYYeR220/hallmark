/**
 * A small declarative input schema.
 *
 * Three faces have to agree on what a skill takes: A2A sends it as message
 * parts, MCP publishes it as JSON Schema in `tools/list`, x402 takes it as a
 * request body. Writing the shape three times is how they drift, so a skill
 * declares it once here and the faces derive from it — validation, the JSON
 * Schema MCP clients read, and the human copy on the agent card.
 *
 * Deliberately not a general-purpose validator. It covers the value kinds an
 * on-chain agent actually accepts, and it is strict: unknown keys are an
 * error, because a silently-ignored `amount` is how an agent does the wrong
 * thing while reporting success.
 */

export type FieldSpec =
  | {
      kind: 'string'
      description: string
      optional?: boolean
      default?: string
      /** Allowed values. Rendered as a JSON Schema `enum`. */
      choices?: readonly string[]
      minLength?: number
      maxLength?: number
    }
  | { kind: 'address'; description: string; optional?: boolean; default?: string }
  | {
      kind: 'integer'
      description: string
      optional?: boolean
      default?: number
      min?: number
      max?: number
    }
  | {
      kind: 'number'
      description: string
      optional?: boolean
      default?: number
      min?: number
      max?: number
    }
  | { kind: 'boolean'; description: string; optional?: boolean; default?: boolean }
  | {
      /** A non-negative integer too large for `number`; carried as a decimal string. */
      kind: 'uint'
      description: string
      optional?: boolean
      default?: string
    }
  | {
      kind: 'array'
      description: string
      items: FieldSpec
      optional?: boolean
      minItems?: number
      maxItems?: number
      /** Arrays take no default: an implicit `[]` reads as "none supplied". */
      default?: never
    }

export type Shape = Readonly<Record<string, FieldSpec>>

export type ValidationOk<T> = { ok: true; value: T }
export type ValidationFail = { ok: false; errors: string[] }
export type Validation<T> = ValidationOk<T> | ValidationFail

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const UINT_RE = /^(0|[1-9][0-9]*)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

function checkField(spec: FieldSpec, raw: unknown, path: string, errors: string[]): unknown {
  switch (spec.kind) {
    case 'string': {
      if (typeof raw !== 'string') {
        errors.push(`${path} must be a string, got ${describe(raw)}`)
        return undefined
      }
      if (spec.choices && !spec.choices.includes(raw)) {
        errors.push(`${path} must be one of ${spec.choices.join(', ')}; got "${raw}"`)
        return undefined
      }
      if (spec.minLength !== undefined && raw.length < spec.minLength) {
        errors.push(`${path} must be at least ${spec.minLength} characters`)
        return undefined
      }
      if (spec.maxLength !== undefined && raw.length > spec.maxLength) {
        errors.push(`${path} must be at most ${spec.maxLength} characters`)
        return undefined
      }
      return raw
    }
    case 'address': {
      if (typeof raw !== 'string') {
        errors.push(`${path} must be a 0x-prefixed address string, got ${describe(raw)}`)
        return undefined
      }
      if (!ADDRESS_RE.test(raw.trim())) {
        errors.push(`${path} is not a 20-byte hex address: "${raw}"`)
        return undefined
      }
      return raw.trim()
    }
    case 'integer': {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
      if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
        errors.push(`${path} must be a whole number, got ${describe(raw)}`)
        return undefined
      }
      if (spec.min !== undefined && n < spec.min) {
        errors.push(`${path} must be >= ${spec.min}; got ${n}`)
        return undefined
      }
      if (spec.max !== undefined && n > spec.max) {
        errors.push(`${path} must be <= ${spec.max}; got ${n}`)
        return undefined
      }
      return n
    }
    case 'number': {
      const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        errors.push(`${path} must be a number, got ${describe(raw)}`)
        return undefined
      }
      if (spec.min !== undefined && n < spec.min) {
        errors.push(`${path} must be >= ${spec.min}; got ${n}`)
        return undefined
      }
      if (spec.max !== undefined && n > spec.max) {
        errors.push(`${path} must be <= ${spec.max}; got ${n}`)
        return undefined
      }
      return n
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw
      if (raw === 'true') return true
      if (raw === 'false') return false
      errors.push(`${path} must be a boolean, got ${describe(raw)}`)
      return undefined
    }
    case 'uint': {
      const text = typeof raw === 'number' ? String(raw) : raw
      if (typeof text !== 'string') {
        errors.push(`${path} must be a decimal integer string, got ${describe(raw)}`)
        return undefined
      }
      const trimmed = text.trim()
      if (!UINT_RE.test(trimmed)) {
        errors.push(
          `${path} must be a non-negative decimal integer with no separators, exponent ` +
            `or sign; got "${text}"`,
        )
        return undefined
      }
      return trimmed
    }
    case 'array': {
      if (!Array.isArray(raw)) {
        errors.push(`${path} must be an array, got ${describe(raw)}`)
        return undefined
      }
      if (spec.minItems !== undefined && raw.length < spec.minItems) {
        errors.push(`${path} needs at least ${spec.minItems} item(s); got ${raw.length}`)
        return undefined
      }
      if (spec.maxItems !== undefined && raw.length > spec.maxItems) {
        errors.push(`${path} takes at most ${spec.maxItems} item(s); got ${raw.length}`)
        return undefined
      }
      const before = errors.length
      const items = raw.map((item, i) => checkField(spec.items, item, `${path}[${i}]`, errors))
      return errors.length === before ? items : undefined
    }
  }
}

/**
 * Validate and coerce. Unknown keys are rejected rather than dropped: an
 * ignored field is an instruction the caller believes was honoured.
 */
export function validate<T = Record<string, unknown>>(shape: Shape, input: unknown): Validation<T> {
  const errors: string[] = []
  const source = input === undefined || input === null ? {} : input

  if (!isRecord(source)) {
    return { ok: false, errors: [`input must be an object, got ${describe(input)}`] }
  }

  const known = new Set(Object.keys(shape))
  for (const key of Object.keys(source)) {
    if (!known.has(key)) {
      errors.push(`unknown field "${key}"; expected one of ${[...known].join(', ')}`)
    }
  }

  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(shape)) {
    const raw = source[key]
    if (raw === undefined || raw === null) {
      if (spec.default !== undefined) {
        out[key] = spec.default
      } else if (spec.optional !== true) {
        errors.push(`missing required field "${key}" (${spec.description})`)
      }
      continue
    }
    const value = checkField(spec, raw, key, errors)
    if (value !== undefined) out[key] = value
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: out as T }
}

type JsonSchemaNode = Record<string, unknown>

function fieldToJsonSchema(spec: FieldSpec): JsonSchemaNode {
  switch (spec.kind) {
    case 'string':
      return {
        type: 'string',
        description: spec.description,
        ...(spec.choices ? { enum: [...spec.choices] } : {}),
        ...(spec.minLength === undefined ? {} : { minLength: spec.minLength }),
        ...(spec.maxLength === undefined ? {} : { maxLength: spec.maxLength }),
      }
    case 'address':
      return {
        type: 'string',
        description: spec.description,
        pattern: '^0x[0-9a-fA-F]{40}$',
      }
    case 'integer':
      return {
        type: 'integer',
        description: spec.description,
        ...(spec.min === undefined ? {} : { minimum: spec.min }),
        ...(spec.max === undefined ? {} : { maximum: spec.max }),
      }
    case 'number':
      return {
        type: 'number',
        description: spec.description,
        ...(spec.min === undefined ? {} : { minimum: spec.min }),
        ...(spec.max === undefined ? {} : { maximum: spec.max }),
      }
    case 'boolean':
      return { type: 'boolean', description: spec.description }
    case 'uint':
      return {
        type: 'string',
        description: `${spec.description} (decimal integer string)`,
        pattern: '^(0|[1-9][0-9]*)$',
      }
    case 'array':
      return {
        type: 'array',
        description: spec.description,
        items: fieldToJsonSchema(spec.items),
        ...(spec.minItems === undefined ? {} : { minItems: spec.minItems }),
        ...(spec.maxItems === undefined ? {} : { maxItems: spec.maxItems }),
      }
  }
}

/** The `inputSchema` an MCP client reads out of `tools/list`. */
export function toJsonSchema(shape: Shape): JsonSchemaNode {
  const properties: Record<string, JsonSchemaNode> = {}
  const required: string[] = []
  for (const [key, spec] of Object.entries(shape)) {
    properties[key] = fieldToJsonSchema(spec)
    if (spec.optional !== true && spec.default === undefined) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

/** One line per field, for the agent card and for error messages. */
export function describeShape(shape: Shape): string[] {
  return Object.entries(shape).map(([key, spec]) => {
    const optional = spec.optional === true || spec.default !== undefined ? ' (optional)' : ''
    const dflt = spec.default === undefined ? '' : ` [default ${JSON.stringify(spec.default)}]`
    return `${key}: ${spec.kind}${optional} — ${spec.description}${dflt}`
  })
}
