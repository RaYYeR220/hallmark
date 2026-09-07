import type { AgentCategory } from '@hallmark/altana'
import { HALLMARK_CATEGORIES, type HallmarkCategory } from '@hallmark/core'

/**
 * The four things an agent gets hired to do here.
 *
 * There is no category field in ERC-8004 and no taxonomy in the indexer, so a
 * category is *inferred* and the app says so wherever one is shown. The
 * inference has two independent halves, and both are visible to the reader:
 *
 *  1. A semantic query, run against 8004scan's embedding search. High
 *     precision, low recall — it finds agents whose description means the
 *     right thing even when the words differ.
 *  2. A keyword set, run as ordinary substring search over name and
 *     description. Low precision, high recall — it catches the agents whose
 *     descriptions are too thin to embed usefully.
 *
 * The union is deduplicated and each result carries how it was matched, so
 * "why is this here?" always has an answer on screen.
 *
 * Each category maps to exactly one Altana policy builder. That mapping is the
 * whole safety story: choosing "Health factor monitoring" is choosing a session
 * key that can repay and supply but cannot borrow.
 */

export type CategoryDefinition = {
  id: HallmarkCategory
  /** Title case, for headings. */
  label: string
  /** Short, for chips and table cells. */
  shortLabel: string
  /** One sentence: what the agent does for you. */
  summary: string
  /** What you are actually buying, in plain terms. */
  jobDescription: string
  /** The natural-language query used for semantic discovery. */
  semanticQuery: string
  /** Substring terms, lowercased, matched against name + description. */
  keywords: string[]
  /** Extra keyword queries handed to the indexer's own text search. */
  searchTerms: string[]
  /** The Altana policy this category grants. */
  policy: AgentCategory
  /** Which protocols the scoped key is allowed to touch, in plain words. */
  scopeSummary: string
  /** What the key deliberately cannot do — the part that makes it a leash. */
  scopeExclusion: string
  /** Example task text pre-filled on the hire page. */
  exampleTask: string
}

export const CATEGORY_DEFINITIONS: Record<HallmarkCategory, CategoryDefinition> = {
  rebalancing: {
    id: 'rebalancing',
    label: 'Rebalancing',
    shortLabel: 'Rebalancing',
    summary:
      'Keeps a concentrated liquidity position inside its range, and moves it when the price walks out.',
    jobDescription:
      'Price the cost of moving a PancakeSwap v3 position back into range — the swap, the fee tier, and the drift you are paying while it sits idle.',
    semanticQuery:
      'rebalance a PancakeSwap v3 concentrated liquidity position back into range, reprice the band, manage LP drift',
    keywords: [
      'rebalanc',
      'range',
      'concentrated liquidity',
      'lp position',
      'position manager',
      'portfolio weight',
      'reweight',
      'drift',
    ],
    searchTerms: ['rebalance', 'liquidity range', 'LP rebalancer'],
    policy: 'pancake-rebalance',
    scopeSummary: 'PancakeSwap v3 position manager and swap router, nothing else.',
    scopeExclusion:
      'It cannot touch a lending market, a bridge, or any token approval outside those two contracts.',
    exampleTask:
      'My WBNB/USDT v3 position is below range. Price the rebalance: the swap needed, the fee tier to re-enter at, and what the move costs against the fees I am forgoing.',
  },
  grid: {
    id: 'grid',
    label: 'Grid trading',
    shortLabel: 'Grid',
    summary:
      'Lays a ladder of buys and sells across a price band and works it while the market ranges.',
    jobDescription:
      'Size a grid for a specific BNB Chain pool and cost it honestly: swap fee, price impact at your actual fill size, and the spacing that survives it.',
    semanticQuery:
      'grid trading bot placing laddered buy and sell orders across a price band, sizing grid spacing and fill costs',
    keywords: [
      'grid',
      'ladder',
      'band',
      'range trading',
      'market making',
      'dca',
      'buy low sell high',
      'spread',
    ],
    searchTerms: ['grid trading', 'grid bot', 'market making'],
    policy: 'pancake-grid',
    scopeSummary: 'The PancakeSwap v3 swap router, and nothing else.',
    scopeExclusion:
      'No position manager, so it can trade the band but cannot open, close or move an LP position.',
    exampleTask:
      'Size a grid for the CAKE/USDT 0.25% pool with 500 $U of working capital. Give me the spacing, the number of rungs, and the fee plus price impact per fill.',
  },
  yield: {
    id: 'yield',
    label: 'Yield optimisation',
    shortLabel: 'Yield',
    summary: 'Finds where idle capital actually earns, and moves it when the ranking changes.',
    jobDescription:
      'Rank the BNB Chain lending venues by what they really pay a supplier — computed from the rate per block, not from a marketing APY — and route capital accordingly.',
    semanticQuery:
      'optimise stablecoin yield across Venus and Aave lending markets on BNB Chain, compare supply APY and route idle capital',
    keywords: [
      'yield',
      'apy',
      'apr',
      'lending',
      'supply rate',
      'venus',
      'aave',
      'vault',
      'farm',
      'staking reward',
      'idle capital',
      'treasury',
    ],
    searchTerms: ['yield optimizer', 'lending yield', 'APY'],
    policy: 'yield-routing',
    scopeSummary:
      'The Venus comptroller and its vBNB and vUSDT markets, plus the Aave V3 pool on mainnet.',
    scopeExclusion:
      'It can move capital between those venues. It cannot send a token anywhere else, and it never holds the funds.',
    exampleTask:
      'Rank every Venus core-pool market on BNB Chain by realised supply APY for a 1,000 $U stablecoin position, and tell me what moving there costs in gas.',
  },
  'health-factor': {
    id: 'health-factor',
    label: 'Health factor monitoring',
    shortLabel: 'Health factor',
    summary:
      'Watches a lending position and unwinds risk before the liquidation bots get to it.',
    jobDescription:
      'Read a Venus position market by market, return its health factor, the collateral drawdown that would liquidate it, and the exact repayment that fixes it.',
    semanticQuery:
      'monitor a lending position health factor on Venus and repay debt or add collateral before liquidation',
    keywords: [
      'health factor',
      'liquidation',
      'collateral',
      'ltv',
      'loan to value',
      'margin call',
      'undercollateral',
      'borrow position',
      'risk monitor',
      'guardian',
      'sentinel',
    ],
    searchTerms: ['health factor', 'liquidation risk', 'lending guardian'],
    policy: 'venus-health-factor',
    scopeSummary:
      'Only the Venus calls that reduce risk: enter markets, supply collateral, repay debt, withdraw supply.',
    scopeExclusion:
      '`borrow` is not on the allowlist. An agent holding this key can unwind the position; it cannot lever it up.',
    exampleTask:
      'Watch my Venus position. If the health factor drops below 1.4, repay enough USDT debt to bring it back to 1.8 and tell me what it cost.',
  },
}

