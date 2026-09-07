import { ButtonLink, Card, SectionHeading } from '@/components/ui'

import layout from '@/components/layout/layout.module.css'

export default function NotFound() {
  return (
    <div className={layout.page}>
      <Card>
        <SectionHeading
          level={1}
          eyebrow="404"
          title="Nothing at this address"
          lead="If you were looking for an agent, the id may never have been minted — the ERC-8004 Identity Registry is not enumerable and its ids are not dense, so plenty of numbers in the range simply do not exist."
        />
        <div style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
          <ButtonLink href="/agents" variant="primary">
            Find an agent
          </ButtonLink>
          <ButtonLink href="/">Home</ButtonLink>
        </div>
      </Card>
    </div>
  )
}
