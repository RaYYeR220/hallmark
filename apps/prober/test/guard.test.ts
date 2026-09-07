import { describe, expect, it } from 'vitest'

import { guardUrl, guardUrlSync, isPrivateAddress } from '../src/probe/guard.ts'
import { stubResolver } from './helpers.ts'

describe('private host refusal', () => {
  const refused = [
    'http://localhost:3000',
    'http://LOCALHOST/health',
    'http://127.0.0.1/',
    'http://127.9.9.9/',
    'https://0.0.0.0/',
    'http://10.0.0.5/',
    'http://10.255.255.255/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://198.18.0.1/',
    'http://255.255.255.255/',
    'http://224.0.0.1/',
    'http://[::1]/',
    'http://[::]/',
    'http://[fd00::1]/',
    'http://[fc00::abcd]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://printer.local/',
    'http://db.internal/api',
    'http://thing.home.arpa/',
    'http://box.lan/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
  ]

  for (const url of refused) {
    it(`refuses ${url}`, () => {
      const verdict = guardUrlSync(url)
      expect(verdict.allowed, `${url} should have been refused`).toBe(false)
    })
  }

  const allowed = [
    'https://example.com/',
    'http://93.184.216.34/',
    'https://agent.example.com:8443/mcp',
    'https://[2606:2800:220:1:248:1893:25c8:1946]/',
    'http://172.32.0.1/',
    'http://11.0.0.1/',
  ]

  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(guardUrlSync(url).allowed, `${url} should have been allowed`).toBe(true)
    })
  }
})

describe('scheme refusal', () => {
  for (const url of ['did:web:example.com', 'mailto:hi@example.com', 'ftp://example.com/x', 'file:///etc/passwd', 'ws://example.com']) {
    it(`refuses ${url}`, () => {
      const verdict = guardUrlSync(url)
      expect(verdict.allowed).toBe(false)
      if (!verdict.allowed) expect(verdict.reason).toMatch(/scheme|not a URL/)
    })
  }

  it('refuses inline credentials so a probe can never carry them', () => {
    const verdict = guardUrlSync('https://user:secret@example.com/')
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toMatch(/credential/)
  })
})

describe('DNS rebinding', () => {
  it('refuses a public hostname that resolves into private space', async () => {
    const verdict = await guardUrl('https://evil.example/', {
      resolver: stubResolver({ 'evil.example': ['169.254.169.254'] }),
    })
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toMatch(/link-local|metadata/)
  })

  it('refuses when any one of several answers is private', async () => {
    const verdict = await guardUrl('https://mixed.example/', {
      resolver: stubResolver({ 'mixed.example': ['93.184.216.34', '10.1.2.3'] }),
    })
    expect(verdict.allowed).toBe(false)
  })

  it('allows a hostname that resolves publicly', async () => {
    const verdict = await guardUrl('https://good.example/', {
      resolver: stubResolver({ 'good.example': ['93.184.216.34'] }),
    })
    expect(verdict.allowed).toBe(true)
  })

  it('refuses a hostname with no answers at all', async () => {
    const verdict = await guardUrl('https://void.example/', { resolver: stubResolver({ 'void.example': [] }) })
    expect(verdict.allowed).toBe(false)
    if (!verdict.allowed) expect(verdict.reason).toMatch(/no addresses/)
  })

  it('skips the lookup for an IP literal that already passed', async () => {
    let called = false
    const verdict = await guardUrl('https://93.184.216.34/', {
      resolver: async () => {
        called = true
        return []
      },
    })
    expect(verdict.allowed).toBe(true)
    expect(called).toBe(false)
  })
})

describe('isPrivateAddress', () => {
  it('classifies raw addresses', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('169.254.169.254')).toBe(true)
    expect(isPrivateAddress('fd12:3456::1')).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
  })
})
