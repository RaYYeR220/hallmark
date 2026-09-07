import { describe, expect, it } from 'vitest'

import { PROTOCOLS } from '../src/addresses.js'
import { parsePaymentRequired, selectPaymentChallenge } from '../src/x402.js'

const PAY_TO = '0x000000000000000000000000000000000000cAfE'
const U_MAINNET = PROTOCOLS[56].erc8183.paymentToken

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')

/** x402 v2 / B402 wire: CAIP-2 network, `amount`, rail in `extra`. */
const v2Challenge = {
  x402Version: 2,
  resource: { url: 'https://api.example/quote', mimeType: 'application/json' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:56',
      amount: '2500000000000000000',
      asset: U_MAINNET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      extra: {
        name: 'United Stables',
        version: '1',
        assetTransferMethod: 'permit2-exact',
        spenderAddress: '0x000000000000000000000000000000000000AbCd',
      },
    },
  ],
}

/** x402 v1 / legacy wire: short network name, `maxAmountRequired`, bare resource. */
const v1Challenge = {
  x402Version: 1,
  resource: 'https://api.example/quote',
  accepts: [
    {
      scheme: 'permit2',
      network: 'bsc',
      maxAmountRequired: '1000000000000000000',
      asset: U_MAINNET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { spender: '0x000000000000000000000000000000000000AbCd' },
    },
  ],
}

function response(init: { headers?: Record<string, string>; body?: unknown }): Response {
  return new Response(init.body === undefined ? null : JSON.stringify(init.body), {
    status: 402,
    headers: init.headers ?? {},
  })
}

describe('parsePaymentRequired', () => {
  it('reads the x402 v2 `PAYMENT-REQUIRED` header', async () => {
    const [challenge, ...rest] = await parsePaymentRequired(
      response({ headers: { 'PAYMENT-REQUIRED': b64(v2Challenge) } }),
    )
    expect(rest).toHaveLength(0)
    expect(challenge).toMatchObject({
      scheme: 'exact',
      network: 'eip155:56',
      chainId: 56,
      amountAtomic: 2_500_000_000_000_000_000n,
      asset: U_MAINNET,
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      rail: 'permit2',
      resource: 'https://api.example/quote',
    })
  })

  it('reads the x402 v1 `X-PAYMENT` header', async () => {
    const [challenge] = await parsePaymentRequired(
      response({ headers: { 'X-PAYMENT': b64(v1Challenge) } }),
    )
    expect(challenge).toMatchObject({
      scheme: 'permit2',
      network: 'bsc',
      chainId: 56,
      amountAtomic: 1_000_000_000_000_000_000n,
      rail: 'permit2',
      resource: 'https://api.example/quote',
    })
  })

  it('accepts a raw-JSON header as well as base64', async () => {
    const [challenge] = await parsePaymentRequired(
      response({ headers: { 'PAYMENT-REQUIRED': JSON.stringify(v2Challenge) } }),
    )
    expect(challenge?.amountAtomic).toBe(2_500_000_000_000_000_000n)
  })

  it('falls back to the JSON body when no header carries the challenge', async () => {
    const [challenge] = await parsePaymentRequired(response({ body: v2Challenge }))
    expect(challenge?.payTo).toBe(PAY_TO)
    expect(challenge?.rail).toBe('permit2')
  })

  it('recognises the eip3009 rail', async () => {
    const body = {
      x402Version: 2,
      accepts: [
        {
          ...v2Challenge.accepts[0],
          extra: { ...v2Challenge.accepts[0]!.extra, assetTransferMethod: 'eip3009' },
        },
      ],
    }
    const [challenge] = await parsePaymentRequired(response({ body }))
    expect(challenge?.rail).toBe('eip3009')
  })

  it('keeps every option when a merchant offers several', async () => {
    const body = {
      x402Version: 2,
      accepts: [
        v2Challenge.accepts[0],
        { ...v2Challenge.accepts[0], network: 'eip155:97', amount: '1' },
      ],
    }
    const challenges = await parsePaymentRequired(response({ body }))
    expect(challenges.map((challenge) => challenge.chainId)).toEqual([56, 97])
  })

  it('leaves chainId undefined for a network it cannot resolve', async () => {
    const body = {
      x402Version: 2,
      accepts: [{ ...v2Challenge.accepts[0], network: 'solana:mainnet' }],
    }
    const [challenge] = await parsePaymentRequired(response({ body }))
    expect(challenge?.chainId).toBeUndefined()
    expect(challenge?.network).toBe('solana:mainnet')
  })

  it('returns nothing for a response that is not a payment challenge', async () => {
    expect(await parsePaymentRequired(response({ body: { error: 'nope' } }))).toEqual([])
    expect(await parsePaymentRequired(response({}))).toEqual([])
    expect(
      await parsePaymentRequired(response({ headers: { 'PAYMENT-REQUIRED': 'not-base64!!' } })),
    ).toEqual([])
  })

  it('skips options missing an amount or a recipient rather than guessing', async () => {
    const body = {
      x402Version: 2,
      accepts: [
        { scheme: 'exact', network: 'eip155:56', asset: U_MAINNET, payTo: PAY_TO },
        v2Challenge.accepts[0],
      ],
    }
    const challenges = await parsePaymentRequired(response({ body }))
    expect(challenges).toHaveLength(1)
  })

  it('does not consume the caller’s copy of the body', async () => {
    const res = response({ body: v2Challenge })
    await parsePaymentRequired(res)
    await expect(res.json()).resolves.toMatchObject({ x402Version: 2 })
  })
})

describe('selectPaymentChallenge', () => {
  it('prefers the requested chain', async () => {
    const body = {
      x402Version: 2,
      accepts: [
        { ...v2Challenge.accepts[0], network: 'eip155:97' },
        v2Challenge.accepts[0],
      ],
    }
    const challenges = await parsePaymentRequired(response({ body }))
    expect(selectPaymentChallenge(challenges, { chainId: 56 })?.chainId).toBe(56)
    expect(selectPaymentChallenge(challenges, { chainId: 97 })?.chainId).toBe(97)
  })

  it('returns undefined when there is nothing payable', () => {
    expect(selectPaymentChallenge([])).toBeUndefined()
  })
})
