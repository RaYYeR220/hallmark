import { decodeEventLog } from 'viem'

import { hallmarkCommerceAbi } from '@/lib/abi'
import { parseChainId, publicClientFor } from '@/lib/chain'
import { getDeployment } from '@/lib/deployments'

/**
 * `GET /api/jobs/:chainId/by-tx/:hash` — the job id a `createJob` produced.
 *
 * Exists so the browser never needs an RPC endpoint of its own. The RPC URL
 * can be a keyed provider, and a key that reaches the bundle is a key that has
 * leaked, so every chain read the client needs is proxied through a route like
 * this one.
 *
 * A pending transaction answers 404, which is the correct answer to "what job
 * did this create?" while the answer does not exist yet. The caller polls.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ chainId: string; hash: string }> }

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { chainId: chainRaw, hash } = await context.params
  const chainId = parseChainId(chainRaw)

  if (chainId === null) {
    return json(400, { error: 'unsupported-chain', detail: `Hallmark reads chains 56 and 97.` })
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return json(400, { error: 'invalid-hash', detail: 'Expected a 32-byte transaction hash.' })
  }

  const deployment = getDeployment(chainId)
  if (deployment === null) {
    return json(404, {
      error: 'no-escrow',
      detail: `Hallmark's escrow is not deployed on chain ${chainId}.`,
    })
  }

  try {
    const receipt = await publicClientFor(chainId).getTransactionReceipt({
      hash: hash as `0x${string}`,
    })

    if (receipt.status !== 'success') {
      return json(200, {
        jobId: null,
        status: 'reverted',
        detail:
          'The transaction reverted, so no job was created. Open it on the explorer for the ' +
          'revert reason.',
      })
    }

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== deployment.commerce.toLowerCase()) continue
      try {
        const decoded = decodeEventLog({
          abi: hallmarkCommerceAbi,
          data: log.data,
          topics: log.topics,
        })
        if (decoded.eventName === 'JobCreated') {
          const args = decoded.args as { jobId: bigint; provider: string; client: string }
          return json(200, {
            jobId: args.jobId.toString(),
            status: 'created',
            provider: args.provider,
            client: args.client,
            blockNumber: receipt.blockNumber.toString(),
          })
        }
      } catch {
        // Some other contract's log in the same receipt. Keep looking.
      }
    }

    return json(200, {
      jobId: null,
      status: 'no-event',
      detail: 'The transaction succeeded but emitted no JobCreated event from the escrow.',
    })
  } catch {
    // viem throws when the receipt does not exist yet, which is the normal
    // state for the first second or two after a broadcast.
    return json(404, { error: 'pending', detail: 'No receipt yet. Try again shortly.' })
  }
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
