/**
 * Local persistence.
 *
 * Deliberately not a database, and deliberately not a source of truth. The
 * truth about an agent's rating is the ERC-8004 attestation on BNB Chain; this
 * is a cache of what we measured and a place to keep the evidence document
 * that the on-chain hash commits to. If this directory is deleted, nothing
 * that was published stops being true — it just has to be re-derived.
 *
 * Layout:
 *
 *   <storeDir>/evidence/<hash>.json      the canonical bytes, byte-identical
 *                                        to what was hashed and to what
 *                                        `/api/evidence/:hash` serves
 *   <storeDir>/chain-<id>/runs.jsonl     append-only history, one run per line
 *   <storeDir>/chain-<id>/latest/<id>.json  newest run per agent
 *   <storeDir>/chain-<id>/published.jsonl   every on-chain write, with its cost
 *
 * `EvidenceStore` is an interface so a blob store can replace the filesystem
 * without anything above it noticing.
 */

import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { canonicalBundleJson } from './evidence.ts'
import type { EndpointProbe, FailureClass, ProbeEvidenceBundle, ProbeRun, PublishKind, ScoreBreakdown } from './types.ts'

/** The compact per-agent row. The bundle itself lives once, under its hash. */
export type RunRecord = {
  chainId: number
  agentId: number
  probedAt: string
  score: number
  breakdown: ScoreBreakdown
  evidenceHash: `0x${string}`
  elapsedMs: number
  name: string | null
  owner: string | null
  cardError: string | null
  /** The endpoint the on-chain feedback names, capped to keep calldata small. */
  primaryEndpoint: string | null
  endpointCount: number
  scoredCount: number
  okCount: number
  protocolOkCount: number
  failures: Partial<Record<FailureClass, number>>
  kinds: string[]
  latencies: number[]
  mcpTools: number
  a2aSkills: number
  x402: boolean
}

export type PublicationRecord = {
  chainId: number
  agentId: number
  kind: PublishKind
  evidenceHash: string
  txHash: string | null
  costWei: string
  gasUsed: string | null
  status: 'sent' | 'failed' | 'dry-run' | 'skipped'
  reason: string | null
  at: string
}

export type EvidenceStore = {
  putRun(run: ProbeRun): Promise<RunRecord>
  getBundleText(hash: string): Promise<string | null>
  getBundle(hash: string): Promise<ProbeEvidenceBundle | null>
  getLatest(chainId: number, agentId: number): Promise<RunRecord | null>
  listLatest(chainId?: number): Promise<RunRecord[]>
  recordPublication(entry: PublicationRecord): Promise<void>
  listPublications(chainId?: number): Promise<PublicationRecord[]>
  /** Total wei actually committed on chain, across every run this store remembers. */
  totalSpentWei(): Promise<bigint>
}

const HASH_PATTERN = /^0x[0-9a-f]{64}$/

/** Path-safety, not cosmetics: this value comes off an HTTP route. */
export function isEvidenceHash(value: string): value is `0x${string}` {
  return HASH_PATTERN.test(value.toLowerCase())
}

export function toRunRecord(run: ProbeRun): RunRecord {
  const bundle = run.bundle
  const scored = bundle.probe.filter((p) => p.scored)
  return {
    chainId: run.chainId,
    agentId: run.agentId,
    probedAt: run.probedAt,
    score: run.score,
    breakdown: run.breakdown,
    evidenceHash: run.evidenceHash,
    elapsedMs: run.elapsedMs,
    name: bundle.agent.name,
    owner: bundle.agent.owner,
    cardError: bundle.agent.cardError,
    primaryEndpoint: primaryEndpointOf(scored),
    endpointCount: bundle.probe.length,
    scoredCount: scored.length,
    okCount: scored.filter((p) => p.ok).length,
    protocolOkCount: scored.filter((p) => p.protocolOk).length,
    failures: countFailures(bundle.probe),
    kinds: [...new Set(bundle.probe.map((p) => p.kind))].sort(),
    latencies: scored.filter((p) => p.ok).map((p) => p.latencyMs),
    mcpTools: bundle.capabilities.mcpTools?.length ?? 0,
    a2aSkills: bundle.capabilities.a2aSkills?.length ?? 0,
    x402: bundle.capabilities.x402 !== null && bundle.capabilities.x402 !== undefined,
  }
}

