import { LoadingTitle } from '@/components/ui/LoadingTitle'
import { Skeleton } from '@/components/ui'

import layout from '@/components/layout/layout.module.css'

export default function Loading() {
  return (
    <div className={`${layout.page} ${layout.pageWide}`}>
      <header className={layout.pageHeader}>
        <LoadingTitle
          title="Checking the evidence gate…"
          lead="Reading isHireable() from the escrow's own hook, so the answer on this page is the answer the contract will give."
        />
      </header>
      <Skeleton height="22rem" />
    </div>
  )
}
