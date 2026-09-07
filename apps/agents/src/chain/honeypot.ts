import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseEther,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { erc20Abi } from '@hallmark/core'

import {
  PANCAKE_V2_FACTORY,
  PANCAKE_V2_ROUTER,
  WBNB,
  pancakeV2FactoryAbi,
  pancakeV2RouterAbi,
} from './abis.js'

/**
 * Whether the token can actually be sold, measured rather than guessed.
 *
 * Static analysis finds the honeypots that look like honeypots. It misses the
 * ones that only trap above a size, or only trap an address that is not the
 * deployer, or only trap once the pool is deep enough to be worth trapping.
 * The way to answer the question is to try it.
 *
 * Nothing here sends a transaction, holds a key or spends anything: it is all
 * `eth_call` with state overrides.
 *
 * **The buy** needs no storage at all — override the buyer's BNB balance, call
 * the router, and recover the amount received by *binary searching
 * `amountOutMin`*. The fee-on-transfer router entry point returns nothing, so
 * the largest minimum that does not revert is how you read its output without
 * deploying a probe contract.
 *
 * **The sell** needs the seller to hold tokens, and there are two ways to
 * arrange that. Both are tried, in this order:
 *
 *   1. *storage override* — find the token's `balanceOf` and `allowance`
 *      mappings by writing a value and reading it back, then write a synthetic
 *      balance. Cheap, and works for most tokens. It fails on ERC-7201
 *      namespaced storage unless the namespace is one we derive, which is why
 *      there is a second method rather than an "unknown".
 *   2. *real holder* — sell from an address that already holds the token and
 *      has already approved the router. No storage override at all, so it
 *      works whatever the layout is, and it is the more faithful simulation:
 *      a real balance, a real approval, a real address.
 *
 * The number is the point. A contract can be perfectly clean and still be a
 * no: a guaranteed 6.8% round-trip cost against a five-figure valuation is
 * hostile economics whether or not anything reverts, and this returns enough
 * to say so.
 *
 * Every binary search verifies its own bracket — the low bound must succeed,
 * the high bound must fail, and the answer is re-tested before it is returned.
 * A silently corrupted search returns a plausible number, which is the worst
 * possible failure here.
 */

/** Where a mapping lives. The base is a decimal string so it survives JSON. */
export type StorageSlot = {
  base: string
  layout: 'solidity' | 'vyper'
  /** True when the base is an ERC-7201 namespaced hash rather than a low index. */
  namespaced: boolean
}

export type TradeProbe = {
  buyer: Address
  seller: Address | null
  sizeBnb: string
  /** What the pool's reserve math says the buy should return, before any tax. */
  theoreticalTokensOut: string | null
  /** What the swap actually returns. */
  actualTokensOut: string | null
  buyTaxPct: number | null
  buyReverted: boolean
  buyRevertReason: string | null
  /** The amount actually offered to the sell leg (capped by the seller's balance). */
  soldTokens: string | null
  /** What the reserve math says selling that back should return. */
  theoreticalBnbOut: string | null
  actualBnbOut: string | null
  sellTaxPct: number | null
  sellReverted: boolean
  sellRevertReason: string | null
  /** 1 − (BNB back ÷ BNB in), as a percentage. The number that matters. */
  roundTripLossPct: number | null
  verdict: 'sellable' | 'sell-blocked' | 'buy-blocked' | 'unknown'
}

export type HoneypotResult = {
  supported: boolean
  /** How the sell leg got tokens into the seller's hands. */
  method: 'storage-override' | 'real-holder' | 'none'
  pair: Address | null
  balanceSlot: StorageSlot | null
  allowanceSlot: StorageSlot | null
  seller: Address | null
  probes: TradeProbe[]
  summary: {
    anySellBlocked: boolean
    maxRoundTripLossPct: number | null
    maxBuyTaxPct: number | null
    maxSellTaxPct: number | null
    sizeDependent: boolean
  }
  detail: string
}

