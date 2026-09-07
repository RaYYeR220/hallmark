import { describe, expect, it } from 'vitest'

import { httpRequest, httpRequestWithRetry, guardFailureClass, DEFAULT_MAX_BODY_BYTES } from '../src/probe/http.ts'
import { stubFetch, stubResolver, transportError } from './helpers.ts'

const base = { checkDns: true, resolver: stubResolver(), timeoutMs: 300 }

describe('failure classification', () => {
  it('classifies a hostname that does not resolve as dns', async () => {
    const stub = stubFetch({}, { throws: transportError('ENOTFOUND', 'getaddrinfo ENOTFOUND nope.test') })
    const res = await httpRequest('https://nope.test/', { ...base, fetchImpl: stub.fetch })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.failure).toBe('dns')
  })

  it('classifies a refused connection as refused', async () => {
    const stub = stubFetch({}, { throws: transportError('ECONNREFUSED') })
    const res = await httpRequest('https://closed.test/', { ...base, fetchImpl: stub.fetch })
    if (!res.ok) expect(res.failure).toBe('refused')
    else expect.unreachable('should have failed')
  })

  it('classifies an unroutable host as refused', async () => {
    const stub = stubFetch({}, { throws: transportError('EHOSTUNREACH') })
    const res = await httpRequest('https://gone.test/', { ...base, fetchImpl: stub.fetch })
    if (!res.ok) expect(res.failure).toBe('refused')
    else expect.unreachable('should have failed')
  })

  it('classifies a certificate problem as tls', async () => {
    const stub = stubFetch({}, { throws: transportError('UNABLE_TO_VERIFY_LEAF_SIGNATURE') })
    const res = await httpRequest('https://badcert.test/', { ...base, fetchImpl: stub.fetch })
    if (!res.ok) expect(res.failure).toBe('tls')
    else expect.unreachable('should have failed')
  })

  it('classifies a self-signed certificate as tls', async () => {
    const stub = stubFetch({}, { throws: transportError('DEPTH_ZERO_SELF_SIGNED_CERT') })
    const res = await httpRequest('https://selfsigned.test/', { ...base, fetchImpl: stub.fetch })
    if (!res.ok) expect(res.failure).toBe('tls')
    else expect.unreachable('should have failed')
  })

  it('classifies a hang as timeout', async () => {
    const stub = stubFetch({}, { hangs: true })
    const res = await httpRequest('https://slow.test/', { ...base, timeoutMs: 60, fetchImpl: stub.fetch })
    if (!res.ok) expect(res.failure).toBe('timeout')
    else expect.unreachable('should have failed')
  })

  it('classifies a connect timeout as timeout', async () => {
    const stub = stubFetch({}, { throws: transportError('UND_ERR_CONNECT_TIMEOUT') })
    const res = await httpRequest('https://slow2.test/', { ...base, fetchImpl: stub.fetch })
    if (!res.ok) expect(res.failure).toBe('timeout')
    else expect.unreachable('should have failed')
  })

  it('classifies a 404 as http-4xx and keeps the body', async () => {
    const stub = stubFetch({}, { status: 404, body: 'not found' })
    const res = await httpRequest('https://missing.test/', { ...base, fetchImpl: stub.fetch })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.failure).toBe('http-4xx')
      expect(res.status).toBe(404)
      expect(res.text).toBe('not found')
    }
  })

  it('classifies a 503 as http-5xx', async () => {
    const stub = stubFetch({}, { status: 503, body: '' })
    const res = await httpRequest('https://down.test/', { ...base, fetchImpl: stub.fetch })
    if (!res.ok) expect(res.failure).toBe('http-5xx')
    else expect.unreachable('should have failed')
  })

  it('classifies an unclassifiable transport error as network', async () => {
    const stub = stubFetch({}, { throws: transportError('ECONNRESET', 'socket hang up') })
    const res = await httpRequest('https://reset.test/', { ...base, fetchImpl: stub.fetch })
    if (!res.ok) expect(res.failure).toBe('network')
    else expect.unreachable('should have failed')
  })

  it('refuses a private host before any socket opens', async () => {
    let called = false
    const stub = stubFetch({}, () => {
      called = true
      return { status: 200 }
    })
    const res = await httpRequest('http://169.254.169.254/latest/meta-data/', { ...base, fetchImpl: stub.fetch })
    expect(called).toBe(false)
    if (!res.ok) expect(res.failure).toBe('blocked')
    else expect.unreachable('should have been blocked')
  })

  it('refuses a non-http scheme', async () => {
    const res = await httpRequest('did:web:example.com', { ...base, fetchImpl: stubFetch({}).fetch })
    if (!res.ok) expect(res.failure).toBe('unsupported-scheme')
    else expect.unreachable('should have been refused')
  })

  it('maps guard reasons onto the right class', () => {
    expect(guardFailureClass('DNS lookup failed for x: nope')).toBe('dns')
    expect(guardFailureClass('DNS lookup returned no addresses for x')).toBe('dns')
    expect(guardFailureClass('refusing scheme ftp; only http and https are probed')).toBe('unsupported-scheme')
    expect(guardFailureClass('refusing private host "localhost"')).toBe('blocked')
  })
})

