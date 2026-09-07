import { Hono } from 'hono'
import type { Context } from 'hono'
import { isSupportedChainId, type SupportedChainId } from '@hallmark/core'

import { AGENTS, findAgent } from './registry.js'
import { publicClientFor } from './chain/clients.js'
import { buildAgentCard, handleA2A } from './runtime/a2a.js'
import { executeIntent } from './runtime/act.js'
import { agentUrls, isPayToConfigured, loadConfig, rpcUrlFor } from './runtime/config.js'
import { invokeSkill, toJsonSafe } from './runtime/invoke.js'
import { handleMcp } from './runtime/mcp.js'
import { altanaExecutor, envSessionProvider } from './runtime/session.js'
import { createDefaultStore, type Store } from './runtime/store.js'
import {
  buildAccept,
  buildChallenge,
  createVerifier,
  decodePaymentHeader,
  encodeChallengeHeader,
  encodePaymentResponseHeader,
  type PaymentVerifier,
} from './runtime/x402.js'
import type {
  ActIntent,
  AgentDefinition,
  Executor,
  RuntimeConfig,
  SessionProvider,
  SkillContext,
} from './runtime/types.js'

/**
 * One service, five agents, three faces each.
 *
 * Route shape, fixed so the ERC-8004 registration files can point at stable
 * URLs from the first registration:
 *
 *   GET  /{agent}/.well-known/agent-card.json   the card
 *   GET  /a2a/{agent}                            the card again — a prober's first guess
 *   POST /a2a/{agent}                            A2A JSON-RPC
 *   POST /mcp/{agent}                            MCP JSON-RPC
 *   ALL  /x402/{agent}[/{skill}]                 the paid endpoint
 *   POST /api/cron/{agent}                       scheduled runs, secret-guarded
 *   GET  /.well-known/agent-card.json            a directory of all five
 *
 * Vercel serves everything from one origin, so five agents cannot each own the
 * true well-known path. The per-agent card lives under the agent's prefix, the
 * origin-level path lists all five, and the A2A endpoint answers a plain GET
 * with its own card — which is what a prober tries first.
 */

export type AppDeps = {
  config?: RuntimeConfig
  store?: Store
  sessions?: SessionProvider
  executor?: Executor
  verifier?: PaymentVerifier
  fetchImpl?: typeof fetch
  now?: () => number
}

