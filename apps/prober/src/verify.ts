/**
 * The audit path.
 *
 * A judge should not have to trust the prober. They should be able to take a
 * `feedbackHash` off BNB Chain, fetch the document the `feedbackURI` points
 * at, hash it themselves, and get the same 32 bytes. This file is that check,
 * automated: fetch, re-canonicalise, re-hash, and compare against what the
 * ERC-8004 registries actually recorded.
 *
 * Three things are asserted, and all three have to hold:
 *
 *   1. The served bytes hash to the name they are served under.
 *   2. The served bytes are already canonical, so re-serialising them cannot
 *      change the hash.
 *   3. Some on-chain record — a Reputation `feedbackHash` or a Validation
 *      `responseHash` — carries exactly that value.
 */

import { keccak256, toBytes } from 'viem'

import { ScanClient, canonicalize, getChain, reputationRegistryAbi } from '@hallmark/core'
import type { RegistryReader, SupportedChainId } from '@hallmark/core'

import { evidenceUri } from './evidence.ts'
import { httpRequest } from './probe/http.ts'
import type { EvidenceStore } from './store.ts'
import type { ProbeEvidenceBundle } from './types.ts'

export type ReputationMatch = {
  client: string
  index: number
  feedbackHash: string | null
  feedbackUri: string | null
  txHash: string | null
  match: boolean
  source: 'scan' | 'logs'
}

export type ValidationMatch = {
  requestHash: string
  validator: string
  response: number
  responseHash: string
  tag: string
  lastUpdate: string
  match: boolean
}

export type VerifyVerdict = 'ok' | 'no-onchain-record' | 'hash-mismatch' | 'not-canonical' | 'unfetchable'

export type VerifyReport = {
  verdict: VerifyVerdict
  source: string
  declaredHash: string
  computedHash: string | null
  canonical: boolean
  bytes: number
  chainId: number | null
  agentId: number | null
  score: number | null
  probedAt: string | null
  scorer: string | null
  reputation: ReputationMatch[]
  validation: ValidationMatch[]
  problems: string[]
}

export type VerifyOptions = {
  chainId: SupportedChainId
  reader: RegistryReader
  store?: EvidenceStore
  scan?: ScanClient
  evidenceBaseUrl: string
  /** How far back the `getLogs` fallback walks when the indexer has nothing. */
  logLookbackBlocks?: bigint
  /** Per-request block window. Public BSC nodes reject anything wider than 50,000. */
  logWindowBlocks?: bigint
  timeoutMs?: number
}

/**
 * About 10 hours of BSC blocks at 0.75s, which is roughly as far back as a
 * public node will serve: `bsc-testnet-rpc.publicnode.com` prunes older history
 * and caps a single `eth_getLogs` window at 50,000 blocks. The 8004scan index
 * is the primary lookup for exactly this reason; logs are the fallback that
 * proves the indexer right for recent writes.
 */
const DEFAULT_LOG_LOOKBACK = 50_000n
const DEFAULT_LOG_WINDOW = 50_000n

/** `hashOrUrl` is either a 0x… evidence hash or the URL a `feedbackURI` points at. */
export async function verifyEvidence(hashOrUrl: string, options: VerifyOptions): Promise<VerifyReport> {
  const problems: string[] = []
  const fetched = await fetchDocument(hashOrUrl, options)

  if (fetched === null) {
    return {
      verdict: 'unfetchable',
      source: hashOrUrl,
      declaredHash: normalizeHash(hashOrUrl) ?? '(unknown)',
      computedHash: null,
      canonical: false,
      bytes: 0,
      chainId: null,
      agentId: null,
      score: null,
      probedAt: null,
      scorer: null,
      reputation: [],
      validation: [],
      problems: [`could not fetch an evidence document for "${hashOrUrl}"`],
    }
  }

  const { text, source, declaredHash } = fetched

  let bundle: ProbeEvidenceBundle
  try {
    bundle = JSON.parse(text) as ProbeEvidenceBundle
  } catch (err) {
    return {
      verdict: 'unfetchable',
      source,
      declaredHash: declaredHash ?? '(unknown)',
      computedHash: null,
      canonical: false,
      bytes: text.length,
      chainId: null,
      agentId: null,
      score: null,
      probedAt: null,
      scorer: null,
      reputation: [],
      validation: [],
      problems: [`document is not JSON: ${messageOf(err)}`],
    }
  }

  const canonicalText = canonicalize(bundle)
  const computedHash = keccak256(toBytes(canonicalText))
  const canonical = canonicalText === text
  if (!canonical) {
    problems.push(
      'document is not stored in canonical form; it still hashes correctly only because we re-canonicalised it before hashing',
    )
  }

  const declared = declaredHash === null ? computedHash : declaredHash
  const hashMatches = declared.toLowerCase() === computedHash.toLowerCase()
  if (!hashMatches) {
    problems.push(`document hashes to ${computedHash} but was served as ${declared}`)
  }

  const chainId = typeof bundle.chainId === 'number' ? bundle.chainId : null
  const agentId = typeof bundle.agentId === 'number' ? bundle.agentId : null

  let reputation: ReputationMatch[] = []
  let validation: ValidationMatch[] = []

  if (agentId !== null) {
    const lookup = await findReputationRecords(agentId, computedHash, options).catch((err: unknown) => {
      problems.push(`reputation lookup failed: ${messageOf(err)}`)
      return { records: [], note: null }
    })
    reputation = lookup.records
    if (lookup.note !== null) problems.push(lookup.note)
    validation = await findValidationRecords(agentId, computedHash, options).catch((err: unknown) => {
      problems.push(`validation lookup failed: ${messageOf(err)}`)
      return []
    })
  }

  const onChainMatch = reputation.some((r) => r.match) || validation.some((v) => v.match)

  const verdict: VerifyVerdict = !hashMatches
    ? 'hash-mismatch'
    : !canonical
      ? 'not-canonical'
      : onChainMatch
        ? 'ok'
        : 'no-onchain-record'

  if (verdict === 'no-onchain-record') {
    problems.push('the document verifies, but no ERC-8004 record on this chain carries its hash yet')
  }

  return {
    verdict,
    source,
    declaredHash: declared,
    computedHash,
    canonical,
    bytes: text.length,
    chainId,
    agentId,
    score: typeof bundle.score === 'number' ? bundle.score : null,
    probedAt: typeof bundle.probedAt === 'string' ? bundle.probedAt : null,
    scorer: bundle.scorer === undefined ? null : `${bundle.scorer.name} ${bundle.scorer.version}`,
    reputation,
    validation,
    problems,
  }
}

