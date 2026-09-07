import {
  signerFromPrivateKey,
  type Call,
  type ExecuteResult,
  type Session,
  type SessionPermissions,
} from '@altananetwork/sdk'
import { encodeFunctionData, parseAbi, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'

import { NATIVE_TOKEN, PROTOCOLS } from '../src/addresses.js'
import {
  checkScope,
  classifyStatusCode,
  describeOutcome,
  executeWithSession,
  isRefusal,
  looksUnfunded,
  outcomeFromThrow,
  toExecuteOutcome,
  type ExecuteOutcome,
  type StatusBand,
} from '../src/execute.js'
import { OBSERVED_KEYSTORE_FEE_WEI } from '../src/network.js'

const NOW = 1_760_000_000
const CALLS_ID = '0xca11' as Hex
const TX_HASH = ('0x' + 'ab'.repeat(32)) as Hex

const ROUTER = PROTOCOLS[56].pancake.swapRouter
const V_USDT = PROTOCOLS[56].venus.vUSDT
const NOT_ALLOWED = '0x000000000000000000000000000000000000dEaD' as const

const permissions: SessionPermissions = {
  calls: [{ to: ROUTER }, { to: V_USDT, signature: 'repayBorrow(uint256)' }],
  spend: [
    { limit: 250n * 10n ** 18n, period: 'day', token: PROTOCOLS[56].defaultStable },
    { limit: 5n * 10n ** 16n, period: 'day' },
  ],
}

const repayBorrow = (amount: bigint): Hex =>
  encodeFunctionData({
    abi: parseAbi(['function repayBorrow(uint256 amount)']),
    functionName: 'repayBorrow',
    args: [amount],
  })

function result(over: Partial<ExecuteResult>): ExecuteResult {
  return { callsId: CALLS_ID, status: 'FAILED', ...over }
}

describe('classifyStatusCode', () => {
  const table: { code: number | undefined; band: StatusBand }[] = [
    { code: 100, band: 'in-flight' },
    { code: 199, band: 'in-flight' },
    { code: 200, band: 'success' },
    { code: 299, band: 'success' },
    { code: 300, band: 'refused' },
    { code: 399, band: 'refused' },
    { code: 499, band: 'refused' },
    { code: 500, band: 'reverted' },
    { code: 501, band: 'reverted' },
    { code: 600, band: 'reverted' },
    { code: 99, band: 'unknown' },
    { code: 0, band: 'unknown' },
    { code: undefined, band: 'unknown' },
  ]

  for (const { code, band } of table) {
    it(`${code ?? 'undefined'} → ${band}`, () => {
      expect(classifyStatusCode(code)).toBe(band)
    })
  }
})

describe('toExecuteOutcome', () => {
  const ctx = { chainId: 56 as const, session: { permissions, expiry: NOW + 3600 }, now: NOW }

  it('200 with a hash is confirmed and carries an explorer link', () => {
    const outcome = toExecuteOutcome(
      result({ status: 'CONFIRMED', statusCode: 200, transactionHash: TX_HASH }),
      ctx,
    )
    expect(outcome).toMatchObject({
      kind: 'confirmed',
      txHash: TX_HASH,
      explorerUrl: `https://bscscan.com/tx/${TX_HASH}`,
      statusCode: 200,
      callsId: CALLS_ID,
    })
  })

  it('confirmed without a receipt degrades to pending rather than inventing a hash', () => {
    const outcome = toExecuteOutcome(result({ status: 'CONFIRMED', statusCode: 200 }), ctx)
    expect(outcome.kind).toBe('pending')
  })

  it('100 is pending', () => {
    const outcome = toExecuteOutcome(result({ status: 'PENDING', statusCode: 100 }), ctx)
    expect(outcome).toMatchObject({ kind: 'pending', statusCode: 100, callsId: CALLS_ID })
  })

  for (const statusCode of [300, 399, 499]) {
    it(`${statusCode} is a refusal, not an error`, () => {
      const outcome = toExecuteOutcome(result({ statusCode }), ctx)
      expect(outcome.kind).toBe('refused')
      expect(isRefusal(outcome)).toBe(true)
      if (outcome.kind !== 'refused') throw new Error('unreachable')
      expect(outcome.source).toBe('relay')
      expect(outcome.callsId).toBe(CALLS_ID)
      expect(outcome.detail).toMatch(/nothing was mined/i)
    })
  }

  it('names the usual suspect for a bare 300 without asserting it', () => {
    const outcome = toExecuteOutcome(result({ statusCode: 300 }), ctx)
    if (outcome.kind !== 'refused') throw new Error('expected a refusal')
    expect(outcome.reason).toBe('unknown')
    expect(outcome.detail).toMatch(/native spend cap too small/)
  })

  for (const statusCode of [500, 501]) {
    it(`${statusCode} reached the chain and reverted`, () => {
      const outcome = toExecuteOutcome(result({ statusCode, transactionHash: TX_HASH }), ctx)
      expect(outcome).toMatchObject({ kind: 'reverted', statusCode, txHash: TX_HASH })
    })
  }

  it('FAILED with no status code stays honestly unknown', () => {
    const outcome = toExecuteOutcome(result({ status: 'FAILED' }), ctx)
    expect(outcome.kind).toBe('pending')
    expect(outcome.detail).toMatch(/genuinely unknown/)
  })
})

describe('refusal diagnosis', () => {
  const expiry = NOW + 3600

  it('names the contract when the target is off the allowlist', () => {
    const outcome = toExecuteOutcome(result({ statusCode: 300 }), {
      chainId: 56,
      session: { permissions, expiry },
      calls: [{ to: NOT_ALLOWED, data: '0xdeadbeef' }],
      now: NOW,
    })
    if (outcome.kind !== 'refused') throw new Error('expected a refusal')
    expect(outcome.reason).toBe('call-not-allowed')
    expect(outcome.detail).toContain('0x0000…dEaD')
    expect(outcome.detail).toContain('0xdeadbeef')
  })

  it('names the cap when a single intent already blows through it', () => {
    const outcome = toExecuteOutcome(result({ statusCode: 300 }), {
      chainId: 56,
      session: { permissions, expiry },
      calls: [{ to: ROUTER, value: 10n ** 18n }],
      now: NOW,
    })
    if (outcome.kind !== 'refused') throw new Error('expected a refusal')
    expect(outcome.reason).toBe('spend-cap')
    expect(outcome.detail).toMatch(/over the session's 0.05 BNB per-day cap/)
  })

  it('reports an expired session as expired', () => {
    const outcome = toExecuteOutcome(result({ statusCode: 400 }), {
      chainId: 56,
      session: { permissions, expiry: NOW - 1 },
      calls: [{ to: ROUTER }],
      now: NOW,
    })
    if (outcome.kind !== 'refused') throw new Error('expected a refusal')
    expect(outcome.reason).toBe('session-expired')
  })
})

describe('checkScope', () => {
  const expiry = NOW + 3600

  it('allows an allowlisted contract', () => {
    expect(checkScope({ permissions, expiry, calls: [{ to: ROUTER }], now: NOW })).toEqual({
      allowed: true,
    })
  })

  it('matches a selector-scoped rule on the selector', () => {
    expect(
      checkScope({
        permissions,
        expiry,
        calls: [{ to: V_USDT, data: repayBorrow(10n ** 18n) }],
        now: NOW,
      }),
    ).toEqual({ allowed: true })
  })

  it('refuses the right contract with the wrong selector', () => {
    const verdict = checkScope({
      permissions,
      expiry,
      calls: [
        {
          to: V_USDT,
          data: encodeFunctionData({
            abi: parseAbi(['function borrow(uint256 amount)']),
            functionName: 'borrow',
            args: [10n ** 18n],
          }),
        },
      ],
      now: NOW,
    })
    expect(verdict).toMatchObject({ allowed: false, reason: 'call-not-allowed' })
  })

  it('treats an omitted allowlist as unrestricted', () => {
    expect(
      checkScope({
        permissions: { spend: permissions.spend ?? [] },
        expiry,
        calls: [{ to: NOT_ALLOWED }],
        now: NOW,
      }),
    ).toEqual({ allowed: true })
  })
})

describe('the unfunded case', () => {
  // The relay's answer, verbatim in shape, when the wallet holds no BNB.
  const emptyRevert = new Error(
    'Rpc.ExecutionError: An error occurred while executing: reverted.\n' +
      'Details: execution reverted\nReason: 0x',
  )

  it('recognises empty revert data', () => {
    expect(looksUnfunded(emptyRevert)).toBe(true)
    expect(looksUnfunded(new Error('insufficient funds for gas'))).toBe(true)
    expect(
      looksUnfunded(new Error('reverted: Reason: 0x08c379a0000000000000000000')),
    ).toBe(false)
    expect(looksUnfunded(new Error('nonce too low'))).toBe(false)
  })

  it('classifies it as unfunded with the fee to send', () => {
    const outcome = outcomeFromThrow(emptyRevert, {
      chainId: 97,
      address: '0x000000000000000000000000000000000000bEEF',
    })
    expect(outcome.kind).toBe('unfunded')
    if (outcome.kind !== 'unfunded') throw new Error('unreachable')
    expect(outcome.requiredWei).toBe(OBSERVED_KEYSTORE_FEE_WEI * 2n)
    expect(outcome.detail).toMatch(/0.001345190940895154 tBNB/)
    expect(outcome.detail).toMatch(/0x0000…bEEF/)
  })

  it('honours a live fee reading over the measured constant', () => {
    const outcome = outcomeFromThrow(emptyRevert, { chainId: 97, requiredWei: 7n })
    expect(outcome.kind === 'unfunded' && outcome.requiredWei).toBe(7n)
  })
})

describe('outcomeFromThrow', () => {
  it('unpacks the relay code grantSession embeds in its message', () => {
    const outcome = outcomeFromThrow(
      new Error('Session grant did not confirm: status=FAILED (relay code 300)'),
      { chainId: 97 },
    )
    expect(outcome).toMatchObject({ kind: 'refused', statusCode: 300, source: 'relay' })
  })

  it('routes a 5xx relay code to reverted', () => {
    const outcome = outcomeFromThrow(
      new Error('Session grant did not confirm: status=FAILED (relay code 500)'),
      { chainId: 97 },
    )
    expect(outcome).toMatchObject({ kind: 'reverted', statusCode: 500 })
  })

  it('recognises the rejected fee token', () => {
    const outcome = outcomeFromThrow(
      new Error('InvalidParamsRpcError: fee token not supported: 0xc70B…'),
      { chainId: 97 },
    )
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'fee' })
  })

  it('keeps the original message when it cannot classify', () => {
    const outcome = outcomeFromThrow(new Error('socket hang up'), { chainId: 56 })
    expect(outcome).toMatchObject({ kind: 'reverted', statusCode: 0 })
    expect(outcome.detail).toContain('socket hang up')
  })
})

