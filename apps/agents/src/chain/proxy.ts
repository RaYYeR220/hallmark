import { getAddress, type Address, type Hex, type PublicClient } from 'viem'

/**
 * Finding the code that actually runs.
 *
 * This is the first thing a token analysis has to get right, and the easiest
 * thing to get wrong. A live BNB Chain token we checked
 * (`0xc255d8b48eFbCE2Cb821A28517678aE685587777`) is a textbook EIP-1167
 * minimal proxy — 45 bytes of delegation stub in front of 19,331 bytes of
 * implementation — and a well-known commercial scanner returned `is_proxy: 0`
 * for it. Anything that believed that then went on to check ownership, mint
 * rights, blacklists and fees against the stub, found none of them, and
 * reported the token clean.
 *
 * So proxies are detected here, from the bytecode and the standard storage
 * slots, and never asked of an API. When one is found every subsequent check
 * runs against the implementation, and the report says so.
 */

export type ProxyKind =
  | 'eip1167-minimal'
  | 'eip1967-transparent'
  | 'eip1967-beacon'
  | 'eip1822-uups'
  | 'openzeppelin-legacy'
  | 'implementation-getter'
  | 'gnosis-safe-mastercopy'

export type ProxyDetection = {
  isProxy: boolean
  kind: ProxyKind | null
  implementation: Address | null
  /** Beacon address, when the implementation came through one. */
  beacon: Address | null
  admin: Address | null
  /** Every signal we looked at, with what it returned. Evidence, not a verdict. */
  evidence: Array<{ check: string; slotOrPattern: string; result: string }>
  /** Bytecode of the address as given. */
  proxyCodeSize: number
  /** Bytecode of the implementation, when there is one. */
  implementationCodeSize: number | null
  detail: string
}

/** The standard slots, all of them, because tokens in the wild use all of them. */
export const PROXY_SLOTS = {
  /** EIP-1967 implementation: keccak256('eip1967.proxy.implementation') − 1 */
  eip1967Implementation:
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex,
  /** EIP-1967 admin: keccak256('eip1967.proxy.admin') − 1 */
  eip1967Admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103' as Hex,
  /** EIP-1967 beacon: keccak256('eip1967.proxy.beacon') − 1 */
  eip1967Beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' as Hex,
  /** EIP-1822 UUPS: keccak256('PROXIABLE') */
  eip1822: '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7' as Hex,
  /** OpenZeppelin before EIP-1967: keccak256('org.zeppelinos.proxy.implementation') */
  openzeppelinLegacy:
    '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3' as Hex,
} as const

const ZERO: Address = '0x0000000000000000000000000000000000000000'

/**
 * `PUSH20 <address>` immediately followed by `DELEGATECALL`.
 *
 * This one pattern covers EIP-1167 and every optimised variant of it — 0age's
 * shorter form, the Vyper forwarder, the Clones-with-immutable-args prefix —
 * because they all differ in the surrounding stack setup and agree on the two
 * opcodes that matter. Matching the canonical 45-byte string alone misses the
 * variants, which is precisely how a proxy gets reported as not-a-proxy.
 */
const PUSH20_DELEGATECALL = /73([0-9a-fA-F]{40})5af4/

function slotToAddress(word: Hex | null): Address | null {
  if (!word || word.length < 42) return null
  const tail = `0x${word.slice(-40)}`
  if (tail.toLowerCase() === ZERO.toLowerCase()) return null
  try {
    return getAddress(tail)
  } catch {
    return null
  }
}

