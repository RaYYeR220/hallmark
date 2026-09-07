'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { ConnectButton } from '@/components/wallet/ConnectButton'

import styles from './layout.module.css'
import { ThemeToggle } from './ThemeToggle'

type NavItem = {
  href: string
  label: string
  /** Extra path prefixes that should light this item up. */
  alsoMatches?: string[]
}

const NAV: NavItem[] = [
  // The hire flow is reached from discovery, so it keeps "Find an agent" lit
  // rather than leaving the reader with no highlighted section.
  { href: '/agents', label: 'Find an agent', alsoMatches: ['/hire/'] },
  { href: '/sessions', label: 'Sessions' },
  { href: '/proof', label: 'Proof' },
  { href: '/publish', label: 'List an agent' },
]

function isActive(pathname: string, item: NavItem): boolean {
  if (pathname === item.href) return true
  if (pathname.startsWith(`${item.href}/`)) return true
  return (item.alsoMatches ?? []).some((prefix) => pathname.startsWith(prefix))
}

export function SiteHeader() {
  const pathname = usePathname()

  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link href="/" className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            H
          </span>
          <span className={styles.brandName}>Hallmark</span>
        </Link>

        <nav className={styles.nav} aria-label="Primary">
          {NAV.map((item) => {
            const active = isActive(pathname, item)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${styles.navLink} ${active ? styles.navLinkActive : ''}`}
                aria-current={active ? 'page' : undefined}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>

        <div className={styles.headerActions}>
          <ConnectButton />
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
