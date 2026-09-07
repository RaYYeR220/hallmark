import { parseAgentCardFromTokenUri } from '@hallmark/core'
import { describe, expect, it } from 'vitest'

import {
  agentUriBytes,
  buildRegistrationFile,
  canonicalJson,
  decodeAgentUri,
  encodeAgentUri,
  withRegistration,
} from '../src/registration.js'
import { REGISTRATION_TYPE, type RegistrationFile } from '../src/types.js'
import { validConfig } from './fixtures.js'

const EIP_KEYS = ['type', 'name', 'description', 'image', 'services', 'x402Support', 'active', 'registrations', 'supportedTrust']

describe('buildRegistrationFile', () => {
  it('produces exactly the EIP registration-v1 shape plus one namespaced key', () => {
    const file = buildRegistrationFile(validConfig())
    expect(Object.keys(file).sort()).toEqual([...EIP_KEYS, 'hallmark'].sort())
    expect(file.type).toBe(REGISTRATION_TYPE)
  })

  it('omits "image" entirely when the config has none, rather than writing null', () => {
    const config = validConfig()
    delete config.image
    const file = buildRegistrationFile(config)
    expect('image' in file).toBe(false)
  })

  it('names services the way the deployed registry does', () => {
    const file = buildRegistrationFile(
      validConfig({
        services: {
          a2a: 'https://example.com/a2a',
          mcp: 'https://example.com/mcp',
          x402: 'https://example.com/x402',
          web: 'https://example.com',
        },
        pricing: { model: 'x402', amount: '1', asset: '$U' },
      }),
    )
    expect(file.services.map((service) => service.name)).toEqual(['A2A', 'MCP', 'x402', 'web'])
    expect(file.x402Support).toBe(true)
  })

  it('puts skill ids on the first machine-callable service so a generic reader can see them', () => {
    const file = buildRegistrationFile(validConfig())
    const a2a = file.services.find((service) => service.name === 'A2A')
    expect(a2a?.skills).toEqual(['health-check'])
    expect(file.services.find((service) => service.name === 'MCP')?.skills).toBeUndefined()
  })

  it('falls back to MCP as the skill carrier when there is no A2A endpoint', () => {
    const file = buildRegistrationFile(validConfig({ services: { mcp: 'https://example.com/mcp' } }))
    expect(file.services.find((service) => service.name === 'MCP')?.skills).toEqual(['health-check'])
  })

  it('starts with an empty registrations array, because the id does not exist yet', () => {
    expect(buildRegistrationFile(validConfig()).registrations).toEqual([])
  })

  it('carries category, skills and pricing under the hallmark key', () => {
    const file = buildRegistrationFile(validConfig())
    expect(file.hallmark.category).toBe('health-factor')
    expect(file.hallmark.skills[0]?.inputSchema).toBeDefined()
    expect(file.hallmark.pricing).toEqual({ model: 'free' })
  })

  it('reads back through the core card parser with no warnings at all', () => {
    const file = buildRegistrationFile(validConfig())
    const parsed = parseAgentCardFromTokenUri(encodeAgentUri(file))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.warnings).toEqual([])
    expect(parsed.card.services).toHaveLength(3)
    expect(parsed.card.name).toBe('Venus Health Guard')
  })
})

describe('withRegistration', () => {
  it('stamps the assigned id and the CAIP-10 registry', () => {
    const file = withRegistration(buildRegistrationFile(validConfig()), 2210n, 97)
    expect(file.registrations).toEqual([
      { agentId: 2210, agentRegistry: 'eip155:97:0x8004A818BFB912233c491871b3d84c89A494BD9e' },
    ])
  })

  it('is idempotent: stamping twice leaves one entry', () => {
    const once = withRegistration(buildRegistrationFile(validConfig()), 7n, 56)
    const twice = withRegistration(once, 7n, 56)
    expect(twice.registrations).toHaveLength(1)
    expect(canonicalJson(once)).toBe(canonicalJson(twice))
  })

  it('leaves the input untouched', () => {
    const file = buildRegistrationFile(validConfig())
    withRegistration(file, 1n, 56)
    expect(file.registrations).toEqual([])
  })
})

describe('encodeAgentUri', () => {
  it('produces a base64 application/json data URI', () => {
    const uri = encodeAgentUri(buildRegistrationFile(validConfig()))
    expect(uri.startsWith('data:application/json;base64,')).toBe(true)
  })

  it('round-trips', () => {
    const file = buildRegistrationFile(validConfig())
    expect(decodeAgentUri(encodeAgentUri(file))).toEqual(JSON.parse(canonicalJson(file)))
  })

  it('is byte-stable under key reordering', () => {
    const file = buildRegistrationFile(validConfig())
    // Same data, keys inserted in the opposite order.
    const shuffled = Object.fromEntries(Object.entries(file).reverse()) as unknown as RegistrationFile
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(file))
    expect(encodeAgentUri(shuffled)).toBe(encodeAgentUri(file))
  })

  it('is byte-stable under key reordering inside nested objects', () => {
    const file = buildRegistrationFile(validConfig())
    const first = file.services[0]
    if (first === undefined) throw new Error('fixture')
    const reorderedService = Object.fromEntries(Object.entries(first).reverse()) as typeof first
    const shuffled: RegistrationFile = {
      ...file,
      services: [reorderedService, ...file.services.slice(1)],
    }
    expect(encodeAgentUri(shuffled)).toBe(encodeAgentUri(file))
  })

  it('is NOT stable under a content change — the negative control', () => {
    const file = buildRegistrationFile(validConfig())
    const changed: RegistrationFile = { ...file, description: `${file.description}.` }
    expect(encodeAgentUri(changed)).not.toBe(encodeAgentUri(file))
  })

  it('is NOT stable under array reordering, because service order is meaningful', () => {
    const file = buildRegistrationFile(validConfig())
    const reversed: RegistrationFile = { ...file, services: [...file.services].reverse() }
    expect(encodeAgentUri(reversed)).not.toBe(encodeAgentUri(file))
  })

  it('escapes non-ASCII so the encoding cannot depend on the platform', () => {
    const file = buildRegistrationFile(validConfig({ name: 'Ünicode Agent ✓' }))
    const json = canonicalJson(file)
    expect(json).toMatch(/\\u00dc/)
    expect(json).not.toMatch(/[^\x20-\x7e]/)
  })

  it('agentUriBytes matches the encoded length', () => {
    const file = buildRegistrationFile(validConfig())
    expect(agentUriBytes(file)).toBe(encodeAgentUri(file).length)
  })

  it('rejects anything that is not one of our data URIs', () => {
    expect(() => decodeAgentUri('https://example.com/card.json')).toThrow(/not a base64/)
  })
})
