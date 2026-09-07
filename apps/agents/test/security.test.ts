import { describe, expect, it } from 'vitest'
import { encodeAbiParameters, keccak256, toFunctionSelector, toHex, type Address, type Hex } from 'viem'

import { analyseSecurity } from '../src/agents/security/analyse.js'
import { detectProxy, analysisTarget, PROXY_SLOTS } from '../src/chain/proxy.js'
import { PRIVILEGE_SIGNATURES, scanPrivileges } from '../src/chain/privileges.js'
import { erc7201Base } from '../src/chain/honeypot.js'
import {
  PANCAKE_V2_FACTORY,
  WBNB,
} from '../src/chain/abis.js'
import { emptyChain, fakeClient, readKey, testContext, type FakeChain } from './support/fixtures.js'

/**
 * Token safety.
 *
 * The single most consequential test in this file is the first one: a live BNB
 * Chain token is an EIP-1167 minimal proxy that a well-known commercial
 * scanner reported as `is_proxy: 0`. Anything that believes that analyses 45
 * bytes of delegation stub, finds no mint function, no blacklist and no owner,
 * and calls the token clean. Detection here is from the bytecode, and the
 * fixture is the real stub shape.
 */

const TOKEN: Address = '0x000000000000000000000000000000000000700f'
const IMPL: Address = '0x0000000000000000000000000000000000091337'
const OWNER: Address = '0x0000000000000000000000000000000000000abc'
const DEAD: Address = '0x000000000000000000000000000000000000dEaD'
const PAIR: Address = '0x0000000000000000000000000000000000000dab'
const NOW = 1_780_000_000

/** The canonical EIP-1167 runtime, 45 bytes, with the implementation inlined. */
function minimalProxyCode(implementation: Address): Hex {
  return `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3` as Hex
}

/** A body big enough to be real code, carrying the given selectors. */
function bodyWith(signatures: string[], padTo = 4_000): Hex {
  const selectors = signatures.map((signature) => toFunctionSelector(signature).slice(2)).join('00')
  const padding = '60'.repeat(Math.max(0, padTo - selectors.length / 2))
  return `0x6080604052${selectors}${padding}` as Hex
}

