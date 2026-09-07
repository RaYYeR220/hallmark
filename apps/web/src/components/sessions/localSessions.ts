'use client'

/**
 * The device-local record of sessions this browser granted.
 *
 * The Keystore is authoritative about which keys exist and whether they are
 * still valid, and it is read live. But the Keystore stores no permissions, no
 * expiry and no spending — those exist only in the grant, which lives with
 * whoever made it. Since Hallmark has no database, "whoever made it" is this
 * browser.
 *
 * That limitation is stated on the page rather than papered over: a session
 * granted on another device shows up in the key list with its live validity and
 * an explicit "granted elsewhere — this device does not hold its scope". The
 * alternative would be a server-side store of what users have authorised, which
 * is precisely the kind of thing this project exists to avoid.
 */

const STORAGE_KEY = 'hallmark.sessions.v1'

export type SpendRecord = {
  at: string
  /** Atomic units of `token`. */
  amount: string
  token: string
  symbol: string
  decimals: number
  note: string
  txHash: string | null
}

export type LocalSession = {
  chainId: number
  walletAddress: string
  keyId: string
  publicKey: string | null
  label: string
  category: string
  agentId: number | null
  agentName: string | null
  /** `describePolicy` output, captured at grant time. */
  sentences: string[]
  caps: { token: string; symbol: string; decimals: number; limitAtomic: string; period: string }[]
  /** Unix seconds. */
  expiresAt: number
  grantedAt: number
  txHash: string | null
  spend: SpendRecord[]
}

function read(): LocalSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as LocalSession[]) : []
  } catch {
    // Private browsing, disabled storage, or a corrupted value. An empty list
    // is the correct answer in all three cases.
    return []
  }
}

function write(sessions: LocalSession[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
  } catch {
    // Nothing to do. The page still works; it just will not remember.
  }
}

export function listLocalSessions(chainId?: number, address?: string): LocalSession[] {
  const all = read()
  return all
    .filter((session) => chainId === undefined || session.chainId === chainId)
    .filter(
      (session) =>
        address === undefined ||
        session.walletAddress.toLowerCase() === address.toLowerCase(),
    )
    .sort((a, b) => b.grantedAt - a.grantedAt)
}

export function findLocalSession(keyId: string): LocalSession | null {
  return read().find((session) => session.keyId.toLowerCase() === keyId.toLowerCase()) ?? null
}

export function saveLocalSession(session: LocalSession): void {
  const all = read().filter(
    (existing) => existing.keyId.toLowerCase() !== session.keyId.toLowerCase(),
  )
  all.push(session)
  write(all)
}

export function recordSpend(keyId: string, record: SpendRecord): void {
  const all = read()
  const session = all.find((entry) => entry.keyId.toLowerCase() === keyId.toLowerCase())
  if (session === undefined) return
  session.spend.push(record)
  write(all)
}

export function forgetLocalSession(keyId: string): void {
  write(read().filter((session) => session.keyId.toLowerCase() !== keyId.toLowerCase()))
}

/**
 * What this device has seen spent through a key, per token.
 *
 * Explicitly *not* the relay's rolling-window figure — we cannot read that,
 * and the UI says so beside every meter. This is a local ledger of what
 * Hallmark itself asked the key to do.
 */
export function spendByToken(session: LocalSession): Map<string, bigint> {
  const totals = new Map<string, bigint>()
  for (const record of session.spend) {
    const key = record.token.toLowerCase()
    try {
      totals.set(key, (totals.get(key) ?? 0n) + BigInt(record.amount))
    } catch {
      // A malformed record from an older schema. Skip it rather than throwing
      // away the whole session.
    }
  }
  return totals
}