export function createFileStore(rootDir: string): EvidenceStore {
  const evidenceDir = join(rootDir, 'evidence')
  const chainDir = (chainId: number) => join(rootDir, `chain-${chainId}`)

  const readJsonl = async <T>(path: string): Promise<T[]> => {
    const text = await readFileOrNull(path)
    if (text === null) return []
    const out: T[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        // A half-written final line after a hard kill. Skip it; the file is a
        // log, not a ledger, and the on-chain record is the ledger.
      }
    }
    return out
  }

  return {
    async putRun(run) {
      const record = toRunRecord(run)
      const hash = run.evidenceHash.toLowerCase()
      if (!isEvidenceHash(hash)) throw new Error(`refusing to store a malformed evidence hash: ${run.evidenceHash}`)

      // The canonical text, not `JSON.stringify(bundle)`. The served bytes must
      // be the hashed bytes.
      await writeFileAtomic(join(evidenceDir, `${hash}.json`), canonicalBundleJson(run.bundle))
      await writeFileAtomic(join(chainDir(run.chainId), 'latest', `${run.agentId}.json`), JSON.stringify(record))
      await appendLine(join(chainDir(run.chainId), 'runs.jsonl'), JSON.stringify(record))
      return record
    },

    async getBundleText(hash) {
      const normalized = hash.toLowerCase()
      if (!isEvidenceHash(normalized)) return null
      return readFileOrNull(join(evidenceDir, `${normalized}.json`))
    },

    async getBundle(hash) {
      const text = await this.getBundleText(hash)
      if (text === null) return null
      try {
        return JSON.parse(text) as ProbeEvidenceBundle
      } catch {
        return null
      }
    },

    async getLatest(chainId, agentId) {
      if (!Number.isInteger(agentId) || agentId < 0) return null
      const text = await readFileOrNull(join(chainDir(chainId), 'latest', `${agentId}.json`))
      if (text === null) return null
      try {
        return JSON.parse(text) as RunRecord
      } catch {
        return null
      }
    },

    async listLatest(chainId) {
      const chains = chainId === undefined ? await discoverChains(rootDir) : [chainId]
      const out: RunRecord[] = []
      for (const id of chains) {
        const dir = join(chainDir(id), 'latest')
        let names: string[]
        try {
          names = await readdir(dir)
        } catch {
          continue
        }
        for (const name of names) {
          if (!name.endsWith('.json')) continue
          const text = await readFileOrNull(join(dir, name))
          if (text === null) continue
          try {
            out.push(JSON.parse(text) as RunRecord)
          } catch {
            continue
          }
        }
      }
      return out.sort((a, b) => a.agentId - b.agentId)
    },

    async recordPublication(entry) {
      await appendLine(join(chainDir(entry.chainId), 'published.jsonl'), JSON.stringify(entry))
    },

    async listPublications(chainId) {
      const chains = chainId === undefined ? await discoverChains(rootDir) : [chainId]
      const out: PublicationRecord[] = []
      for (const id of chains) {
        out.push(...(await readJsonl<PublicationRecord>(join(chainDir(id), 'published.jsonl'))))
      }
      return out
    },

    async totalSpentWei() {
      const entries = await this.listPublications()
      let total = 0n
      for (const entry of entries) {
        if (entry.status !== 'sent') continue
        try {
          total += BigInt(entry.costWei)
        } catch {
          continue
        }
      }
      return total
    },
  }
}

/** In-memory store, for tests and for `--no-store` runs. */
export function createMemoryStore(): EvidenceStore {
  const bundles = new Map<string, string>()
  const latest = new Map<string, RunRecord>()
  const publications: PublicationRecord[] = []

  return {
    async putRun(run) {
      const record = toRunRecord(run)
      bundles.set(run.evidenceHash.toLowerCase(), canonicalBundleJson(run.bundle))
      latest.set(`${run.chainId}:${run.agentId}`, record)
      return record
    },
    async getBundleText(hash) {
      return bundles.get(hash.toLowerCase()) ?? null
    },
    async getBundle(hash) {
      const text = bundles.get(hash.toLowerCase())
      return text === undefined ? null : (JSON.parse(text) as ProbeEvidenceBundle)
    },
    async getLatest(chainId, agentId) {
      return latest.get(`${chainId}:${agentId}`) ?? null
    },
    async listLatest(chainId) {
      return [...latest.values()]
        .filter((record) => chainId === undefined || record.chainId === chainId)
        .sort((a, b) => a.agentId - b.agentId)
    },
    async recordPublication(entry) {
      publications.push(entry)
    },
    async listPublications(chainId) {
      return publications.filter((entry) => chainId === undefined || entry.chainId === chainId)
    },
    async totalSpentWei() {
      return publications
        .filter((entry) => entry.status === 'sent')
        .reduce((total, entry) => total + BigInt(entry.costWei), 0n)
    },
  }
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

/** Calldata is paid for by the byte, so the named endpoint is capped. */
export const MAX_FEEDBACK_ENDPOINT_CHARS = 128

function primaryEndpointOf(scored: EndpointProbe[]): string | null {
  const chosen = scored.find((p) => p.protocolOk) ?? scored.find((p) => p.ok) ?? scored[0]
  if (chosen === undefined) return null
  return chosen.endpoint.length <= MAX_FEEDBACK_ENDPOINT_CHARS
    ? chosen.endpoint
    : chosen.endpoint.slice(0, MAX_FEEDBACK_ENDPOINT_CHARS)
}

function countFailures(probe: EndpointProbe[]): Partial<Record<FailureClass, number>> {
  const counts: Partial<Record<FailureClass, number>> = {}
  for (const entry of probe) {
    if (entry.failure === null) continue
    counts[entry.failure] = (counts[entry.failure] ?? 0) + 1
  }
  return counts
}

async function discoverChains(rootDir: string): Promise<number[]> {
  try {
    const names = await readdir(rootDir)
    return names
      .map((name) => /^chain-(\d+)$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .sort((a, b) => a - b)
  } catch {
    return []
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  // Write-then-rename would be nicer, but Windows renames onto an open handle
  // fail; for a cache that is rebuilt by re-running the sweep, a direct write
  // is the honest trade.
  await writeFile(path, contents, 'utf8')
}

async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${line}\n`, 'utf8')
}
