import type { AgentDefinition, AgentSkill, SkillContext } from './types.js'
import { validate } from './schema.js'
import { messageOf } from './jsonrpc.js'

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

export async function invokeSkill(
  agent: AgentDefinition,
  skillId: string,
  rawInput: unknown,
  ctx: SkillContext,
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

  try {
    const output = await skill.run(parsed.value, ctx)
    return { ok: true, skill, output: toJsonSafe(output) }
  } catch (error) {
    // A throw from a skill is a bug in this service, not a user error — the
    // expected negatives (a refusal, a stale feed, no session) are all values.
    return { ok: false, code: 'failed', message: messageOf(error) }
  }
}
