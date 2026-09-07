'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState, useTransition } from 'react'

import { testScope } from '@/app/actions/scope'
import {
  SCOPE_ATTEMPTS,
  type ScopeAttemptId,
  type ScopeVerdictResult,
} from '@/lib/scopeAttempts'
import { Countdown, RelativeTime } from '@/components/time/RelativeTime'
import { Badge, Button, Callout, Card, EmptyState, Meter, SectionHeading, SourceNote } from '@/components/ui'
import { useWallet } from '@/components/wallet/WalletProvider'
import { CATEGORY_LIST } from '@/lib/categories'
import { chainLabel } from '@/lib/deployments'
import { formatDateTime, formatUnitsFixed, percentOf, shortAddress } from '@/lib/format'
import type { HallmarkCategory } from '@/lib/categories'

import { listLocalSessions, spendByToken, type LocalSession } from './localSessions'
import styles from './sessions.module.css'

/**
 * The control panel: where enforcement stops being a claim.
 *
 * Three things are shown together, and the difference between them is never
 * blurred:
 *
 *  - What the chain says. `getKeys` and `isValidKey`, read live from a public
 *    node, for any address at all. This is the part a sceptic can reproduce.
 *  - What this device remembers. The scope, cap and expiry of sessions granted
 *    in this browser, because the Keystore does not store them and Hallmark
 *    has no database that could.
 *  - What the policy engine decides. A live scope test, running the same
 *    `checkScope` an agent's own execution path runs.
 */

export type KeyView = {
  keyId: string
  valid: boolean
  keystoreUrl: string
}

export type SessionPanelProps = {
  chainId: number
  address: string | null
  keys: KeyView[]
  accountUrl: string
  keystoreAddress: string
  readAt: string
  error: string | null
  serverNow: number
}

export function SessionAddressForm({
  chainId,
  address,
  suggestions,
}: {
  chainId: number
  address: string | null
  suggestions: { label: string; address: string }[]
}) {
  const router = useRouter()
  const params = useSearchParams()
  const wallet = useWallet()
  const [value, setValue] = useState(address ?? '')
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    setValue(address ?? '')
  }, [address])

  // Following the connected wallet is the behaviour someone expects; doing it
  // only when the field is empty keeps a deliberately-typed address stable.
  useEffect(() => {
    if (wallet.address !== null && address === null) {
      const next = new URLSearchParams(params.toString())
      next.set('address', wallet.address)
      next.set('chain', String(wallet.chainId === 56 ? 56 : 97))
      startTransition(() => router.replace(`/sessions?${next.toString()}`, { scroll: false }))
    }
  }, [wallet.address, wallet.chainId, address, params, router])

  const submit = (nextAddress: string, nextChain: number) => {
    const next = new URLSearchParams()
    if (nextAddress.trim() !== '') next.set('address', nextAddress.trim())
    next.set('chain', String(nextChain))
    startTransition(() =>
      router.push(`/sessions?${next.toString()}`, { scroll: false }),
    )
  }

  return (
    <form
      className={styles.lookup}
      onSubmit={(event) => {
        event.preventDefault()
        submit(value, chainId)
      }}
    >
      <div className={styles.lookupField}>
        <label className={styles.label} htmlFor="session-address">
          Wallet address
        </label>
        <input
          id="session-address"
          className={styles.input}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
        />
        <span className={styles.hint}>
          Anyone&rsquo;s. The Keystore is public and these reads need no credentials — that is the
          whole point of putting authorisation on-chain.
        </span>
      </div>

      <div className={styles.lookupField} style={{ flex: '0 0 auto' }}>
        <label className={styles.label} htmlFor="session-chain">
          Chain
        </label>
        <select
          id="session-chain"
          className={styles.select}
          value={chainId}
          onChange={(event) => submit(value, Number(event.target.value))}
        >
          <option value={56}>BNB Smart Chain</option>
          <option value={97}>BNB testnet</option>
        </select>
      </div>

      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? 'Reading…' : 'Read the Keystore'}
      </Button>

      {wallet.status !== 'connected' && (
        <Button type="button" onClick={() => void wallet.connect()}>
          Use my wallet
        </Button>
      )}

      {suggestions.length > 0 && (
        <div style={{ flexBasis: '100%', display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
          <span className={styles.hint}>Or look at:</span>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.address}
              type="button"
              className={styles.hint}
              style={{
                textDecoration: 'underline',
                cursor: 'pointer',
                background: 'none',
                border: 'none',
                color: 'var(--text-accent)',
              }}
              onClick={() => {
                setValue(suggestion.address)
                submit(suggestion.address, chainId)
              }}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      )}
    </form>
  )
}