export function formatVerifyReport(report: VerifyReport): string {
  const lines: string[] = []
  lines.push(`source        ${report.source}`)
  lines.push(`bytes         ${report.bytes}`)
  lines.push(`declared      ${report.declaredHash}`)
  lines.push(`computed      ${report.computedHash ?? '(none)'}`)
  lines.push(`canonical     ${report.canonical ? 'yes' : 'NO'}`)
  lines.push(
    `bundle        chain ${report.chainId ?? '?'} agent ${report.agentId ?? '?'} score ${report.score ?? '?'} probed ${report.probedAt ?? '?'}`,
  )
  lines.push(`scorer        ${report.scorer ?? '(none)'}`)
  lines.push('')
  lines.push(`reputation records (${report.reputation.length})`)
  if (report.reputation.length === 0) lines.push('  (none found)')
  for (const entry of report.reputation) {
    lines.push(
      `  ${entry.match ? 'MATCH  ' : 'other  '} client ${entry.client} index ${entry.index} hash ${entry.feedbackHash ?? '-'} [${entry.source}]`,
    )
    if (entry.feedbackUri !== null) lines.push(`           uri ${entry.feedbackUri}`)
  }
  lines.push('')
  lines.push(`validation records (${report.validation.length})`)
  if (report.validation.length === 0) lines.push('  (none found)')
  for (const entry of report.validation) {
    lines.push(
      `  ${entry.match ? 'MATCH  ' : 'other  '} request ${entry.requestHash} validator ${entry.validator} response ${entry.response} tag "${entry.tag}"`,
    )
    lines.push(`           responseHash ${entry.responseHash}`)
  }
  if (report.problems.length > 0) {
    lines.push('')
    lines.push('problems')
    for (const problem of report.problems) lines.push(`  - ${problem}`)
  }
  lines.push('')
  lines.push(`VERDICT       ${report.verdict.toUpperCase()}`)
  return lines.join('\n')
}

