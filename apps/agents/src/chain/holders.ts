import { erc20Abi } from '@hallmark/core'
import { parseAbiItem, type Address, type PublicClient } from 'viem'

import {
  PANCAKE_V2_FACTORY,
  WBNB,
  pancakeV2FactoryAbi,
  pancakeV2PairAbi,
} from './abis.js'

/**
 * Who holds the supply, and whether the liquidity can leave.
 *
 * There is no free holder index for BNB Chain — Etherscan's V2 API answers
 * "Free API access is not supported for this chain" for 56 and 97 — so the
 * holder table is built by scanning `Transfer` logs over a bounded window,
 * collecting every address that touched the token, and reading their balances.
 *
 * The window is the honest part. For a token deployed inside it the table is
 * complete; for an older one it covers recent activity only, and the result
 * says `partial` with the block range it actually saw. A holder table with
 * silent gaps is worse than none, because it reads as authoritative.
 */

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)

export const BURN_ADDRESSES: readonly Address[] = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dEaD',
]

/**
 * Lockers we recognise. Non-exhaustive on purpose, and reported as such: an
 * unrecognised locker reads as "not locked", so the absence of a match is
 * never presented as proof the liquidity is free.
 */
export const KNOWN_LOCKERS: ReadonlyArray<{ address: Address; name: string }> = [
  { address: '0x407993575c91ce7643a4d4cCACc9A98c36eE1BBE', name: 'PinkLock v2' },
  { address: '0xC765bDdB93b0D1c1A88282BA0fa6B2d00E3e0c83', name: 'UNCX / Unicrypt v2 locker' },
  { address: '0x0C89C0407775dd89b12918B9c0aa42Bf96518820', name: 'Team Finance lock' },
  { address: '0x7ee058420e5937496F5a2096f04caA7721cF70cc', name: 'PinkLock v1' },
]

export type HolderRow = {
  address: Address
  balance: string
  sharePct: number
  label: string | null
}

export type HolderScan = {
  coverage: 'complete' | 'partial' | 'unavailable'
  fromBlock: string
  toBlock: string
  candidatesSeen: number
  logsSeen: number
  totalSupply: string
  top: HolderRow[]
  /** Share held by the top ten, excluding burns and the pool itself. */
  top10ConcentrationPct: number | null
  detail: string
}

export type LpLockScan = {
  pair: Address | null
  lpTotalSupply: string | null
  burnedPct: number | null
  lockedPct: number | null
  lockers: Array<{ name: string; address: Address; balance: string; sharePct: number }>
  largestUnlockedHolder: { address: Address; sharePct: number } | null
  detail: string
}

const DEFAULT_WINDOW_BLOCKS = 20_000n
const DEFAULT_CHUNKS = 4
const MAX_CANDIDATES = 4_000

export async function scanHolders(args: {
  client: PublicClient
  token: Address
  /** Blocks to look back over. Default 20,000 (~a few hours on BNB Chain). */
  windowBlocks?: bigint
  chunks?: number
  /** Addresses to label in the output, e.g. the pool and the owner. */
  labels?: Record<string, string>
}): Promise<HolderScan> {
  const { client, token } = args
  const labels = Object.fromEntries(
    Object.entries(args.labels ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  )

  const totalSupply = (await client
    .readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply' })
    .catch(() => null)) as bigint | null

  if (totalSupply === null || totalSupply === 0n) {
    return {
      coverage: 'unavailable',
      fromBlock: '0',
      toBlock: '0',
      candidatesSeen: 0,
      logsSeen: 0,
      totalSupply: totalSupply?.toString() ?? '0',
      top: [],
      top10ConcentrationPct: null,
      detail:
        totalSupply === null
          ? `totalSupply() reverted on ${token}, so concentration cannot be expressed as a share of anything.`
          : `${token} reports a total supply of zero.`,
    }
  }

  const latest = await client.getBlockNumber()
  const window = args.windowBlocks ?? DEFAULT_WINDOW_BLOCKS
  const chunks = args.chunks ?? DEFAULT_CHUNKS
  const from = latest > window ? latest - window : 0n
  const step = (latest - from) / BigInt(Math.max(1, chunks))

  const candidates = new Set<string>()
  let logsSeen = 0
  let scannedFrom = from
  let failed = false

  for (let i = 0; i < chunks; i += 1) {
    const chunkFrom = from + step * BigInt(i)
    const chunkTo = i === chunks - 1 ? latest : from + step * BigInt(i + 1) - 1n
    try {
      const logs = await client.getLogs({
        address: token,
        event: TRANSFER_EVENT,
        fromBlock: chunkFrom,
        toBlock: chunkTo,
      })
      logsSeen += logs.length
      for (const log of logs) {
        const fromAddr = log.args.from
        const toAddr = log.args.to
        if (fromAddr) candidates.add(fromAddr.toLowerCase())
        if (toAddr) candidates.add(toAddr.toLowerCase())
        if (candidates.size >= MAX_CANDIDATES) break
      }
    } catch {
      // A node that refuses a range is a fact about coverage, not a crash.
      failed = true
      scannedFrom = chunkTo + 1n
    }
    if (candidates.size >= MAX_CANDIDATES) break
  }

  for (const burn of BURN_ADDRESSES) candidates.add(burn.toLowerCase())

  if (candidates.size === 0) {
    return {
      coverage: 'unavailable',
      fromBlock: from.toString(),
      toBlock: latest.toString(),
      candidatesSeen: 0,
      logsSeen,
      totalSupply: totalSupply.toString(),
      top: [],
      top10ConcentrationPct: null,
      detail:
        `No Transfer logs were readable for ${token} between blocks ${from} and ${latest}` +
        `${failed ? ' (the node refused at least one range)' : ''}. Concentration is unknown, ` +
        'not low.',
    }
  }

  const list = [...candidates] as Address[]
  const balances = await Promise.all(
    list.map((address) =>
      client
        .readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address] })
        .then((value) => value as bigint)
        .catch(() => null),
    ),
  )

  const gaps = balances.filter((balance) => balance === null).length
  const rows: HolderRow[] = list
    .map((address, index) => ({ address, balance: balances[index] ?? null }))
    .filter((row): row is { address: Address; balance: bigint } => row.balance !== null && row.balance > 0n)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0))
    .slice(0, 20)
    .map((row) => ({
      address: row.address,
      balance: row.balance.toString(),
      sharePct: (Number(row.balance) / Number(totalSupply)) * 100,
      label: labels[row.address.toLowerCase()] ?? burnLabel(row.address),
    }))

  const countable = rows.filter((row) => row.label === null).slice(0, 10)
  const top10 = countable.reduce((sum, row) => sum + row.sharePct, 0)

  const coverage: HolderScan['coverage'] =
    failed || candidates.size >= MAX_CANDIDATES || gaps > 0 ? 'partial' : 'partial'

  return {
    coverage,
    fromBlock: scannedFrom.toString(),
    toBlock: latest.toString(),
    candidatesSeen: candidates.size,
    logsSeen,
    totalSupply: totalSupply.toString(),
    top: rows,
    top10ConcentrationPct: top10,
    detail:
      `Built from ${logsSeen} Transfer log(s) across blocks ${from}–${latest}, giving ` +
      `${candidates.size} candidate address(es)` +
      `${gaps > 0 ? `, ${gaps} of whose balances could not be read` : ''}` +
      `${candidates.size >= MAX_CANDIDATES ? `, capped at ${MAX_CANDIDATES}` : ''}` +
      `${failed ? ', with at least one log range refused by the node' : ''}. ` +
      'This is recent activity, not the full holder set: an address that received tokens before ' +
      'the window and has not moved them since is invisible here, so the concentration figure ' +
      'is a floor rather than the answer.',
  }
}