export function buildApp(deps: AppDeps = {}) {
  const config = deps.config ?? loadConfig()
  const store = deps.store ?? createDefaultStore()
  const sessions = deps.sessions ?? envSessionProvider()
  const executor = deps.executor ?? altanaExecutor()
  const verifier = deps.verifier ?? createVerifier()
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))

  const app = new Hono()

  app.use('*', async (c, next) => {
    await next()
    c.header('access-control-allow-origin', '*')
    c.header(
      'access-control-allow-headers',
      'content-type, x-payment, payment-signature, authorization',
    )
    c.header('access-control-allow-methods', 'GET, POST, OPTIONS')
    c.header(
      'access-control-expose-headers',
      'payment-required, payment-response, x-payment, x-payment-response, www-authenticate',
    )
  })
  app.options('*', (c) => c.body(null, 204))

  const chainFrom = (raw: string | undefined): SupportedChainId => {
    const parsed = Number(raw)
    return raw !== undefined && isSupportedChainId(parsed) ? parsed : config.defaultChainId
  }

  const contextFor = (chainId: SupportedChainId, agent: AgentDefinition): SkillContext => {
    const context: SkillContext = {
      chainId,
      client: publicClientFor(chainId, rpcUrlFor(config, chainId)),
      fetch: fetchImpl,
      store,
      now,
      session: sessions,
      config,
      execute: async (intent: ActIntent) => {
        const binding = agent.manifest.policy
        if (binding === null) {
          // A read-only agent has no policy and therefore no way to act. This
          // is unreachable through the skills we ship; it exists so that
          // adding a write skill to a read-only agent fails loudly here rather
          // than executing unbounded.
          return {
            status: 'aborted',
            intentId: intent.intentId,
            replayed: false,
            reason: 'not-authorised',
            detail:
              `${agent.manifest.slug} declares no session-key policy, so it has no authority ` +
              'to send anything. Nothing was attempted.',
            evidence: { summary: intent.summary },
            observedAt: new Date(now() * 1000).toISOString(),
          }
        }
        return executeIntent(intent, {
          agentSlug: agent.manifest.slug,
          chainId,
          binding,
          sessions,
          executor,
          store,
          now,
        })
      },
    }
    return context
  }

  // -------------------------------------------------------------------------
  // Service-level
  // -------------------------------------------------------------------------

  app.get('/', (c) =>
    c.json({
      service: 'hallmark-agents',
      version: config.version,
      chainId: config.defaultChainId,
      description:
        'Five BNB Chain agents behind one runtime. Every agent speaks A2A, MCP and x402; every ' +
        'value-moving call goes through an Altana session key with a contract allowlist, a ' +
        'spend cap and an expiry. No agent here holds a user private key.',
      agents: AGENTS.map((agent) => ({
        slug: agent.manifest.slug,
        name: agent.manifest.name,
        category: agent.manifest.category,
        categoryLabel: agent.manifest.categoryLabel,
        card: agentUrls(config, agent.manifest.slug).card,
        a2a: agentUrls(config, agent.manifest.slug).a2a,
        mcp: agentUrls(config, agent.manifest.slug).mcp,
        x402: agentUrls(config, agent.manifest.slug).x402,
        skills: agent.skills.map((skill) => ({
          id: skill.id,
          mode: skill.mode,
          ...(skill.price ? { price: skill.price.display } : {}),
        })),
      })),
    }),
  )

  app.get('/healthz', (c) => c.json({ ok: true, at: new Date(now() * 1000).toISOString() }))

  /** A directory at the origin's well-known path, for probers that start there. */
  app.get('/.well-known/agent-card.json', (c) =>
    c.json({
      type: 'AgentDirectory',
      name: 'Hallmark Agents',
      description:
        'Five agents on one origin. Each has its own card; this document lists where they are, ' +
        'because a single origin cannot serve five different well-known paths.',
      url: config.baseUrl,
      agents: AGENTS.map((agent) => ({
        slug: agent.manifest.slug,
        name: agent.manifest.name,
        category: agent.manifest.category,
        card: agentUrls(config, agent.manifest.slug).card,
        a2a: agentUrls(config, agent.manifest.slug).a2a,
      })),
    }),
  )

  // -------------------------------------------------------------------------
  // Per-agent cards
  // -------------------------------------------------------------------------

  const cardFor = (slug: string, chainId: SupportedChainId) => {
    const agent = findAgent(slug)
    if (!agent) return null
    return buildAgentCard({
      agent,
      config,
      chainId,
      urls: agentUrls(config, slug),
    })
  }

  app.get('/:slug/.well-known/agent-card.json', (c) => {
    const slug = c.req.param('slug')
    const card = cardFor(slug, chainFrom(c.req.query('chainId')))
    return card === null ? notFound(slug, c) : c.json(card)
  })

  // -------------------------------------------------------------------------
  // A2A
  // -------------------------------------------------------------------------

  app.get('/a2a/:slug', (c) => {
    // A prober's first move is a plain GET on the endpoint. Answering with the
    // card there costs nothing and saves it a guess.
    const slug = c.req.param('slug')
    const card = cardFor(slug, chainFrom(c.req.query('chainId')))
    return card === null ? notFound(slug, c) : c.json(card)
  })

  app.post('/a2a/:slug', async (c) => {
    const slug = c.req.param('slug')
    const agent = findAgent(slug)
    if (!agent) return notFound(slug, c)

    const chainId = chainFrom(c.req.query('chainId'))
    const body = await readJson(c)
    const response = await handleA2A(body, {
      agent,
      config,
      chainId,
      urls: agentUrls(config, slug),
      context: contextFor(chainId, agent),
    })
    return c.json(toJsonSafe(response) as object)
  })

  // -------------------------------------------------------------------------
  // MCP
  // -------------------------------------------------------------------------

  app.get('/mcp/:slug', (c) => {
    const slug = c.req.param('slug')
    const agent = findAgent(slug)
    if (!agent) return notFound(slug, c)
    return c.json({
      transport: 'JSON-RPC over HTTP POST',
      protocolVersion: '2025-06-18',
      endpoint: agentUrls(config, slug).mcp,
      hint: 'POST an `initialize` request here, then `tools/list`.',
    })
  })

  app.post('/mcp/:slug', async (c) => {
    const slug = c.req.param('slug')
    const agent = findAgent(slug)
    if (!agent) return notFound(slug, c)

    const chainId = chainFrom(c.req.query('chainId'))
    const body = await readJson(c)
    const response = await handleMcp(body, {
      agent,
      config,
      chainId,
      urls: agentUrls(config, slug),
      context: contextFor(chainId, agent),
    })
    // A notification gets 202 and an empty body, per JSON-RPC.
    if (response === null) return c.body(null, 202)
    return c.json(toJsonSafe(response) as object)
  })

  // -------------------------------------------------------------------------
  // x402
  // -------------------------------------------------------------------------

  const x402Handler = async (c: Context) => {
    const slug = c.req.param('slug') ?? ''
    const agent = findAgent(slug)
    if (!agent) return notFound(slug, c)

    const chainId = chainFrom(c.req.query('chainId'))
    const requested = c.req.param('skill') ?? undefined
    const skill =
      requested === undefined
        ? agent.skills.find((entry) => entry.price !== undefined)
        : agent.skills.find((entry) => entry.id === requested)

    if (!skill) {
      return c.json(
        {
          error: 'unknown-skill',
          message: `${slug} has no skill "${requested}"`,
          skills: agent.skills.map((entry) => entry.id),
        },
        404,
      )
    }
    if (!skill.price) {
      return c.json(
        {
          error: 'not-a-paid-skill',
          message:
            `${slug}.${skill.id} is free. Call it over A2A or MCP; the x402 face serves the ` +
            'priced skills only.',
          free: { a2a: agentUrls(config, slug).a2a, mcp: agentUrls(config, slug).mcp },
        },
        400,
      )
    }

    const resource = `${agentUrls(config, slug).x402}/${skill.id}`
    const accept = buildAccept({ skill, manifest: agent.manifest, chainId, config, resource })!

    if (!isPayToConfigured(config)) {
      // Quoting a challenge that pays to the zero address would burn a payer's
      // money. Refusing is the only honest answer.
      return c.json(
        {
          error: 'x402-unconfigured',
          message:
            'This deployment has no X402_PAY_TO address set, so it cannot quote a payment ' +
            'destination. Refusing to issue a challenge that would send funds to the zero ' +
            'address.',
        },
        503,
      )
    }

    // v2 sends `payment-signature`; v1 sent `X-PAYMENT`. Both are read, and
    // header names are matched lowercased.
    const payment = decodePaymentHeader(
      c.req.header('payment-signature'),
      c.req.header('x-payment'),
    )

    // The v2 402 carries the challenge in a header and an empty body; the v1
    // `x-payment` header is emitted alongside for older payers. Neither costs
    // the other anything, and a payer that reads only one still sees it.
    const challenge402 = (error: string, retryable?: boolean) => {
      const challenge = buildChallenge({
        accepts: [accept],
        resource,
        description: `${skill.name} — ${skill.description}`,
        error,
      })
      const encoded = encodeChallengeHeader(challenge)
      c.header('payment-required', encoded)
      c.header('x-payment', encoded)
      c.header('www-authenticate', 'Payment')
      if (retryable !== undefined) c.header('x-payment-retryable', String(retryable))
      return c.json({}, 402)
    }

    if (payment === null) {
      return challenge402(
        `${skill.name} costs ${skill.price.display}. The challenge is in the payment-required ` +
          'header; sign it and retry with a payment-signature header.',
      )
    }

    const verification = await verifier.verify({ payment, accept, resource })
    if (!verification.ok) {
      return challenge402(`Payment not accepted: ${verification.reason}`, verification.retryable)
    }

    const input =
      c.req.method === 'GET'
        ? Object.fromEntries(new URL(c.req.url).searchParams.entries())
        : await readJson(c)

    const result = await invokeSkill(agent, skill.id, stripControlParams(input), contextFor(chainId, agent))
    if (!result.ok) {
      return c.json(
        {
          error: result.code,
          message: result.message,
          ...(result.code === 'invalid-input' ? { errors: result.errors } : {}),
        },
        result.code === 'invalid-input'
          ? 400
          : result.code === 'unknown-skill'
            ? 404
            : result.code === 'timeout'
              ? 504
              : 500,
      )
    }

    const receipt = encodePaymentResponseHeader({
      x402Version: 2,
      success: true,
      settled: verification.detail,
      ...(verification.txHash ? { transaction: verification.txHash } : {}),
      ...(verification.payer ? { payer: verification.payer } : {}),
    })
    c.header('payment-response', receipt)
    c.header('x-payment-response', receipt)
    return c.json(result.output as object)
  }

  app.all('/x402/:slug', x402Handler)
  app.all('/x402/:slug/:skill', x402Handler)

  // -------------------------------------------------------------------------
  // Scheduled runs
  // -------------------------------------------------------------------------

  /**
   * The cron face.
   *
   * Guarded by a shared secret, and — this is the important half — it *refuses*
   * when no secret is configured rather than running open. An unauthenticated
   * endpoint that can move money is not a convenience.
   */
  const cronHandler = async (c: Context) => {
    const slug = c.req.param('slug') ?? ''
    const agent = findAgent(slug)
    if (!agent) return notFound(slug, c)

    if (config.cronSecret === null) {
      return c.json(
        {
          error: 'cron-unconfigured',
          message:
            'No CRON_SECRET is set for this deployment, so the scheduled endpoint refuses every ' +
            'request. It does not fall back to running unauthenticated.',
        },
        503,
      )
    }

    const header = c.req.header('authorization') ?? ''
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : c.req.header('x-cron-secret')
    if (bearer !== config.cronSecret) {
      return c.json({ error: 'unauthorised', message: 'Bad or missing cron secret.' }, 401)
    }

    const chainId = chainFrom(c.req.query('chainId'))
    const body = await readJson(c)
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    const skillId = typeof record['skill'] === 'string' ? record['skill'] : 'watch'
    const input = record['input'] ?? {}

    const result = await invokeSkill(agent, skillId, input, contextFor(chainId, agent))
    if (!result.ok) {
      return c.json(
        {
          error: result.code,
          message: result.message,
          ...(result.code === 'invalid-input' ? { errors: result.errors } : {}),
        },
        result.code === 'invalid-input' ? 400 : result.code === 'timeout' ? 504 : 404,
      )
    }
    return c.json(result.output as object)
  }

  app.all('/api/cron/:slug', cronHandler)

  app.notFound((c) =>
    c.json(
      {
        error: 'not-found',
        message: `No route for ${c.req.method} ${new URL(c.req.url).pathname}`,
        agents: AGENTS.map((agent) => agentUrls(config, agent.manifest.slug).card),
      },
      404,
    ),
  )

  app.onError((error, c) =>
    c.json(
      {
        error: 'internal',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    ),
  )

  return app
}

function notFound(slug: string, c: Context): Response {
  return c.json(
    {
      error: 'unknown-agent',
      message: `No agent "${slug}" on this service.`,
      agents: AGENTS.map((agent) => agent.manifest.slug),
    },
    404,
  )
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    return {}
  }
}

/** Query params that steer the transport, not the skill. */
function stripControlParams(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const { chainId: _chainId, ...rest } = input as Record<string, unknown>
  return 'chainId' in (input as Record<string, unknown>) && _chainId !== undefined
    ? { ...rest, chainId: Number(_chainId) }
    : rest
}
