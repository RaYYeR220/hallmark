/**
 * Typed errors for the Altana authorization surface.
 *
 * The rule this package follows: an *expected* outcome is never an exception.
 * A session key refused by its own policy, a wallet with no gas, a relay that
 * rejected a bundle — all of those come back as values (see `ExecuteOutcome`).
 * The errors below are reserved for programmer mistakes and genuinely
 * exceptional conditions, so a `try/catch` around this package means "we are
 * broken", not "the user's agent was told no".
 */

/** Base class so callers can `instanceof` one thing. */
export class AltanaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/** A chainId this package has no Altana deployment for. */
export class UnsupportedChainError extends AltanaError {
  readonly chainId: number

  constructor(chainId: number, supported: readonly number[]) {
    super(
      `Chain ${chainId} is not an Altana network Hallmark supports. ` +
        `Supported: ${supported.join(', ')}.`,
    )
    this.chainId = chainId
  }
}

/** A policy that cannot be turned into on-chain permissions. */
export class InvalidPolicyError extends AltanaError {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`Policy is not safe to grant:\n  - ${problems.join('\n  - ')}`)
    this.problems = problems
  }
}

/**
 * The relay refused to submit because the wallet cannot pay the Keystore
 * registration fee. Thrown only by call sites that have no outcome value to
 * return; `grantAgentSession` returns an `unfunded` result instead.
 */
export class UnfundedWalletError extends AltanaError {
  readonly address: `0x${string}`
  readonly requiredWei: bigint

  constructor(address: `0x${string}`, requiredWei: bigint) {
    super(
      `Wallet ${address} has no native balance to cover the Altana Keystore fee ` +
        `(~${requiredWei} wei per registration call). Fund it and retry.`,
    )
    this.address = address
    this.requiredWei = requiredWei
  }
}
