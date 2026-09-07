/**
 * The negative control.
 *
 * Everything else in the suite proves the prober can say yes. This file proves
 * it can say no — that a "reachable" verdict is never vacuous, because the
 * three ways an endpoint fails in the wild all end up as failures with the
 * right label and a score of zero.
 *
 * If these tests ever go green while the endpoints are broken, every rating
 * Hallmark has published is worthless.
 */

import { describe, expect, it } from 'vitest'

import { createProbeContext, probeAgent } from '../src/probe/index.ts'
import { loadConfig } from '../src/config.ts'
import { scoreRun } from '../src/score.ts'
import { toRunRecord } from '../src/store.ts'
import type { RegistryReader } from '@hallmark/core'
import { stubFetch, stubResolver, transportError } from './helpers.ts'

// Every hostname in this file resolves to a public address, so a failure is
// always the endpoint's fault and never the test environment's.
const resolver = stubResolver()

const CARD = (services: Array<{ name: string; endpoint: string }>) =>
  `data:application/json,${encodeURIComponent(
    JSON.stringify({ type: 'agent', name: 'Control Agent', services, active: true }),
  )}`

function fakeRegistry(tokenUri: string): RegistryReader {
  return {
    chainId: 97,
    getAgent: async (agentId: bigint | number) => ({
      agentId: BigInt(agentId),
      owner: '0x0000000000000000000000000000000000000042',
      tokenUri,
      card: (
        await import('@hallmark/core')
      ).parseAgentCardFromTokenUri(tokenUri),
    }),
  } as unknown as RegistryReader
}

const observed = async () => ({ blockNumber: 129_000_000, blockTimestamp: 1_757_000_000 })

function contextFor(tokenUri: string, fetchImpl: typeof fetch) {
  return createProbeContext({
    config: loadConfig({
      env: {},
      probe: { timeoutMs: 300, concurrency: 4, checkDns: true },
      storeDir: './.tmp-not-used',
    }),
    chainId: 97,
    reader: fakeRegistry(tokenUri),
    fetchImpl,
    resolver,
    observe: observed,
    now: () => new Date('2026-09-07T12:00:00.000Z'),
  })
}

describe('negative control', () => {
  it('an endpoint whose host does not resolve is a dns failure, not a pass', async () => {
    const stub = stubFetch({}, { throws: transportError('ENOTFOUND', 'getaddrinfo ENOTFOUND ghost.invalid') })
    const ctx = contextFor(CARD([{ name: 'web', endpoint: 'https://ghost.invalid/' }]), stub.fetch)
    const run = await probeAgent(ctx, 1)

    expect(run.bundle.probe[0]?.ok).toBe(false)
    expect(run.bundle.probe[0]?.failure).toBe('dns')
    expect(run.score).toBe(0)
    expect(toRunRecord(run).failures).toEqual({ dns: 1 })
  })

  it('an endpoint that 404s is an http-4xx failure, not a pass', async () => {
    const stub = stubFetch({}, { status: 404, body: 'nope' })
    const ctx = contextFor(CARD([{ name: 'web', endpoint: 'https://alive.test/gone' }]), stub.fetch)
    const run = await probeAgent(ctx, 2)

    expect(run.bundle.probe[0]?.ok).toBe(false)
    expect(run.bundle.probe[0]?.failure).toBe('http-4xx')
    expect(run.bundle.probe[0]?.httpStatus).toBe(404)
    expect(run.score).toBe(0)
  })

  it('an A2A endpoint that returns HTML where JSON was promised is a not-json failure', async () => {
    const stub = stubFetch({}, {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<!doctype html><html><body>Welcome to my startup</body></html>',
    })
    const ctx = contextFor(CARD([{ name: 'a2a', endpoint: 'https://landing.test/a2a' }]), stub.fetch)
    const run = await probeAgent(ctx, 3)

    expect(run.bundle.probe[0]?.ok).toBe(false)
    expect(run.bundle.probe[0]?.failure).toBe('not-json')
    expect(run.bundle.probe[0]?.httpStatus).toBe(200)
    expect(run.score).toBe(0)
  })

  it('an MCP endpoint that answers 200 with prose is a bad-protocol failure', async () => {
    const stub = stubFetch({}, { status: 200, body: '{"message":"hello"}' })
    const ctx = contextFor(CARD([{ name: 'mcp', endpoint: 'https://pretend.test/mcp' }]), stub.fetch)
    const run = await probeAgent(ctx, 4)

    expect(run.bundle.probe[0]?.failure).toBe('bad-protocol')
    expect(run.score).toBe(0)
  })

  it('an agent that declares only a did: identifier scores 0 with nothing counted', async () => {
    const ctx = contextFor(CARD([{ name: 'did', endpoint: 'did:web:example.com' }]), stubFetch({}).fetch)
    const run = await probeAgent(ctx, 5)

    expect(run.bundle.probe[0]?.scored).toBe(false)
    expect(run.bundle.probe[0]?.failure).toBe('unsupported-scheme')
    expect(run.score).toBe(0)
  })

  it('an agent whose registration file is garbage scores 0 and says why', async () => {
    const ctx = contextFor('0x1234', stubFetch({}).fetch)
    const run = await probeAgent(ctx, 6)

    expect(run.bundle.agent.cardError).toMatch(/bare hex/)
    expect(run.bundle.probe).toEqual([])
    expect(run.score).toBe(0)
  })

  it('an agent pointing at loopback is refused before a socket opens', async () => {
    let called = false
    const stub = stubFetch({}, () => {
      called = true
      return { status: 200, body: '{}' }
    })
    const ctx = contextFor(CARD([{ name: 'web', endpoint: 'http://127.0.0.1:8080/' }]), stub.fetch)
    const run = await probeAgent(ctx, 7)

    expect(called).toBe(false)
    expect(run.bundle.probe[0]?.failure).toBe('blocked')
    expect(run.score).toBe(0)
  })

  it('a working agent does score, so the control is not just "everything fails"', async () => {
    const card = JSON.stringify({
      name: 'Live One',
      capabilities: { streaming: true },
      skills: [{ id: 'quote', name: 'quote' }],
    })
    const stub = stubFetch({ 'https://live.test/a2a': { status: 200, body: card } })
    const ctx = contextFor(CARD([{ name: 'a2a', endpoint: 'https://live.test/a2a' }]), stub.fetch)
    const run = await probeAgent(ctx, 8)

    expect(run.bundle.probe[0]?.ok).toBe(true)
    expect(run.score).toBeGreaterThan(0)
    expect(run.bundle.capabilities.a2aSkills).toContain('quote')
  })

  it('mixed outcomes produce a partial score, never a rounded-up one', async () => {
    const card = JSON.stringify({ name: 'Half Alive', skills: [{ name: 'quote' }] })
    const stub = stubFetch({
      'https://half.test/a2a': { status: 200, body: card },
      'https://half.test/dead': { status: 500, body: '' },
    })
    const ctx = contextFor(
      CARD([
        { name: 'a2a', endpoint: 'https://half.test/a2a' },
        { name: 'web', endpoint: 'https://half.test/dead' },
      ]),
      stub.fetch,
    )
    const run = await probeAgent(ctx, 9)

    expect(run.score).toBeGreaterThan(0)
    expect(run.score).toBeLessThan(100)
    expect(scoreRun({ probe: run.bundle.probe, capabilities: run.bundle.capabilities }).score).toBe(run.score)
    expect(run.bundle.probe.filter((p) => p.ok)).toHaveLength(1)
  })
})
