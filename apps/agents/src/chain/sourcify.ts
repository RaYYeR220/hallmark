/**
 * Source verification, keyless.
 *
 * This module exists to correct a claim this service used to make: that there
 * is "no keyless way to confirm verified source" on BNB Chain. That is false.
 * Etherscan's V2 API does charge for chain 56, which is where the belief came
 * from, but Sourcify is free, open, needs no key, and holds BNB Chain
 * contracts — including, as it happens, the implementation behind the EIP-1167
 * proxy this agent was built to see through.
 *
 * A plausible-sounding justification attached to a question we simply did not
 * ask is exactly the failure this whole codebase claims to be better than, so
 * it is worth naming what went wrong: the reasoning was sound and the premise
 * was never checked.
 *
 * Sourcify grades a match three ways, and the difference matters:
 *
 *   - `exact_match` — the bytecode *and* the metadata hash agree. The source
 *     is the source, comments and all.
 *   - `match` — the runtime bytecode agrees but the metadata does not. The
 *     logic is what it claims to be; a constant or a comment may not be.
 *   - `null` — Sourcify holds nothing for this address. That is "unknown",
 *     not "unverified": plenty of verified-on-BscScan contracts were never
 *     submitted to Sourcify.
 */
import type { Address } from 'viem'
import type { SupportedChainId } from '@hallmark/core'

export const SOURCIFY_API = 'https://sourcify.dev/server/v2/contract'

export type SourcifyMatch = 'exact_match' | 'match' | null

export type SourcifyResult = {
  checked: boolean
  address: Address
  chainId: SupportedChainId
  match: SourcifyMatch
  creationMatch: SourcifyMatch
  runtimeMatch: SourcifyMatch
  verifiedAt: string | null
  url: string
  detail: string
}

function describe(match: SourcifyMatch, address: Address, verifiedAt: string | null): string {
  if (match === 'exact_match') {
    return (
      `Sourcify holds an exact match for ${address}: the deployed bytecode and the metadata ` +
      `hash both agree with the published source${verifiedAt ? `, verified ${verifiedAt}` : ''}. ` +
      'The source you can read is the source that is running.'
    )
  }
  if (match === 'match') {
    return (
      `Sourcify holds a partial match for ${address}: the runtime bytecode agrees with the ` +
      'published source but the metadata hash does not. The logic is what it claims to be; a ' +
      'constant, a comment or a compiler setting may differ from what you read.'
    )
  }
  return (
    `Sourcify holds no verified source for ${address}. That is unknown rather than unverified — ` +
    'a contract can be verified on a block explorer and never submitted to Sourcify — so it ' +
    'lowers confidence without proving anything.'
  )
}

/**
 * Ask Sourcify about one address.
 *
 * Never throws: an unreachable Sourcify is `checked: false`, which the verdict
 * treats as an unknown rather than a pass. A timeout on a free public service
 * must not fail a security report.
 */
export async function checkSourcify(args: {
  address: Address
  chainId: SupportedChainId
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<SourcifyResult> {
  const { address, chainId } = args
  const url = `${SOURCIFY_API}/${chainId}/${address}`
  const base = {
    address,
    chainId,
    url: `https://repo.sourcify.dev/${chainId}/${address}`,
  }

  try {
    const res = await (args.fetchImpl ?? fetch)(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(args.timeoutMs ?? 8_000),
    })

    if (!res.ok && res.status !== 404) {
      return {
        ...base,
        checked: false,
        match: null,
        creationMatch: null,
        runtimeMatch: null,
        verifiedAt: null,
        detail: `Sourcify answered HTTP ${res.status}, so verification is unknown, not absent.`,
      }
    }

    const body = (await res.json()) as Record<string, unknown>
    const match = (body['match'] ?? null) as SourcifyMatch
    const verifiedAt = typeof body['verifiedAt'] === 'string' ? body['verifiedAt'] : null

    return {
      ...base,
      checked: true,
      match,
      creationMatch: (body['creationMatch'] ?? null) as SourcifyMatch,
      runtimeMatch: (body['runtimeMatch'] ?? null) as SourcifyMatch,
      verifiedAt,
      detail: describe(match, address, verifiedAt),
    }
  } catch (error) {
    return {
      ...base,
      checked: false,
      match: null,
      creationMatch: null,
      runtimeMatch: null,
      verifiedAt: null,
      detail:
        `Sourcify could not be reached (${error instanceof Error ? error.message : String(error)}), ` +
        'so verification is unknown. An unreachable check is not a failed check.',
    }
  }
}