describe('proxy detection', () => {
  it('detects an EIP-1167 minimal proxy from the bytecode and resolves it', async () => {
    const client = fakeClient(
      emptyChain({
        code: {
          [TOKEN.toLowerCase()]: minimalProxyCode(IMPL),
          [IMPL.toLowerCase()]: bodyWith(['mint(address,uint256)'], 19_331),
        },
      }),
    )
    const proxy = await detectProxy(client, TOKEN)

    expect(proxy.isProxy).toBe(true)
    expect(proxy.kind).toBe('eip1167-minimal')
    expect(proxy.implementation?.toLowerCase()).toBe(IMPL.toLowerCase())
    expect(proxy.proxyCodeSize).toBe(45)
    expect(proxy.implementationCodeSize).toBeGreaterThan(19_000)
    expect(analysisTarget(TOKEN, proxy).toLowerCase()).toBe(IMPL.toLowerCase())
    expect(proxy.detail).toContain('delegation stub')
  })

  it('detects the optimised minimal-proxy variants too, not only the canonical 45 bytes', async () => {
    // 0age's shorter form. Different stack setup, same PUSH20 + DELEGATECALL.
    const optimised = `0x3d3d3d3d363d3d37363d73${IMPL.slice(2)}5af43d3d93803e602a57fd5bf3` as Hex
    const client = fakeClient(
      emptyChain({ code: { [TOKEN.toLowerCase()]: optimised, [IMPL.toLowerCase()]: bodyWith([]) } }),
    )
    const proxy = await detectProxy(client, TOKEN)
    expect(proxy.isProxy).toBe(true)
    expect(proxy.kind).toBe('eip1167-minimal')
  })

  it('reads the EIP-1967 implementation slot', async () => {
    const client = fakeClient(
      emptyChain({
        code: { [TOKEN.toLowerCase()]: bodyWith([], 200), [IMPL.toLowerCase()]: bodyWith([]) },
        storage: {
          [`${TOKEN.toLowerCase()}::${PROXY_SLOTS.eip1967Implementation.toLowerCase()}`]:
            `0x${IMPL.slice(2).padStart(64, '0')}` as Hex,
          [`${TOKEN.toLowerCase()}::${PROXY_SLOTS.eip1967Admin.toLowerCase()}`]:
            `0x${OWNER.slice(2).padStart(64, '0')}` as Hex,
        },
      }),
    )
    const proxy = await detectProxy(client, TOKEN)
    expect(proxy.kind).toBe('eip1967-transparent')
    expect(proxy.implementation?.toLowerCase()).toBe(IMPL.toLowerCase())
    expect(proxy.admin?.toLowerCase()).toBe(OWNER.toLowerCase())
  })

  it('reads the EIP-1822 and legacy OpenZeppelin slots', async () => {
    for (const [slot, kind] of [
      [PROXY_SLOTS.eip1822, 'eip1822-uups'],
      [PROXY_SLOTS.openzeppelinLegacy, 'openzeppelin-legacy'],
    ] as const) {
      const client = fakeClient(
        emptyChain({
          code: { [TOKEN.toLowerCase()]: bodyWith([], 200), [IMPL.toLowerCase()]: bodyWith([]) },
          storage: {
            [`${TOKEN.toLowerCase()}::${slot.toLowerCase()}`]: `0x${IMPL.slice(2).padStart(64, '0')}` as Hex,
          },
        }),
      )
      const proxy = await detectProxy(client, TOKEN)
      expect(proxy.kind).toBe(kind)
    }
  })

  it('reports a plain contract as not a proxy — the negative control', async () => {
    const client = fakeClient(emptyChain({ code: { [TOKEN.toLowerCase()]: bodyWith(['mint(address,uint256)']) } }))
    const proxy = await detectProxy(client, TOKEN)
    expect(proxy.isProxy).toBe(false)
    expect(proxy.implementation).toBeNull()
    expect(analysisTarget(TOKEN, proxy)).toBe(TOKEN)
    // Every check it ran is still reported, so "not a proxy" is evidenced.
    expect(proxy.evidence.length).toBeGreaterThanOrEqual(5)
  })

  it('reports an address with no code rather than analysing nothing', async () => {
    const proxy = await detectProxy(fakeClient(emptyChain()), TOKEN)
    expect(proxy.isProxy).toBe(false)
    expect(proxy.detail).toContain('no bytecode')
  })

  it('does not mistake a large contract containing DELEGATECALL for a stub', async () => {
    // A real contract can hold PUSH20 + DELEGATECALL in a library call. The
    // size bound is what stops that reading as a minimal proxy.
    const client = fakeClient(
      emptyChain({
        code: {
          [TOKEN.toLowerCase()]: `0x${'60'.repeat(500)}73${IMPL.slice(2)}5af4${'60'.repeat(500)}` as Hex,
        },
      }),
    )
    const proxy = await detectProxy(client, TOKEN)
    expect(proxy.kind).not.toBe('eip1167-minimal')
    expect(proxy.evidence[0]!.result).toContain('body is')
  })
})

describe('privilege scanning', () => {
  it('finds the selectors that are present and reports the ones that are not', () => {
    const scan = scanPrivileges({
      address: IMPL,
      bytecode: bodyWith(['mint(address,uint256)', 'pause()', 'setSellTax(uint256)']),
    })
    const found = scan.found.map((entry) => entry.signature)
    expect(found).toContain('mint(address,uint256)')
    expect(found).toContain('pause()')
    expect(found).toContain('setSellTax(uint256)')
    expect(scan.counts.critical).toBeGreaterThanOrEqual(1)
    expect(scan.absent.length).toBe(PRIVILEGE_SIGNATURES.length - scan.found.length)
  })

  it('finds nothing in a body that contains none of them — the negative control', () => {
    const scan = scanPrivileges({ address: IMPL, bytecode: `0x${'ab'.repeat(2_000)}` as Hex })
    expect(scan.found).toHaveLength(0)
    expect(scan.counts.critical).toBe(0)
  })

  it('every finding carries a reason a holder can act on', () => {
    for (const definition of PRIVILEGE_SIGNATURES) {
      expect(definition.why.length).toBeGreaterThan(20)
      expect(definition.label.length).toBeGreaterThan(3)
    }
  })
})

