import type { ReactNode } from 'react'

import { explorerAddressUrl, explorerTokenUrl, explorerTxUrl } from '@/lib/deployments'
import { shortAddress, shortHash } from '@/lib/format'
import { evidencePath } from '@/lib/site'

import styles from './links.module.css'
import { CopyButton } from './CopyButton'

/**
 * Every on-chain reference in the app renders through one of these.
 *
 * The rule they encode: an address, a hash or an evidence id is never printed
 * as inert text. If it exists on a chain, it is a link to a block explorer; if
 * it names an evidence bundle, it is a link to the bytes. A reader should
 * always be one click from checking us.
 */

export function ExternalLink({
  href,
  children,
  className,
  mono = false,
}: {
  href: string
  children: ReactNode
  className?: string
  mono?: boolean
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={[mono ? styles.link : undefined, styles.external, className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </a>
  )
}

export function AddressLink({
  chainId,
  address,
  label,
  full = false,
  copy = false,
}: {
  chainId: number
  address: string | null | undefined
  label?: string
  full?: boolean
  copy?: boolean
}) {
  if (address === null || address === undefined || address === '') {
    return <span className={styles.plain}>—</span>
  }
  const text = label ?? (full ? address : shortAddress(address))
  const link = (
    <a
      href={explorerAddressUrl(chainId, address)}
      target="_blank"
      rel="noreferrer noopener"
      className={`${styles.link} ${styles.external}`}
      title={address}
    >
      {text}
    </a>
  )
  if (!copy) return link
  return (
    <span className={styles.pair}>
      {link}
      <CopyButton value={address} label="Copy address" />
    </span>
  )
}

export function TokenLink({
  chainId,
  address,
  label,
}: {
  chainId: number
  address: string
  label?: string
}) {
  return (
    <a
      href={explorerTokenUrl(chainId, address)}
      target="_blank"
      rel="noreferrer noopener"
      className={`${styles.link} ${styles.external}`}
      title={address}
    >
      {label ?? shortAddress(address)}
    </a>
  )
}

export function TxLink({
  chainId,
  hash,
  label,
  full = false,
}: {
  chainId: number
  hash: string | null | undefined
  label?: string
  full?: boolean
}) {
  if (hash === null || hash === undefined || hash === '') {
    return <span className={styles.plain}>—</span>
  }
  return (
    <a
      href={explorerTxUrl(chainId, hash)}
      target="_blank"
      rel="noreferrer noopener"
      className={`${styles.link} ${styles.external}`}
      title={hash}
    >
      {label ?? (full ? hash : shortHash(hash))}
    </a>
  )
}

/**
 * A link to the canonical bytes an on-chain hash commits to.
 *
 * Always rendered next to the transaction that recorded it, so the path
 * attestation → transaction → bundle → recompute never leaves the page.
 */
export function EvidenceLink({
  hash,
  label,
}: {
  hash: string | null | undefined
  label?: string
}) {
  if (hash === null || hash === undefined || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return <span className={styles.plain}>—</span>
  }
  return (
    <a
      href={evidencePath(hash)}
      target="_blank"
      rel="noreferrer noopener"
      className={styles.evidence}
      title={`Evidence bundle ${hash} — the exact bytes this hash commits to`}
    >
      {label ?? shortHash(hash)}
    </a>
  )
}

export function HashText({ value, copy = true }: { value: string; copy?: boolean }) {
  if (!copy) return <span className={styles.plain}>{value}</span>
  return (
    <span className={styles.pair}>
      <span className={styles.plain}>{value}</span>
      <CopyButton value={value} label="Copy" />
    </span>
  )
}

export { CopyButton }