const implementationGetterAbi = [
  {
    type: 'function',
    name: 'implementation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'masterCopy',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

export async function detectProxy(
  client: PublicClient,
  address: Address,
): Promise<ProxyDetection> {
  const evidence: ProxyDetection['evidence'] = []

  const code = (await client.getCode({ address }).catch(() => undefined)) ?? '0x'
  const proxyCodeSize = Math.max(0, (code.length - 2) / 2)

  const fail = (detail: string): ProxyDetection => ({
    isProxy: false,
    kind: null,
    implementation: null,
    beacon: null,
    admin: null,
    evidence,
    proxyCodeSize,
    implementationCodeSize: null,
    detail,
  })

  if (proxyCodeSize === 0) {
    evidence.push({ check: 'bytecode', slotOrPattern: 'eth_getCode', result: 'empty' })
    return fail(`${address} has no bytecode: it is an EOA or a contract that has not been deployed.`)
  }

  // --- 1. minimal proxy, straight out of the bytecode ----------------------
  const minimal = PUSH20_DELEGATECALL.exec(code)
  if (minimal && proxyCodeSize <= 128) {
    const implementation = getAddress(`0x${minimal[1]!}`)
    evidence.push({
      check: 'EIP-1167 minimal proxy',
      slotOrPattern: 'PUSH20 <impl> DELEGATECALL in a body of ≤128 bytes',
      result: `matched, implementation ${implementation}`,
    })
    const implCode = (await client.getCode({ address: implementation }).catch(() => undefined)) ?? '0x'
    return {
      isProxy: true,
      kind: 'eip1167-minimal',
      implementation,
      beacon: null,
      admin: null,
      evidence,
      proxyCodeSize,
      implementationCodeSize: (implCode.length - 2) / 2,
      detail:
        `${address} is an EIP-1167 minimal proxy: ${proxyCodeSize} bytes of delegation stub in ` +
        `front of ${(implCode.length - 2) / 2} bytes at ${implementation}. Every check below ` +
        'runs against the implementation, because the stub contains no logic to check.',
    }
  }
  evidence.push({
    check: 'EIP-1167 minimal proxy',
    slotOrPattern: 'PUSH20 <impl> DELEGATECALL in a body of ≤128 bytes',
    result: minimal ? `PUSH20+DELEGATECALL present but body is ${proxyCodeSize} bytes` : 'not matched',
  })

  // --- 2. the standard slots ----------------------------------------------
  const [impl1967, admin1967, beacon1967, impl1822, implLegacy] = await Promise.all([
    readSlot(client, address, PROXY_SLOTS.eip1967Implementation),
    readSlot(client, address, PROXY_SLOTS.eip1967Admin),
    readSlot(client, address, PROXY_SLOTS.eip1967Beacon),
    readSlot(client, address, PROXY_SLOTS.eip1822),
    readSlot(client, address, PROXY_SLOTS.openzeppelinLegacy),
  ])

  const admin = slotToAddress(admin1967)
  evidence.push({ check: 'EIP-1967 implementation slot', slotOrPattern: PROXY_SLOTS.eip1967Implementation, result: describeSlot(impl1967) })
  evidence.push({ check: 'EIP-1967 admin slot', slotOrPattern: PROXY_SLOTS.eip1967Admin, result: describeSlot(admin1967) })
  evidence.push({ check: 'EIP-1967 beacon slot', slotOrPattern: PROXY_SLOTS.eip1967Beacon, result: describeSlot(beacon1967) })
  evidence.push({ check: 'EIP-1822 PROXIABLE slot', slotOrPattern: PROXY_SLOTS.eip1822, result: describeSlot(impl1822) })
  evidence.push({ check: 'OpenZeppelin legacy slot', slotOrPattern: PROXY_SLOTS.openzeppelinLegacy, result: describeSlot(implLegacy) })

  const direct: Array<[ProxyKind, Address | null]> = [
    ['eip1967-transparent', slotToAddress(impl1967)],
    ['eip1822-uups', slotToAddress(impl1822)],
    ['openzeppelin-legacy', slotToAddress(implLegacy)],
  ]
  for (const [kind, implementation] of direct) {
    if (implementation === null) continue
    const implCode = (await client.getCode({ address: implementation }).catch(() => undefined)) ?? '0x'
    return {
      isProxy: true,
      kind,
      implementation,
      beacon: null,
      admin,
      evidence,
      proxyCodeSize,
      implementationCodeSize: (implCode.length - 2) / 2,
      detail:
        `${address} is a ${kind} proxy. Logic lives at ${implementation} ` +
        `(${(implCode.length - 2) / 2} bytes)${admin ? `, upgradeable by ${admin}` : ''}. Every ` +
        'check below runs against the implementation.',
    }
  }

  // --- 3. beacon -----------------------------------------------------------
  const beacon = slotToAddress(beacon1967)
  if (beacon !== null) {
    const implementation = (await client
      .readContract({ address: beacon, abi: implementationGetterAbi, functionName: 'implementation' })
      .catch(() => null)) as Address | null
    evidence.push({
      check: 'Beacon implementation()',
      slotOrPattern: beacon,
      result: implementation ?? 'call reverted',
    })
    if (implementation && implementation !== ZERO) {
      const implCode = (await client.getCode({ address: implementation }).catch(() => undefined)) ?? '0x'
      return {
        isProxy: true,
        kind: 'eip1967-beacon',
        implementation,
        beacon,
        admin,
        evidence,
        proxyCodeSize,
        implementationCodeSize: (implCode.length - 2) / 2,
        detail:
          `${address} is a beacon proxy. The beacon at ${beacon} currently points at ` +
          `${implementation}, and whoever controls the beacon can repoint every proxy behind ` +
          'it at once. Every check below runs against the current implementation.',
      }
    }
  }

  // --- 4. a getter, for proxies that publish one ---------------------------
  for (const fn of ['implementation', 'masterCopy'] as const) {
    const result = (await client
      .readContract({ address, abi: implementationGetterAbi, functionName: fn })
      .catch(() => null)) as Address | null
    evidence.push({ check: `${fn}()`, slotOrPattern: 'direct call', result: result ?? 'reverted' })
    if (result && result !== ZERO) {
      const implCode = (await client.getCode({ address: result }).catch(() => undefined)) ?? '0x'
      if ((implCode.length - 2) / 2 > 0) {
        return {
          isProxy: true,
          kind: fn === 'masterCopy' ? 'gnosis-safe-mastercopy' : 'implementation-getter',
          implementation: result,
          beacon: null,
          admin,
          evidence,
          proxyCodeSize,
          implementationCodeSize: (implCode.length - 2) / 2,
          detail:
            `${address} publishes ${fn}() = ${result}, which holds code. Treating it as the ` +
            'implementation and running every check below against it.',
        }
      }
    }
  }

  return fail(
    `${address} is not a proxy by any of the checks above: no PUSH20+DELEGATECALL stub, no ` +
      'EIP-1967, EIP-1822 or legacy OpenZeppelin slot set, no beacon, no implementation getter. ' +
      `Its own ${proxyCodeSize} bytes are the code that runs.`,
  )
}

async function readSlot(client: PublicClient, address: Address, slot: Hex): Promise<Hex | null> {
  return (await client.getStorageAt({ address, slot }).catch(() => null)) ?? null
}

function describeSlot(word: Hex | null): string {
  if (word === null) return 'read failed'
  const address = slotToAddress(word)
  return address === null ? 'empty' : address
}

/**
 * The address whose bytecode should be analysed.
 *
 * One line, but the single most consequential line in the security agent: get
 * it wrong and every check that follows is run against 45 bytes of stub.
 */
export function analysisTarget(address: Address, proxy: ProxyDetection): Address {
  return proxy.implementation ?? address
}
