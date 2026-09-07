/**
 * The things a visitor can try to make a session key do.
 *
 * This lives outside `app/actions/scope.ts` on purpose. A module marked
 * `'use server'` may only export async functions: Next rewrites every export
 * into a server-action reference, so a plain array exported from there arrives
 * in the browser as a function and the first `.map` over it throws. The action
 * imports this; the client component imports this; nothing crosses the
 * server-action boundary except the action itself.
 */

export type ScopeAttemptId =
  | 'drain-token'
  | 'unlisted-protocol'
  | 'over-cap'
  | 'in-scope'
  | 'expired-key'

export type ScopeAttempt = {
  id: ScopeAttemptId
  label: string
  /** What an agent holding this key would be trying to do. */
  intent: string
}

export const SCOPE_ATTEMPTS: ScopeAttempt[] = [
  {
    id: 'in-scope',
    label: 'Do the job it was hired for',
    intent: 'Call the protocol contract this policy exists to allow.',
  },
  {
    id: 'drain-token',
    label: 'Move your tokens somewhere else',
    intent: 'Call transfer() on a stablecoin, sending the balance to an address it chose.',
  },
  {
    id: 'unlisted-protocol',
    label: 'Use a contract that is not on the list',
    intent:
      'Call the PancakeSwap v3 factory — real, deployed, and named by none of the four policies.',
  },
  {
    id: 'over-cap',
    label: 'Spend more than the cap',
    intent: 'Move more native BNB in one intent than the per-day cap allows.',
  },
  {
    id: 'expired-key',
    label: 'Act after the key expired',
    intent: 'Submit the allowed call, but one second past the expiry.',
  },
]

export type ScopeVerdictResult = {
  attempt: ScopeAttemptId
  label: string
  allowed: boolean
  /** `spend-cap`, `call-not-allowed`, `session-expired`… straight from the SDK. */
  reason: string | null
  /** The SDK's own sentence. Not rewritten here. */
  detail: string
  /** The call that was judged, so nothing is hidden behind a label. */
  target: string
  selector: string | null
  value: string
  /** The cap in force at the time of the check. */
  capAtomic: string
  capLabel: string
  category: string
  at: string
}
