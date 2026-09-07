import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

import {
  classifyTokenUri,
  endpointsOf,
  normalizeCard,
  parseAgentCardFromTokenUri,
  resolveAgentCard,
} from '../src/agentCard.js'
import type { ParseResult } from '../src/agentCard.js'

/* ------------------------------------------------------------------ */
/* fixtures — all three cards are verbatim from BSC mainnet             */
/* ------------------------------------------------------------------ */

/** agentId 1, ClawNews. */
const CLAWNEWS_JSON =
  '{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1","name":"ClawNews","description":"Hacker News for AI agents","image":"https://clawnews.io/logo.png","services":[{"name":"web","endpoint":"https://clawnews.io"},{"name":"OASF","endpoint":"https://github.com/agntcy/oasf/","version":"0.8.0","skills":["natural_language_processing/text_classification"],"domains":["technology/blockchain"]},{"name":"agentWallet","endpoint":"eip155:56:0x89E9E1ab11dD1B138b1dcE6d6A4a0926aaFD5029"},{"name":"email","endpoint":"hello@clawnews.io"}],"registrations":[{"agentId":null,"agentRegistry":"eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"}],"active":true,"x402Support":false,"supportedTrust":["reputation"]}'

/** agentId 39008, Ave.ai Trading Agent — a card with no services at all. */
const AVE_JSON =
  '{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1","name":"Ave.ai Trading Agent","description":"AI-driven multi-chain trading agent with on-chain reputation.","image":"https://www.iconaves.com/logo/pro.ave.ai.png","active":true,"supportedTrust":["reputation"]}'

/** agentId 7, NAMEAI — the casing-drift case: `x402support` and `supportedTrusts`. */
const NAMEAI_JSON =
  '{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1","name":"NAMEAI","description":"NAMEAINAMEAINAMEAINAMEAINAMEAINAMEAINAMEAINAMEAINAMEAINAMEAINAMEAI","image":"https://blob.8004scan.app/dfc0908e868820f7bb5c1b9a5b7247d72f38523552c2e5bb436226c40effdcde.jpg","services":[{"name":"OASF","endpoint":"https://github.com/agntcy/oasf/","skills":["advanced_reasoning_planning/chain_of_thought_structuring"],"domains":["finance_and_business/banking"]}],"registrations":[],"supportedTrusts":["reputation","crypto-economic","tee-attestation"],"active":true,"x402support":true}'

/** Not from chain: the remaining drift shapes stacked into one hostile card. */
const DRIFTED_JSON =
  '{"type":"https://eips.ethereum.org/EIPS/eip-8004#registration-v1","name":"Drifted Agent","endpoints":[{"name":"A2A","endpoint":"https://drift.example/a2a","version":"0.3.0"},{"name":"MCP","url":"https://drift.example/mcp"}],"registrations":[{"agentId":"4242","agentRegistry":"eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"}],"active":true,"x402Support":true,"supported_trust":["reputation","crypto-economic"]}'

function base64DataUri(json: string): string {
  return `data:application/json;base64,${Buffer.from(json, 'utf8').toString('base64')}`
}

function gzipDataUri(json: string): string {
  const packed = gzipSync(Buffer.from(json, 'utf8'), { level: 6 })
  return `data:application/json;enc=gzip;level=6;base64,${packed.toString('base64')}`
}