describe('executeWithSession', () => {
  const session: Session = {
    walletAddress: '0x000000000000000000000000000000000000bEEF',
    signer: signerFromPrivateKey(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    ),
    publicKey: '0x04' as Hex,
    permissions,
    expiry: NOW + 3600,
  }

  function clientReturning(over: Partial<ExecuteResult>) {
    const seen: unknown[] = []
    return {
      seen,
      execute: async (opts: unknown) => {
        seen.push(opts)
        return result(over)
      },
    }
  }

  it('refuses an out-of-scope call locally, without touching the relay', async () => {
    const client = clientReturning({ status: 'CONFIRMED', statusCode: 200 })
    const outcome = await executeWithSession({
      chainId: 56,
      session,
      calls: [{ to: NOT_ALLOWED, data: '0xdeadbeef' }],
      client,
      now: NOW,
    })
    expect(outcome).toMatchObject({
      kind: 'refused',
      reason: 'call-not-allowed',
      source: 'preflight',
      statusCode: 0,
    })
    expect(client.seen).toHaveLength(0)
  })

  it('lets the relay answer when preflight is off', async () => {
    const client = clientReturning({ statusCode: 300 })
    const outcome = await executeWithSession({
      chainId: 56,
      session,
      calls: [{ to: NOT_ALLOWED, data: '0xdeadbeef' }],
      client,
      preflight: false,
      now: NOW,
    })
    expect(outcome).toMatchObject({ kind: 'refused', source: 'relay', statusCode: 300 })
    expect(client.seen).toHaveLength(1)
  })

  it('passes an in-scope call through', async () => {
    const client = clientReturning({
      status: 'CONFIRMED',
      statusCode: 200,
      transactionHash: TX_HASH,
    })
    const calls: Call[] = [{ to: ROUTER, data: '0x12345678' }]
    const outcome = await executeWithSession({ chainId: 56, session, calls, client, now: NOW })
    expect(outcome.kind).toBe('confirmed')
    expect(client.seen[0]).toMatchObject({ chainId: 56, calls })
  })

  it('refuses an empty intent instead of asking the relay to', async () => {
    const client = clientReturning({})
    const outcome = await executeWithSession({ chainId: 56, session, calls: [], client })
    expect(outcome).toMatchObject({ kind: 'refused', source: 'preflight' })
    expect(client.seen).toHaveLength(0)
  })

  it('turns a thrown relay error into an outcome', async () => {
    const outcome = await executeWithSession({
      chainId: 97,
      session,
      calls: [{ to: ROUTER }],
      client: {
        execute: async () => {
          throw new Error('Rpc.ExecutionError ... Reason: 0x')
        },
      },
      now: NOW,
    })
    expect(outcome.kind).toBe('unfunded')
  })
})

