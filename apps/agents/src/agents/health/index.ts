import { defineSkill } from '../../runtime/types.js'
import type { AgentDefinition, Shape } from '../../runtime/types.js'
import { analyseHealth, type HealthInput } from './analyse.js'
import { actHealth, type HealthActInput } from './act.js'
import { healthManifest, healthReportPrice, HEALTH_SLUG } from './manifest.js'

const shape: Shape = {
  borrower: {
    kind: 'address',
    description: 'The account whose Venus position to watch.',
  },
  chainId: {
    kind: 'integer',
    description: 'BNB Chain id: 56 (mainnet) or 97 (testnet).',
    optional: true,
    min: 56,
    max: 97,
  },
  triggerHealthFactor: {
    kind: 'number',
    description: 'Act once health falls to or below this. Default 1.25.',
    optional: true,
    default: 1.25,
    min: 1,
    max: 10,
  },
  targetHealthFactor: {
    kind: 'number',
    description: 'Repay enough to restore this. Must exceed the trigger. Default 1.6.',
    optional: true,
    default: 1.6,
    min: 1,
    max: 20,
  },
  maxPriceAgeSeconds: {
    kind: 'integer',
    description:
      'Refuse to act on a Chainlink answer older than this. Default 3600; BNB Chain feeds update far more often.',
    optional: true,
    min: 30,
    max: 86_400,
  },
  oracleToleranceBps: {
    kind: 'integer',
    description:
      'How far Chainlink may sit from the Venus oracle before the agent stops. Default 200 bps.',
    optional: true,
    min: 1,
    max: 5_000,
  },
}

const analyse = defineSkill<HealthInput>({
  id: 'analyse',
  name: 'Assess a Venus position',
  description:
    'Health factor, the exact liquidation price, and the precise repay that would restore a ' +
    'target margin — computed against Venus\'s own oracle and cross-checked against Chainlink. ' +
    'A stale feed, a feed with the wrong decimals, or two derivations of health that disagree ' +
    'produce a refusal with the evidence, not a number. Read-only.',
  mode: 'read',
  tags: ['analysis', 'lending', 'risk'],
  input: shape,
  examples: [
    'How close to liquidation is 0x…?',
    'What would it take to bring that position back to a health factor of 1.8?',
  ],
  run: (input, ctx) => analyseHealth(input, ctx, { deep: false }),
})

const report = defineSkill<HealthInput>({
  id: 'report',
  name: 'Priced position report',
  description:
    'Everything `analyse` returns, plus the full per-market breakdown behind it — balances, ' +
    'collateral factors, oracle mantissas and rates — so the health factor can be recomputed ' +
    'independently rather than trusted. Sold over x402.',
  mode: 'read',
  tags: ['analysis', 'lending', 'risk', 'paid'],
  input: shape,
  price: healthReportPrice(56),
  run: (input, ctx) => analyseHealth(input, ctx, { deep: true }),
})

const act = defineSkill<HealthActInput>({
  id: 'act',
  name: 'Repay to restore health',
  description:
    'Repays the precise amount needed to reach the target health factor, under an Altana ' +
    'session key whose allowlist contains enterMarkets, mint, repayBorrow and redeemUnderlying ' +
    'and does not contain borrow — so this agent can only ever make a position safer. Handles ' +
    'the vBNB split: `repayBorrow()` payable on vBNB, `repayBorrow(uint256)` everywhere else. ' +
    'Fails closed on a stale feed. Re-running with the same intentId never executes twice.',
  mode: 'write',
  tags: ['on-chain', 'lending', 'risk'],
  input: {
    ...shape,
    intentId: {
      kind: 'string',
      description: 'Idempotency key. The same id never executes twice.',
      minLength: 4,
      maxLength: 128,
    },
  },
  run: (input, ctx) => actHealth(input, ctx),
})

/**
 * The scheduled entry point.
 *
 * A liquidation guard that only runs when someone asks is not a guard. This
 * skill is what the cron endpoint calls: it analyses the watchlist and acts on
 * anything past its trigger, deriving a per-run intent id so a scheduler that
 * fires twice in the same window cannot repay twice.
 */
const watch = defineSkill<{ borrowers: string[]; chainId?: number; triggerHealthFactor?: number; targetHealthFactor?: number; dryRun?: boolean }>({
  id: 'watch',
  name: 'Sweep a watchlist',
  description:
    'Analyses several positions and acts on any that have crossed their trigger. Intended for ' +
    'the cron endpoint; each position gets a deterministic intent id derived from the borrower ' +
    'and the run window, so a scheduler firing twice cannot repay twice.',
  mode: 'write',
  tags: ['on-chain', 'lending', 'scheduled'],
  input: {
    borrowers: {
      kind: 'array',
      description: 'Accounts to watch.',
      items: { kind: 'address', description: 'A Venus borrower.' },
      minItems: 1,
      maxItems: 25,
    },
    chainId: shape['chainId']!,
    triggerHealthFactor: shape['triggerHealthFactor']!,
    targetHealthFactor: shape['targetHealthFactor']!,
    dryRun: {
      kind: 'boolean',
      description: 'Analyse only; never send. Default true, so a misconfigured cron does nothing.',
      optional: true,
      default: true,
    },
  },
  run: async (input, ctx) => {
    const now = ctx.now()
    // One window per five minutes: a scheduler that fires twice inside it
    // produces the same intent id, and the second run replays rather than
    // repaying again.
    const window = Math.floor(now / 300)
    const results: unknown[] = []

    for (const borrower of input.borrowers) {
      const common = {
        borrower,
        ...(input.chainId === undefined ? {} : { chainId: input.chainId }),
        ...(input.triggerHealthFactor === undefined ? {} : { triggerHealthFactor: input.triggerHealthFactor }),
        ...(input.targetHealthFactor === undefined ? {} : { targetHealthFactor: input.targetHealthFactor }),
      }
      if (input.dryRun !== false) {
        results.push({ borrower, mode: 'dry-run', analysis: await analyseHealth(common, ctx, { deep: false }) })
        continue
      }
      results.push({
        borrower,
        mode: 'live',
        result: await actHealth({ ...common, intentId: `watch-${borrower.toLowerCase()}-${window}` }, ctx),
      })
    }

    return {
      agent: HEALTH_SLUG,
      sweptAt: new Date(now * 1000).toISOString(),
      window,
      dryRun: input.dryRun !== false,
      count: input.borrowers.length,
      results,
    }
  },
})

export const healthAgent: AgentDefinition = {
  manifest: healthManifest,
  skills: [analyse, report, act, watch],
}

export { healthManifest }
