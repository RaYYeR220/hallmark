import { Skeleton } from '@/components/ui'

import layout from '@/components/layout/layout.module.css'

export default function Loading() {
  return (
    <div className={`${layout.page} ${layout.pageWide}`}>
      <Skeleton height="1rem" width="16rem" />
      <div style={{ height: 'var(--sp-4)' }} />
      <Skeleton height="5rem" />
      <div style={{ height: 'var(--sp-5)' }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.9fr) minmax(0, 1fr)', gap: 'var(--sp-5)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
          <Skeleton height="18rem" />
          <Skeleton height="12rem" />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
          <Skeleton height="14rem" />
          <Skeleton height="10rem" />
        </div>
      </div>
    </div>
  )
}
