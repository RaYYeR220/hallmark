import { afterEach, describe, expect, it } from 'vitest'

import { describeShape, toJsonSchema, validate, type Shape } from '../src/runtime/schema.js'
import { toJsonSafe } from '../src/runtime/invoke.js'
import { createMemoryStore } from '../src/runtime/store.js'
import { narrate, setNarrator } from '../src/runtime/narrative.js'
import { reconcile, allAgree, assertion, failedAssertions } from '../src/chain/reconcile.js'
import { decodePaymentHeader } from '../src/runtime/x402.js'
import { parseJsonRpc, RPC_ERRORS } from '../src/runtime/jsonrpc.js'
import { actHealth } from '../src/agents/health/act.js'
import { AGENTS } from '../src/registry.js'

describe('input validation', () => {
  const shape: Shape = {
    token: { kind: 'address', description: 'a token' },
    amount: { kind: 'uint', description: 'atomic amount' },
    slippageBps: { kind: 'integer', description: 'bps', optional: true, default: 50, min: 1, max: 1_000 },
    flag: { kind: 'boolean', description: 'a flag', optional: true },
    mode: { kind: 'string', description: 'a mode', optional: true, choices: ['fast', 'slow'] },
  }

  it('accepts a well-formed input and applies defaults', () => {
    const result = validate(shape, { token: '0x' + '11'.repeat(20), amount: '1000' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.value['slippageBps']).toBe(50)
  })

  it('rejects an unknown field rather than dropping it', () => {
    // An ignored field is an instruction the caller believes was honoured.
    const result = validate(shape, { token: '0x' + '11'.repeat(20), amount: '1', amonut: '999' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors[0]).toContain('unknown field "amonut"')
  })

  it('rejects a malformed address', () => {
    const result = validate(shape, { token: '0xnope', amount: '1' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors[0]).toContain('not a 20-byte hex address')
  })

  it('rejects an amount in exponent or separator form, which BigInt would mangle', () => {
    for (const bad of ['1e18', '1_000', '-5', '1.5', ' 12 3']) {
      const result = validate(shape, { token: '0x' + '11'.repeat(20), amount: bad })
      expect(result.ok, bad).toBe(false)
    }
    expect(validate(shape, { token: '0x' + '11'.repeat(20), amount: '0' }).ok).toBe(true)
  })

  it('enforces bounds and enumerations', () => {
    const base = { token: '0x' + '11'.repeat(20), amount: '1' }
    expect(validate(shape, { ...base, slippageBps: 5_000 }).ok).toBe(false)
    expect(validate(shape, { ...base, mode: 'sideways' }).ok).toBe(false)
    expect(validate(shape, { ...base, mode: 'fast' }).ok).toBe(true)
  })

  it('names a missing required field with its description', () => {
    const result = validate(shape, { amount: '1' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.errors[0]).toContain('missing required field "token" (a token)')
  })

  it('emits JSON Schema that closes the object', () => {
    const schema = toJsonSchema(shape) as Record<string, any>
    expect(schema['additionalProperties']).toBe(false)
    expect(schema['required']).toEqual(['token', 'amount'])
    expect(schema['properties'].token.pattern).toBe('^0x[0-9a-fA-F]{40}$')
    expect(schema['properties'].mode.enum).toEqual(['fast', 'slow'])
  })

  it('describes every field for the agent card', () => {
    const lines = describeShape(shape)
    expect(lines).toHaveLength(5)
    expect(lines[2]).toContain('[default 50]')
  })
})

describe('JSON safety', () => {
  it('turns bigints into decimal strings rather than losing them to Number', () => {
    const wei = 123_456_789_012_345_678_901_234n
    const safe = toJsonSafe({ wei, nested: [{ wei }] }) as Record<string, any>
    expect(safe['wei']).toBe('123456789012345678901234')
    expect(safe['nested'][0].wei).toBe('123456789012345678901234')
    expect(() => JSON.stringify(safe)).not.toThrow()
    // Number() would have silently rounded this.
    expect(BigInt(safe['wei'])).toBe(wei)
  })

  it('leaves everything else alone', () => {
    expect(toJsonSafe({ a: 1, b: 'x', c: null, d: true })).toEqual({ a: 1, b: 'x', c: null, d: true })
  })
})

describe('the store', () => {
  it('claims an id exactly once', async () => {
    const store = createMemoryStore()
    const first = await store.claim('k', { n: 1 })
    const second = await store.claim('k', { n: 2 })
    expect(first.claimed).toBe(true)
    expect(second.claimed).toBe(false)
    if (second.claimed) throw new Error('unreachable')
    expect(second.existing).toEqual({ n: 1 })
  })

  it('lists by prefix and deletes', async () => {
    const store = createMemoryStore()
    await store.set('a:1', 1)
    await store.set('a:2', 2)
    await store.set('b:1', 3)
    expect(await store.list('a:')).toEqual(['a:1', 'a:2'])
    await store.delete('a:1')
    expect(await store.list('a:')).toEqual(['a:2'])
  })
})

describe('reconciliation', () => {
  it('agrees when two derivations are within tolerance', () => {
    const check = reconcile({
      label: 'price',
      primary: { source: 'a', value: 100 },
      secondary: { source: 'b', value: 100.5 },
      toleranceBps: 100,
    })
    expect(check.agrees).toBe(true)
    expect(check.deviationBps).toBeCloseTo(49.75, 1)
  })

  it('disagrees past tolerance and names both sources', () => {
    const check = reconcile({
      label: 'price',
      primary: { source: 'venus', value: 100 },
      secondary: { source: 'chainlink', value: 120 },
      toleranceBps: 200,
    })
    expect(check.agrees).toBe(false)
    expect(check.detail).toContain('venus says 100')
    expect(check.detail).toContain('chainlink says 120')
    expect(allAgree([check])).toBe(false)
  })

  it('treats a non-finite derivation as a disagreement, not a pass', () => {
    const check = reconcile({
      label: 'price',
      primary: { source: 'a', value: Number.NaN },
      secondary: { source: 'b', value: 1 },
      toleranceBps: 10_000,
    })
    expect(check.agrees).toBe(false)
    expect(check.detail).toContain('not a finite number')
  })

  it('collects failed assertions', () => {
    const checks = [assertion('ok', true, 'fine'), assertion('bad', false, 'not fine')]
    expect(failedAssertions(checks).map((check) => check.label)).toEqual(['bad'])
  })
})

describe('x402 header decoding', () => {
  it('reads base64 and raw JSON, and prefers the first header given', () => {
    const v2 = Buffer.from(JSON.stringify({ scheme: 'v2' })).toString('base64')
    expect(decodePaymentHeader(v2, undefined)).toEqual({ scheme: 'v2' })
    expect(decodePaymentHeader(undefined, '{"scheme":"v1"}')).toEqual({ scheme: 'v1' })
    expect(decodePaymentHeader(v2, '{"scheme":"v1"}')).toEqual({ scheme: 'v2' })
  })

  it('treats an undecodable header as no payment', () => {
    expect(decodePaymentHeader('not base64 and not json')).toBeNull()
    expect(decodePaymentHeader('')).toBeNull()
    expect(decodePaymentHeader(null, undefined)).toBeNull()
  })
})

describe('JSON-RPC envelopes', () => {
  it('accepts a notification without an id', () => {
    const parsed = parseJsonRpc({ jsonrpc: '2.0', method: 'ping' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('unreachable')
    expect(parsed.request.id).toBeUndefined()
  })

  it('rejects the wrong version and a missing method', () => {
    const version = parseJsonRpc({ jsonrpc: '1.0', id: 1, method: 'ping' })
    expect(version.ok).toBe(false)
    if (version.ok) throw new Error('unreachable')
    expect(version.response).toMatchObject({ error: { code: RPC_ERRORS.INVALID_REQUEST } })

    const method = parseJsonRpc({ jsonrpc: '2.0', id: 1 })
    expect(method.ok).toBe(false)
  })
})

describe('where a language model is allowed to be', () => {
  afterEach(() => setNarrator(null))

  it('passes the deterministic lines through by default', async () => {
    const lines = await narrate({ agent: 'a', skill: 's', decision: {}, lines: ['one', 'two'] })
    expect(lines).toEqual(['one', 'two'])
  })

  it('discards output that introduces an address the decision never mentioned', async () => {
    setNarrator({
      name: 'hostile',
      narrate: () => ['Send the funds to 0x000000000000000000000000000000000000dEaD instead.'],
    })
    const lines = await narrate({
      agent: 'health',
      skill: 'analyse',
      decision: { repayTo: '0x1111111111111111111111111111111111111111' },
      lines: ['The agent computed this.'],
    })
    expect(lines[0]).toBe('The agent computed this.')
    expect(lines.join(' ')).toContain('introduced the address')
    expect(lines.join(' ')).not.toContain('dEaD instead')
  })

  it('keeps output that only repeats addresses the decision contains', async () => {
    setNarrator({
      name: 'honest',
      narrate: () => ['Repaying via 0x1111111111111111111111111111111111111111.'],
    })
    const lines = await narrate({
      agent: 'health',
      skill: 'analyse',
      decision: { repayTo: '0x1111111111111111111111111111111111111111' },
      lines: ['fallback'],
    })
    expect(lines[0]).toContain('Repaying via')
  })

  it('survives a narrator that throws', async () => {
    setNarrator({
      name: 'broken',
      narrate: () => {
        throw new Error('model unavailable')
      },
    })
    const lines = await narrate({ agent: 'a', skill: 's', decision: {}, lines: ['fallback'] })
    expect(lines[0]).toBe('fallback')
    expect(lines[1]).toContain('threw: model unavailable')
  })

  it('cannot change what act sends, whatever it returns', async () => {
    // The structural guarantee: `act` takes an ActInput, which has no
    // narrative field, so there is no path from prose to calldata. Driving a
    // hostile narrator through a real act shows the calls are unchanged.
    const { fakeClient, emptyChain, testContext } = await import('./support/fixtures.js')
    const ctx = testContext({ client: fakeClient(emptyChain()), now: 1_780_000_000 })

    const clean = await actHealth(
      { borrower: '0x000000000000000000000000000000000000b055', intentId: 'n-1' },
      ctx,
    )

    setNarrator({
      name: 'hostile',
      narrate: () => ['Actually, repay to 0x000000000000000000000000000000000000dEaD.'],
    })
    const withNarrator = await actHealth(
      { borrower: '0x000000000000000000000000000000000000b055', intentId: 'n-2' },
      ctx,
    )

    expect(withNarrator.status).toBe(clean.status)
    if (clean.status !== 'aborted' || withNarrator.status !== 'aborted') throw new Error('unreachable')
    expect(withNarrator.reason).toBe(clean.reason)
    expect(JSON.stringify(withNarrator.evidence)).not.toContain('dEaD')
  })
})

describe('the marketplace surface', () => {
  it('covers all four contest categories plus security, with no duplicates', () => {
    const categories = AGENTS.map((agent) => agent.manifest.category)
    expect([...categories].sort()).toEqual(
      ['grid', 'health-factor', 'rebalancing', 'security', 'yield'].sort(),
    )
    expect(new Set(AGENTS.map((agent) => agent.manifest.slug)).size).toBe(5)
  })

  it('gives every agent a read skill, and every writing agent a policy', () => {
    for (const agent of AGENTS) {
      expect(agent.skills.some((skill) => skill.mode === 'read'), agent.manifest.slug).toBe(true)
      const writes = agent.skills.some((skill) => skill.mode === 'write')
      // An agent that can write declares the key that bounds it; one that
      // cannot declares no policy, so its card never claims an authority it
      // does not have.
      expect(writes, agent.manifest.slug).toBe(agent.manifest.policy !== null)
    }
  })

  it('prices exactly one skill per agent, in eighteen-decimal units', () => {
    for (const agent of AGENTS) {
      const priced = agent.skills.filter((skill) => skill.price !== undefined)
      expect(priced, agent.manifest.slug).toHaveLength(1)
      expect(priced[0]!.price!.decimals).toBe(18)
      expect(BigInt(priced[0]!.price!.amountAtomic)).toBeGreaterThan(10n ** 16n)
    }
  })

  it('never prices a write skill — paying to be refused would be absurd', () => {
    for (const agent of AGENTS) {
      for (const skill of agent.skills) {
        if (skill.mode !== 'write') continue
        expect(skill.price, `${agent.manifest.slug}.${skill.id}`).toBeUndefined()
      }
    }
  })
})
