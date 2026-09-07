/**
 * `@hallmark/altana` — Hallmark's entire authorization surface.
 *
 * Hiring an on-chain agent must never hand it custody. What it gets instead is
 * an Altana session key: an allowlist of contracts, a spend cap, an expiry,
 * registered in a public Keystore. The user revokes it in one click. Anyone
 * checks it with one `eth_call` and no credentials.
 *
 * The rest of the app talks to this package and never to the raw SDK.
 */

export * from './addresses.js'
export * from './client.js'
export * from './commerce.js'
export * from './errors.js'
export * from './execute.js'
export * from './keystore.js'
export * from './network.js'
export * from './policy.js'
export * from './session.js'
export * from './x402.js'
