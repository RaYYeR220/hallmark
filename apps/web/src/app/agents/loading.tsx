import { AgentListSkeleton } from '@/components/agents/AgentList'
import { LoadingTitle } from '@/components/ui/LoadingTitle'
import { Skeleton } from '@/components/ui'

import layout from '@/components/layout/layout.module.css'

export default function Loading() {
  return (
    <div className={`${layout.page} ${layout.pageWide}`}>
      <header className={layout.pageHeader}>
        <LoadingTitle eyebrow="ERC-8004" title="Find an agent" />
      </header>
      <Skeleton height="9rem" />
      <div style={{ height: 'var(--sp-5)' }} />
      <AgentListSkeleton />
    </div>
  )
}
