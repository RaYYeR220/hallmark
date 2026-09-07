/**
 * Where a language model is allowed to be.
 *
 * Nowhere near a decision. Addresses, amounts, selectors, ranges and
 * thresholds are computed by the code in `src/agents/*` and `src/chain/*` from
 * chain reads, and nothing else may produce them.
 *
 * A model may do exactly one thing here: turn a *finished* decision into
 * sentences. It is handed the decision object and the deterministic lines the
 * agent already wrote, and its output goes into one field — `Analysis.narrative`
 * — which nothing downstream reads. `act` takes an `ActInput`; there is no
 * narrative on it, so there is no path from prose to calldata even if a
 * narrator were compromised.
 *
 * That is the structural guarantee. On top of it, `narrate` enforces a cheap
 * runtime one: any 0x address in the output must already appear in the
 * decision. A narrator that invents an address gets discarded, and the
 * deterministic lines ship instead. The test suite drives exactly that case.
 */

export type NarrativeInput = {
  agent: string
  skill: string
  /** The finished decision. Read-only input; never mutated. */
  decision: unknown
  /** The sentences the agent computed itself. Always a valid answer. */
  lines: string[]
}

export type Narrator = {
  name: string
  narrate: (input: NarrativeInput) => string[] | Promise<string[]>
}

/** The default and the fallback: the agent's own sentences, unchanged. */
export const deterministicNarrator: Narrator = {
  name: 'deterministic',
  narrate: (input) => input.lines,
}

let active: Narrator = deterministicNarrator

export function setNarrator(next: Narrator | null): void {
  active = next ?? deterministicNarrator
}

export function currentNarrator(): Narrator {
  return active
}

const ADDRESS_RE = /0x[0-9a-fA-F]{40}/g
const MAX_LINES = 12
const MAX_LINE_CHARS = 400

/**
 * Run the narrator, and refuse anything it invents.
 *
 * Failure here is never fatal and never silent: a throw, a bad shape or an
 * unknown address all fall back to the deterministic lines and say so in the
 * returned copy.
 */
export async function narrate(input: NarrativeInput): Promise<string[]> {
  const narrator = active
  if (narrator === deterministicNarrator) return input.lines

  let produced: string[]
  try {
    const result = await narrator.narrate({ ...input, decision: freeze(input.decision) })
    if (!Array.isArray(result) || result.some((line) => typeof line !== 'string')) {
      return [...input.lines, `(narrator "${narrator.name}" returned a non-string list; discarded)`]
    }
    produced = result
  } catch (error) {
    return [
      ...input.lines,
      `(narrator "${narrator.name}" threw: ${
        error instanceof Error ? error.message : String(error)
      }; discarded)`,
    ]
  }

  const decisionText = safeStringify(input.decision).toLowerCase()
  for (const line of produced) {
    for (const address of line.match(ADDRESS_RE) ?? []) {
      if (!decisionText.includes(address.toLowerCase())) {
        return [
          ...input.lines,
          `(narrator "${narrator.name}" introduced the address ${address}, which is not in the ` +
            'decision this agent computed. Its output was discarded; the lines above are the ' +
            "agent's own.)",
        ]
      }
    }
  }

  return produced.slice(0, MAX_LINES).map((line) => line.slice(0, MAX_LINE_CHARS))
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry)
    return Object.freeze(value)
  }
  return value
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item,
    ) ?? ''
  } catch {
    return ''
  }
}