/** Two sizes: enough to expose a trap that only fires above a threshold. */
const DEFAULT_SIZES = ['0.05', '0.5'] as const
const DEFAULT_BUYERS: readonly Address[] = [
  '0x00000000000000000000000000000000000a11ce',
  '0x0000000000000000000000000000000000b0b0b0',
]

/**
 * How far to scan for the balance mapping.
 *
 * Measured, not guessed: a live token we tested keeps `_balances` at slot 51,
 * well past the slot 0-3 that a textbook ERC-20 uses. Tokens with a lot of
 * configuration state ahead of their balances are ordinary, and stopping at 24
 * reports them as "sellability unknown" for no reason. The probes are batched,
 * so the wider scan costs latency rather than time.
 */
const MAX_SLOT_PROBE = 96
const PROBE_BATCH = 24
const SEARCH_ITERATIONS = 18
const DEADLINE = 4_102_444_800n // 2100-01-01, so the deadline never decides anything
const ZERO: Address = '0x0000000000000000000000000000000000000000'

/**
 * ERC-7201 namespaced storage.
 *
 * A modern upgradeable token does not put `_balances` at slot 0: OpenZeppelin
 * v5 puts it at a base derived from a string, which no amount of scanning the
 * low slots will find. The bases are *derived* here rather than pasted in as
 * constants, so they are right by construction:
 *
 *     base = keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~0xff
 */
export function erc7201Base(id: string): bigint {
  const inner = BigInt(keccak256(toHex(id))) - 1n
  const outer = BigInt(keccak256(encodeAbiParameters([{ type: 'uint256' }], [inner])))
  return outer & ~0xffn
}

const NAMESPACED_BASES: readonly bigint[] = [
  erc7201Base('openzeppelin.storage.ERC20'),
  erc7201Base('openzeppelin.storage.ERC20Upgradeable'),
]

/**
 * Every base slot worth trying, in order of likelihood: the low integers for
 * hand-written and OZ v4 tokens, then the namespaced bases and their
 * neighbours, where `_allowances` sits when `_balances` is at the base.
 */
function candidateBases(): bigint[] {
  const low = Array.from({ length: MAX_SLOT_PROBE }, (_, i) => BigInt(i))
  const namespaced = NAMESPACED_BASES.flatMap((base) => [base, base + 1n, base + 2n])
  return [...low, ...namespaced]
}

function mappingKey(layout: 'solidity' | 'vyper', base: bigint, holder: Address): Hex {
  return layout === 'solidity'
    ? keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, base]))
    : keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }], [base, holder]))
}

function allowanceKey(
  layout: 'solidity' | 'vyper',
  base: bigint,
  owner: Address,
  spender: Address,
): Hex {
  const outer = mappingKey(layout, base, owner)
  return layout === 'solidity'
    ? keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [spender, outer]))
    : keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }], [outer, spender]))
}

