import { AddressLink } from '@/components/chain/links'
import { ButtonLink, Callout, Card, SectionHeading } from '@/components/ui'
import { CHAIN_IDS, chainLabel, registries } from '@/lib/deployments'

import layout from '@/components/layout/layout.module.css'

/**
 * A missing agent id is not an error, it is a fact about the registry.
 *
 * The ERC-8004 Identity Registry is ERC-721 but not Enumerable: ids are minted
 * sequentially but ownership can be burned, and the id space is far larger than
 * the number of agents. `ownerOf` reverting is the normal, correct answer for
 * most numbers, and saying so is more useful than "404".
 */
export default function AgentNotFound() {
  return (
    <div className={layout.page}>
      <Card>
        <SectionHeading
          level={1}
          eyebrow="No such agent"
          title="Nothing is registered under that id"
          lead="Both checks came back empty: ownerOf reverted on the Identity Registry, and the public index has no row for it either. Hallmark will not render a page for an agent that does not exist."
        />

        <Callout tone="info" title="Why this happens more often than you would expect">
          <p>
            The registry is ERC-721 based but not Enumerable — there is no{' '}
            <code>totalSupply()</code>, and agent ids do not form a dense range. Plenty of numbers
            inside the range simply were never minted, and Hallmark finds the highest one by
            bisecting <code>ownerOf</code> rather than iterating.
          </p>
          <p>
            It also happens when the id exists on the other chain. The two registries are separate
            deployments with separate id spaces: agent #42 on mainnet and agent #42 on testnet are
            unrelated.
          </p>
        </Callout>

        <div style={{ marginTop: 'var(--sp-5)', display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
          {CHAIN_IDS.map((chainId) => (
            <ButtonLink key={chainId} href={`/agents?chain=${chainId}`}>
              Browse {chainLabel(chainId)}
            </ButtonLink>
          ))}
          <ButtonLink href="/agents" variant="primary">
            Search all agents
          </ButtonLink>
        </div>

        <div style={{ marginTop: 'var(--sp-5)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          Check for yourself:{' '}
          {CHAIN_IDS.map((chainId, index) => (
            <span key={chainId}>
              {index > 0 && ' · '}
              <AddressLink
                chainId={chainId}
                address={registries(chainId).identityRegistry}
                label={`${chainLabel(chainId)} registry`}
              />
            </span>
          ))}
        </div>
      </Card>
    </div>
  )
}