export function SessionList({
  chainId,
  address,
  keys,
  accountUrl,
  readAt,
  error,
  serverNow,
}: SessionPanelProps) {
  const [local, setLocal] = useState<LocalSession[]>([])

  useEffect(() => {
    setLocal(listLocalSessions(chainId, address ?? undefined))
  }, [chainId, address])

  if (address === null) {
    return (
      <EmptyState title="Point it at an address.">
        <p>
          Every session key Hallmark grants is registered in Altana&rsquo;s public Keystore, and
          the Keystore answers to anyone. Paste a wallet address above, or connect yours, and this
          page will read its keys straight off {chainLabel(chainId)} — no account, no API key, no
          trust in us.
        </p>
      </EmptyState>
    )
  }

  if (error !== null) {
    return (
      <Callout tone="bad" title="The Keystore read failed" role="alert">
        <p>{error}</p>
        <p>
          This page shows nothing rather than showing zero keys — an empty list and a failed read
          are different facts and would be dishonest to conflate.
        </p>
      </Callout>
    )
  }

  const localByKeyId = new Map(local.map((session) => [session.keyId.toLowerCase(), session]))

  if (keys.length === 0) {
    return (
      <EmptyState title={`${shortAddress(address, 8)} has never granted a session key.`}>
        <p>
          The Altana Keystore holds no keys for this wallet on {chainLabel(chainId)}. That is the
          normal state for an address that has not hired an agent yet, and it is a genuine chain
          read — <code>getKeys</code> returned an empty array{' '}
          <RelativeTime value={readAt} serverNow={serverNow} />.
        </p>
        <p>
          <Link href="/agents">Find an agent to hire →</Link>
        </p>
      </EmptyState>
    )
  }

  return (
    <ul className={styles.keys}>
      {keys.map((key) => {
        const session = localByKeyId.get(key.keyId.toLowerCase()) ?? null
        return (
          <li key={key.keyId} className={styles.key}>
            <div className={styles.keyHead}>
              <div className={styles.keyTitle}>
                <Badge tone={key.valid ? 'ok' : 'neutral'} dot>
                  {key.valid ? 'Authorised' : 'Not authorised'}
                </Badge>
                {session !== null && <Badge tone="accent">{session.label}</Badge>}
                <span className={styles.keyId}>{key.keyId}</span>
              </div>
              <a href={key.keystoreUrl} target="_blank" rel="noreferrer noopener">
                Keystore ↗
              </a>
            </div>

            <div className={styles.keyBody}>
              <div>
                <p className={styles.label} style={{ marginBottom: 'var(--sp-2)' }}>
                  What it may do
                </p>
                {session === null ? (
                  <p className={styles.hint}>
                    This key was granted somewhere other than this browser, so its scope is not
                    stored here. The chain proves it exists and whether it is still valid; it does
                    not record the permissions attached. Hallmark keeps no server-side copy of
                    what you have authorised — that is deliberate, and this gap is the cost of it.
                  </p>
                ) : (
                  <ul className={styles.scopeList}>
                    {session.sentences.map((sentence) => {
                      const isCannot = sentence.startsWith('Cannot')
                      const isCan = sentence.startsWith('Can ')
                      return (
                        <li key={sentence} className={styles.scopeItem}>
                          <span
                            className={`${styles.scopeGlyph} ${
                              isCannot ? styles.cannot : isCan ? styles.can : styles.neutral
                            }`}
                            aria-hidden="true"
                          >
                            {isCannot ? '✕' : isCan ? '✓' : '·'}
                          </span>
                          <span>{sentence}</span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              <div className={styles.meters}>
                {session !== null && (
                  <>
                    {session.caps.map((cap) => {
                      const used = spendByToken(session).get(cap.token.toLowerCase()) ?? 0n
                      const limit = BigInt(cap.limitAtomic)
                      const remaining = limit > used ? limit - used : 0n
                      return (
                        <div key={cap.token} className={styles.meterBlock}>
                          <div className={styles.meterHead}>
                            <span>{cap.symbol} spend cap</span>
                            <span>per {cap.period}</span>
                          </div>
                          <Meter
                            percent={percentOf(used, limit)}
                            label={`${cap.symbol} spend against its cap`}
                            left={`${formatUnitsFixed(used, cap.decimals)} used`}
                            right={`${formatUnitsFixed(remaining, cap.decimals)} of ${formatUnitsFixed(
                              limit,
                              cap.decimals,
                            )} left`}
                          />
                        </div>
                      )
                    })}

                    <div className={styles.expiry}>
                      <span className={styles.label}>Expires in</span>
                      <span className={styles.expiryValue}>
                        <Countdown expiresAt={session.expiresAt} serverNow={serverNow} />
                      </span>
                    </div>
                  </>
                )}

                <p className={styles.hint}>
                  {session === null
                    ? 'Validity above is a live eth_call. Everything else about this key lives with whoever granted it.'
                    : 'Spend is what this browser recorded asking the key to do. The relay enforces the real rolling window and is the authority on it — we do not claim to read it.'}
                </p>
              </div>
            </div>

            <div className={styles.keyActions}>
              {session === null ? (
                <span className={styles.hint}>
                  Revoking needs the admin signer that granted this key, which lives with the
                  device that made the grant. Revoke it from there, or from the Altana Keystore
                  explorer.
                </span>
              ) : (
                <>
                  <a
                    href={key.keystoreUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{ fontSize: 'var(--fs-sm)' }}
                  >
                    Revoke in the Altana Keystore ↗
                  </a>
                  <span className={styles.hint}>
                    One transaction, effective immediately. This page will show it as no longer
                    authorised on the next read — same call, same node, no cache.
                  </span>
                </>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/* ------------------------------------------------------------------ */
/* the refusal feed                                                    */
/* ------------------------------------------------------------------ */

export function RefusalFeed({ chainId }: { chainId: number }) {
  const [category, setCategory] = useState<HallmarkCategory>('health-factor')
  const [results, setResults] = useState<ScopeVerdictResult[]>([])
  const [pending, setPending] = useState<ScopeAttemptId | null>(null)

  const run = useCallback(
    async (attempt: ScopeAttemptId) => {
      setPending(attempt)
      try {
        const result = await testScope({ attempt, category, chainId })
        setResults((previous) => [result, ...previous].slice(0, 12))
      } finally {
        setPending(null)
      }
    },
    [category, chainId],
  )

  return (
    <Card>
      <SectionHeading
        eyebrow="Refusals"
        title="Make the key say no"
        lead="These buttons run the real scope check — the same function an agent's execution path runs before it touches the relay — against the real policy for the category you pick. Nothing reaches a chain and nothing is mocked. A refusal here is the value a live agent would receive, word for word."
      />

      <div style={{ marginBottom: 'var(--sp-4)' }}>
        <Callout tone="neutral" title="What a refusal looks like further down the stack">
          <p>
            The check below runs locally, before anything is sent. If a call gets past it, the
            relay applies the same policy again and refuses <em>by name</em>: an over-cap spend
            comes back as <code>ExceededSpendLimit</code> and an off-allowlist call as{' '}
            <code>UnauthorizedCall</code>, each naming the key hash, the target and the calldata,
            raised at <code>wallet_prepareCalls</code> before a bundle exists at all.
          </p>
          <p>
            So there is no transaction, no gas, and no status code to read — the refusal is a typed
            error, which is better evidence than a number.{' '}
            <a
              href="https://github.com/hallmark"
              target="_blank"
              rel="noreferrer noopener"
            >
              @hallmark/altana
            </a>{' '}
            currently classifies those two as <code>reverted</code> rather than <code>refused</code>
            ; that is a known misclassification in the package and is documented there.
          </p>
        </Callout>
      </div>

      <div className={styles.attempts}>
        <select
          className={styles.select}
          value={category}
          onChange={(event) => setCategory(event.target.value as HallmarkCategory)}
          aria-label="Which policy to test"
        >
          {CATEGORY_LIST.map((definition) => (
            <option key={definition.id} value={definition.id}>
              {definition.label} policy
            </option>
          ))}
        </select>
      </div>

      <div className={styles.attempts}>
        {SCOPE_ATTEMPTS.map((attempt) => (
          <Button
            key={attempt.id}
            size="small"
            variant={attempt.id === 'in-scope' ? 'default' : 'danger'}
            onClick={() => void run(attempt.id)}
            disabled={pending !== null}
            title={attempt.intent}
          >
            {pending === attempt.id ? 'Checking…' : attempt.label}
          </Button>
        ))}
      </div>

      {results.length === 0 ? (
        <EmptyState title="Nothing attempted yet.">
          <p>
            Press one of the buttons above. The interesting ones are the red ones: a session key
            that cannot be made to refuse has not demonstrated anything.
          </p>
        </EmptyState>
      ) : (
        <ul className={styles.feed}>
          {results.map((result, index) => (
            <li
              key={`${result.attempt}-${result.at}-${index}`}
              className={`${styles.feedItem} ${
                result.allowed ? styles.feedAllowed : styles.feedRefused
              }`}
            >
              <span className={styles.feedGlyph} aria-hidden="true">
                {result.allowed ? '✓' : '⦸'}
              </span>
              <div>
                <div className={styles.feedTitle}>
                  <span>{result.label}</span>
                  {result.reason !== null && <Badge tone="warn">{result.reason}</Badge>}
                  <span className={styles.feedTime}>{formatDateTime(result.at)}</span>
                </div>
                <p className={styles.feedDetail}>{result.detail}</p>
                <div className={styles.feedMeta}>
                  <span>to {shortAddress(result.target, 10)}</span>
                  {result.selector !== null && <span>selector {result.selector}</span>}
                  <span>value {formatUnitsFixed(BigInt(result.value), 18)} BNB</span>
                  <span>cap at the time: {result.capLabel}</span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <SourceNote>
        Runs <code>checkScope()</code> from <code>@hallmark/altana</code> over{' '}
        <code>buildPolicy()</code>&rsquo;s output. The reasons — <code>call-not-allowed</code>,{' '}
        <code>spend-cap</code>, <code>session-expired</code> — are the SDK&rsquo;s own, not copy
        written for this page. The relay&rsquo;s equivalents, one layer down, are{' '}
        <code>UnauthorizedCall</code> and <code>ExceededSpendLimit</code>.
      </SourceNote>
    </Card>
  )
}
