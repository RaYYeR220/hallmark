import type { AgentDefinition, AgentSkill, SkillContext } from './types.js'
import { validate } from './schema.js'
import { messageOf } from './jsonrpc.js'
import { loadTimeouts, withDeadline } from './deadline.js'

/**
 * One place where a skill actually runs.
 *
 * All three faces land here, so validation, error shape and the JSON-safety
 * pass are identical whether a caller arrived over A2A, MCP or x402. A face
 * that did its own coercion would be a face where an input means something
 * slightly different, which is exactly the kind of divergence that turns into
 * a wrong on-chain amount.
 */

export type InvokeResult =
  | { ok: true; skill: AgentSkill; output: unknown }
  | { ok: false; code: 'unknown-skill'; message: string; known: string[] }
  | { ok: false; code: 'invalid-input'; message: string; errors: string[] }
  | { ok: false; code: 'failed'; message: string }
  | { ok: false; code: 'timeout'; message: string; timeoutMs: number }

export function findSkill(agent: AgentDefinition, skillId: string): AgentSkill | undefined {
  return agent.skills.find((skill) => skill.id === skillId)
}

/**
 * `bigint` is the only value viem hands back that `JSON.stringify` throws on,
 * and an agent that computes in wei produces plenty. Converting to a decimal
 * string keeps precision; converting to Number would silently lose it above
 * 2^53, which for wei amounts is most of them.
 */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (value instanceof Date) return value.toISOString()
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonSafe(item)
    }
    return out
  }
  return value
}

export type InvokeOptions = {
  /** Milliseconds a single skill may run for. Defaults to the configured skill timeout. */
  timeoutMs?: number
}

export async function invokeSkill(
  agent: AgentDefinition,
  skillId: string,
  rawInput: unknown,
  ctx: SkillContext,
  opts: InvokeOptions = {},
): Promise<InvokeResult> {
  const skill = findSkill(agent, skillId)
  if (!skill) {
    return {
      ok: false,
      code: 'unknown-skill',
      message: `${agent.manifest.slug} has no skill "${skillId}"`,
      known: agent.skills.map((entry) => entry.id),
    }
  }

  const parsed = validate(skill.input, rawInput)
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'invalid-input',
      message: `Invalid input for ${agent.manifest.slug}.${skillId}`,
      errors: parsed.errors,
    }
  }

  // A skill reads the chain, and a chain read can stall. Every transport here
  // carries its own timeout, but a deadline on the whole invocation is what
  // guarantees the face answers even when something below it does not — and a
  // face that answers slowly is scored alive, where one that hangs is not.
  const timeoutMs = opts.timeoutMs ?? loadTimeouts().skill

  let ran
  try {
    ran = await withDeadline(Promise.resolve(skill.run(parsed.value, ctx)), {
      label: `${agent.manifest.slug}.${skillId}`,
      timeoutMs,
    })
  } catch (error) {
    // A throw from a skill is a bug in this service, not a user error — the
    // expected negatives (a refusal, a stale feed, no session) are all values.
    return { ok: false, code: 'failed', message: messageOf(error) }
  }

  if (!ran.ok) {
    return {
      ok: false,
      code: 'timeout',
      timeoutMs,
      message:
        `${agent.manifest.slug}.${skillId} did not finish within ${timeoutMs}ms. Nothing was ` +
        'sent: this is a read that stalled, and the skill was abandoned rather than left to ' +
        'hold the request open.',
    }
  }

  return { ok: true, skill, output: toJsonSafe(ran.value) }
}
