/**
 * The grower.
 *
 * A branching random walk. Every hypha is a path, every branch point a node,
 * every terminal a fruiting body. It is the asset layer of the whole visual
 * language, and the reason it lives in `lib/` rather than inside a component
 * is that it must be **pure and deterministic**: the same seed grows the same
 * colony on the server and in the browser, so the SVG can be rendered during
 * SSR, survives hydration without a mismatch, and is visible with JavaScript
 * disabled.
 *
 * ---------------------------------------------------------------------------
 * What makes this the product rather than decoration: the shape is driven by
 * the agent's real record, not by an aesthetic parameter.
 *
 *   branches      ← how many contracts the session key may call
 *   hypha length  ← the spend cap
 *   fruiting bodies ← jobs that actually settled
 *   depth         ← the evidence score
 *   seed          ← the agent id, so an agent always grows the same colony
 *
 * A colony that ignores its agent's data would be a picture of a mushroom. One
 * that encodes it lets you compare two agents at a glance before reading a
 * single number — which is the thing the discovery page is for.
 * ---------------------------------------------------------------------------
 */

export type ColonyPath = {
  d: string
  /** Stroke width at this depth. */
  w: number
  /** Recursion depth remaining when it was drawn; higher = closer to the root. */
  depth: number
}

export type ColonyFruit = { x: number; y: number; r: number }

export type Colony = {
  paths: ColonyPath[]
  fruits: ColonyFruit[]
}

export type GrowOptions = {
  seed: number
  /** Canvas the walk is bounded to. */
  w: number
  h: number
  /** How far past the canvas a hypha may wander before it is cut. */
  pad: number
  /** Starting points: [x, y, angle in radians]. */
  roots: [number, number, number][]
  /** Length of a first-generation segment run. */
  len: number
  /** Straight sections per segment run; more = smoother curves. */
  segs: number
  /** Recursion depth. */
  depth: number
  /** Radians of jitter per section. */
  wander: number
  /** Radians between sibling branches. */
  spread: number
  /** Probability a node splits in two rather than continuing as one. */
  branchP: number
  /** Root stroke width. */
  w0: number
  /** Below this length a run terminates in a fruiting body. */
  minLen: number
  fruitR: number
}

/**
 * Mulberry32. Small, fast, and — the only property that matters here —
 * identical in every JavaScript runtime, which is what lets the server and the
 * browser agree on a colony.
 */
