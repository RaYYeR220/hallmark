import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Sans_Condensed, Space_Mono } from 'next/font/google'

import { SiteFooter } from '@/components/layout/SiteFooter'
import { Substrate } from '@/components/mycelium/Substrate'
import { SiteHeader } from '@/components/layout/SiteHeader'
import { THEME_BOOTSTRAP_SCRIPT } from '@/components/layout/ThemeToggle'
import { WalletProvider } from '@/components/wallet/WalletProvider'
import { BASE_URL } from '@/lib/site'

import '@/styles/fonts.css'
import '@/styles/tokens.css'
import '@/styles/base.css'

/*
 * Self-hosted at build time by `next/font`, so there is no third-party request
 * on load and no layout shift when they arrive. The third face, Bespoke
 * Stencil, is declared in fonts.css — see the note there about Fontshare's
 * protocol-relative URLs, which fail silently under any scheme but https.
 *
 * The CSS variables here are what `--font-sans` and `--font-mono` in
 * tokens.css resolve through.
 */
const plex = IBM_Plex_Sans_Condensed({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-plex-condensed',
  display: 'swap',
})

const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-space-mono',
  display: 'swap',
})

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
    <html
      lang="en"
      className={`${plex.variable} ${spaceMono.variable}`}
      suppressHydrationWarning
    >
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
        {/*
          The colony every page sits on. Server-rendered SVG from a fixed seed,
          so it is one continuous organism across routes rather than per-page
          ornament, and it needs no JavaScript to appear.
        */}
        <Substrate />
        <WalletProvider>
          <SiteHeader />
          <main id="main">{children}</main>
          <SiteFooter />
        </WalletProvider>
      </body>
    </html>
  )
}
