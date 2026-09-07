import { handle } from 'hono/vercel'

import { buildApp } from '../src/app.js'

/**
 * The Vercel entry point.
 *
 * Node runtime, not edge: the agents read chain state through viem and the
 * security agent's simulation issues a few hundred `eth_call`s, which is not
 * work for an edge function's budget.
 *
 * One caveat worth stating rather than discovering: serverless instances do
 * not share memory, so the default in-memory store gives each invocation its
 * own view. Grid state and `act` idempotency both depend on the store, so a
 * production deployment must set `HALLMARK_STORE_PATH` — or swap in a shared
 * `Store` implementation — before either is relied on.
 */

export const config = { runtime: 'nodejs' }

const app = buildApp()

export default handle(app)