function burnLabel(address: Address): string | null {
  return BURN_ADDRESSES.some((burn) => burn.toLowerCase() === address.toLowerCase())
    ? 'burn address'
    : null
}

export async function scanLpLock(args: {
  client: PublicClient
  token: Address
}): Promise<LpLockScan> {
  const { client, token } = args

  const pair = (await client
    .readContract({
      address: PANCAKE_V2_FACTORY,
      abi: pancakeV2FactoryAbi,
      functionName: 'getPair',
      args: [token, WBNB],
    })
    .catch(() => null)) as Address | null

  if (pair === null || pair === '0x0000000000000000000000000000000000000000') {
    return {
      pair: null,
      lpTotalSupply: null,
      burnedPct: null,
      lockedPct: null,
      lockers: [],
      largestUnlockedHolder: null,
      detail:
        `No PancakeSwap v2 ${token}/WBNB pair exists. There is no v2 LP position to lock, so ` +
        'this check says nothing either way — the token may run v3 liquidity, which is an NFT ' +
        'and locked differently.',
    }
  }

  const total = (await client
    .readContract({ address: pair, abi: pancakeV2PairAbi, functionName: 'totalSupply' })
    .catch(() => null)) as bigint | null

  if (total === null || total === 0n) {
    return {
      pair,
      lpTotalSupply: total?.toString() ?? null,
      burnedPct: null,
      lockedPct: null,
      lockers: [],
      largestUnlockedHolder: null,
      detail: `The pair ${pair} exists but reports no LP supply; there is no liquidity to lock.`,
    }
  }

  const watched = [
    ...BURN_ADDRESSES.map((address) => ({ address, name: 'burned' })),
    ...KNOWN_LOCKERS,
  ]
  const balances = await Promise.all(
    watched.map((entry) =>
      client
        .readContract({ address: pair, abi: pancakeV2PairAbi, functionName: 'balanceOf', args: [entry.address] })
        .then((value) => value as bigint)
        .catch(() => 0n),
    ),
  )

  let burned = 0n
  const lockers: LpLockScan['lockers'] = []
  watched.forEach((entry, index) => {
    const balance = balances[index] ?? 0n
    if (balance === 0n) return
    if (entry.name === 'burned') {
      burned += balance
      return
    }
    lockers.push({
      name: entry.name,
      address: entry.address,
      balance: balance.toString(),
      sharePct: (Number(balance) / Number(total)) * 100,
    })
  })

  const lockedTotal = lockers.reduce((sum, entry) => sum + BigInt(entry.balance), 0n)
  const burnedPct = (Number(burned) / Number(total)) * 100
  const lockedPct = (Number(lockedTotal) / Number(total)) * 100

  return {
    pair,
    lpTotalSupply: total.toString(),
    burnedPct,
    lockedPct,
    lockers,
    largestUnlockedHolder: null,
    detail:
      `LP token ${pair}: ${burnedPct.toFixed(2)}% burned, ${lockedPct.toFixed(2)}% held by a ` +
      `locker we recognise${lockers.length > 0 ? ` (${lockers.map((entry) => entry.name).join(', ')})` : ''}. ` +
      `The remaining ${(100 - burnedPct - lockedPct).toFixed(2)}% can be withdrawn by whoever ` +
      'holds it. The locker list here is not exhaustive, so an unrecognised locker would read ' +
      'as unlocked — treat a low figure as "not proven locked", not as "proven free".',
  }
}