describe('ERC-7201 namespaced storage bases', () => {
  it('derives the base by the published formula rather than a pasted constant', () => {
    const id = 'openzeppelin.storage.ERC20'
    const inner = BigInt(keccak256(toHex(id))) - 1n
    const expected = BigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }], [inner]))) & ~0xffn
    expect(erc7201Base(id)).toBe(expected)
    // The low byte is masked off, which is what makes it a valid base.
    expect(erc7201Base(id) & 0xffn).toBe(0n)
  })
})

// ---------------------------------------------------------------------------

type TokenFixture = {
  proxy?: boolean
  owner?: Address | null
  privileges?: string[]
  lpBurnedShare?: bigint
  totalSupply?: bigint
}

function tokenChain(fixture: TokenFixture = {}): FakeChain {
  const isProxy = fixture.proxy ?? false
  const target = isProxy ? IMPL : TOKEN
  const totalSupply = fixture.totalSupply ?? 10n ** 24n
  const lpTotal = 10n ** 21n
  const burned = fixture.lpBurnedShare ?? lpTotal // fully burned by default

  const reads: Record<string, unknown> = {
    [readKey(TOKEN, 'symbol')]: 'TKN',
    [readKey(TOKEN, 'name')]: 'Token',
    [readKey(TOKEN, 'decimals')]: 18,
    [readKey(TOKEN, 'totalSupply')]: totalSupply,
    [readKey(PANCAKE_V2_FACTORY, 'getPair', [TOKEN, WBNB])]: PAIR,
    [readKey(PAIR, 'totalSupply')]: lpTotal,
    [readKey(PAIR, 'balanceOf', ['0x0000000000000000000000000000000000000000'])]: 0n,
    [readKey(PAIR, 'balanceOf', [DEAD])]: burned,
    [readKey(PAIR, 'getReserves')]: [10n ** 19n, 10n ** 23n, 0],
    [readKey(PAIR, 'token0')]: WBNB,
    [readKey('0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE', 'latestRoundData')]: [
      1n, 700_00000000n, BigInt(NOW - 10), BigInt(NOW - 10), 1n,
    ],
    [readKey('0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE', 'decimals')]: 8,
  }

  // Lockers we recognise hold nothing in this fixture.
  for (const locker of [
    '0x407993575c91ce7643a4d4cCACc9A98c36eE1BBE',
    '0xC765bDdB93b0D1c1A88282BA0fa6B2d00E3e0c83',
    '0x0C89C0407775dd89b12918B9c0aa42Bf96518820',
    '0x7ee058420e5937496F5a2096f04caA7721cF70cc',
  ]) {
    reads[readKey(PAIR, 'balanceOf', [locker])] = 0n
  }

  if (fixture.owner !== null) {
    reads[readKey(TOKEN, 'owner')] = fixture.owner ?? DEAD
  }

  return emptyChain({
    reads,
    code: {
      [TOKEN.toLowerCase()]: isProxy ? minimalProxyCode(IMPL) : bodyWith(fixture.privileges ?? []),
      ...(isProxy ? { [IMPL.toLowerCase()]: bodyWith(fixture.privileges ?? [], 19_331) } : {}),
    },
    blockNumber: 41_000_000n,
  })
  void target
}

