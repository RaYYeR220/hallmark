import { getChain, isSupportedChainId, type SupportedChainId } from '@hallmark/core'
import type { Address, Hex } from 'viem'

import { ownableAbi, PANCAKE_V2_FACTORY, WBNB, pancakeV2FactoryAbi, pancakeV2PairAbi } from '../../chain/abis.js'
import { analysisTarget, detectProxy, type ProxyDetection } from '../../chain/proxy.js'
import {
  auxiliaryGetterAbi,
  AUXILIARY_GETTERS,
  scanPrivileges,
  type PrivilegeScan,
} from '../../chain/privileges.js'
import { simulateRoundTrip, type HoneypotResult } from '../../chain/honeypot.js'
import { scanHolders, scanLpLock, type HolderScan, type LpLockScan } from '../../chain/holders.js'
import { checkSourcify, type SourcifyResult } from '../../chain/sourcify.js'
import { readTokenMeta, type TokenMeta } from '../../chain/tokens.js'
import { priceUsdForSymbol } from '../../chain/usd.js'
import { assertion, failedAssertions, type Assertion } from '../../chain/reconcile.js'
import { clientFor } from '../../runtime/client.js'
import { narrate } from '../../runtime/narrative.js'
import type { Analysis, SkillContext, Source } from '../../runtime/types.js'
import { SECURITY_SLUG } from './manifest.js'

/**
 * A defensible go / no-go on a BNB Chain token.
 *
 * Two rules shape the output.
 *
 * *Unknown is not clean.* Every check that could not run says so, and an
 * unknown on anything that matters caps the verdict at `caution` — it can
 * never reach `go`. The most dangerous output a scanner can produce is a green
 * tick that means "we did not look".
 *
 * *A clean contract can still be a no.* The verdict weighs measured economics
 * alongside code findings: a token with renounced ownership, no mint, locked
 * liquidity and a guaranteed 7% round-trip cost against a five-figure
 * valuation is a no, and saying otherwise because nothing reverted would be
 * technically accurate and practically useless.
 */

export type SecurityInput = {
  chainId?: number
  token: string
  /** Blocks of Transfer history to build the holder table from. */
  holderWindowBlocks?: number
}

export type Finding = {
  id: string
  title: string
  status: 'pass' | 'warn' | 'fail' | 'unknown'
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
  detail: string
  /** Exactly what was read, so a reader can repeat it. */
  evidence: Record<string, unknown>
}

export type SecurityDecision = {
  /** The risk grade. */
  verdict: 'go' | 'caution' | 'no-go'
  /**
   * The answer to the question that was actually asked.
   *
   * Two values, never three. `caution` is a grade, not a decision, and a
   * report that stops at `caution, score 70` has declined to answer: someone
   * has to decide whether to buy, and pushing that back to them while holding
   * all the evidence is an abstention dressed as a verdict.
   *
   * The rule is stated rather than felt: anything that failed, any unknown on
   * a check that matters, or a round trip that costs more than 5%, and the
   * answer is no. An unrun check is not a reason to proceed.
   */
  recommendation: 'proceed' | 'do-not-proceed'
  recommendationReason: string
  headline: string
  score: number
  token: {
    address: string
    name: string
    symbol: string
    decimals: number
    totalSupply: string | null
  }
  analysedContract: string
  proxy: ProxyDetection
  findings: Finding[]
  economics: {
    liquidityBnb: string | null
    liquidityUsd: number | null
    fdvUsd: number | null
    priceBnb: number | null
    roundTripLossPct: number | null
    /** Round trips before the position is worth nothing at this cost. */
    detail: string
  }
  privileges: PrivilegeScan
  /**
   * Contracts the token names: who controls them, and what their code can do.
   *
   * Ownership alone is half the answer. Both auxiliary contracts on the token
   * this agent was built against are themselves EIP-1167 stubs, so a scanner
   * that resolves the token's proxy but not theirs finds two addresses with
   * nothing behind them and reports clean. Mint, blacklist, pause and
   * fee-modifier authority living one hop out in an unverified implementation
   * is an ordinary way to hide privilege.
   */
  auxiliary: Array<{
    getter: string
    address: string
    owner: string | null
    renounced: boolean | null
    codeSize: number
    /** The second hop: this contract's own proxy, if it is one. */
    proxy: { isProxy: boolean; kind: string | null; implementation: string | null } | null
    /** Where the privilege scan actually looked — the implementation if proxied. */
    scanned: string | null
    privileges: Array<{ signature: string; severity: string; why: string }>
    detail: string
  }>
  /** Where the second hop stopped, so the report never implies it looked everywhere. */
  auxiliaryScan: {
    found: number
    followed: number
    cap: number
    capped: boolean
    detail: string
  }
  /** Buy and sell tax, in basis points. `null` means not determined. */
  tax: {
    buyBps: number | null
    sellBps: number | null
    roundTripBps: number | null
    source: 'simulated' | 'not-determined'
    detail: string
  }
  sourcify: SourcifyResult | null
  honeypot: HoneypotResult | null
  holders: HolderScan | null
  lp: LpLockScan | null
  assertions: Assertion[]
  unknowns: string[]
}

