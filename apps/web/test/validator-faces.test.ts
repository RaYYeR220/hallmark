import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalize } from '@hallmark/core'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  MCP_PROTOCOL_VERSION,
  VALIDATOR_SKILLS,
  VALIDATOR_URLS,
  buildValidatorCard,
  extractInvocation,
  runSkill,
  toolName,
  validatorTools,
} from '../src/lib/validator/service'
import { hashBundle } from '../src/lib/evidenceStore'

/**
 * The contract this file exists to hold:
 *
 *   Hallmark's own validator must pass Hallmark's own probe.
 *
 * The prober's A2A check accepts a card only if it has a `name` plus a
 * non-empty `skills` array, and its MCP check requires `initialize` followed by
 * a `tools/list` that returns at least one tool. Those two rules are what
 * separate the 19 agents on BSC that answer from the 506 that return a
 * well-formed card declaring nothing. If this file goes red, agent 2210 has
 * quietly rejoined the second group — which is the exact failure the whole
 * product is an argument about.
 */

let storeDir: string

const bundle = {
  version: 1,
  chainId: 97,
  agentId: 2210,
  probedAt: '2026-09-08T19:00:00.000Z',
  score: 87,
  capabilities: { a2aSkills: ['census'], mcpTools: ['census'], x402: null },
  probe: [],
  scorer: {
    name: 'hallmark',
    version: '1.0.0',
    weights: { reachability: 45, latency: 15, mcpTools: 15, a2aSkills: 15, x402: 10 },
  },
}

const canonical = canonicalize(bundle)
const hash = hashBundle(bundle)

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'hallmark-validator-'))
  await mkdir(join(storeDir, 'evidence'), { recursive: true })
  await writeFile(join(storeDir, 'evidence', `${hash}.json`), canonical, 'utf8')
  process.env['EVIDENCE_STORE_DIR'] = storeDir
})

describe('the A2A card the prober reads', () => {
  const card = buildValidatorCard()

  it('carries a name and a non-empty skills array', () => {
    // Exactly the prober's acceptance rule for an A2A face.
    expect(typeof card['name']).toBe('string')
    expect(Array.isArray(card['skills'])).toBe(true)
    expect((card['skills'] as unknown[]).length).toBeGreaterThan(0)
  })

  it('declares only endpoints this app actually serves', () => {
    const services = card['services'] as Array<{ name: string; endpoint: string }>
    const byName = new Map(services.map((service) => [service.name, service.endpoint]))

    expect(byName.get('A2A')).toBe(VALIDATOR_URLS.a2a)
    expect(byName.get('MCP')).toBe(VALIDATOR_URLS.mcp)
    expect(byName.get('web')).toBe(VALIDATOR_URLS.web)

    // The bug this whole service exists to fix: a card pointing at a domain
    // nobody registered. Every endpoint must live on the deployed origin.
    for (const endpoint of byName.values()) {
      expect(endpoint.startsWith(VALIDATOR_URLS.web)).toBe(true)
    }
  })

  it('claims no x402 support, because there is none', () => {
    // Ten points of our own score. Declaring a paid face we do not serve is
    // the single most common lie in the census we publish.
    expect(card['x402Support']).toBe(false)
    expect(
      (card['services'] as Array<{ name: string }>).some((service) => service.name === 'x402'),
    ).toBe(false)
  })

  it('names the registry entry it claims', () => {
    const registrations = card['registrations'] as Array<Record<string, unknown>>
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.['agentId']).toBe(2210)
    expect(String(registrations[0]?.['agentRegistry'])).toMatch(/^eip155:97:0x8004/)
  })
})

describe('the MCP tool list', () => {
  it('exposes every skill under an MCP-legal name', () => {
    const tools = validatorTools()
    expect(tools.length).toBe(VALIDATOR_SKILLS.length)
    for (const tool of tools) {
      expect(String(tool['name'])).toMatch(/^[a-zA-Z0-9_-]+$/)
      expect(tool['inputSchema']).toBeTypeOf('object')
    }
  })

  it('round-trips a skill id through the tool name', () => {
    for (const skill of VALIDATOR_SKILLS) {
      const found = VALIDATOR_SKILLS.find((entry) => toolName(entry.id) === toolName(skill.id))
      expect(found?.id).toBe(skill.id)
    }
  })

  it('speaks one protocol revision and names it', () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2025-06-18')
  })
})

describe('verify-evidence', () => {
  it('confirms a document that reproduces its own hash', async () => {
    const result = await runSkill('verify-evidence', { hash })
    expect(result.ok).toBe(true)
    const output = (result as { output: Record<string, unknown> }).output
    expect(output['verdict']).toBe('match')
    expect(output['canonical']).toBe(true)
    expect(output['declared']).toBe(output['computed'])
    expect((output['summary'] as Record<string, unknown>)['score']).toBe(87)
  })

  it('reports an unknown hash as unfetchable rather than as a failure', async () => {
    const missing = `0x${'ab'.repeat(32)}`
    const result = await runSkill('verify-evidence', { hash: missing })
    expect(result.ok).toBe(true)
    const output = (result as { output: Record<string, unknown> }).output
    expect(output['found']).toBe(false)
    expect(output['verdict']).toBe('unfetchable')
    // Naming what was searched is what turns a dead attestation link into
    // something an operator can fix.
    expect(Array.isArray(output['searched'])).toBe(true)
  })

  it('rejects a malformed hash as the caller’s error', async () => {
    const result = await runSkill('verify-evidence', { hash: 'not-a-hash' })
    expect(result.ok).toBe(false)
    expect((result as { code: string }).code).toBe('invalid-input')
  })
})

describe('skill dispatch', () => {
  it('names an unknown skill rather than answering something else', async () => {
    const result = await runSkill('does-not-exist', {})
    expect(result.ok).toBe(false)
    expect((result as { code: string }).code).toBe('unknown-skill')
  })

  it('accepts both A2A shapes callers actually send', () => {
    const viaParts = extractInvocation({
      message: { parts: [{ kind: 'data', data: { skill: 'census', input: { chainId: 97 } } }] },
    })
    expect(viaParts).toMatchObject({ ok: true, skill: 'census' })

    const viaSkillId = extractInvocation({ skillId: 'census', input: {} })
    expect(viaSkillId).toMatchObject({ ok: true, skill: 'census' })
  })

  it('explains itself when the envelope names no skill', () => {
    const result = extractInvocation({ message: { parts: [{ kind: 'text', text: 'hello' }] } })
    expect(result.ok).toBe(false)
  })
})
