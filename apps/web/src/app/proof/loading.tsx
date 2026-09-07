import { LoadingTitle } from '@/components/ui/LoadingTitle'
import { Skeleton } from '@/components/ui'

import layout from '@/components/layout/layout.module.css'

export default function Loading() {
  return (
    <div className={layout.page}>
      <header className={layout.pageHeader}>
        <LoadingTitle
          eyebrow="Verify"
          title="Reading the chain…"
          lead="Nothing on this page is cached, so it is being read from BNB Chain right now."
        />
      </header>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <Skeleton height="12rem" />
        <Skeleton height="10rem" />
      </div>
    </div>
  )
}
