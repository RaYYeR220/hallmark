import { getAgentDetail } from '@/lib/agents'
import { parseAgentId, parseChainId } from '@/lib/chain'
import { preflightHire } from '@/lib/hire'

/**
 * `GET /api/agents/:chainId/:agentId` — everything the detail page renders.
 *
 * The on-chain read, the parsed registration file with its warnings, the
 * reputation and validation records, Hallmark's own evidence, and the live
 * answer to "would the escrow fund a job for this agent right now".
 *
 * `?preflight=false` skips that last call when a consumer only wants the card.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ chainId: string; agentId: string }> }

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { chainId: chainRaw, agentId: agentRaw } = await context.params
  const chainId = parseChainId(chainRaw)
  const agentId = parseAgentId(agentRaw)

  if (chainId === null) {
    return json(400, {
      error: 'unsupported-chain',
      detail: 'Hallmark reads BNB Smart Chain (56) and BNB testnet (97).',
    })
  }
  if (agentId === null) {
    return json(400, { error: 'invalid-agent-id', detail: 'Agent ids are positive integers.' })
  }

  const wantsPreflight = new URL(request.url).searchParams.get('preflight') !== 'false'

  try {
    const [detail, preflight] = await Promise.all([
      getAgentDetail(chainId, agentId),
      wantsPreflight ? preflightHire(chainId, agentId) : Promise.resolve(null),
    ])

    if (detail === null) {
      return json(404, {
        error: 'unknown-agent',
        detail:
          `Agent #${agentId} does not exist on chain ${chainId}: ownerOf reverted and the index ` +
          'has no row for it either.',
      })
    }

    return json(200, {
      chainId: detail.chainId,
      agentId: detail.agentId,
      owner: detail.owner,
      name: detail.name,
      description: detail.description,
      image: detail.image,
      active: detail.active,
      x402: detail.x402,
      supportedTrust: detail.supportedTrust,
      registration: {
        tokenUri: detail.tokenUri,
        kind: detail.cardKind,
        card: detail.card,
        // Printed rather than swallowed: how a card had to be bent to be read
        // is information about the agent.
        warnings: detail.cardWarnings,
        error: detail.cardError,
      },
      endpoints: detail.endpoints,
      declaresEndpoint: detail.declaresEndpoint,
      evidence: detail.evidence,
      hallmark: detail.hallmark,
      gate: detail.hookConfig,
      reputation: {
        clients: detail.reputation.clients,
        byTag: detail.reputation.byTag,
        feedback: detail.reputation.feedback,
      },
      validations: detail.validations,
      index: {
        endpointVerified: detail.index.endpointVerified,
        endpointVerifiedDomain: detail.index.endpointVerifiedDomain,
        endpointCheckedAt: detail.index.endpointCheckedAt,
        endpointError: detail.index.endpointError,
        health: detail.index.health,
        services: detail.index.services,
        parseWarnings: detail.index.parseWarnings,
        createdTxHash: detail.index.createdTxHash,
      },
      categories: detail.categories,
      hireable: preflight === null ? null : preflight.hireable,
      refusal: preflight?.refusal ?? null,
      notices: detail.notices,
      fetchedAt: detail.fetchedAt,
      href: `/agents/${detail.chainId}/${detail.agentId}`,
    })
  } catch (error) {
    return json(502, {
      error: 'read-failed',
      detail: error instanceof Error ? error.message : 'The chain read failed.',
    })
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, bigintSafe, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? 'public, max-age=0, s-maxage=15' : 'no-store',
      'access-control-allow-origin': '*',
    },
  })
}

function bigintSafe(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}