describe('redirects', () => {
  it('follows a redirect and reports the hop count', async () => {
    const stub = stubFetch({
      'https://a.test/': { status: 302, headers: { location: 'https://b.test/final' } },
      'https://b.test/final': { status: 200, body: '{"ok":true}' },
    })
    const res = await httpRequest('https://a.test/', { ...base, fetchImpl: stub.fetch })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.redirects).toBe(1)
      expect(res.finalUrl).toBe('https://b.test/final')
    }
  })

  it('re-guards every hop, so a redirect into private space is blocked', async () => {
    const stub = stubFetch({
      'https://a.test/': { status: 302, headers: { location: 'http://169.254.169.254/' } },
    })
    const res = await httpRequest('https://a.test/', { ...base, fetchImpl: stub.fetch })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.failure).toBe('blocked')
    expect(stub.calls.length).toBe(1)
  })

  it('caps the redirect chain', async () => {
    const stub = stubFetch({}, (url) => ({ status: 302, headers: { location: `${url}x` } }))
    const res = await httpRequest('https://loop.test/', { ...base, maxRedirects: 2, fetchImpl: stub.fetch })
    if (!res.ok) expect(res.failure).toBe('too-many-redirects')
    else expect.unreachable('should have failed')
  })

  it('demotes a redirected POST to GET and drops the body', async () => {
    const stub = stubFetch({
      'https://mcp.test/a': { status: 302, headers: { location: 'https://mcp.test/b' } },
      'https://mcp.test/b': { status: 200, body: '{}' },
    })
    await httpRequest('https://mcp.test/a', { ...base, method: 'POST', body: '{"x":1}', fetchImpl: stub.fetch })
    expect(stub.calls[0]?.method).toBe('POST')
    expect(stub.calls[1]?.method).toBe('GET')
    expect(stub.calls[1]?.body).toBe(null)
  })

  it('replays a POST body across a 307', async () => {
    const stub = stubFetch({
      'https://mcp.test/a': { status: 307, headers: { location: 'https://mcp.test/b' } },
      'https://mcp.test/b': { status: 200, body: '{}' },
    })
    await httpRequest('https://mcp.test/a', { ...base, method: 'POST', body: '{"x":1}', fetchImpl: stub.fetch })
    expect(stub.calls[1]?.method).toBe('POST')
    expect(stub.calls[1]?.body).toBe('{"x":1}')
  })
})

describe('body cap', () => {
  it('refuses a body that declares itself too large', async () => {
    const stub = stubFetch({}, {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(DEFAULT_MAX_BODY_BYTES + 1) },
      body: 'x',
    })
    const res = await httpRequest('https://fat.test/', { ...base, fetchImpl: stub.fetch })
    if (!res.ok) expect(res.failure).toBe('too-large')
    else expect.unreachable('should have failed')
  })

  it('stops reading a body that grows past the cap', async () => {
    const stub = stubFetch({}, { status: 200, body: 'x'.repeat(4096) })
    const res = await httpRequest('https://fat2.test/', { ...base, maxBodyBytes: 512, fetchImpl: stub.fetch })
    if (!res.ok) expect(res.failure).toBe('too-large')
    else expect.unreachable('should have failed')
  })
})

describe('retry', () => {
  it('retries once on a transient failure and keeps the success', async () => {
    let attempts = 0
    const stub = stubFetch({}, () => {
      attempts += 1
      return attempts === 1 ? { throws: transportError('ECONNRESET', 'socket hang up') } : { status: 200, body: '{}' }
    })
    const res = await httpRequestWithRetry('https://flaky.test/', { ...base, fetchImpl: stub.fetch })
    expect(res.ok).toBe(true)
    expect(attempts).toBe(2)
  })

  it('does not retry a settled answer like a 404', async () => {
    let attempts = 0
    const stub = stubFetch({}, () => {
      attempts += 1
      return { status: 404, body: '' }
    })
    await httpRequestWithRetry('https://missing.test/', { ...base, fetchImpl: stub.fetch })
    expect(attempts).toBe(1)
  })

  it('does not retry a refused connection', async () => {
    let attempts = 0
    const stub = stubFetch({}, () => {
      attempts += 1
      return { throws: transportError('ECONNREFUSED') }
    })
    await httpRequestWithRetry('https://closed.test/', { ...base, fetchImpl: stub.fetch })
    expect(attempts).toBe(1)
  })
})