function word(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, '0')}` as Hex
}

function short(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const first = message.split('\n').find((line) => line.trim().length > 0) ?? message
  return first.slice(0, 200)
}

/**
 * Locate the `balanceOf` mapping by writing to it and reading it back.
 *
 * The test is not "does this look like a balance" — it is "did the value we
 * wrote come back out of `balanceOf`", which cannot produce a false positive.
 */
export async function findBalanceSlot(args: {
  client: PublicClient
  token: Address
  holder: Address
}): Promise<StorageSlot | null> {
  const probe = 1_337_000_000_000_000_000n
  const readData = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [args.holder] })
  return probeMapping({
    client: args.client,
    token: args.token,
    readData,
    probe,
    keyFor: (layout, base) => mappingKey(layout, base, args.holder),
  })
}

/**
 * Locate the `allowance` mapping the same way.
 *
 * Skipping this would make the sell leg revert inside `transferFrom` for every
 * token that checks an allowance — which is all of them — and every token
 * would be reported as a honeypot. A false positive here is as damaging as the
 * false negative it exists to catch.
 */
export async function findAllowanceSlot(args: {
  client: PublicClient
  token: Address
  owner: Address
  spender: Address
}): Promise<StorageSlot | null> {
  const probe = 424_242_000_000_000_000n
  const readData = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'allowance',
    args: [args.owner, args.spender],
  })
  return probeMapping({
    client: args.client,
    token: args.token,
    readData,
    probe,
    keyFor: (layout, base) => allowanceKey(layout, base, args.owner, args.spender),
  })
}

/**
 * Write a known value at a candidate slot and see whether the getter returns
 * it.
 *
 * The test is not "does this look like a balance" — it is "did the value we
 * wrote come back out", which cannot produce a false positive. Batched,
 * because a 96-slot scan across two layouts is 192 calls and doing them one at
 * a time is minutes rather than seconds.
 */
async function probeMapping(args: {
  client: PublicClient
  token: Address
  readData: Hex
  probe: bigint
  keyFor: (layout: 'solidity' | 'vyper', base: bigint) => Hex
}): Promise<StorageSlot | null> {
  const candidates = candidateBases().flatMap((base) =>
    (['solidity', 'vyper'] as const).map((layout) => ({ base, layout })),
  )

  for (let offset = 0; offset < candidates.length; offset += PROBE_BATCH) {
    const batch = candidates.slice(offset, offset + PROBE_BATCH)
    const results = await Promise.all(
      batch.map(async (candidate) => {
        try {
          const result = await args.client.call({
            to: args.token,
            data: args.readData,
            stateOverride: [
              {
                address: args.token,
                stateDiff: [
                  { slot: args.keyFor(candidate.layout, candidate.base), value: word(args.probe) },
                ],
              },
            ],
          })
          return result.data !== undefined && BigInt(result.data) === args.probe
        } catch {
          return false
        }
      }),
    )
    const hitIndex = results.findIndex(Boolean)
    if (hitIndex !== -1) {
      const hit = batch[hitIndex]!
      return {
        base: hit.base.toString(),
        layout: hit.layout,
        namespaced: hit.base > 0xffffn,
      }
    }
  }
  return null
}

/**
 * The largest `amountOutMin` a swap still accepts — which is exactly its
 * output.
 *
 * Bracketed by construction: the search only begins once the low bound is
 * known to succeed and the high bound is known to fail, and the answer is
 * re-tested before it is returned. If a bracket cannot be established the
 * function says so rather than returning the midpoint of two unknowns.
 */
export async function searchMaxAcceptedMin(args: {
  attempt: (minOut: bigint) => Promise<boolean>
  upper: bigint
}): Promise<{ ok: true; value: bigint } | { ok: false; reason: string }> {
  if (!(await args.attempt(0n))) {
    return { ok: false, reason: 'the swap reverts even with amountOutMin = 0' }
  }
  if (args.upper <= 0n) return { ok: true, value: 0n }

  // Push the ceiling up until it genuinely fails. A reserve-math estimate can
  // sit *below* the real output when the pool moved between reads, and
  // assuming otherwise silently caps the answer at the estimate.
  let hi = args.upper
  let bracketed = false
  for (let i = 0; i < 4; i += 1) {
    if (!(await args.attempt(hi))) {
      bracketed = true
      break
    }
    hi *= 2n
  }
  if (!bracketed) {
    return {
      ok: false,
      reason: `the swap still succeeds at ${hi} out, sixteen times the reserve-math estimate; the bracket is unreliable`,
    }
  }

  let lo = 0n
  for (let i = 0; i < SEARCH_ITERATIONS && hi - lo > 1n; i += 1) {
    const mid = lo + (hi - lo) / 2n
    if (await args.attempt(mid)) lo = mid
    else hi = mid
  }

  // The invariant, verified rather than assumed.
  if (!(await args.attempt(lo))) {
    return { ok: false, reason: 'the search ended on a bound that does not actually succeed' }
  }
  return { ok: true, value: lo }
}

export type SimulateArgs = {
  client: PublicClient
  token: Address
  sizes?: readonly string[]
  buyers?: readonly Address[]
  /**
   * Real holders to try selling from, when a storage override is unavailable.
   * The security agent passes its holder table.
   */
  holders?: readonly Address[]
}

export async function simulateRoundTrip(args: SimulateArgs): Promise<HoneypotResult> {
  const { client, token } = args
  const sizes = args.sizes ?? DEFAULT_SIZES
  const buyers = args.buyers ?? DEFAULT_BUYERS

  const empty = (
    method: HoneypotResult['method'],
    pair: Address | null,
    detail: string,
  ): HoneypotResult => ({
    supported: false,
    method,
    pair,
    balanceSlot: null,
    allowanceSlot: null,
    seller: null,
    probes: [],
    summary: {
      anySellBlocked: false,
      maxRoundTripLossPct: null,
      maxBuyTaxPct: null,
      maxSellTaxPct: null,
      sizeDependent: false,
    },
    detail,
  })

  const pair = (await client
    .readContract({
      address: PANCAKE_V2_FACTORY,
      abi: pancakeV2FactoryAbi,
      functionName: 'getPair',
      args: [token, WBNB],
    })
    .catch(() => null)) as Address | null

  if (pair === null || pair === ZERO) {
    return empty(
      'none',
      null,
      `No PancakeSwap v2 ${token}/WBNB pair exists, so there is no route to simulate a buy and a ` +
        'sell against. The token may trade only on v3, or not at all; either way this check ' +
        'returns "unknown" rather than "clean".',
    )
  }

  // --- how will the sell leg get its tokens? -------------------------------
  const firstBuyer = buyers[0]!
  const balanceSlot = await findBalanceSlot({ client, token, holder: firstBuyer })
  const allowanceSlot =
    balanceSlot === null
      ? null
      : await findAllowanceSlot({ client, token, owner: firstBuyer, spender: PANCAKE_V2_ROUTER })

  let method: HoneypotResult['method'] = balanceSlot !== null ? 'storage-override' : 'none'
  let seller: Address | null = null
  let sellerBalance = 0n

  if (balanceSlot === null && args.holders && args.holders.length > 0) {
    // No usable storage layout. Fall back to a real holder who has already
    // approved the router — the more faithful simulation anyway, and immune to
    // whatever storage layout the token uses.
    for (const holder of args.holders.slice(0, 12)) {
      if (holder.toLowerCase() === pair.toLowerCase()) continue
      const [balance, allowance] = await Promise.all([
        client
          .readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] })
          .catch(() => 0n) as Promise<bigint>,
        client
          .readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [holder, PANCAKE_V2_ROUTER],
          })
          .catch(() => 0n) as Promise<bigint>,
      ])
      if (balance > 0n && allowance >= balance) {
        seller = holder
        sellerBalance = balance
        method = 'real-holder'
        break
      }
    }
  }

  if (method === 'none') {
    return empty(
      'none',
      pair,
      `The token's balance mapping is not in the first ${MAX_SLOT_PROBE} storage slots under ` +
        'either the Solidity or Vyper layout, nor at the ERC-7201 namespaced bases this service ' +
        'derives, and no holder with a standing router approval was available to sell from. The ' +
        'sell leg could not be reached, so sellability is unknown — not clean.',
    )
  }

  const probes: TradeProbe[] = []

  for (const [index, sizeBnb] of sizes.entries()) {
    const buyer = buyers[index % buyers.length]!
    const value = parseEther(sizeBnb)

    const probe: TradeProbe = {
      buyer,
      seller,
      sizeBnb,
      theoreticalTokensOut: null,
      actualTokensOut: null,
      buyTaxPct: null,
      buyReverted: false,
      buyRevertReason: null,
      soldTokens: null,
      theoreticalBnbOut: null,
      actualBnbOut: null,
      sellTaxPct: null,
      sellReverted: false,
      sellRevertReason: null,
      roundTripLossPct: null,
      verdict: 'unknown',
    }

    // --- theoretical buy, from the reserves ------------------------------
    const buyAmounts = (await client
      .readContract({
        address: PANCAKE_V2_ROUTER,
        abi: pancakeV2RouterAbi,
        functionName: 'getAmountsOut',
        args: [value, [WBNB, token]],
      })
      .catch(() => null)) as readonly bigint[] | null
    const theoreticalTokens = buyAmounts?.[1] ?? null
    probe.theoreticalTokensOut = theoreticalTokens?.toString() ?? null

    // --- actual buy: BNB balance override only, no storage ---------------
    const attemptBuy = async (minOut: bigint): Promise<boolean> => {
      try {
        await client.call({
          account: buyer,
          to: PANCAKE_V2_ROUTER,
          value,
          data: encodeFunctionData({
            abi: pancakeV2RouterAbi,
            functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
            args: [minOut, [WBNB, token], buyer, DEADLINE],
          }),
          stateOverride: [{ address: buyer, balance: value + parseEther('1') }],
        })
        return true
      } catch {
        return false
      }
    }

    if (!(await attemptBuy(0n))) {
      probe.buyReverted = true
      probe.buyRevertReason = await captureRevert(async () => {
        await client.call({
          account: buyer,
          to: PANCAKE_V2_ROUTER,
          value,
          data: encodeFunctionData({
            abi: pancakeV2RouterAbi,
            functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
            args: [0n, [WBNB, token], buyer, DEADLINE],
          }),
          stateOverride: [{ address: buyer, balance: value + parseEther('1') }],
        })
      })
      probe.verdict = 'buy-blocked'
      probes.push(probe)
      continue
    }

    const bought = await searchMaxAcceptedMin({ attempt: attemptBuy, upper: theoreticalTokens ?? 0n })
    if (!bought.ok) {
      probe.buyRevertReason = `Buy output could not be measured: ${bought.reason}.`
      probes.push(probe)
      continue
    }
    probe.actualTokensOut = bought.value.toString()
    if (theoreticalTokens !== null && theoreticalTokens > 0n) {
      probe.buyTaxPct = (1 - Number(bought.value) / Number(theoreticalTokens)) * 100
    }
    if (bought.value === 0n) {
      probe.verdict = 'buy-blocked'
      probe.buyRevertReason = 'The buy succeeds but returns zero tokens.'
      probes.push(probe)
      continue
    }

    // --- how much can actually be sold back ------------------------------
    const sellAmount =
      method === 'real-holder' && sellerBalance < bought.value ? sellerBalance : bought.value
    probe.soldTokens = sellAmount.toString()

    const sellAmounts = (await client
      .readContract({
        address: PANCAKE_V2_ROUTER,
        abi: pancakeV2RouterAbi,
        functionName: 'getAmountsOut',
        args: [sellAmount, [token, WBNB]],
      })
      .catch(() => null)) as readonly bigint[] | null
    const theoreticalBnb = sellAmounts?.[1] ?? null
    probe.theoreticalBnbOut = theoreticalBnb?.toString() ?? null

    const sellFrom = method === 'real-holder' ? seller! : buyer
    const overrides: Array<{ address: Address; balance?: bigint; stateDiff?: Array<{ slot: Hex; value: Hex }> }> =
      method === 'real-holder'
        ? [{ address: sellFrom, balance: parseEther('1') }]
        : [
            { address: sellFrom, balance: parseEther('1') },
            {
              address: token,
              stateDiff: [
                { slot: mappingKey(balanceSlot!.layout, BigInt(balanceSlot!.base), sellFrom), value: word(sellAmount) },
                ...(allowanceSlot === null
                  ? []
                  : [
                      {
                        slot: allowanceKey(
                          allowanceSlot.layout,
                          BigInt(allowanceSlot.base),
                          sellFrom,
                          PANCAKE_V2_ROUTER,
                        ),
                        value: word(2n ** 256n - 1n),
                      },
                    ]),
              ],
            },
          ]

    const sellCall = (minOut: bigint) => ({
      account: sellFrom,
      to: PANCAKE_V2_ROUTER,
      data: encodeFunctionData({
        abi: pancakeV2RouterAbi,
        functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens' as const,
        args: [sellAmount, minOut, [token, WBNB], sellFrom, DEADLINE] as const,
      }),
      stateOverride: overrides,
    })

    const attemptSell = async (minOut: bigint): Promise<boolean> => {
      try {
        await client.call(sellCall(minOut) as never)
        return true
      } catch {
        return false
      }
    }

    if (!(await attemptSell(0n))) {
      probe.sellReverted = true
      probe.sellRevertReason = await captureRevert(async () => {
        await client.call(sellCall(0n) as never)
      })
      probe.verdict = 'sell-blocked'
      probes.push(probe)
      continue
    }

    const sold = await searchMaxAcceptedMin({ attempt: attemptSell, upper: theoreticalBnb ?? 0n })
    if (!sold.ok) {
      probe.sellRevertReason = `Sell output could not be measured: ${sold.reason}.`
      probe.verdict = 'sellable'
      probes.push(probe)
      continue
    }

    probe.actualBnbOut = sold.value.toString()
    if (theoreticalBnb !== null && theoreticalBnb > 0n) {
      probe.sellTaxPct = (1 - Number(sold.value) / Number(theoreticalBnb)) * 100
    }
    // Only a genuine round trip — same amount out and back — gives a loss
    // figure. A sell capped by a real holder's balance is a different trade,
    // and reporting it as a round trip would be wrong.
    if (sellAmount === bought.value) {
      probe.roundTripLossPct = (1 - Number(sold.value) / Number(value)) * 100
    }
    probe.verdict = 'sellable'
    probes.push(probe)
  }

  const measured = probes.filter((probe) => probe.roundTripLossPct !== null)
  const buyTaxes = probes.map((probe) => probe.buyTaxPct).filter((tax): tax is number => tax !== null)
  const sellTaxes = probes.map((probe) => probe.sellTaxPct).filter((tax): tax is number => tax !== null)
  const losses = measured.map((probe) => probe.roundTripLossPct!)

  const summary: HoneypotResult['summary'] = {
    anySellBlocked: probes.some((probe) => probe.verdict === 'sell-blocked'),
    maxRoundTripLossPct: losses.length > 0 ? Math.max(...losses) : null,
    maxBuyTaxPct: buyTaxes.length > 0 ? Math.max(...buyTaxes) : null,
    maxSellTaxPct: sellTaxes.length > 0 ? Math.max(...sellTaxes) : null,
    sizeDependent:
      new Set(probes.map((probe) => probe.verdict)).size > 1 ||
      (losses.length > 1 && Math.max(...losses) - Math.min(...losses) > 2),
  }

  return {
    supported: true,
    method,
    pair,
    balanceSlot,
    allowanceSlot,
    seller,
    probes,
    summary,
    detail:
      `Simulated ${probes.length} buy-then-sell round trip(s) against the v2 pair ${pair} with ` +
      '`eth_call` state overrides, recovering each leg\'s output by binary search on ' +
      'amountOutMin. ' +
      (method === 'real-holder'
        ? `The sell was run as ${seller}, a real holder with a standing router approval, because ` +
          "the token's balance mapping is not at any storage base this service can derive."
        : `The sell used a synthetic balance written at base ${balanceSlot?.base}` +
          `${balanceSlot?.namespaced ? ' (an ERC-7201 namespaced base)' : ''}.`) +
      ' ' +
      (summary.anySellBlocked
        ? 'At least one sell reverted: this token traps holders.'
        : summary.maxRoundTripLossPct === null
          ? 'No complete round trip could be measured, so the round-trip cost is unknown.'
          : `Worst measured round trip loses ${summary.maxRoundTripLossPct.toFixed(2)}% of the BNB ` +
            'put in — a guaranteed cost, before any price movement.'),
  }
}

async function captureRevert(run: () => Promise<void>): Promise<string> {
  try {
    await run()
    return 'no revert on the second attempt'
  } catch (error) {
    return short(error)
  }
}
