import { getCachedEcosystem, getCachedHookConfig } from '@/lib/cache'
import { DEMO_CHAIN_ID, getDeployment } from '@/lib/deployments'

/**
 * `GET /api/stats` — the census, plus the gate's live configuration.
 *
 * The numbers behind the landing page's proof strip, served separately so they
 * can be checked without scraping HTML. Every figure carries the timestamp of
 * the read that produced it: a cached number that does not say it is cached is
 * a lie with a shelf life.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const [mainnet, testnet, gate] = await Promise.all([
    getCachedEcosystem(56),
    getCachedEcosystem(97),
    getCachedHookConfig(DEMO_CHAIN_ID),
  ])

  const deployment = getDeployment(DEMO_CHAIN_ID)

  return new Response(
    JSON.stringify(
      {
        chains: [mainnet, testnet].filter((entry) => entry !== null),
        gate:
          gate === null || deployment === null
            ? null
            : {
                chainId: DEMO_CHAIN_ID,
                hook: deployment.hook,
                commerce: deployment.commerce,
                attestor: gate.attestor,
                maxEvidenceAgeSeconds: gate.maxEvidenceAge,
                minValidationScore: gate.minValidationScore,
                evidenceBaseUri: gate.evidenceBaseUri,
              },
        notes: [
          'Chain figures come from the 8004scan index and are cached for five minutes; the ' +
            '`fetchedAt` on each is the moment of the underlying read, not of this response.',
          'Gate configuration is read from HallmarkHook on chain 97 and cached for an hour. ' +
            'Both values are owner-settable, which is why they are read rather than hard-coded.',
          'Hallmark keeps no database. Every number here is derivable from BNB Chain and a ' +
            'public index by anyone who wants to check it.',
        ],
        servedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=0, s-maxage=60',
        'access-control-allow-origin': '*',
      },
    },
  )
}
