/**
 * The proof run.
 *
 * Boots the real service in-process and exercises every face against live BNB
 * Chain mainnet: the five agent cards, an MCP `initialize` + `tools/list`
 * round trip, an unpaid x402 request, and each agent's `analyse` against a
 * real subject.
 *
 * Read-only throughout. No transaction is sent, no key is loaded, and the
 * session provider is the one that always answers "none granted", so an `act`
 * reached from here can only ever return `aborted / no-session`.
 *
 *   pnpm prove                      # everything
 *   pnpm prove -- cards mcp x402    # a subset
 */
import { buildApp } from '../src/app.js'
import { AGENTS } from '../src/registry.js'
import { loadConfig } from '../src/runtime/config.js'
import { createMemoryStore } from '../src/runtime/store.js'
import { noSessionProvider } from '../src/runtime/session.js'
import { invokeSkill } from '../src/runtime/invoke.js'
import { publicClientFor } from '../src/chain/clients.js'
import { securityAgent } from '../src/agents/security/index.js'
import type { SkillContext } from '../src/runtime/types.js'

const BASE = 'http://proof.local'
const config = {
  ...loadConfig({ PUBLIC_BASE_URL: BASE, X402_PAY_TO: '0x1111111111111111111111111111111111111111' }),
}
const app = buildApp({ config, store: createMemoryStore(), sessions: noSessionProvider() })

const only = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
const want = (section: string) => only.length === 0 || only.includes(section)

function rule(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

async function call(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`${BASE}${path}`, init))
}

async function json(path: string, init?: RequestInit): Promise<unknown> {
  const res = await call(path, init)
  return res.json()
}

function rpc(method: string, params: unknown, id: number): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }
}

// --- 1. agent cards ---------------------------------------------------------
if (want('cards')) {
  rule('1. /{agent}/.well-known/agent-card.json — all five')
  for (const agent of AGENTS) {
    const slug = agent.manifest.slug
    const res = await call(`/${slug}/.well-known/agent-card.json`)
    const card = (await res.json()) as Record<string, unknown>
    const skills = card['skills'] as Array<{ id: string; pricing?: { display: string } }>
    const services = card['services'] as Array<{ name: string; endpoint: string }>
    console.log(
      `\n${slug}  HTTP ${res.status}  ${card['name']}\n` +
        `  protocolVersion ${card['protocolVersion']}   x402Support ${card['x402Support']}   active ${card['active']}\n` +
        `  skills (${skills.length}): ${skills.map((s) => s.id + (s.pricing ? ` [${s.pricing.display}]` : '')).join(', ')}\n` +
        `  services: ${services.map((s) => `${s.name}=${s.endpoint}`).join('  ')}\n` +
        `  registrations: ${JSON.stringify(card['registrations'])}`,
    )
  }

  rule('1b. GET on the A2A endpoint returns the card, not a landing page')
  const res = await call('/a2a/health')
  const card = (await res.json()) as Record<string, unknown>
  console.log(
    `GET /a2a/health -> HTTP ${res.status}, content-type ${res.headers.get('content-type')}\n` +
      `  type=${card['type']}  name=${card['name']}  skills=${(card['skills'] as unknown[]).length}`,
  )
}

// --- 2. MCP -----------------------------------------------------------------
if (want('mcp')) {
  rule('2. MCP initialize + tools/list (protocol 2025-06-18)')
  const init = await json(
    '/mcp/security',
    rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'proof', version: '1' } }, 1),
  )
  console.log('initialize ->', JSON.stringify(init, null, 2))

  const notified = await call('/mcp/security', rpc('notifications/initialized', {}, 0))
  console.log(`notifications/initialized -> HTTP ${notified.status} (no body, per JSON-RPC)`)

  const tools = (await json('/mcp/security', rpc('tools/list', {}, 2))) as {
    result: { tools: Array<{ name: string; annotations: Record<string, unknown> }> }
  }
  console.log(
    'tools/list ->',
    JSON.stringify(
      tools.result.tools.map((tool) => ({ name: tool.name, readOnly: tool.annotations['readOnlyHint'] })),
      null,
      2,
    ),
  )
}

// --- 3. x402 ----------------------------------------------------------------
if (want('x402')) {
  rule('3. Unpaid x402 request — the real 402 challenge')
  const res = await call('/x402/security/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: '0xc255d8b48eFbCE2Cb821A28517678aE685587777' }),
  })
  const header = res.headers.get('payment-required')
  console.log(`POST /x402/security/report (no payment) -> HTTP ${res.status}`)
  console.log(`  body: ${JSON.stringify(await res.json())}   (v2 carries the challenge in a header)`)
  console.log(`  www-authenticate: ${res.headers.get('www-authenticate')}`)
  console.log(`  payment-required: ${header?.slice(0, 72)}…`)
  console.log(
    '  decoded:',
    JSON.stringify(JSON.parse(Buffer.from(header ?? '', 'base64').toString('utf8')), null, 2),
  )

  const bad = await call('/x402/security/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'payment-signature': Buffer.from('{"scheme":"exact"}').toString('base64') },
    body: JSON.stringify({ token: '0xc255d8b48eFbCE2Cb821A28517678aE685587777' }),
  })
  const badChallenge = JSON.parse(
    Buffer.from(bad.headers.get('payment-required') ?? '', 'base64').toString('utf8'),
  ) as { error: string }
  console.log(`\nWith an unverifiable payment -> HTTP ${bad.status}: ${badChallenge.error}`)
}