export function rng(seed: number): () => number {
  let state = seed | 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function grow(opts: GrowOptions): Colony {
  const random = rng(opts.seed)
  const paths: ColonyPath[] = []
  const fruits: ColonyFruit[] = []

  // Explicit stack rather than recursion: a deep colony with a high branch
  // probability can nest past the call-stack limit, and a blown stack during
  // SSR takes the whole page down.
  const stack: { x: number; y: number; ang: number; len: number; depth: number; w: number }[] =
    opts.roots.map(([x, y, ang]) => ({
      x,
      y,
      ang,
      len: opts.len,
      depth: opts.depth,
      w: opts.w0,
    }))

  // Hard ceiling on total segments. A pathological parameter set must degrade
  // to a sparser colony, never to a hung render.
  let budget = 4000

  while (stack.length > 0 && budget > 0) {
    const node = stack.pop()
    if (node === undefined) break
    budget -= 1

    let { x, y, ang } = node
    if (node.depth <= 0 || node.len < opts.minLen) {
      fruits.push({ x, y, r: opts.fruitR * (0.6 + random() * 0.9) })
      continue
    }

    const points: [number, number][] = [[x, y]]
    for (let i = 0; i < opts.segs; i += 1) {
      ang += (random() - 0.5) * opts.wander
      x += (Math.cos(ang) * node.len) / opts.segs
      y += (Math.sin(ang) * node.len) / opts.segs
      if (x < -opts.pad || x > opts.w + opts.pad || y < -opts.pad || y > opts.h + opts.pad) break
      points.push([x, y])
    }

    paths.push({
      d: `M${points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join('L')}`,
      w: node.w,
      depth: node.depth,
    })

    const children = random() < opts.branchP ? 2 : 1
    for (let b = 0; b < children; b += 1) {
      stack.push({
        x,
        y,
        ang: ang + (b === 0 ? -1 : 1) * (opts.spread * (0.5 + random())),
        len: node.len * (0.62 + random() * 0.26),
        depth: node.depth - 1,
        w: node.w * 0.74,
      })
    }
  }

  return { paths, fruits }
}

/* ------------------------------------------------------------------ */
/* the mapping from an agent's record to a colony                      */
/* ------------------------------------------------------------------ */

export type AgentColonyInput = {
  /** Seeds the walk, so one agent always grows the same shape. */
  agentId: number
  /** Contracts the session key may call. Drives branch density. */
  allowlistSize: number
  /** Declared service endpoints. Drives how many roots the colony has. */
  endpointCount: number
  /** Evidence score 0-100, or null when nobody has probed it. Drives depth. */
  score: number | null
  /** Jobs that actually settled. Drives how many fruiting bodies are lit. */
  settledJobs: number
  /** On-chain ratings. Also lights a body — someone measured this agent. */
  attestations?: number
}

export type AgentColony = Colony & {
  /** How many fruits get a signal colour rather than staying grey. */
  litFruits: number
  /** True when nothing has ever been observed — the colony grew and never fruited. */
  barren: boolean
}

const COLONY_W = 200
const COLONY_H = 96

/**
 * Grow the colony for one agent, at card size.
 *
 * The honest case is the important one: an agent with no evidence and no
 * settled jobs grows a short, shallow, entirely grey colony. It is visibly
 * stunted next to a probed one, and that difference is the same fact the
 * "Never probed" badge states in words.
 */
export function growAgentColony(input: AgentColonyInput): AgentColony {
  const score = input.score ?? 0
  const roots = Math.max(1, Math.min(3, input.endpointCount))
  const allowlist = Math.max(1, Math.min(8, input.allowlistSize))

  const colony = grow({
    seed: 3300 + input.agentId * 613,
    w: COLONY_W,
    h: COLONY_H,
    pad: 8,
    roots: Array.from({ length: roots }, (_, index) => {
      const spanned = (COLONY_W * (index + 1)) / (roots + 1)
      return [spanned, COLONY_H + 4, -Math.PI / 2] as [number, number, number]
    }),
    // An unprobed agent gets short hyphae. A well-scoring one reaches.
    len: 22 + (score / 100) * 26,
    segs: 6,
    // Depth is the evidence: nothing observed, nothing much grown.
    depth: Math.max(3, Math.min(7, Math.round(3 + (score / 100) * 3 + allowlist * 0.25))),
    wander: 0.62,
    spread: 0.72,
    branchP: 0.4 + allowlist * 0.05,
    w0: 1.9,
    minLen: 4,
    fruitR: 1.8,
  })

  return {
    ...colony,
    // One lit body per settled job, then per attestation, capped so a busy
    // agent does not turn into a solid disc. An agent with neither stays
    // entirely grey, which is the honest picture and the common one.
    litFruits: Math.min(colony.fruits.length, input.settledJobs + (input.attestations ?? 0)),
    barren: input.score === null && input.settledJobs === 0 && (input.attestations ?? 0) === 0,
  }
}

export const COLONY_VIEWBOX = { w: COLONY_W, h: COLONY_H }

/**
 * The full-bleed substrate behind every page.
 *
 * One fixed seed, so it is the same drawing on every route and reads as one
 * continuous organism the pages sit on rather than a per-page decoration.
 */
export function growSubstrate(): Colony {
  return grow({
    seed: 7717,
    w: 1440,
    h: 900,
    pad: 200,
    roots: [
      [120, 760, -1.05],
      [1330, 820, -2.1],
      [720, 930, -1.55],
      [80, 180, 0.55],
      [1380, 140, 2.55],
      [720, -50, 1.6],
      [-40, 470, 0.1],
      [1490, 470, 3.05],
      [380, 930, -1.25],
      [1060, -50, 1.95],
      [200, -40, 1.25],
      [1240, 940, -1.95],
    ],
    len: 205,
    segs: 10,
    depth: 7,
    wander: 0.58,
    spread: 0.66,
    branchP: 0.62,
    w0: 2.6,
    minLen: 14,
    fruitR: 2.8,
  })
}

export const SUBSTRATE_VIEWBOX = { w: 1440, h: 900 }
