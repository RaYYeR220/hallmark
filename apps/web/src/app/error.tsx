'use client'

import { useEffect } from 'react'

import { ButtonLink, Callout, Card, SectionHeading } from '@/components/ui'
import { Button } from '@/components/ui'

import layout from '@/components/layout/layout.module.css'

/**
 * The whole-app error boundary.
 *
 * Says what broke in the terms the reader actually needs: this product reads
 * two public chains and one public index, and when a page fails it is almost
 * always one of those three being slow or rate-limiting us. Naming that is
 * more useful than "Something went wrong", and retrying really can fix it.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Server digests are opaque by design; logging keeps the correlation id
    // reachable from the browser console when someone reports a page.
    console.error('Hallmark page error', error.digest ?? error.message)
  }, [error])

  return (
    <div className={layout.page}>
      <Card>
        <SectionHeading
          level={1}
          eyebrow="Error"
          title="This page could not be assembled"
          lead="Hallmark reads BNB Chain and a public index live on every request, with no database in between. When a page fails it is nearly always one of those upstreams timing out or rate-limiting us — which usually clears on a retry."
        />

        <Callout tone="bad" title="What happened">
          <p>{error.message || 'The request failed before it produced a page.'}</p>
          {error.digest !== undefined && (
            <p>
              Server digest <code>{error.digest}</code>
            </p>
          )}
        </Callout>

        <div style={{ marginTop: 'var(--sp-5)', display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
          <Button variant="primary" onClick={reset}>
            Try again
          </Button>
          <ButtonLink href="/agents">Back to discovery</ButtonLink>
          <ButtonLink href="/proof">Check what is live</ButtonLink>
        </div>
      </Card>
    </div>
  )
}