// --- 4. live analyse --------------------------------------------------------
const subjects = {
  position: process.env['PROOF_POSITION'] ?? '6888460',
  borrower: process.env['PROOF_BORROWER'] ?? '0x5EF4876b6439da23D341d7CC3aF53466bE48970D',
  token: process.env['PROOF_TOKEN'] ?? '0xc255d8b48eFbCE2Cb821A28517678aE685587777',
}

async function analyse(slug: string, input: unknown, skill = 'analyse'): Promise<unknown> {
  const body = (await json(`/a2a/${slug}`, rpc('message/send', { skillId: skill, input }, 9))) as {
    result?: { parts: Array<{ data: { result: unknown } }> }
    error?: unknown
  }
  return body.result?.parts[0]?.data.result ?? body.error
}

if (want('analyse')) {
  rule(`4a. rebalancer.analyse — live PancakeSwap v3 position #${subjects.position}`)
  const rebalance = (await analyse('rebalancer', {
    tokenId: subjects.position,
    driftToleranceBps: 200,
  })) as Record<string, any>
  console.log(
    JSON.stringify(
      {
        subject: rebalance['subject'],
        blockNumber: rebalance['blockNumber'],
        decision: {
          action: rebalance['decision']?.action,
          urgency: rebalance['decision']?.urgency,
          reason: rebalance['decision']?.reason,
          current: rebalance['decision']?.current,
          proposed: rebalance['decision']?.proposed,
          valueUsd: rebalance['decision']?.value?.totalUsd,
          cost: rebalance['decision']?.cost && {
            gasTotal: rebalance['decision'].cost.gasTotal,
            gasCostUsd: rebalance['decision'].cost.gasCostUsd,
            swap: rebalance['decision'].cost.swap?.detail,
          },
          checks: rebalance['decision']?.checks?.map((c: any) => c.detail),
          checksPass: rebalance['decision']?.checksPass,
          blocking: rebalance['decision']?.preconditions?.blocking,
        },
        sources: rebalance['sources']?.map((s: any) => `${s.label}: ${s.detail}`),
        narrative: rebalance['narrative'],
      },
      null,
      2,
    ),
  )

  rule('4b. grid.analyse — a fresh grid over the WBNB/USDT 0.05% pool')
  // The pool sorts USDT first, so its price is WBNB per USDT — not the 600-900
  // a human thinks in. A band written the other way round is caught by the
  // orientation assertion rather than sitting there never triggering; see
  // `4b-inverted` below.
  const grid = (await analyse('grid', {
    gridId: 'proof-bnb-usdt',
    token0: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    token1: '0x55d398326f99059fF775485246999027B3197955',
    fee: 500,
    lowerPrice: 0.00120,
    upperPrice: 0.00160,
    levels: 13,
    sizePerLevel: '0.05',
  })) as Record<string, any>
  console.log(
    JSON.stringify(
      {
        subject: grid['subject'],
        price: grid['decision']?.price,
        inBand: grid['decision']?.inBand,
        step: grid['decision']?.step,
        action: grid['decision']?.action,
        filled: grid['decision']?.filled,
        checks: grid['decision']?.checks?.map((c: any) => c.detail),
        assertions: grid['decision']?.assertions?.map((c: any) => `${c.holds ? 'OK' : 'FAIL'} ${c.label}`),
        narrative: grid['narrative'],
      },
      null,
      2,
    ),
  )

  rule('4b-inverted. the same grid with the band written the wrong way round')
  const inverted = (await analyse('grid', {
    gridId: 'proof-bnb-usdt-inverted',
    token0: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    token1: '0x55d398326f99059fF775485246999027B3197955',
    fee: 500,
    lowerPrice: 600,
    upperPrice: 900,
    levels: 13,
    sizePerLevel: '50',
  })) as Record<string, any>
  console.log(
    JSON.stringify(
      {
        checksPass: inverted['decision']?.checksPass,
        caught: inverted['decision']?.assertions?.find((c: any) => !c.holds)?.detail,
      },
      null,
      2,
    ),
  )

  rule('4c. yield.analyse — 5,000 USDT across BNB Chain venues')
  const yields = (await analyse('yield', { asset: 'USDT', amount: '5000' })) as Record<string, any>
  console.log(
    JSON.stringify(
      {
        best: yields['decision']?.best && {
          name: yields['decision'].best.name,
          apyPct: yields['decision'].best.apyPct,
          depositsUsd: yields['decision'].best.depositsUsd,
          availableLiquidityUsd: yields['decision'].best.availableLiquidityUsd,
          depthSource: yields['decision'].best.depthSource,
          caveats: yields['decision'].best.caveats,
        },
        venues: yields['decision']?.venues?.slice(0, 6).map((v: any) => ({
          name: v.name,
          apyPct: v.apyPct,
          depositsUsd: v.depositsUsd,
          availableLiquidityUsd: v.availableLiquidityUsd,
          depthSource: v.depthSource,
        })),
        breakEven: yields['decision']?.breakEven,
        checks: yields['decision']?.checks?.map((c: any) => c.detail),
        narrative: yields['narrative'],
      },
      null,
      2,
    ),
  )

  rule(`4d. health.analyse — live Venus borrower ${subjects.borrower}`)
  const health = (await analyse('health', { borrower: subjects.borrower })) as Record<string, any>
  console.log(
    JSON.stringify(
      {
        subject: health['subject'],
        blockNumber: health['blockNumber'],
        decision: {
          action: health['decision']?.action,
          urgency: health['decision']?.urgency,
          reason: health['decision']?.reason,
          healthFactor: health['decision']?.healthFactor,
          totals: health['decision']?.totals,
          markets: health['decision']?.markets,
          liquidation: health['decision']?.liquidation,
          repay: health['decision']?.repay?.ok && {
            amount: health['decision'].repay.repayUnderlying,
            usd: health['decision'].repay.repayUsd,
            projected: health['decision'].repay.projectedHealthFactor,
            cappedBy: health['decision'].repay.cappedBy,
          },
          feeds: health['decision']?.feeds,
          checks: health['decision']?.checks?.map((c: any) => c.detail),
          failClosed: health['decision']?.failClosed,
        },
        narrative: health['narrative'],
      },
      null,
      2,
    ),
  )

  rule(`4e. security.analyse — live token ${subjects.token}`)
  const security = (await analyse('security', { token: subjects.token })) as Record<string, any>
  console.log(
    JSON.stringify(
      {
        verdict: security['decision']?.verdict,
        headline: security['decision']?.headline,
        analysedContract: security['decision']?.analysedContract,
        proxy: {
          kind: security['decision']?.proxy?.kind,
          proxyCodeSize: security['decision']?.proxy?.proxyCodeSize,
          implementationCodeSize: security['decision']?.proxy?.implementationCodeSize,
        },
        findings: security['decision']?.findings?.map((f: any) => `${f.status.toUpperCase()} ${f.id}: ${f.title}`),
        economics: security['decision']?.economics,
        unknowns: security['decision']?.unknowns,
      },
      null,
      2,
    ),
  )
}

