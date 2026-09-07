'use server'

import { checkScope, buildPolicy, toAltanaPermissions } from '@hallmark/altana'
import { encodeFunctionData, parseUnits, type Address, type Hex } from 'viem'

import { CATEGORY_DEFINITIONS, type HallmarkCategory } from '@/lib/categories'
import { SCOPE_ATTEMPTS, type ScopeAttemptId, type ScopeVerdictResult } from '@/lib/scopeAttempts'
import { getProtocolAddresses } from '@/lib/protocols'
import type { SupportedChainId } from '@/lib/deployments'

/**
 * Ask a session key's own policy whether it would allow something.
 *
 * This runs the real `checkScope` from `@hallmark/altana` — the same function
 * `executeWithSession` runs before it touches the relay — against a real
 * policy built by the same builder the hire page shows. Nothing is mocked and
 * nothing reaches a chain: a refusal here is the identical value, with the
 * identical reason string, that a live agent would get back.
 *
 * The point is to make a refusal something a visitor can *cause* rather than
 * something they have to take on faith. A control panel that only ever shows
 * green has demonstrated nothing.
 *
 * Note what is NOT exported from here: the attempt list and its types live in
 * `lib/scopeAttempts.ts`, because a `'use server'` module may only export async
 * functions — Next rewrites every other export into an action reference, and an
 * array that arrives in the browser as a function throws on its first `.map`.
 */

/**
 * Build one concrete call per attempt, against the real protocol addresses for
 * the chain — the same ones the policy allowlists.
 */
function buildCall(
  attempt: ScopeAttemptId,
  category: HallmarkCategory,
  chainId: SupportedChainId,
): { to: Address; data: Hex; value: bigint } {
  const protocols = getProtocolAddresses(chainId)
  const attacker: Address = '0x000000000000000000000000000000000000dEaD'

  const transferData = encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'transfer',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ type: 'bool' }],
      },
    ],
    functionName: 'transfer',
    args: [attacker, parseUnits('1000', 18)],
  })

  switch (attempt) {
    case 'drain-token':
      return { to: protocols.stable, data: transferData, value: 0n }
    case 'unlisted-protocol':
      return {
        to: protocols.unlistedContract,
        data: encodeFunctionData({
          abi: [
            {
              type: 'function',
              name: 'createPool',
              stateMutability: 'nonpayable',
              inputs: [
                { name: 'tokenA', type: 'address' },
                { name: 'tokenB', type: 'address' },
                { name: 'fee', type: 'uint24' },
              ],
              outputs: [{ name: 'pool', type: 'address' }],
            },
          ],
          functionName: 'createPool',
          args: [protocols.stable, protocols.venusVBnb, 2500],
        }),
        value: 0n,
      }
    case 'over-cap':
      // The call itself must be one the policy allows, or `checkScope` refuses
      // it on the allowlist and never reaches the spend check — which would
      // demonstrate the wrong rule. Same target and same selector as the
      // in-scope attempt; the only difference is the native value attached.
      return {
        to: allowedTarget(category, chainId),
        data: allowedData(category),
        value: parseUnits('5', 18),
      }
    default:
      return { to: allowedTarget(category, chainId), data: allowedData(category), value: 0n }
  }
}

function allowedTarget(category: HallmarkCategory, chainId: SupportedChainId): Address {
  const protocols = getProtocolAddresses(chainId)
  switch (category) {
    case 'rebalancing':
      return protocols.pancakePositionManager
    case 'grid':
      return protocols.pancakeSwapRouter
    case 'yield':
      return protocols.venusComptroller
    case 'health-factor':
      return protocols.venusVUsdt
  }
}

function allowedData(category: HallmarkCategory): Hex {
  // The health-factor policy allowlists by selector as well as by address, so
  // an in-scope call there has to carry a selector the policy actually names.
  if (category !== 'health-factor') return '0x'
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'repayBorrow',
        stateMutability: 'nonpayable',
        inputs: [{ name: 'amount', type: 'uint256' }],
        outputs: [{ type: 'uint256' }],
      },
    ],
    functionName: 'repayBorrow',
    args: [parseUnits('100', 18)],
  })
}

export async function testScope(input: {
  attempt: ScopeAttemptId
  category: HallmarkCategory
  chainId: number
}): Promise<ScopeVerdictResult> {
  const chainId: SupportedChainId = input.chainId === 56 ? 56 : 97
  const category = input.category
  const now = Math.floor(Date.now() / 1000)

  const policy = buildPolicy(CATEGORY_DEFINITIONS[category].policy, chainId, {
    now,
    ttlSeconds: 7 * 24 * 60 * 60,
  })
  const permissions = toAltanaPermissions(policy)

  const call = buildCall(input.attempt, category, chainId)

  // The expired-key case moves the clock, not the policy: the key is exactly
  // the one shown on the hire page, one second past its own expiry.
  const evaluationNow = input.attempt === 'expired-key' ? policy.expiresAt + 1 : now

  const verdict = checkScope({
    permissions,
    expiry: policy.expiresAt,
    calls: [call],
    now: evaluationNow,
  })

  const nativeCap = policy.spend.find(
    (cap) => cap.token.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  )
  const stableCap = policy.spend.find((cap) => cap !== nativeCap)
  const relevantCap = input.attempt === 'over-cap' ? nativeCap : (stableCap ?? nativeCap)

  const attemptMeta = SCOPE_ATTEMPTS.find((entry) => entry.id === input.attempt)

  return {
    attempt: input.attempt,
    label: attemptMeta?.label ?? input.attempt,
    allowed: verdict.allowed,
    reason: verdict.allowed ? null : verdict.reason,
    detail: verdict.allowed
      ? 'Allowed. This call is on the key’s allowlist and inside its caps, so the agent may ' +
        'make it — and only calls like this one.'
      : verdict.detail,
    target: call.to,
    selector: call.data.length >= 10 ? call.data.slice(0, 10) : null,
    value: call.value.toString(),
    capAtomic: (relevantCap?.limitAtomic ?? 0n).toString(),
    capLabel:
      relevantCap === undefined
        ? 'no cap'
        : `${Number(relevantCap.limitAtomic) / 10 ** relevantCap.decimals} per ${relevantCap.period}`,
    category,
    at: new Date().toISOString(),
  }
}
