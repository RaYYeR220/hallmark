import { AddressLink, TxLink } from '@/components/chain/links'
import { Badge, Card, SectionHeading, SourceNote } from '@/components/ui'
import { getDeployment, type SupportedChainId } from '@/lib/deployments'
import { shortAddress } from '@/lib/format'
import { isKeyStillValid, KEYSTORE_ADDRESSES } from '@/lib/sessions'

import styles from './sessions.module.css'

/**
 * The session-key lifecycle, as it actually happened.
 *
 * This panel exists because the leash was the one claim on the site that was
 * still theoretical: the scope tester below proves a policy *would* refuse
 * things, but nothing proved a key had ever been granted, used to move real
 * value, and then killed. It has, on chain 97, and these are the three
 * receipts.
 *
 * The transactions are configuration — a receipt does not change. The Keystore
 * verdict beside them is read live on every request, so if the revoke were ever
 * undone this panel would say the key is authorised again rather than keep
 * asserting a story that had stopped being true.
 */
export async function SessionLifecycle({ chainId }: { chainId: SupportedChainId }) {
  const deployment = getDeployment(chainId)
  if (deployment === null) return null

  const { sessionProof } = deployment
  const stillValid = await isKeyStillValid(
    chainId,
    sessionProof.wallet,
    sessionProof.sessionKeyId,
  )

  return (
    <Card>
      <SectionHeading
        eyebrow="A key that lived and died"
        title="Granted, used, revoked"
        level={2}
        lead="Three transactions on BNB testnet. In between them an agent supplied real collateral to Venus using a key that could do that and nothing else — then the key stopped existing."
      />

      <div className={styles.lifecycle}>
        <div className={`${styles.phase} ${styles.phaseLive}`}>
          <span className={`${styles.phaseName} ${styles.phaseNameLive}`}>1 · Grant</span>
          <p className={styles.phaseBody}>
            A scoped key registered in the public Altana Keystore against{' '}
            <AddressLink chainId={chainId} address={sessionProof.wallet} />. The user keeps the
            admin key; the agent gets this one.
          </p>
          <span className={styles.phaseState}>
            <TxLink chainId={chainId} hash={sessionProof.grant} />
          </span>
        </div>

        <div className={`${styles.phase} ${styles.phaseLive}`}>
          <span className={`${styles.phaseName} ${styles.phaseNameLive}`}>2 · Act</span>
          <p className={styles.phaseBody}>
            {sessionProof.act.label}. Signed by the session key, not by the wallet owner — the
            agent moved value under a policy that let it supply collateral and nothing else.
          </p>
          <span className={styles.phaseState}>
            <TxLink chainId={chainId} hash={sessionProof.act.hash} />
          </span>
        </div>

        <div className={`${styles.phase} ${styles.phaseDead}`}>
          <span className={styles.phaseName}>3 · Revoke</span>
          <p className={styles.phaseBody}>
            One transaction, effective immediately. Anyone can confirm it without asking us — the
            Keystore is public and the read below took no credentials.
          </p>
          <span className={styles.phaseState}>
            <TxLink chainId={chainId} hash={sessionProof.revoke} />
          </span>
        </div>
      </div>

      <div style={{ marginTop: 'var(--sp-4)' }}>
        <div className={styles.phaseState} style={{ border: 'none', paddingTop: 0 }}>
          <span>
            Read just now —{' '}
            <code>
              isValidKey({shortAddress(sessionProof.wallet, 8)},{' '}
              {sessionProof.sessionKeyId.slice(0, 10)}…)
            </code>{' '}
            ={' '}
            <span className={styles.phaseStateValue}>
              <Badge tone={stillValid ? 'ok' : 'neutral'} dot>
                {stillValid ? 'true — still authorised' : 'false — revoked'}
              </Badge>
            </span>
          </span>
        </div>
      </div>

      <SourceNote>
        Keystore <AddressLink chainId={chainId} address={KEYSTORE_ADDRESSES[chainId]} /> on BNB
        testnet. The key no longer appears in <code>getKeys()</code> for that wallet at all, which
        is what revocation looks like from the outside. On BNB Smart Chain this lifecycle has not
        been run — the escrow and the probe live on testnet, and we do not imply otherwise.
      </SourceNote>
    </Card>
  )
}