describe('describeOutcome', () => {
  const cases: [ExecuteOutcome['kind'], ExecuteOutcome][] = [
    [
      'confirmed',
      {
        kind: 'confirmed',
        txHash: TX_HASH,
        explorerUrl: 'x',
        statusCode: 200,
        callsId: CALLS_ID,
        detail: 'd',
      },
    ],
    ['pending', { kind: 'pending', callsId: CALLS_ID, statusCode: 100, detail: 'd' }],
    [
      'refused',
      { kind: 'refused', statusCode: 300, reason: 'spend-cap', detail: 'd', source: 'relay' },
    ],
    ['reverted', { kind: 'reverted', statusCode: 500, detail: 'd' }],
    ['unfunded', { kind: 'unfunded', detail: 'd', requiredWei: 1n }],
  ]

  for (const [kind, outcome] of cases) {
    it(`gives ${kind} a headline and a tone`, () => {
      const copy = describeOutcome(outcome)
      expect(copy.headline.length).toBeGreaterThan(0)
      expect(copy.detail).toBe('d')
      expect(['ok', 'pending', 'blocked', 'error']).toContain(copy.tone)
    })
  }

  it('distinguishes a local block from a relay refusal in the headline', () => {
    expect(
      describeOutcome({
        kind: 'refused',
        statusCode: 0,
        reason: 'call-not-allowed',
        detail: 'd',
        source: 'preflight',
      }).headline,
    ).toBe('Blocked by the session key')
    expect(
      describeOutcome({
        kind: 'refused',
        statusCode: 300,
        reason: 'unknown',
        detail: 'd',
        source: 'relay',
      }).headline,
    ).toBe('Refused before it reached the chain')
  })
})

describe('native token sentinel', () => {
  it('maps to an omitted token in Altana permissions', () => {
    expect(NATIVE_TOKEN).toBe('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE')
  })
})