// --- 5. the paid report, which runs the simulation ---------------------------
if (want('honeypot')) {
  rule(`5. security.report — the buy/sell simulation on ${subjects.token}`)
  // `report` is the priced skill, so the A2A face answers 402 rather than
  // serving it. This calls the same handler the x402 face invokes once a
  // payment verifies — the code path is identical, the payment is not
  // simulated, and nothing here is presented as having been paid for.
  const store = createMemoryStore()
  const proofContext: SkillContext = {
    chainId: 56,
    client: publicClientFor(56),
    fetch,
    store,
    now: () => Math.floor(Date.now() / 1000),
    session: noSessionProvider(),
    config,
    execute: async () => {
      throw new Error('the proof harness never executes')
    },
  }
  const invoked = await invokeSkill(
    securityAgent,
    'report',
    { token: subjects.token, holderWindowBlocks: 20000 },
    proofContext,
  )
  const deep = (invoked.ok ? invoked.output : invoked) as Record<string, any>
  console.log(
    JSON.stringify(
      {
        verdict: deep['verdict'] ?? deep['decision']?.verdict,
        honeypot: deep['decision']?.honeypot,
        holders: deep['decision']?.holders && {
          coverage: deep['decision'].holders.coverage,
          logsSeen: deep['decision'].holders.logsSeen,
          top10ConcentrationPct: deep['decision'].holders.top10ConcentrationPct,
          top: deep['decision'].holders.top?.slice(0, 5),
        },
        economics: deep['decision']?.economics,
        error: deep['error'],
      },
      null,
      2,
    ),
  )
}

// --- 6. act with no session -------------------------------------------------
if (want('act')) {
  rule('6. act with no session key granted — the refusal, with the plan it would have sent')
  const acted = await analyse(
    'health',
    { borrower: subjects.borrower, intentId: 'proof-run-1' },
    'act',
  )
  const record = acted as Record<string, any>
  console.log(
    JSON.stringify(
      {
        status: record['status'],
        reason: record['reason'],
        detail: record['detail'],
        evidenceKeys: Object.keys(record['evidence'] ?? {}),
      },
      null,
      2,
    ),
  )
}

console.log('\nProof run complete. No transaction was sent and no key was loaded.')