function expectOk(result: ParseResult): Extract<ParseResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected a parsed card, got: ${result.error}`)
  return result
}

/* ------------------------------------------------------------------ */

describe('classifyTokenUri', () => {
  it('recognises plain base64 JSON data URIs', () => {
    expect(classifyTokenUri(base64DataUri(CLAWNEWS_JSON))).toBe('data-json')
  })

  it('recognises the gzip variant seen on mainnet', () => {
    expect(classifyTokenUri(gzipDataUri(CLAWNEWS_JSON))).toBe('data-json-gzip')
    expect(classifyTokenUri('data:application/json;enc=gzip;level=6;base64,H4sIAA==')).toBe('data-json-gzip')
  })

  it('recognises unencoded data URIs', () => {
    expect(classifyTokenUri('data:application/json,{"name":"x"}')).toBe('data-json')
  })

  it('accepts an uppercase scheme', () => {
    expect(classifyTokenUri('HTTPS://www.arrondesean.us')).toBe('http')
    expect(classifyTokenUri('https://example.com/agent-card.json')).toBe('http')
  })

  it('recognises ipfs in all the shapes agents use', () => {
    expect(classifyTokenUri('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe('ipfs')
    expect(classifyTokenUri('/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe('ipfs')
    expect(classifyTokenUri('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe('ipfs')
  })

  it('calls garbage garbage', () => {
    expect(classifyTokenUri('0x6446ad98a3f2b4b19cf1e1b0eafd6f5b76a26e1c')).toBe('unknown')
    expect(classifyTokenUri('')).toBe('unknown')
    expect(classifyTokenUri('   ')).toBe('unknown')
    expect(classifyTokenUri('not a uri at all')).toBe('unknown')
    expect(classifyTokenUri('data:image/png;base64,iVBORw0KGgo=')).toBe('unknown')
  })
})

describe('parseAgentCardFromTokenUri', () => {
  it('parses the ClawNews card with no complaints', () => {
    const parsed = expectOk(parseAgentCardFromTokenUri(base64DataUri(CLAWNEWS_JSON)))

    expect(parsed.kind).toBe('data-json')
    expect(parsed.warnings).toEqual([])
    expect(parsed.card.name).toBe('ClawNews')
    expect(parsed.card.description).toBe('Hacker News for AI agents')
    expect(parsed.card.active).toBe(true)
    expect(parsed.card.x402Support).toBe(false)
    expect(parsed.card.supportedTrust).toEqual(['reputation'])
    expect(parsed.card.services).toHaveLength(4)
    expect(parsed.card.services[1]).toEqual({
      name: 'OASF',
      endpoint: 'https://github.com/agntcy/oasf/',
      version: '0.8.0',
      skills: ['natural_language_processing/text_classification'],
      domains: ['technology/blockchain'],
    })
    expect(parsed.card.registrations).toEqual([
      { agentId: null, agentRegistry: 'eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' },
    ])
    expect(parsed.card.extra).toEqual({})
  })

  it('inflates a gzip data URI to the same card', () => {
    const plain = expectOk(parseAgentCardFromTokenUri(base64DataUri(CLAWNEWS_JSON)))
    const packed = expectOk(parseAgentCardFromTokenUri(gzipDataUri(CLAWNEWS_JSON)))

    expect(packed.kind).toBe('data-json-gzip')
    expect(packed.card).toEqual(plain.card)
  })

  it('flags a card with no services', () => {
    const parsed = expectOk(parseAgentCardFromTokenUri(base64DataUri(AVE_JSON)))

    expect(parsed.card.name).toBe('Ave.ai Trading Agent')
    expect(parsed.card.services).toEqual([])
    expect(parsed.warnings).toContain('no "services" or "endpoints" array; agent declares no reachable endpoint')
  })

  it('reads the lowercase and pluralised keys agent 7 actually uses', () => {
    const parsed = expectOk(parseAgentCardFromTokenUri(base64DataUri(NAMEAI_JSON)))

    expect(parsed.card.name).toBe('NAMEAI')
    expect(parsed.card.x402Support).toBe(true)
    expect(parsed.card.supportedTrust).toEqual(['reputation', 'crypto-economic', 'tee-attestation'])
    expect(parsed.card.registrations).toEqual([])
    expect(parsed.card.services[0]).toEqual({
      name: 'OASF',
      endpoint: 'https://github.com/agntcy/oasf/',
      skills: ['advanced_reasoning_planning/chain_of_thought_structuring'],
      domains: ['finance_and_business/banking'],
    })

    expect(parsed.warnings).toEqual([
      'used "x402support" as "x402Support"',
      'used "supportedTrusts" as "supportedTrust"',
    ])
  })

  it('absorbs the remaining drift shapes and says what it did', () => {
    const parsed = expectOk(parseAgentCardFromTokenUri(base64DataUri(DRIFTED_JSON)))

    expect(parsed.card.x402Support).toBe(true)
    expect(parsed.card.supportedTrust).toEqual(['reputation', 'crypto-economic'])
    expect(parsed.card.services).toHaveLength(2)
    expect(parsed.card.services[1]?.endpoint).toBe('https://drift.example/mcp')
    expect(parsed.card.registrations[0]?.agentId).toBe(4242)

    expect(parsed.warnings).toContain('used "endpoints" as "services"')
    expect(parsed.warnings).toContain('used "supported_trust" as "supportedTrust"')
    expect(parsed.warnings).toContain('services[1] used "url" as "endpoint"')
    expect(parsed.warnings).toContain('registrations[0].agentId was the string "4242"; coerced to 4242')
  })

  it('reports off-chain tokenURIs instead of guessing', () => {
    const result = parseAgentCardFromTokenUri('HTTPS://www.arrondesean.us')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('http')
    expect(result.error).toMatch(/resolveAgentCard/)
    expect(result.raw).toBe('HTTPS://www.arrondesean.us')
  })

  it('explains a bare address tokenURI', () => {
    const result = parseAgentCardFromTokenUri('0x6446ad98a3f2b4b19cf1e1b0eafd6f5b76a26e1c')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('tokenURI is a bare address, not a registration file')
  })

  it('fails cleanly on a data URI holding broken JSON', () => {
    const uri = `data:application/json;base64,${Buffer.from('{"name":', 'utf8').toString('base64')}`
    const result = parseAgentCardFromTokenUri(uri)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('data-json')
    expect(result.error).toMatch(/^invalid JSON/)
  })

  it('fails cleanly on a data URI holding broken base64', () => {
    const result = parseAgentCardFromTokenUri('data:application/json;base64,!!!!!!!!!')
    expect(result.ok).toBe(false)
  })

  it('never throws, whatever it is handed', () => {
    const inputs = [
      '',
      '   ',
      'data:',
      'data:application/json;base64,',
      'data:application/json,',
      'data:application/json;enc=gzip;base64,bm90Z3ppcA==',
      'ipfs://',
      'https://',
      '0x',
      ' ',
      'data:application/json;base64,' + 'A'.repeat(1001),
    ]
    for (const input of inputs) {
      expect(() => parseAgentCardFromTokenUri(input)).not.toThrow()
    }
  })
})

describe('normalizeCard', () => {
  it('survives inputs that are not objects', () => {
    for (const raw of [null, undefined, 42, 'a string', true, [1, 2, 3]]) {
      const { card, warnings } = normalizeCard(raw)
      expect(card.services).toEqual([])
      expect(card.registrations).toEqual([])
      expect(warnings.length).toBeGreaterThan(0)
    }
  })

  it('preserves everything it does not recognise', () => {
    const { card } = normalizeCard({
      name: 'Keeps Extras',
      trustModels: ['tee-attestation'],
      nested: { a: 1 },
      weird: [null],
    })
    expect(card.extra).toEqual({
      trustModels: ['tee-attestation'],
      nested: { a: 1 },
      weird: [null],
    })
  })

  it('coerces registrations[].agentId from every shape seen in the wild', () => {
    const { card, warnings } = normalizeCard({
      registrations: [
        { agentId: null, agentRegistry: 'eip155:56:0xabc' },
        { agentId: 7, agentRegistry: 'eip155:56:0xabc' },
        { agentId: '9', agentRegistry: 'eip155:56:0xabc' },
        { agentId: 'not-a-number', agentRegistry: 'eip155:56:0xabc' },
        { agentId: 3, registry: 'eip155:97:0xdef' },
        { agentId: 5 },
        'nonsense',
      ],
    })

    expect(card.registrations).toEqual([
      { agentId: null, agentRegistry: 'eip155:56:0xabc' },
      { agentId: 7, agentRegistry: 'eip155:56:0xabc' },
      { agentId: 9, agentRegistry: 'eip155:56:0xabc' },
      { agentId: null, agentRegistry: 'eip155:56:0xabc' },
      { agentId: 3, agentRegistry: 'eip155:97:0xdef' },
      { agentId: 5, agentRegistry: '' },
    ])
    expect(warnings).toContain('registrations[3].agentId "not-a-number" is not a number; treated as null')
    expect(warnings).toContain('registrations[4] used "registry" as "agentRegistry"')
    expect(warnings).toContain('registrations[5] has no agentRegistry; kept with an empty registry')
    expect(warnings).toContain('registrations[6] was a string; dropped')
  })

  it('treats an empty registrations array as fine', () => {
    const { card, warnings } = normalizeCard({ services: [], registrations: [], active: true })
    expect(card.registrations).toEqual([])
    expect(warnings).toEqual([])
  })

  it('handles service entries that are strings, mislabelled, or unusable', () => {
    const { card, warnings } = normalizeCard({
      active: true,
      services: [
        'https://bare.example',
        { type: 'mcp', uri: 'https://typed.example/mcp' },
        { name: 'broken' },
        null,
        { name: 'skills', endpoint: 'https://s.example', skills: ['a', 7] },
      ],
    })

    expect(card.services).toEqual([
      { name: 'other', endpoint: 'https://bare.example' },
      { name: 'mcp', endpoint: 'https://typed.example/mcp' },
      { name: 'skills', endpoint: 'https://s.example', skills: ['a'] },
    ])
    expect(warnings).toContain('services[0] was a bare string; treated as an unnamed endpoint')
    expect(warnings).toContain('services[1] used "uri" as "endpoint"')
    expect(warnings).toContain('services[1] used "type" as "name"')
    expect(warnings).toContain('services[2] has no endpoint/url; dropped')
    expect(warnings).toContain('services[3] was null; dropped')
    expect(warnings).toContain('"services[4].skills"[1] was a number; dropped')
  })

  it('coerces stringly-typed booleans', () => {
    const yes = normalizeCard({ active: 'true', x402Support: 'yes', services: [] })
    expect(yes.card.active).toBe(true)
    expect(yes.card.x402Support).toBe(true)

    const no = normalizeCard({ active: 0, x402Support: 'false', services: [] })
    expect(no.card.active).toBe(false)
    expect(no.card.x402Support).toBe(false)
  })

  it('wraps a single supportedTrust string in an array', () => {
    const { card, warnings } = normalizeCard({ services: [], active: true, supportedTrust: 'reputation' })
    expect(card.supportedTrust).toEqual(['reputation'])
    expect(warnings).toContain('"supportedTrust" was a single string; wrapped in an array')
  })

  it('defaults active to true and says so', () => {
    const { card, warnings } = normalizeCard({ services: [] })
    expect(card.active).toBe(true)
    expect(warnings).toContain('"active" missing; assuming true')
  })
})

describe('endpointsOf', () => {
  it('labels the ClawNews services', () => {
    const parsed = expectOk(parseAgentCardFromTokenUri(base64DataUri(CLAWNEWS_JSON)))
    expect(endpointsOf(parsed.card)).toEqual([
      { kind: 'web', url: 'https://clawnews.io' },
      { kind: 'oasf', url: 'https://github.com/agntcy/oasf/', version: '0.8.0' },
      { kind: 'other', url: 'eip155:56:0x89E9E1ab11dD1B138b1dcE6d6A4a0926aaFD5029' },
      { kind: 'email', url: 'hello@clawnews.io' },
    ])
  })

  it('labels protocol endpoints regardless of naming', () => {
    const { card } = normalizeCard({
      active: true,
      services: [
        { name: 'A2A', endpoint: 'https://x.example/a2a' },
        { name: 'mcp-server', endpoint: 'https://x.example/mcp' },
        { name: 'x402', endpoint: 'https://x.example/pay' },
        { name: 'identity', endpoint: 'did:web:x.example' },
        { name: 'wallet', endpoint: 'agent.eth' },
        { name: 'contact', endpoint: 'mailto:hi@x.example' },
        { name: 'mystery', endpoint: 'tcp://x.example:900' },
      ],
    })
    expect(endpointsOf(card).map((e) => e.kind)).toEqual([
      'a2a',
      'mcp',
      'x402',
      'did',
      'ens',
      'email',
      'other',
    ])
  })
})

describe('resolveAgentCard', () => {
  it('handles data URIs without touching the network', async () => {
    const fetchImpl = (() => {
      throw new Error('should not fetch')
    }) as unknown as typeof fetch

    const parsed = expectOk(await resolveAgentCard(gzipDataUri(CLAWNEWS_JSON), { fetchImpl }))
    expect(parsed.card.name).toBe('ClawNews')
  })

  it('fetches http cards', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(url)
      return new Response(CLAWNEWS_JSON, { status: 200 })
    }) as unknown as typeof fetch

    const parsed = expectOk(await resolveAgentCard('https://example.com/agent-card.json', { fetchImpl }))
    expect(seen).toEqual(['https://example.com/agent-card.json'])
    expect(parsed.kind).toBe('http')
    expect(parsed.card.name).toBe('ClawNews')
  })

  it('maps ipfs uris onto a gateway', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(url)
      return new Response(AVE_JSON, { status: 200 })
    }) as unknown as typeof fetch

    await resolveAgentCard('ipfs://bafyfixture/card.json', {
      fetchImpl,
      ipfsGateway: 'https://gw.example/ipfs',
    })
    expect(seen).toEqual(['https://gw.example/ipfs/bafyfixture/card.json'])
  })

  it('reports a dead link instead of throwing', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    const result = await resolveAgentCard('https://www.arrondesean.us', { fetchImpl })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/HTTP 404/)
  })

  it('reports a network failure instead of throwing', async () => {
    const fetchImpl = (async () => {
      throw new Error('ENOTFOUND')
    }) as unknown as typeof fetch
    const result = await resolveAgentCard('https://www.arrondesean.us', { fetchImpl })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/ENOTFOUND/)
  })

  it('refuses garbage without a fetch', async () => {
    const fetchImpl = (() => {
      throw new Error('should not fetch')
    }) as unknown as typeof fetch
    const result = await resolveAgentCard('0x6446ad98a3f2b4b19cf1e1b0eafd6f5b76a26e1c', { fetchImpl })
    expect(result.ok).toBe(false)
  })
})
