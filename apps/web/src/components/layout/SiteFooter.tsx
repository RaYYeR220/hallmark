import Link from 'next/link'

import { CHAINS } from '@/lib/deployments'
import { getDeployment } from '@/lib/deployments'

import styles from './layout.module.css'

const IDENTITY_56 = CHAINS[56].contracts.identityRegistry
const TESTNET = getDeployment(97)

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerBrand}>
          <Link href="/" className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true">
              H
            </span>
            <span>Hallmark</span>
          </Link>
          <p className={styles.footerBlurb}>
            The trust layer for ERC-8004 agents on BNB Smart Chain. Every rating here is an
            on-chain attestation backed by a probe we ran or a job that actually settled. There
            is no private database — the whole index can be rebuilt from BSC.
          </p>
        </div>

        <div className={styles.footerGroup}>
          <span className={styles.footerHeading}>Product</span>
          <Link className={styles.footerLink} href="/agents">
            Find an agent
          </Link>
          <Link className={styles.footerLink} href="/sessions">
            Session control
          </Link>
          <Link className={styles.footerLink} href="/publish">
            List an agent
          </Link>
        </div>

        <div className={styles.footerGroup}>
          <span className={styles.footerHeading}>Verify</span>
          <Link className={styles.footerLink} href="/proof">
            On-chain proof
          </Link>
          <a
            className={styles.footerLink}
            href={`https://bscscan.com/address/${IDENTITY_56}`}
            target="_blank"
            rel="noreferrer noopener"
          >
            Identity Registry
          </a>
          {TESTNET !== null && (
            <a
              className={styles.footerLink}
              href={`https://testnet.bscscan.com/address/${TESTNET.hook}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              Evidence hook
            </a>
          )}
        </div>

        <div className={styles.footerGroup}>
          <span className={styles.footerHeading}>Standards</span>
          <a
            className={styles.footerLink}
            href="https://eips.ethereum.org/EIPS/eip-8004"
            target="_blank"
            rel="noreferrer noopener"
          >
            ERC-8004
          </a>
          <a
            className={styles.footerLink}
            href="https://eips.ethereum.org/EIPS/eip-8183"
            target="_blank"
            rel="noreferrer noopener"
          >
            ERC-8183
          </a>
          <a
            className={styles.footerLink}
            href="https://8004scan.io"
            target="_blank"
            rel="noreferrer noopener"
          >
            8004scan
          </a>
        </div>
      </div>

      <div className={styles.footerBottom}>
        <span>
          Mainnet reads are live. Hallmark&rsquo;s escrow and evidence hook are deployed on BNB
          testnet (97) — see <Link href="/proof">Proof</Link> for exactly what runs where.
        </span>
      </div>
    </footer>
  )
}