/** 0 verified end to end, 3 document fine but nothing on chain, 1 broken, 2 unfetchable. */
export function exitCodeFor(verdict: VerifyVerdict): number {
  switch (verdict) {
    case 'ok':
      return 0
    case 'no-onchain-record':
      return 3
    case 'unfetchable':
      return 2
    default:
      return 1
  }
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

type Fetched = { text: string; source: string; declaredHash: string | null }

async function fetchDocument(hashOrUrl: string, options: VerifyOptions): Promise<Fetched | null> {
  const hash = normalizeHash(hashOrUrl)

  if (hash !== null) {
    if (options.store !== undefined) {
      const local = await options.store.getBundleText(hash)
      if (local !== null) return { text: local, source: `store:${hash}`, declaredHash: hash }
    }
    const url = evidenceUri(options.evidenceBaseUrl, hash)
    const remote = await fetchText(url, options.timeoutMs)
    return remote === null ? null : { text: remote, source: url, declaredHash: hash }
  }

  if (!/^https?:\/\//i.test(hashOrUrl)) return null
  const text = await fetchText(hashOrUrl, options.timeoutMs)
  if (text === null) return null
  // The URL's last path segment is the hash the publisher committed to.
  const tail = hashOrUrl.split('?')[0]?.split('/').pop() ?? ''
  return { text, source: hashOrUrl, declaredHash: normalizeHash(tail) }
}

async function fetchText(url: string, timeoutMs?: number): Promise<string | null> {
  const res = await httpRequest(url, { method: 'GET', timeoutMs: timeoutMs ?? 15_000, maxBodyBytes: 8 * 1024 * 1024 })
  return res.ok ? res.text : null
}

type ReputationLookup = { records: ReputationMatch[]; note: string | null }

async function findReputationRecords(
  agentId: number,
  hash: string,
  options: VerifyOptions,
): Promise<ReputationLookup> {
  const scan = options.scan ?? new ScanClient()
  const out: ReputationMatch[] = []
  let indexerNote: string | null = null

  try {
    const page = await scan.listFeedbacks({
      chain_id: options.chainId,
      agent_token_id: String(agentId),
      include_revoked: true,
      limit: 100,
    })
    for (const feedback of page.items) {
      out.push({
        client: feedback.user_address,
        index: feedback.feedback_index,
        feedbackHash: feedback.feedback_hash,
        feedbackUri: feedback.feedback_uri,
        txHash: feedback.transaction_hash,
        match: (feedback.feedback_hash ?? '').toLowerCase() === hash.toLowerCase(),
        source: 'scan',
      })
    }
    if (out.length > 0) return { records: out, note: null }
  } catch (err) {
    // The indexer is a convenience, not the source of truth. Fall through, but
    // say that it was tried and what it said.
    indexerNote = `8004scan lookup failed (${messageOf(err)}); fell back to eth_getLogs`
  }

  // Direct from the chain. `readFeedback` does not return the file hash — only
  // the `NewFeedback` event carries it — so this reads logs.
  //
  // Public BSC nodes cap `eth_getLogs` at a 50,000-block window and answer a
  // wider request with an error rather than a truncated result, so the lookback
  // is walked backwards one window at a time, newest first.
  const chain = getChain(options.chainId)
  const latest = await options.reader.client.getBlockNumber()
  const lookback = options.logLookbackBlocks ?? DEFAULT_LOG_LOOKBACK
  const window = options.logWindowBlocks ?? DEFAULT_LOG_WINDOW
  const floor = latest > lookback ? latest - lookback : 0n

  let toBlock = latest
  let logNote: string | null = null
  while (toBlock > floor) {
    const fromBlock = toBlock > floor + window ? toBlock - window : floor

    let logs
    try {
      logs = await options.reader.client.getContractEvents({
        address: chain.contracts.reputationRegistry,
        abi: reputationRegistryAbi,
        eventName: 'NewFeedback',
        args: { agentId: BigInt(agentId) },
        fromBlock,
        toBlock,
      })
    } catch (err) {
      // Pruned history or a narrower window than we asked for. Stop walking and
      // report how far the search actually reached, rather than claiming the
      // whole lookback was searched and found nothing.
      logNote = `eth_getLogs stopped at block ${toBlock} (${messageOf(err)}); older feedback was not searched`
      break
    }

    for (const log of logs) {
      const args = log.args as {
        clientAddress?: string
        filehash?: string
        fileuri?: string
        feedbackIndex?: bigint
      }
      out.push({
        client: args.clientAddress ?? '(unknown)',
        index: Number(args.feedbackIndex ?? 0n),
        feedbackHash: args.filehash ?? null,
        feedbackUri: args.fileuri ?? null,
        txHash: log.transactionHash,
        match: (args.filehash ?? '').toLowerCase() === hash.toLowerCase(),
        source: 'logs',
      })
    }

    // Stop as soon as the answer is found; walking the whole lookback for an
    // agent that was attested ten minutes ago is pure waste.
    if (out.some((entry) => entry.match)) break
    if (fromBlock === floor) break
    toBlock = fromBlock - 1n
  }

  return { records: out, note: logNote ?? indexerNote }
}

async function findValidationRecords(
  agentId: number,
  hash: string,
  options: VerifyOptions,
): Promise<ValidationMatch[]> {
  const hashes = await options.reader.agentValidations(agentId)
  if (hashes === null) return []

  const out: ValidationMatch[] = []
  for (const requestHash of hashes) {
    const status = await options.reader.validationStatus(requestHash)
    if (status === null) continue
    out.push({
      requestHash,
      validator: status.validator,
      response: status.response,
      responseHash: status.responseHash,
      tag: status.tag,
      lastUpdate: status.lastUpdate.toString(),
      match: status.responseHash.toLowerCase() === hash.toLowerCase(),
    })
  }
  return out
}

function normalizeHash(value: string): `0x${string}` | null {
  const trimmed = value.trim().toLowerCase()
  return /^0x[0-9a-f]{64}$/.test(trimmed) ? (trimmed as `0x${string}`) : null
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
