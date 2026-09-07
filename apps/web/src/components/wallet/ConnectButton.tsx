'use client'

import { useEffect, useRef, useState } from 'react'

import { chainLabel } from '@/lib/deployments'
import { shortAddress } from '@/lib/format'

import { useWallet } from './WalletProvider'
import styles from './wallet.module.css'

/**
 * The header's wallet control.
 *
 * Connecting is optional everywhere in the app: discovery, evidence and proof
 * are entirely read-only, and the hire flow has a sponsored path that needs no
 * wallet at all. So this never blocks anything, and the menu says so when no
 * wallet is installed rather than dead-ending.
 */
export function ConnectButton() {
  const wallet = useWallet()
  const [open, setOpen] = useState(false)
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (container.current?.contains(event.target as Node) !== true) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const known = wallet.chainId === 56 || wallet.chainId === 97

  return (
    <div className={styles.connect} ref={container}>
      <button
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={wallet.status === 'connecting'}
        onClick={() => setOpen((value) => !value)}
      >
        {wallet.status === 'connected' && wallet.address !== null ? (
          <>
            <span
              className={`${styles.chainDot} ${known ? '' : styles.chainDotWarn}`}
              aria-hidden="true"
            />
            <span className={styles.address}>{shortAddress(wallet.address, 6)}</span>
          </>
        ) : wallet.status === 'connecting' ? (
          'Connecting…'
        ) : (
          'Connect'
        )}
      </button>

      {open && (
        <div className={styles.menu} role="menu">
          {wallet.status === 'connected' && wallet.address !== null ? (
            <>
              <span className={styles.menuHeading}>Connected</span>
              <p className={styles.menuNote}>
                {shortAddress(wallet.address, 10)} on{' '}
                {known ? chainLabel(wallet.chainId ?? 0) : `chain ${wallet.chainId ?? '?'}`}
                {known
                  ? ''
                  : ' — Hallmark only reads BNB Smart Chain (56) and BNB testnet (97).'}
              </p>
              <hr className={styles.menuDivider} />
              {wallet.chainId !== 97 && (
                <button
                  type="button"
                  className={styles.menuItem}
                  role="menuitem"
                  onClick={() => {
                    void wallet.switchChain(97)
                    setOpen(false)
                  }}
                >
                  Switch to BNB testnet
                </button>
              )}
              {wallet.chainId !== 56 && (
                <button
                  type="button"
                  className={styles.menuItem}
                  role="menuitem"
                  onClick={() => {
                    void wallet.switchChain(56)
                    setOpen(false)
                  }}
                >
                  Switch to BNB Smart Chain
                </button>
              )}
              <button
                type="button"
                className={styles.menuItem}
                role="menuitem"
                onClick={() => {
                  wallet.disconnect()
                  setOpen(false)
                }}
              >
                Forget this connection
              </button>
              <p className={styles.menuNote}>
                Forgetting drops the site&rsquo;s reference to your wallet. Your wallet still
                lists this site until you remove it there — saying otherwise would be a lie about
                a permission you actually granted.
              </p>
            </>
          ) : wallet.available.length === 0 ? (
            <>
              <span className={styles.menuHeading}>No wallet found</span>
              <p className={styles.menuNote}>
                No browser wallet announced itself. You do not need one to use Hallmark: every
                agent page, the evidence timeline and the proof page are read-only, and the hire
                flow has a sponsored testnet path that needs no wallet.
              </p>
            </>
          ) : (
            <>
              <span className={styles.menuHeading}>Choose a wallet</span>
              {wallet.available.map((info) => (
                <button
                  key={info.rdns}
                  type="button"
                  className={styles.menuItem}
                  role="menuitem"
                  onClick={() => {
                    void wallet.connect(info.rdns)
                    setOpen(false)
                  }}
                >
                  {info.icon !== '' && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className={styles.menuIcon} src={info.icon} alt="" aria-hidden="true" />
                  )}
                  {info.name}
                </button>
              ))}
            </>
          )}

          {wallet.error !== null && <p className={styles.menuError}>{wallet.error}</p>}
        </div>
      )}
    </div>
  )
}