export const CATEGORY_LIST: CategoryDefinition[] = HALLMARK_CATEGORIES.map(
  (id) => CATEGORY_DEFINITIONS[id],
)

export function isCategory(value: string | null | undefined): value is HallmarkCategory {
  if (value === null || value === undefined) return false
  return (HALLMARK_CATEGORIES as readonly string[]).includes(value)
}

export function categoryOf(value: string | null | undefined): CategoryDefinition | null {
  return isCategory(value) ? CATEGORY_DEFINITIONS[value] : null
}

export type CategoryMatch = {
  category: HallmarkCategory
  /** How the match was made, so the UI can show its provenance. */
  via: 'semantic' | 'keyword'
  /** 0…1 for semantic matches; keyword matches carry the term count instead. */
  strength: number
  /** The keyword(s) that hit, when `via` is 'keyword'. */
  terms: string[]
}

/**
 * Classify an agent by keyword alone.
 *
 * Returns every category that matched, strongest first — an agent that does
 * both grid trading and rebalancing is a real thing and forcing it into one
 * bucket would be a lie. Callers that need a single label take the first.
 */
export function classifyByKeyword(
  name: string | null,
  description: string | null,
  extra: string[] = [],
): CategoryMatch[] {
  const haystack = [name ?? '', description ?? '', ...extra].join(' ').toLowerCase()
  if (haystack.trim() === '') return []

  const matches: CategoryMatch[] = []
  for (const definition of CATEGORY_LIST) {
    const hits = definition.keywords.filter((keyword) => haystack.includes(keyword))
    if (hits.length === 0) continue
    matches.push({
      category: definition.id,
      via: 'keyword',
      strength: hits.length,
      terms: hits,
    })
  }
  return matches.sort((a, b) => b.strength - a.strength)
}

/** The single best keyword category, or null when nothing matched. */
export function primaryCategory(
  name: string | null,
  description: string | null,
  extra: string[] = [],
): HallmarkCategory | null {
  return classifyByKeyword(name, description, extra)[0]?.category ?? null
}

export type { HallmarkCategory }
