import { describe, expect, it } from 'vitest'

import { defineAgent, validateAgentConfig } from '../src/config.js'
import { AgentConfigError } from '../src/errors.js'
import { CARD_MAX_BYTES } from '../src/schema.js'
import { validConfig } from './fixtures.js'

function codes(issues: { code: string }[]): string[] {
  return issues.map((issue) => issue.code)
}

describe('validateAgentConfig — accepts', () => {
  it('accepts a complete config', () => {
    const result = validateAgentConfig(validConfig())
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('accepts an mcp-only agent', () => {
    const result = validateAgentConfig(
      validConfig({ services: { mcp: 'https://example.com/mcp', web: 'https://example.com' } }),
    )
    expect(result.ok).toBe(true)
  })

  it('normalises the endpoints it keeps', () => {
    const result = validateAgentConfig(
      validConfig({ services: { a2a: '  https://Example.com/a2a  ', web: 'https://example.com' } }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.services.a2a).toBe('https://example.com/a2a')
  })

  it('drops nothing it accepted: every skill survives', () => {
    const result = validateAgentConfig(validConfig())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.skills).toHaveLength(1)
    expect(result.config.skills[0]?.id).toBe('health-check')
  })
})

describe('validateAgentConfig — rejects', () => {
  it('rejects a non-object', () => {
    const result = validateAgentConfig('nope')
    expect(result.ok).toBe(false)
    expect(codes(result.errors)).toContain('not_an_object')
  })

  it('rejects an agent with no machine endpoint', () => {
    const result = validateAgentConfig(validConfig({ services: { web: 'https://example.com' } }))
    expect(result.ok).toBe(false)
    expect(codes(result.errors)).toContain('no_machine_endpoint')
    expect(result.errors.find((issue) => issue.code === 'no_machine_endpoint')?.hint).toMatch(/agent 42/)
  })

  it('rejects a plain http endpoint', () => {
    const result = validateAgentConfig(
      validConfig({ services: { a2a: 'http://example.com/a2a', web: 'https://example.com' } }),
    )
    expect(result.ok).toBe(false)
    const issue = result.errors.find((entry) => entry.path === 'services.a2a')
    expect(issue?.code).toBe('bad_url')
    expect(issue?.message).toMatch(/scheme is "http"/)
  })

  it('rejects a private host', () => {
    const result = validateAgentConfig(
      validConfig({ services: { mcp: 'https://192.168.1.10/mcp', web: 'https://example.com' } }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.find((entry) => entry.path === 'services.mcp')?.message).toMatch(/private/)
  })

  it('rejects localhost', () => {
    const result = validateAgentConfig(
      validConfig({ services: { mcp: 'https://localhost:3000/mcp', web: 'https://example.com' } }),
    )
    expect(result.ok).toBe(false)
    expect(codes(result.errors)).toContain('bad_url')
  })

  it('rejects an unknown category', () => {
    const result = validateAgentConfig(validConfig({ category: 'arbitrage' as never }))
    expect(result.ok).toBe(false)
    const issue = result.errors.find((entry) => entry.path === 'category')
    expect(issue?.code).toBe('unknown_value')
    expect(issue?.hint).toMatch(/health-factor/)
  })

  it('rejects an unknown chain', () => {
    const result = validateAgentConfig(validConfig({ chain: 'ethereum' as never }))
    expect(result.ok).toBe(false)
    expect(result.errors.some((entry) => entry.path === 'chain')).toBe(true)
  })

  it('rejects a skill with no input schema', () => {
    const config = validConfig()
    const [skill] = config.skills
    if (skill === undefined) throw new Error('fixture')
    const result = validateAgentConfig({
      ...config,
      skills: [{ ...skill, inputSchema: undefined as never }],
    })
    expect(result.ok).toBe(false)
    const issue = result.errors.find((entry) => entry.path === 'skills[0].inputSchema')
    expect(issue?.code).toBe('required')
    expect(issue?.hint).toMatch(/JSON Schema/)
  })

  it('rejects a schema that is an empty object', () => {
    const config = validConfig()
    const [skill] = config.skills
    if (skill === undefined) throw new Error('fixture')
    const result = validateAgentConfig({ ...config, skills: [{ ...skill, outputSchema: {} }] })
    expect(result.ok).toBe(false)
    expect(codes(result.errors)).toContain('empty_schema')
  })

  it('rejects a schema-shaped object with no schema keywords', () => {
    const config = validConfig()
    const [skill] = config.skills
    if (skill === undefined) throw new Error('fixture')
    const result = validateAgentConfig({ ...config, skills: [{ ...skill, outputSchema: { note: 'a string' } }] })
    expect(result.ok).toBe(false)
    expect(codes(result.errors)).toContain('not_a_schema')
  })

  it('rejects duplicate skill ids', () => {
    const config = validConfig()
    const [skill] = config.skills
    if (skill === undefined) throw new Error('fixture')
    const result = validateAgentConfig({ ...config, skills: [skill, { ...skill }] })
    expect(result.ok).toBe(false)
    expect(codes(result.errors)).toContain('duplicate_id')
  })

  it('rejects an empty skill list', () => {
    const result = validateAgentConfig(validConfig({ skills: [] }))
    expect(result.ok).toBe(false)
    expect(codes(result.errors)).toContain('empty')
  })

  it('rejects x402 pricing with no x402 endpoint', () => {
    const result = validateAgentConfig(validConfig({ pricing: { model: 'x402', amount: '1', asset: '$U' } }))
    expect(result.ok).toBe(false)
    expect(codes(result.errors)).toContain('missing_x402_endpoint')
  })

  it('rejects a price with no asset', () => {
    const result = validateAgentConfig(
      validConfig({
        services: { mcp: 'https://example.com/mcp', x402: 'https://example.com/x402' },
        pricing: { model: 'x402', amount: '1' },
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.find((entry) => entry.path === 'pricing.asset')?.code).toBe('required')
  })

  it('rejects a non-decimal amount', () => {
    const result = validateAgentConfig(
      validConfig({
        services: { mcp: 'https://example.com/mcp', x402: 'https://example.com/x402' },
        pricing: { model: 'x402', amount: '1e-3' as string, asset: '$U' },
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.errors.find((entry) => entry.path === 'pricing.amount')?.hint).toMatch(/decimal string/)
  })

  it('rejects a validator that is neither "hallmark" nor an address', () => {
    const result = validateAgentConfig(validConfig({ validation: { requestFrom: '0xdeadbeef' as never } }))
    expect(result.ok).toBe(false)
    expect(codes(result.errors)).toContain('bad_validator')
  })

  it('rejects a card over the size ceiling', () => {
    const config = validConfig()
    const [skill] = config.skills
    if (skill === undefined) throw new Error('fixture')
    const bloat = { type: 'object', description: 'x'.repeat(CARD_MAX_BYTES) }
    const result = validateAgentConfig({ ...config, skills: [{ ...skill, inputSchema: bloat }] })
    expect(result.ok).toBe(false)
    const issue = result.errors.find((entry) => entry.code === 'card_too_large')
    expect(issue).toBeDefined()
    expect(issue?.message).toMatch(/bytes/)
  })

  it('reports every problem at once, not just the first', () => {
    const result = validateAgentConfig({
      name: '',
      description: 'short',
      category: 'nope',
      chain: 'nope',
      services: {},
      skills: [],
    })
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(5)
  })
})

describe('validateAgentConfig — warnings', () => {
  it('warns about a crypto-economic claim with no validation request', () => {
    const result = validateAgentConfig(validConfig({ trust: ['reputation', 'crypto-economic'] }))
    expect(result.ok).toBe(true)
    expect(codes(result.warnings)).toContain('unbacked_trust_claim')
  })

  it('does not warn once validation is requested', () => {
    const result = validateAgentConfig(
      validConfig({ trust: ['crypto-economic'], validation: { requestFrom: 'hallmark' } }),
    )
    expect(codes(result.warnings)).not.toContain('unbacked_trust_claim')
  })

  it('warns about unknown top-level keys instead of silently dropping them', () => {
    const result = validateAgentConfig({ ...validConfig(), author: 'someone' })
    expect(result.ok).toBe(true)
    expect(codes(result.warnings)).toContain('unknown_key')
  })

  it('warns about a missing image and a missing web page', () => {
    const config = validConfig({ services: { mcp: 'https://example.com/mcp' } })
    delete config.image
    const result = validateAgentConfig(config)
    expect(result.ok).toBe(true)
    expect(codes(result.warnings)).toEqual(expect.arrayContaining(['no_image', 'no_web']))
  })
})

describe('defineAgent', () => {
  it('returns a frozen config', () => {
    const config = defineAgent(validConfig())
    expect(Object.isFrozen(config)).toBe(true)
  })

  it('throws an AgentConfigError carrying every issue', () => {
    let thrown: unknown
    try {
      defineAgent(validConfig({ services: { web: 'https://example.com' }, category: 'nope' as never }))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(AgentConfigError)
    const error = thrown as AgentConfigError
    expect(codes(error.issues)).toEqual(expect.arrayContaining(['no_machine_endpoint', 'unknown_value']))
    expect(error.message).toMatch(/agent config has \d+ problems/)
  })

  it('does not throw on warnings alone', () => {
    expect(() => defineAgent(validConfig({ trust: ['crypto-economic'] }))).not.toThrow()
  })
})
