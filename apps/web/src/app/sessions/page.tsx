import type { Metadata } from 'next'
import { Suspense } from 'react'

import { AddressLink } from '@/components/chain/links'
import { RefusalFeed, SessionAddressForm, SessionList } from '@/components/sessions/SessionPanel'
import { RelativeTime } from '@/components/time/RelativeTime'
import { Card, CodeBlock, SectionHeading, Skeleton, SourceNote } from '@/components/ui'
import { chainLabel, getDeployment, type SupportedChainId } from '@/lib/deployments'
import {
  isValidAddress,
  KEYSTORE_ADDRESSES,
  readKeystore,
  verificationRecipe,
} from '@/lib/sessions'

import layout from '@/components/layout/layout.module.css'

export const metadata: Metadata = {
  title: 'Session control',
  description:
    'Every session key a wallet has granted, read live from the public Altana Keystore: what it ' +
    'may call, how much it may spend, when it expires, and whether it is still authorised.',
}

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

function one(params: SearchParams, key: string): string | null {
  const value = params[key]
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const chainId: SupportedChainId = one(params, 'chain') === '56' ? 56 : 97
  const addressRaw = one(params, 'address')
  const address = isValidAddress(addressRaw) ? addressRaw : null
  const serverNow = Date.now()
  const deployment = getDeployment(chainId)

  // A judge with no wallet still needs something real to look at, so the
  // attestor — which has actually written on-chain evidence — is offered as a
  // one-click example. It is a real address doing real work, not a fixture.
  const suggestions =
    deployment === null
      ? []
      : [{ label: `Hallmark's attestor (${deployment.attestor.slice(0, 8)}…)`, address: deployment.attestor }]

  return (
    <div className={layout.page}>
      <header className={layout.pageHeader}>
        <SectionHeading
          level={1}
          eyebrow={`${chainLabel(chainId)} · Altana Keystore`}
          title="Session control"
          lead="An agent you hired never holds your funds. It holds a key that names what it may call, caps what it may spend, and dies on a date you set — registered in a public Keystore that anybody, including you, can read without asking us."
        />
      </header>

      <SessionAddressForm chainId={chainId} address={address} suggestions={suggestions} />

      <Suspense key={`${chainId}-${address ?? 'none'}`} fallback={<KeysSkeleton />}>
        <Keys chainId={chainId} address={address} serverNow={serverNow} />
      </Suspense>

      <div style={{ marginTop: 'var(--sp-6)' }}>
        <RefusalFeed chainId={chainId} />
      </div>

      <div style={{ marginTop: 'var(--sp-5)' }}>
        <Card muted>
          <SectionHeading
            eyebrow="Check it yourself"
            title="Two calls, a public node, no credentials"
            level={3}
            lead="If verification needed our cooperation it would not be verification. Paste this into a terminal."
          />
          <CodeBlock>
            {verificationRecipe(
              chainId,
              (address ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
            )}
          </CodeBlock>
          <SourceNote>
            Keystore contract on {chainLabel(chainId)}:{' '}
            <AddressLink chainId={chainId} address={KEYSTORE_ADDRESSES[chainId]} full copy />
          </SourceNote>
        </Card>
      </div>
    </div>
  )
}

async function Keys({
  chainId,
  address,
  serverNow,
}: {
  chainId: SupportedChainId
  address: `0x${string}` | null
  serverNow: number
}) {
  if (address === null) {
    return (
      <SessionList
        chainId={chainId}
        address={null}
        keys={[]}
        accountUrl=""
        keystoreAddress={KEYSTORE_ADDRESSES[chainId]}
        readAt={new Date().toISOString()}
        error={null}
        serverNow={serverNow}
      />
    )
  }

  const view = await readKeystore(chainId, address)

  return (
    <>
      <SessionList
        chainId={chainId}
        address={view.address}
        keys={view.keys.map((key) => ({
          keyId: key.keyId,
          valid: key.valid,
          keystoreUrl: key.keystoreUrl,
        }))}
        accountUrl={view.accountUrl}
        keystoreAddress={view.keystoreAddress}
        readAt={view.readAt}
        error={view.error}
        serverNow={serverNow}
      />
      <SourceNote>
        <span>
          Read <RelativeTime value={view.readAt} serverNow={serverNow} /> from{' '}
          <code>getKeys(address)</code> and <code>isValidKey(address, keyId)</code> on{' '}
          <AddressLink chainId={chainId} address={view.keystoreAddress} /> · account page on the{' '}
          <a href={view.accountUrl} target="_blank" rel="noreferrer noopener">
            Altana Keystore explorer
          </a>
          . A false from <code>isValidKey</code> covers three different situations — never
          registered, revoked, expired — because that is all the contract reports. The explorer
          tells them apart.
        </span>
      </SourceNote>
    </>
  )
}

function KeysSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
      <Skeleton height="8rem" />
      <Skeleton height="8rem" />
    </div>
  )
}
