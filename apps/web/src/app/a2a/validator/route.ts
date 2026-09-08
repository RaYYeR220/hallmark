import { randomUUID } from 'node:crypto'

import {
  RPC_ERRORS,
  VALIDATOR_SKILLS,
  buildValidatorCard,
  extractInvocation,
  parseRpc,
  rpcError,
  rpcResult,
  runSkill,
} from '@/lib/validator/service'

/**
 * The Hallmark validator's A2A face.
 *
 * `GET` returns the agent card. That is not a convenience: a prober's first
 * move against an A2A endpoint is a plain GET, and an endpoint that answers a
 * GET with 405 is indistinguishable from a dead one at the point where the
 * decision gets made. Hallmark's own prober does exactly this to 12,403 agents
 * on mainnet, so our endpoint has to survive the same test.
 *
 * `POST` speaks A2A JSON-RPC: `agent/card`, `agent/skills`, `message/send`.
 * Every skill completes in one round trip, so `message/send` answers with a
 * Message rather than inventing a Task lifecycle for work that is already
 * done, and `tasks/get` says so instead of returning an empty task.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
} as const

function json(body: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, ...CORS },
  })
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS })
}

export function GET(): Response {
  // The card changes only on deploy, so it is cacheable — but briefly, because
  // a stale card is how an integrator ends up calling a skill that moved.
  return json(buildValidatorCard(), 200, 'public, max-age=0, s-maxage=300')
}

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null)
  if (body === null) {
    return json(rpcError(null, RPC_ERRORS.PARSE_ERROR, 'Body must be JSON'), 400)
  }

  const parsed = parseRpc(body)
  if (!parsed.ok) return json(parsed.response, 400)

  const { method, params, id } = parsed

  switch (method) {
    case 'agent/card':
    case 'agent/getAuthenticatedExtendedCard':
      return json(rpcResult(id, buildValidatorCard()))

    case 'agent/skills':
      return json(
        rpcResult(
          id,
          VALIDATOR_SKILLS.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            mode: 'read',
            inputSchema: skill.inputSchema,
          })),
        ),
      )

    case 'message/stream':
      return json(
        rpcError(
          id,
          RPC_ERRORS.METHOD_NOT_FOUND,
          'This agent does not advertise streaming; use message/send.',
        ),
      )

    case 'message/send': {
      const invocation = extractInvocation(params)
      if (!invocation.ok) {
        return json(
          rpcError(id, RPC_ERRORS.INVALID_PARAMS, invocation.message, {
            skills: VALIDATOR_SKILLS.map((skill) => skill.id),
          }),
        )
      }

      const result = await runSkill(invocation.skill, invocation.input)
      if (!result.ok) {
        const code =
          result.code === 'unknown-skill'
            ? RPC_ERRORS.METHOD_NOT_FOUND
            : result.code === 'invalid-input'
              ? RPC_ERRORS.INVALID_PARAMS
              : RPC_ERRORS.INTERNAL_ERROR
        return json(rpcError(id, code, result.message))
      }

      return json(
        rpcResult(id, {
          kind: 'message',
          role: 'agent',
          messageId: randomUUID(),
          parts: [{ kind: 'data', data: { skill: invocation.skill, result: result.output } }],
          metadata: { agent: 'validator', skill: invocation.skill },
        }),
      )
    }

    case 'tasks/get':
      return json(
        rpcError(
          id,
          RPC_ERRORS.METHOD_NOT_FOUND,
          'This agent completes every skill in one round trip and creates no tasks.',
        ),
      )

    default:
      return json(
        rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown A2A method "${method}"`, {
          supported: ['message/send', 'agent/card', 'agent/skills'],
        }),
      )
  }
}
