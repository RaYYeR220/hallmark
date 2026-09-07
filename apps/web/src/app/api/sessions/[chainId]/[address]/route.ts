import { parseChainId } from '@/lib/chain'
import { isValidAddress, readKeystore, verificationRecipe } from '@/lib/sessions'

/**
 * `GET /api/sessions/:chainId/:address` — session-key state for any wallet.
 *
 * Deliberately open: the Keystore is public, these reads need no credentials,
 * and a claim that a user can independently verify their own authorisations is
 * worth nothing if the only way to do it is through our UI. The response
 * includes the `cast` commands that reproduce it without us.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ chainId: string; address: string }> }

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const { chainId: chainRaw, address } = await context.params
  const chainId = parseChainId(chainRaw)

  if (chainId === null) {
    return json(400, {
      error: 'unsupported-chain',
      detail: 'The Altana Keystore is read on BNB Smart Chain (56) and BNB testnet (97).',
    })
  }
  if (!isValidAddress(address)) {
    return json(400, { error: 'invalid-address', detail: 'Expected a 20-byte hex address.' })
  }

  const view = await readKeystore(chainId, address)

  if (view.error !== null) {
    // An empty key list and a failed read are different facts, and returning
    // 200 with zero keys would conflate them.
    return json(502, { error: 'keystore-read-failed', detail: view.error, address, chainId })
  }

  return json(200, {
    chainId: view.chainId,
    address: view.address,
    keystore: view.keystoreAddress,
    keys: view.keys,
    keyCount: view.keys.length,
    validKeyCount: view.keys.filter((key) => key.valid).length,
    accountUrl: view.accountUrl,
    readAt: view.readAt,
    notes: [
      'isValidKey returns a single boolean covering three situations — never registered, ' +
        'revoked, and expired — because that is all the contract reports. The Keystore ' +
        'explorer distinguishes them.',
      'The Keystore stores no permissions, no expiry and no spend. Those live in the grant, ' +
        'with whoever made it. Hallmark keeps no server-side record of what a user has ' +
        'authorised.',
    ],
    reproduce: verificationRecipe(chainId, address),
  })
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  })
}


