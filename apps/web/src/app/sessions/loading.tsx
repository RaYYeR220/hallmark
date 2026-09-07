import { LoadingTitle } from '@/components/ui/LoadingTitle'
import { Skeleton } from '@/components/ui'

import layout from '@/components/layout/layout.module.css'

export default function Loading() {
  return (
    <div className={layout.page}>
      <header className={layout.pageHeader}>
        <LoadingTitle eyebrow="Altana Keystore" title="Session control" />
      </header>
      <Skeleton height="5rem" />
      <div style={{ height: 'var(--sp-5)' }} />
      <Skeleton height="14rem" />
    </div>
  )
}