export type SecurityAnalysis = Analysis<SecurityDecision>

const DEAD: Address = '0x000000000000000000000000000000000000dEaD'
const ZERO: Address = '0x0000000000000000000000000000000000000000'

export async function analyseSecurity(
  input: SecurityInput,
  ctx: SkillContext,
  opts: { deep: boolean },
): Promise<SecurityAnalysis | { error: string; detail: string }> {
  const chainId: SupportedChainId =
    input.chainId !== undefined && isSupportedChainId(input.chainId) ? input.chainId : ctx.chainId
  const chain = getChain(chainId)
  const client = clientFor(ctx, chainId)
  const now = ctx.now()
  const token = input.token as Address
  const sources: Source[] = []
  const warnings: string[] = []
  const findings: Finding[] = []
  const unknowns: string[] = []
  const pairAddressesSeen = new Set<string>()

  // --- 1. is there even a contract, and is it a proxy? ---------------------
  const proxy = await detectProxy(client, token)
  sources.push({
    kind: 'onchain',
    label: 'Proxy detection',
    detail:
      'eth_getCode plus the EIP-1967, EIP-1822 and legacy OpenZeppelin storage slots, read ' +
      'directly. No third-party proxy flag is trusted: a commercial scanner returned is_proxy=0 ' +
      'for a live EIP-1167 minimal proxy, which sends every subsequent check to the wrong bytecode.',
    url: `${chain.explorer}/address/${token}`,
  })

  if (proxy.proxyCodeSize === 0) {
    return {
      error: 'not-a-contract',
      detail: `${token} has no bytecode on chain ${chainId}. There is nothing to analyse.`,
    }
  }

  const target = analysisTarget(token, proxy)
  findings.push({
    id: 'proxy',
    title: proxy.isProxy ? 'Contract is a proxy' : 'Contract is not a proxy',
    status: proxy.isProxy ? 'warn' : 'pass',
    severity: proxy.isProxy ? 'high' : 'info',
    detail: proxy.detail,
    evidence: {
      kind: proxy.kind,
      implementation: proxy.implementation,
      admin: proxy.admin,
      beacon: proxy.beacon,
      proxyCodeSize: proxy.proxyCodeSize,
      implementationCodeSize: proxy.implementationCodeSize,
      checks: proxy.evidence,
    },
  })

  const meta: TokenMeta = await readTokenMeta(client, token, { cache: false })
  if (meta.unreadable.length > 0) {
    unknowns.push(`ERC-20 metadata unreadable: ${meta.unreadable.join(', ')}`)
  }

  // --- 2. ownership --------------------------------------------------------
  let owner: Address | null = null
  let ownerFn: string | null = null
  for (const fn of ['owner', 'getOwner', '_owner'] as const) {
    const result = (await client
      .readContract({ address: token, abi: ownableAbi, functionName: fn })
      .catch(() => null)) as Address | null
    if (result) {
      owner = result
      ownerFn = `${fn}()`
      break
    }
  }

  const renounced =
    owner !== null &&
    (owner.toLowerCase() === ZERO.toLowerCase() || owner.toLowerCase() === DEAD.toLowerCase())

  findings.push({
    id: 'ownership',
    title: owner === null ? 'No owner function found' : renounced ? 'Ownership renounced' : 'Ownership retained',
    status: owner === null ? 'unknown' : renounced ? 'pass' : 'warn',
    severity: owner === null ? 'medium' : renounced ? 'info' : 'high',
    detail:
      owner === null
        ? 'Neither owner(), getOwner() nor _owner() answered. The contract may have no owner, or ' +
          'may name its admin something else — this check cannot tell which, so it reports ' +
          'unknown rather than assuming there is nobody in charge.'
        : renounced
          ? `${ownerFn} returns ${owner}, a burn address. Owner-gated functions can no longer be ` +
            'called — though anything gated on a *role* rather than the owner is unaffected, and ' +
            'a proxy admin is separate from the owner entirely.'
          : `${ownerFn} returns ${owner}. Whoever controls that key can call every owner-gated ` +
            'function in the list below, at any time, including after you buy.',
    evidence: { owner, via: ownerFn, renounced, proxyAdmin: proxy.admin },
  })

  // --- 2b. contracts the token points at, and their code -------------------
  //
  // A renounced token can still be controlled one hop away, and the privilege
  // can live in the code rather than the owner. So each address the token
  // publishes is followed: through its own proxy if it has one, then its
  // implementation bytecode is scanned for the same privileged selectors the
  // token itself was scanned for.
  //
  // Exactly one extra hop, and a hard cap on how many contracts are followed.
  // An unbounded walk of a token's address graph is a denial-of-service on
  // ourselves, and a report that quietly stopped early would be worse than one
  // that says where it stopped — so `auxiliaryScan` carries the limit.
  const MAX_AUXILIARY_FOLLOWED = 6
  const auxiliary: SecurityDecision['auxiliary'] = []
  let auxiliaryFound = 0
  let auxiliaryFollowed = 0

  for (const getter of AUXILIARY_GETTERS) {
    const address = (await client
      .readContract({ address: token, abi: auxiliaryGetterAbi, functionName: getter })
      .catch(() => null)) as Address | null
    if (!address || address === ZERO) continue
    if (address.toLowerCase() === token.toLowerCase()) continue
    if (pairAddressesSeen.has(address.toLowerCase())) continue
    pairAddressesSeen.add(address.toLowerCase())
    auxiliaryFound += 1

    const code = ((await client.getCode({ address }).catch(() => undefined)) ?? '0x') as Hex
    const codeSize = Math.max(0, (code.length - 2) / 2)
    if (codeSize === 0) {
      auxiliary.push({
        getter: `${getter}()`,
        address,
        owner: null,
        renounced: null,
        codeSize: 0,
        proxy: null,
        scanned: null,
        privileges: [],
        detail: `${getter}() points at ${address}, which holds no code — an EOA or an unused slot.`,
      })
      continue
    }

    let auxOwner: Address | null = null
    for (const fn of ['owner', 'getOwner', '_owner'] as const) {
      const found = (await client
        .readContract({ address, abi: ownableAbi, functionName: fn })
        .catch(() => null)) as Address | null
      if (found) {
        auxOwner = found
        break
      }
    }
    const auxRenounced =
      auxOwner === null
        ? null
        : auxOwner.toLowerCase() === ZERO.toLowerCase() ||
          auxOwner.toLowerCase() === DEAD.toLowerCase()

    // --- the second hop ---------------------------------------------------
    let auxProxy: SecurityDecision['auxiliary'][number]['proxy'] = null
    let scanned: string | null = null
    let auxPrivileges: SecurityDecision['auxiliary'][number]['privileges'] = []

    if (auxiliaryFollowed < MAX_AUXILIARY_FOLLOWED) {
      auxiliaryFollowed += 1
      const resolved = await detectProxy(client, address)
      auxProxy = {
        isProxy: resolved.isProxy,
        kind: resolved.kind,
        implementation: resolved.implementation,
      }
      const auxTarget = analysisTarget(address, resolved)
      scanned = auxTarget
      const auxCode = ((await client.getCode({ address: auxTarget }).catch(() => undefined)) ??
        '0x') as Hex
      auxPrivileges = scanPrivileges({ address: auxTarget, bytecode: auxCode })
        .found.filter((entry) => entry.severity === 'critical' || entry.severity === 'high')
        .map((entry) => ({ signature: entry.signature, severity: entry.severity, why: entry.why }))
    }

    const ownerSentence =
      auxOwner === null
        ? `publishes no owner this agent could read — unknown control, not absent control`
        : auxRenounced
          ? 'has renounced its ownership'
          : `is still owned by ${auxOwner}`

    const proxySentence =
      auxProxy === null
        ? ' It was not followed: the cap on contracts to resolve was already reached.'
        : auxProxy.isProxy
          ? ` It is itself a ${auxProxy.kind} proxy over ${auxProxy.implementation}, which is ` +
            'where its code actually lives.'
          : ''

    const privilegeSentence =
      auxPrivileges.length === 0
        ? auxProxy === null
          ? ''
          : ' Its code carries none of the privileged selectors this agent looks for.'
        : ` Its code carries ${auxPrivileges.map((entry) => entry.signature).join(', ')} — ` +
          'privilege one hop out from the token, which the token being renounced does not ' +
          'constrain.'

    auxiliary.push({
      getter: `${getter}()`,
      address,
      owner: auxOwner,
      renounced: auxRenounced,
      codeSize,
      proxy: auxProxy,
      scanned,
      privileges: auxPrivileges,
      detail:
        `${getter}() points at contract ${address} (${codeSize} bytes), which ${ownerSentence}.` +
        proxySentence +
        privilegeSentence,
    })
  }

  const auxiliaryScan = {
    found: auxiliaryFound,
    followed: auxiliaryFollowed,
    cap: MAX_AUXILIARY_FOLLOWED,
    capped: auxiliaryFound > auxiliaryFollowed,
    detail:
      auxiliaryFound === 0
        ? 'The token publishes no auxiliary contract addresses this agent recognises.'
        : auxiliaryFound > auxiliaryFollowed
          ? `${auxiliaryFound} auxiliary contract(s) found; the first ${auxiliaryFollowed} were ` +
            `resolved and scanned and the rest were not. The walk stops at one hop and ` +
            `${MAX_AUXILIARY_FOLLOWED} contracts by design — this is where it stopped, not ` +
            'everywhere it could have looked.'
          : `${auxiliaryFollowed} auxiliary contract(s) followed one hop: each resolved through ` +
            'its own proxy where it had one, then its implementation bytecode scanned. The walk ' +
            'stops at one hop by design; a contract those contracts point at is not examined.',
  }

  const controlledAux = auxiliary.filter((entry) => entry.renounced === false)
  const unknownAux = auxiliary.filter((entry) => entry.renounced === null && entry.codeSize > 0)
  const privilegedAux = auxiliary.filter((entry) => entry.privileges.length > 0)
  const criticalAux = privilegedAux.filter((entry) =>
    entry.privileges.some((privilege) => privilege.severity === 'critical'),
  )

  if (auxiliary.length > 0) {
    // Privilege in the code of a contract someone still owns is the dangerous
    // combination: either alone is survivable, together they are control.
    const controlledAndPrivileged = auxiliary.filter(
      (entry) => entry.renounced === false && entry.privileges.length > 0,
    )

    findings.push({
      id: 'auxiliary-contracts',
      title:
        controlledAndPrivileged.length > 0
          ? `${controlledAndPrivileged.length} owned contract(s) one hop out carry privileged code`
          : privilegedAux.length > 0
            ? `${privilegedAux.length} contract(s) one hop out carry privileged code`
            : controlledAux.length > 0
              ? `${controlledAux.length} contract(s) the token routes through are still owned`
              : 'Contracts the token routes through are renounced or ownerless',
      status:
        controlledAndPrivileged.length > 0 || criticalAux.length > 0
          ? 'fail'
          : controlledAux.length > 0 || privilegedAux.length > 0
            ? 'warn'
            : unknownAux.length > 0
              ? 'unknown'
              : 'pass',
      severity: criticalAux.length > 0 || controlledAndPrivileged.length > 0 ? 'critical' : 'high',
      detail:
        auxiliary.map((entry) => entry.detail).join(' ') +
        (controlledAndPrivileged.length > 0
          ? ' A contract that is both still owned and carries privileged code is control, not a ' +
            'loose end: the token being renounced says nothing about it.'
          : '') +
        (controlledAux.length > 0 && renounced
          ? ' Control of a contract the token routes through survives the token itself being ' +
            'renounced, so the clean ownership check above does not cover it.'
          : '') +
        ' ' +
        auxiliaryScan.detail,
      evidence: { auxiliary, scan: auxiliaryScan },
    })
    if (unknownAux.length > 0) unknowns.push('ownership of auxiliary contracts')
    if (auxiliaryScan.capped) {
      unknowns.push(
        `${auxiliaryScan.found - auxiliaryScan.followed} auxiliary contract(s) beyond the scan cap`,
      )
    }
  }

  // --- 3. privileges, against the implementation ---------------------------
  const bytecode = ((await client.getCode({ address: target }).catch(() => undefined)) ?? '0x') as Hex
  const privileges = scanPrivileges({ address: target, bytecode })
  sources.push({
    kind: 'onchain',
    label: 'Privilege selector scan',
    detail: privileges.detail,
    url: `${chain.explorer}/address/${target}`,
  })

  const critical = privileges.found.filter((entry) => entry.severity === 'critical')
  const high = privileges.found.filter((entry) => entry.severity === 'high')

  findings.push({
    id: 'privileges',
    title:
      critical.length > 0
        ? `${critical.length} critical privilege(s) in the bytecode`
        : high.length > 0
          ? `${high.length} high-severity privilege(s) in the bytecode`
          : 'No dangerous privileges found in the bytecode',
    status: critical.length > 0 ? 'fail' : high.length > 0 ? 'warn' : 'pass',
    severity: critical.length > 0 ? 'critical' : high.length > 0 ? 'high' : 'info',
    detail:
      privileges.found.length === 0
        ? `No privileged selector from a list of ${privileges.found.length + privileges.absent.length} ` +
          `appears in the ${privileges.codeSize} bytes at ${target}. A selector scan is evidence, ` +
          'not proof: privilege hidden behind a fallback names no selector.'
        : `${target} exposes ${privileges.found.map((entry) => entry.signature).join(', ')}. ` +
          (renounced
            ? 'Ownership is renounced, so owner-gated ones cannot be reached — but role-gated ones can.'
            : 'Ownership is not renounced, so these are reachable by the owner now.'),
    evidence: {
      scanned: target,
      viaProxy: proxy.isProxy,
      found: privileges.found.map((entry) => ({
        signature: entry.signature,
        selector: entry.selector,
        severity: entry.severity,
        why: entry.why,
      })),
      counts: privileges.counts,
    },
  })

  // --- 4. source verification ---------------------------------------------
  // Sourcify, on the *implementation* — which is the whole point of resolving
  // the proxy first. On the token this agent was built against, the 45-byte
  // stub is unverified and the implementation behind it is an exact match; a
  // scanner that checked the address the user typed would report neither.
  const sourcify = await checkSourcify({
    address: target,
    chainId,
    fetchImpl: ctx.fetch,
  })
  sources.push({
    kind: 'http',
    label: 'Sourcify',
    detail:
      `v2 contract lookup for ${target} on chain ${chainId} — keyless and free. ` +
      'Etherscan V2 does charge for BNB Chain, which is why this check used to be skipped; ' +
      'that was a wrong premise, not a missing capability.',
    url: sourcify.url,
  })

  const proxyNote = proxy.isProxy
    ? ` This is the implementation behind the proxy at ${token}, which is the contract that ` +
      'actually runs; the stub in front of it is not itself verified and would not be.'
    : ''

  findings.push({
    id: 'source-verification',
    title: !sourcify.checked
      ? 'Source verification unknown'
      : sourcify.match === 'exact_match'
        ? 'Source verified — exact match'
        : sourcify.match === 'match'
          ? 'Source verified — partial match'
          : 'No verified source found',
    status: !sourcify.checked ? 'unknown' : sourcify.match === null ? 'warn' : 'pass',
    severity: 'low',
    detail: sourcify.detail + (sourcify.match === null ? '' : proxyNote),
    evidence: {
      source: 'sourcify',
      scanned: target,
      match: sourcify.match,
      creationMatch: sourcify.creationMatch,
      runtimeMatch: sourcify.runtimeMatch,
      verifiedAt: sourcify.verifiedAt,
      sourcifyUrl: sourcify.url,
      explorer: `${chain.explorer}/address/${target}#code`,
    },
  })
  if (!sourcify.checked || sourcify.match === null) unknowns.push('verified source')

  // --- 5. liquidity and economics -----------------------------------------
  const pair = (await client
    .readContract({
      address: PANCAKE_V2_FACTORY,
      abi: pancakeV2FactoryAbi,
      functionName: 'getPair',
      args: [token, WBNB],
    })
    .catch(() => null)) as Address | null

  let liquidityBnb: bigint | null = null
  let priceBnb: number | null = null

  if (pair && pair !== ZERO) {
    const [reserves, token0] = await Promise.all([
      client.readContract({ address: pair, abi: pancakeV2PairAbi, functionName: 'getReserves' }).catch(() => null) as Promise<readonly [bigint, bigint, number] | null>,
      client.readContract({ address: pair, abi: pancakeV2PairAbi, functionName: 'token0' }).catch(() => null) as Promise<Address | null>,
    ])
    if (reserves && token0) {
      const wbnbIsToken0 = token0.toLowerCase() === WBNB.toLowerCase()
      const bnbReserve = wbnbIsToken0 ? reserves[0] : reserves[1]
      const tokenReserve = wbnbIsToken0 ? reserves[1] : reserves[0]
      liquidityBnb = bnbReserve
      if (tokenReserve > 0n) {
        priceBnb =
          (Number(bnbReserve) / 1e18) / (Number(tokenReserve) / 10 ** meta.decimals)
      }
      sources.push({
        kind: 'onchain',
        label: 'PancakeSwap v2 pair reserves',
        detail: `getReserves() on ${pair}`,
        url: `${chain.explorer}/address/${pair}`,
      })
    }
  }

  const bnb = await priceUsdForSymbol({ client, chainId, symbol: 'BNB', now })
  const liquidityUsd =
    liquidityBnb === null || bnb.usd === null ? null : (Number(liquidityBnb) / 1e18) * bnb.usd * 2
  const fdvUsd =
    priceBnb === null || bnb.usd === null || meta.totalSupply === null
      ? null
      : priceBnb * bnb.usd * (Number(meta.totalSupply) / 10 ** meta.decimals)

  // --- 6. LP lock ----------------------------------------------------------
  const lp = await scanLpLock({ client, token })
  const lpFreePct =
    lp.burnedPct === null || lp.lockedPct === null ? null : 100 - lp.burnedPct - lp.lockedPct
  findings.push({
    id: 'lp-lock',
    title:
      lp.pair === null
        ? 'No v2 liquidity pair'
        : lpFreePct === null
          ? 'LP lock unknown'
          : lpFreePct > 50
            ? 'Most liquidity is withdrawable'
            : 'Most liquidity is burned or locked',
    status: lp.pair === null ? 'unknown' : lpFreePct === null ? 'unknown' : lpFreePct > 50 ? 'fail' : 'pass',
    severity: lpFreePct !== null && lpFreePct > 50 ? 'critical' : 'medium',
    detail: lp.detail,
    evidence: { pair: lp.pair, burnedPct: lp.burnedPct, lockedPct: lp.lockedPct, lockers: lp.lockers },
  })
  if (lp.pair === null || lpFreePct === null) unknowns.push('LP lock status')

  // --- 7. holders (deep only: it is a log scan) ----------------------------
  let holders: HolderScan | null = null
  if (opts.deep) {
    holders = await scanHolders({
      client,
      token,
      ...(input.holderWindowBlocks === undefined
        ? {}
        : { windowBlocks: BigInt(input.holderWindowBlocks) }),
      labels: {
        ...(pair && pair !== ZERO ? { [pair]: 'liquidity pool' } : {}),
        ...(owner ? { [owner]: 'owner' } : {}),
      },
    })
    sources.push({ kind: 'onchain', label: 'Holder scan', detail: holders.detail })
    findings.push({
      id: 'concentration',
      title:
        holders.top10ConcentrationPct === null
          ? 'Holder concentration unknown'
          : holders.top10ConcentrationPct > 50
            ? 'Top holders control most of the supply'
            : 'No single cluster dominates the visible supply',
      status:
        holders.top10ConcentrationPct === null
          ? 'unknown'
          : holders.top10ConcentrationPct > 50
            ? 'fail'
            : holders.top10ConcentrationPct > 25
              ? 'warn'
              : 'pass',
      severity: 'high',
      detail:
        holders.top10ConcentrationPct === null
          ? holders.detail
          : `The ten largest non-pool, non-burn holders visible in this window hold ` +
            `${holders.top10ConcentrationPct.toFixed(2)}% of supply. ${holders.detail}`,
      evidence: {
        coverage: holders.coverage,
        window: `${holders.fromBlock}–${holders.toBlock}`,
        top: holders.top.slice(0, 10),
      },
    })
    if (holders.top10ConcentrationPct === null) unknowns.push('holder concentration')
  } else {
    unknowns.push('holder concentration (not run on the free tier)')
  }

  // --- 8. the sell test ----------------------------------------------------
  let honeypot: HoneypotResult | null = null
  // Never silently absent. The free tier does not simulate, so the default
  // says that rather than leaving the field off the report.
  let tax: SecurityDecision['tax'] = {
    buyBps: null,
    sellBps: null,
    roundTripBps: null,
    source: 'not-determined',
    detail:
      'Buy and sell tax are measured by the buy/sell simulation, which runs on the paid ' +
      '`report` skill only. On this tier they are not determined — which is not the same as ' +
      'zero.',
  }
  if (opts.deep) {
    // The holder table earns its keep twice: as a concentration finding, and
    // as a list of addresses that may already have approved the router — which
    // is what lets the sell leg run against a token whose storage layout the
    // override method cannot find.
    honeypot = await simulateRoundTrip({
      client,
      token,
      ...(holders === null
        ? {}
        : { holders: holders.top.filter((row) => row.label === null).map((row) => row.address) }),
    })
    sources.push({
      kind: 'onchain',
      label: 'Buy/sell simulation',
      detail: honeypot.detail,
    })
    findings.push({
      id: 'sellability',
      title: !honeypot.supported
        ? 'Sellability could not be measured'
        : honeypot.summary.anySellBlocked
          ? 'Sell blocked — honeypot'
          : 'Token sold successfully in simulation',
      status: !honeypot.supported ? 'unknown' : honeypot.summary.anySellBlocked ? 'fail' : 'pass',
      severity: 'critical',
      detail: honeypot.detail,
      evidence: { probes: honeypot.probes, summary: honeypot.summary, balanceSlot: honeypot.balanceSlot },
    })
    if (!honeypot.supported) unknowns.push('sellability')

    // Buy and sell tax, stated separately. The simulation already measures
    // each leg against the pool's own reserve math, so the tax is the gap —
    // and an agent whose pitch is "sellability is measured, not inferred"
    // has no business omitting the number that makes a position unsellable
    // in slow motion.
    if (honeypot.summary.maxBuyTaxPct !== null || honeypot.summary.maxSellTaxPct !== null) {
      const buyBps = honeypot.summary.maxBuyTaxPct === null ? null : Math.round(honeypot.summary.maxBuyTaxPct * 100)
      const sellBps = honeypot.summary.maxSellTaxPct === null ? null : Math.round(honeypot.summary.maxSellTaxPct * 100)
      tax = {
        buyBps,
        sellBps,
        roundTripBps: buyBps === null || sellBps === null ? null : buyBps + sellBps,
        source: 'simulated',
        detail:
          `Buy ${buyBps === null ? 'not measured' : `${buyBps} bps`}, sell ` +
          `${sellBps === null ? 'not measured' : `${sellBps} bps`}, measured by simulating each ` +
          'leg against the pool and comparing the result with what the reserves alone would give.',
      }
      const worst = Math.max(buyBps ?? 0, sellBps ?? 0)
      findings.push({
        id: 'transfer-tax',
        title:
          worst === 0
            ? 'No transfer tax measured'
            : `Transfer tax: ${buyBps ?? '?'} bps buy, ${sellBps ?? '?'} bps sell`,
        status: worst >= 1_000 ? 'fail' : worst >= 300 ? 'warn' : 'pass',
        severity: worst >= 1_000 ? 'critical' : 'high',
        detail:
          tax.detail +
          (worst === 0
            ? ' Neither leg loses value beyond the pool fee.'
            : ` A round trip therefore costs ${((buyBps ?? 0) + (sellBps ?? 0)) / 100}% in tax ` +
              'alone, before price impact. A tax can usually be raised by whoever controls the ' +
              'token, so treat this as the rate today rather than the rate you will pay.'),
        evidence: { buyBps, sellBps, probes: honeypot.probes.map((probe) => ({
          sizeBnb: probe.sizeBnb,
          buyTaxPct: probe.buyTaxPct,
          sellTaxPct: probe.sellTaxPct,
        })) },
      })
    } else {
      tax = {
        buyBps: null,
        sellBps: null,
        roundTripBps: null,
        source: 'not-determined',
        detail:
          'Buy and sell tax could not be measured: ' +
          (honeypot.supported
            ? 'the simulation ran but neither leg produced a comparable figure.'
            : honeypot.detail),
      }
      unknowns.push('buy and sell tax')
      findings.push({
        id: 'transfer-tax',
        title: 'Transfer tax not determined',
        status: 'unknown',
        severity: 'high',
        detail: tax.detail + ' Unknown tax is not zero tax.',
        evidence: { honeypotMethod: honeypot.method, supported: honeypot.supported },
      })
    }

    const loss = honeypot.summary.maxRoundTripLossPct
    if (loss !== null) {
      findings.push({
        id: 'round-trip-cost',
        title: `Round trip costs ${loss.toFixed(2)}%`,
        status: loss > 10 ? 'fail' : loss > 5 ? 'warn' : 'pass',
        severity: loss > 10 ? 'critical' : loss > 5 ? 'high' : 'info',
        detail:
          `Buying and immediately selling loses ${loss.toFixed(2)}% of the BNB put in, measured ` +
          `at ${honeypot.probes.length} size(s). That is a guaranteed cost before the price ` +
          `moves at all: the position has to appreciate ${(loss / (1 - loss / 100)).toFixed(2)}% ` +
          'simply to break even. A contract with no red flags and economics like these is still ' +
          'a no.' +
          (honeypot.summary.sizeDependent
            ? ' The cost also varies with trade size, which usually means a fee that scales or a ' +
              'pool too thin for the sizes tested.'
            : ''),
        evidence: {
          maxRoundTripLossPct: loss,
          buyTaxPct: honeypot.summary.maxBuyTaxPct,
          sellTaxPct: honeypot.summary.maxSellTaxPct,
          sizeDependent: honeypot.summary.sizeDependent,
        },
      })
    }
  } else {
    // The free tier does not simulate. These must still appear as findings —
    // omitting them entirely was how an unrun critical check ended up costing
    // nothing in the verdict, and how the report could reach "caution" with
    // sellability and tax simply missing from the page.
    unknowns.push('sellability (not run on the free tier)')
    unknowns.push('buy and sell tax (not run on the free tier)')
    findings.push({
      id: 'sellability',
      title: 'Sellability not measured',
      status: 'unknown',
      severity: 'critical',
      detail:
        'The buy/sell round trip runs on the paid `report` skill only. Whether this token can ' +
        'be sold is therefore unknown on this tier — which is not the same as sellable, and is ' +
        'why this report will not recommend proceeding.',
      evidence: { tier: 'analyse', availableOn: 'report' },
    })
    findings.push({
      id: 'transfer-tax',
      title: 'Transfer tax not measured',
      status: 'unknown',
      severity: 'high',
      detail: tax.detail,
      evidence: { tier: 'analyse', availableOn: 'report' },
    })
  }

  // --- verdict -------------------------------------------------------------
  const fails = findings.filter((finding) => finding.status === 'fail')
  const warnsHigh = findings.filter(
    (finding) => finding.status === 'warn' && (finding.severity === 'critical' || finding.severity === 'high'),
  )
  const unknownCritical = findings.filter(
    (finding) => finding.status === 'unknown' && (finding.severity === 'critical' || finding.severity === 'high'),
  )

  let verdict: SecurityDecision['verdict']
  let headline: string

  if (fails.some((finding) => finding.severity === 'critical')) {
    verdict = 'no-go'
    headline = `No-go: ${fails.filter((f) => f.severity === 'critical').map((f) => f.title).join('; ')}.`
  } else if (fails.length > 0 || warnsHigh.length > 0) {
    verdict = 'caution'
    headline = `Caution: ${[...fails, ...warnsHigh].map((f) => f.title).join('; ')}.`
  } else if (unknownCritical.length > 0 || unknowns.length > 0) {
    // Unknown is never clean. The most dangerous output here would be a green
    // tick that actually means "we did not look".
    verdict = 'caution'
    headline =
      `Caution: nothing failed, but ${unknowns.length} check(s) could not be completed ` +
      `(${unknowns.join(', ')}). An unrun check is not a pass.`
  } else {
    verdict = 'go'
    headline = 'Go: every check ran and none failed.'
  }

  const score = Math.max(
    0,
    100 -
      fails.reduce((sum, f) => sum + (f.severity === 'critical' ? 45 : 20), 0) -
      warnsHigh.length * 12 -
      unknowns.length * 6,
  )

  // --- the decision -------------------------------------------------------
  // Two values. Whatever the grade, someone has to decide, and this is the
  // agent's answer rather than a shrug handed back with the evidence.
  const blockers: string[] = []
  if (fails.length > 0) {
    blockers.push(
      `${fails.length} check(s) failed: ${fails.map((finding) => finding.title).join('; ')}`,
    )
  }
  if (unknownCritical.length > 0) {
    blockers.push(
      `${unknownCritical.length} check(s) that matter could not be run: ` +
        unknownCritical.map((finding) => finding.title).join('; '),
    )
  }
  const roundTrip = honeypot?.summary.maxRoundTripLossPct ?? null
  if (roundTrip !== null && roundTrip > 5) {
    blockers.push(
      `a round trip costs ${roundTrip.toFixed(2)}%, which is a guaranteed loss before the price moves`,
    )
  }
  const worstTax = Math.max(tax.buyBps ?? 0, tax.sellBps ?? 0)
  if (worstTax >= 1_000) {
    blockers.push(`transfer tax reaches ${worstTax} bps`)
  }

  const recommendation: 'proceed' | 'do-not-proceed' =
    blockers.length > 0 ? 'do-not-proceed' : 'proceed'
  const recommendationReason =
    blockers.length > 0
      ? `Do not proceed: ${blockers.join('; ')}. ` +
        (fails.length === 0 && roundTrip === null
          ? 'Nothing here proves the token is hostile — but an unrun check is not a reason to ' +
            'buy, and this agent will not treat "we did not look" as "it is fine".'
          : 'That is a decision, not a grade: the evidence above does not support buying this.')
      : `Proceed: every check ran and none failed. ${findings.length} checks, ` +
        `${unknowns.length} unknown. That is the agent's answer, not a deferral — ` +
        'the risks that remain are the ones listed, and they are ordinary ones.'

  const assertions: Assertion[] = [
    assertion(
      'Checks ran against the implementation, not a proxy stub',
      !proxy.isProxy || privileges.codeSize > 200,
      proxy.isProxy
        ? `Proxy resolved to ${target}, ${privileges.codeSize} bytes scanned.`
        : `Not a proxy; ${privileges.codeSize} bytes scanned at ${token}.`,
    ),
    assertion(
      'Every finding carries evidence',
      findings.every((finding) => Object.keys(finding.evidence).length > 0),
      'A finding with no evidence is an opinion.',
    ),
  ]
  const failedAsserts = failedAssertions(assertions)
  if (failedAsserts.length > 0) {
    warnings.push(...failedAsserts.map((check) => `${check.label} failed: ${check.detail}`))
  }

  const decision: SecurityDecision = {
    verdict,
    recommendation,
    recommendationReason,
    headline,
    score,
    token: {
      address: token,
      name: meta.name,
      symbol: meta.symbol,
      decimals: meta.decimals,
      totalSupply: meta.totalSupply?.toString() ?? null,
    },
    analysedContract: target,
    proxy,
    findings,
    economics: {
      liquidityBnb: liquidityBnb?.toString() ?? null,
      liquidityUsd,
      fdvUsd,
      priceBnb,
      roundTripLossPct: honeypot?.summary.maxRoundTripLossPct ?? null,
      detail:
        liquidityUsd === null
          ? 'Liquidity could not be priced, so the economics below are incomplete.'
          : `About $${liquidityUsd.toFixed(0)} of two-sided v2 liquidity` +
            (fdvUsd === null ? '.' : ` against a fully diluted valuation of $${fdvUsd.toFixed(0)}.`) +
            (honeypot?.summary.maxRoundTripLossPct != null
              ? ` A round trip costs ${honeypot.summary.maxRoundTripLossPct.toFixed(2)}%.`
              : ''),
    },
    privileges,
    auxiliary,
    auxiliaryScan,
    tax,
    sourcify,
    honeypot,
    holders,
    lp,
    assertions,
    unknowns,
  }

  const lines = [
    `${meta.symbol} (${meta.name}) at ${token} on ${chain.name}: ` +
      `${recommendation === 'proceed' ? 'PROCEED' : 'DO NOT PROCEED'} (risk grade ${verdict}).`,
    recommendationReason,
    headline,
    proxy.detail,
    ...findings
      .filter((finding) => finding.status !== 'pass')
      .map((finding) => `${finding.status.toUpperCase()} — ${finding.title}: ${finding.detail}`),
    decision.economics.detail,
  ]

  return {
    agent: SECURITY_SLUG,
    skill: opts.deep ? 'report' : 'analyse',
    chainId,
    subject: { token, symbol: meta.symbol, analysedContract: target },
    observedAt: new Date(now * 1000).toISOString(),
    decision,
    facts: {
      metadata: { ...meta, totalSupply: meta.totalSupply?.toString() ?? null },
      proxyEvidence: proxy.evidence,
      privilegeSelectorsChecked: privileges.found.length + privileges.absent.length,
      bnbPrice: bnb,
      pair,
    },
    sources,
    warnings,
    narrative: await narrate({ agent: SECURITY_SLUG, skill: opts.deep ? 'report' : 'analyse', decision, lines }),
  }
}
