import { describe, expect, it } from 'vitest'

import { BlockedUrlError } from '../src/errors.js'
import {
  assertPublicUrl,
  classifyUrl,
  isBlockedHostname,
  isPrivateIpv4,
  isPrivateIpv6,
  safeFetch,
} from '../src/net.js'
import { publicLookup } from './fixtures.js'

describe('address classification', () => {
  it.each([
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
  ])('refuses %s', (address) => {
    expect(isPrivateIpv4(address)).toBe(true)
  })

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.0.1'])(
    'allows the public address %s',
    (address) => {
      expect(isPrivateIpv4(address)).toBe(false)
    },
  )

  it.each(['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1'])('refuses the v6 %s', (address) => {
    expect(isPrivateIpv6(address)).toBe(true)
  })

  it('allows a public v6 address', () => {
    expect(isPrivateIpv6('2606:4700:4700::1111')).toBe(false)
  })

  it.each(['localhost', 'printer.local', 'api.internal', 'db.home.arpa', 'intranet'])(
    'refuses the hostname %s',
    (host) => {
      expect(isBlockedHostname(host)).toBe(true)
    },
  )

  it('allows a normal public hostname', () => {
    expect(isBlockedHostname('agents.example.com')).toBe(false)
  })
})

describe('classifyUrl', () => {
  it('accepts https', () => {
    expect(classifyUrl('https://example.com/a2a').ok).toBe(true)
  })

  it('refuses http unless explicitly allowed', () => {
    expect(classifyUrl('http://example.com')).toEqual({ ok: false, reason: 'scheme is "http", expected https' })
    expect(classifyUrl('http://example.com', { allowHttp: true }).ok).toBe(true)
  })

  it('refuses other schemes', () => {
    expect(classifyUrl('file:///etc/passwd').ok).toBe(false)
    expect(classifyUrl('ftp://example.com').ok).toBe(false)
  })

  it('refuses credentials in the URL', () => {
    expect(classifyUrl('https://user:pass@example.com')).toEqual({ ok: false, reason: 'URL carries credentials' })
  })

  it('refuses garbage', () => {
    expect(classifyUrl('not a url')).toEqual({ ok: false, reason: 'not a URL' })
  })
})

describe('assertPublicUrl', () => {
  it('refuses a host that resolves to a private address', async () => {
    await expect(
      assertPublicUrl('https://evil.example.com/x', { lookup: async () => ['10.1.2.3'] }),
    ).rejects.toBeInstanceOf(BlockedUrlError)
  })

  it('refuses when any of the resolved addresses is private', async () => {
    await expect(
      assertPublicUrl('https://evil.example.com/x', { lookup: async () => ['8.8.8.8', '127.0.0.1'] }),
    ).rejects.toThrow(/private address 127\.0\.0\.1/)
  })

  it('allows a host that resolves publicly', async () => {
    const url = await assertPublicUrl('https://example.com/x', { lookup: publicLookup })
    expect(url.hostname).toBe('example.com')
  })

  it('refuses a host with no addresses', async () => {
    await expect(assertPublicUrl('https://example.com', { lookup: async () => [] })).rejects.toThrow(
      /no addresses/,
    )
  })
})

describe('safeFetch', () => {
  const lookup = publicLookup

  it('follows redirects up to the cap', async () => {
    const fetchImpl = (async (input: string) => {
      if (input === 'https://example.com/a') {
        return new Response(null, { status: 302, headers: { location: 'https://example.com/b' } })
      }
      return new Response('done', { status: 200 })
    }) as unknown as typeof fetch

    const result = await safeFetch('https://example.com/a', { fetchImpl, lookup })
    expect(result.status).toBe(200)
    expect(result.redirects).toBe(1)
    expect(result.body).toBe('done')
  })

  it('gives up past the redirect cap instead of looping', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.com/next' } })) as unknown as typeof fetch

    await expect(safeFetch('https://example.com/a', { fetchImpl, lookup, maxRedirects: 2 })).rejects.toThrow(
      /more than 2 redirects/,
    )
  })

  it('re-checks every redirect hop, so a public host cannot bounce us inward', async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })) as unknown as typeof fetch

    await expect(safeFetch('https://example.com/a', { fetchImpl, lookup })).rejects.toBeInstanceOf(BlockedUrlError)
  })

  it('caps the body', async () => {
    const fetchImpl = (async () => new Response('x'.repeat(10_000), { status: 200 })) as unknown as typeof fetch
    const result = await safeFetch('https://example.com', { fetchImpl, lookup, maxBytes: 128 })
    expect(result.truncated).toBe(true)
    expect(result.body).toHaveLength(128)
  })

  it('does not flag a body that fits', async () => {
    const fetchImpl = (async () => new Response('small', { status: 200 })) as unknown as typeof fetch
    const result = await safeFetch('https://example.com', { fetchImpl, lookup, maxBytes: 128 })
    expect(result.truncated).toBe(false)
  })

  it('refuses a private target before sending anything', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch

    await expect(safeFetch('https://127.0.0.1/x', { fetchImpl, lookup })).rejects.toBeInstanceOf(BlockedUrlError)
    expect(called).toBe(false)
  })
})
