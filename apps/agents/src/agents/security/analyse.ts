import { getChain, isSupportedChainId, type SupportedChainId } from '@hallmark/core'
import type { Address, Hex } from 'viem'

import { ownableAbi, PANCAKE_V2_FACTORY, WBNB, pancakeV2FactoryAbi, pancakeV2PairAbi } from '../../chain/abis.js'
import { analysisTarget, detectProxy, type ProxyDetection } from '../../chain/proxy.js'
import { scanPrivileges, type PrivilegeScan } from '../../chain/privileges.js'
import { simulateRoundTrip, type HoneypotResult } from '../../chain/honeypot.js'
import { scanHolders, scanLpLock, type HolderScan, type LpLockScan } from '../../chain/holders.js'
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
  verdict: 'go' | 'caution' | 'no-go'
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
  findings.push({
    id: 'source-verification',
    title: 'Source verification not checked',
    status: 'unknown',
    severity: 'low',
    detail:
      'Etherscan\'s V2 API answers "Free API access is not supported for this chain" for BNB ' +
      'Chain (56 and 97), so there is no keyless way to confirm verified source. This check is ' +
      'reported unknown rather than guessed; set BSCSCAN_API_KEY to enable it. Note that every ' +
      'check above reads bytecode directly and does not need the source.',
    evidence: {
      explorer: `${chain.explorer}/address/${target}#code`,
      keyConfigured: ctx.config.bscscanApiKey !== null,
    },
  })
  unknowns.push('verified source')

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
    unknowns.push('sellability (not run on the free tier)')
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
    honeypot,
    holders,
    lp,
    assertions,
    unknowns,
  }

  const lines = [
    `${meta.symbol} (${meta.name}) at ${token} on ${chain.name}: ${verdict.toUpperCase()}.`,
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
