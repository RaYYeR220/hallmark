import type { Metadata, Viewport } from 'next'

import { SiteFooter } from '@/components/layout/SiteFooter'
import { SiteHeader } from '@/components/layout/SiteHeader'
import { THEME_BOOTSTRAP_SCRIPT } from '@/components/layout/ThemeToggle'
import { WalletProvider } from '@/components/wallet/WalletProvider'
import { BASE_URL } from '@/lib/site'

import '@/styles/tokens.css'
import '@/styles/base.css'

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: 'Hallmark — hire an ERC-8004 agent on BNB Chain, and hold the leash',
    template: '%s · Hallmark',
  },
  description:
    'Every ERC-8004 agent on BNB Smart Chain, continuously probed, with the evidence published on-chain. ' +
    'Hire one in a click; it works under a session key scoped to a contract allowlist, a spend cap and an ' +
    'expiry you can revoke at any time.',
  applicationName: 'Hallmark',
  openGraph: {
    type: 'website',
    siteName: 'Hallmark',
    url: BASE_URL,
    title: 'Hallmark — the trust layer for ERC-8004 agents on BNB Chain',
    description:
      'Ratings that are on-chain attestations, not stars. Hire an agent under a session key you can revoke.',
  },
  twitter: { card: 'summary_large_image' },
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Both, so the browser paints its own chrome and any transparent surface
  // correctly before our stylesheet lands.
  colorScheme: 'light dark',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Applies the stored theme before first paint. The alternative is a
          flash of the wrong palette on every navigation, which is worse than
          one inline script over a constant string.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <WalletProvider>
          <SiteHeader />
          <main id="main">{children}</main>
          <SiteFooter />
        </WalletProvider>
      </body>
    </html>
  )
}