describe('the verdict', () => {
  it('runs the privilege scan against the implementation when the token is a proxy', async () => {
    const ctx = testContext({
      client: fakeClient(tokenChain({ proxy: true, privileges: ['mint(address,uint256)'] })),
      now: NOW,
    })
    const result = await analyseSecurity({ token: TOKEN }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)

    expect(result.decision.analysedContract.toLowerCase()).toBe(IMPL.toLowerCase())
    expect(result.decision.privileges.scanned.toLowerCase()).toBe(IMPL.toLowerCase())
    // The mint lives in the implementation. Scanning the 45-byte stub would
    // have found nothing and called the token clean.
    expect(result.decision.privileges.found.map((entry) => entry.signature)).toContain(
      'mint(address,uint256)',
    )
    expect(result.decision.verdict).toBe('no-go')
  })

  it('would have missed the mint if it had scanned the stub — the control', async () => {
    // The same bytecode at the same address, without the proxy resolution.
    const stub = scanPrivileges({ address: TOKEN, bytecode: minimalProxyCode(IMPL) })
    expect(stub.found).toHaveLength(0)
    expect(stub.codeSize).toBe(45)
  })

  it('never reaches "go" while a check could not be run', async () => {
    const ctx = testContext({ client: fakeClient(tokenChain()), now: NOW })
    const result = await analyseSecurity({ token: TOKEN }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)

    // Nothing failed, but the free tier does not run the holder scan or the
    // sell simulation, and BNB Chain source verification needs a paid key.
    expect(result.decision.unknowns.length).toBeGreaterThan(0)
    expect(result.decision.verdict).toBe('caution')
    expect(result.decision.headline).toContain('An unrun check is not a pass')
  })

  it('calls a retained owner a warning, and a burned one a pass', async () => {
    const retained = await analyseSecurity(
      { token: TOKEN },
      testContext({ client: fakeClient(tokenChain({ owner: OWNER })), now: NOW }),
      { deep: false },
    )
    if ('error' in retained) throw new Error(retained.detail)
    const retainedFinding = retained.decision.findings.find((finding) => finding.id === 'ownership')!
    expect(retainedFinding.status).toBe('warn')
    expect(retainedFinding.detail).toContain('including after you buy')

    const renounced = await analyseSecurity(
      { token: TOKEN },
      testContext({ client: fakeClient(tokenChain({ owner: DEAD })), now: NOW }),
      { deep: false },
    )
    if ('error' in renounced) throw new Error(renounced.detail)
    expect(renounced.decision.findings.find((finding) => finding.id === 'ownership')!.status).toBe('pass')
  })

  it('reports withdrawable liquidity as a critical failure', async () => {
    const ctx = testContext({
      client: fakeClient(tokenChain({ lpBurnedShare: 10n ** 19n })), // 1% burned
      now: NOW,
    })
    const result = await analyseSecurity({ token: TOKEN }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    const lp = result.decision.findings.find((finding) => finding.id === 'lp-lock')!
    expect(lp.status).toBe('fail')
    expect(result.decision.verdict).toBe('no-go')
  })

  it('says an unrecognised locker reads as unlocked, so a low figure is not proof', async () => {
    const ctx = testContext({ client: fakeClient(tokenChain({ lpBurnedShare: 0n })), now: NOW })
    const result = await analyseSecurity({ token: TOKEN }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    expect(result.decision.lp!.detail).toContain('not proven locked')
  })

  it('gives every finding evidence a reader can repeat', async () => {
    const ctx = testContext({ client: fakeClient(tokenChain()), now: NOW })
    const result = await analyseSecurity({ token: TOKEN }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    for (const finding of result.decision.findings) {
      expect(Object.keys(finding.evidence).length, finding.id).toBeGreaterThan(0)
    }
    expect(result.decision.assertions.every((check) => check.holds)).toBe(true)
  })

  it('reports source verification as unknown rather than guessing', async () => {
    const ctx = testContext({ client: fakeClient(tokenChain()), now: NOW })
    const result = await analyseSecurity({ token: TOKEN }, ctx, { deep: false })
    if ('error' in result) throw new Error(result.detail)
    const source = result.decision.findings.find((finding) => finding.id === 'source-verification')!
    expect(source.status).toBe('unknown')
    expect(source.detail).toContain('Free API access is not supported for this chain')
  })

  it('refuses to analyse an address with no code', async () => {
    const ctx = testContext({ client: fakeClient(emptyChain()), now: NOW })
    const result = await analyseSecurity({ token: TOKEN }, ctx, { deep: false })
    expect('error' in result).toBe(true)
    if (!('error' in result)) throw new Error('unreachable')
    expect(result.error).toBe('not-a-contract')
  })
})
