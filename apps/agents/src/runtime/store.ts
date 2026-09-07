import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The bit of state an autonomous agent cannot do without.
 *
 * A grid that forgets which levels filled re-places orders it already filled.
 * An `act` that forgets which intents it ran executes them twice. Both are
 * money, so persistence is part of the safety story rather than a convenience.
 *
 * The interface is deliberately tiny — get / set / delete / list, plus an
 * atomic `claim` — so a deployment can back it with Redis, KV or Postgres
 * without touching an agent. Two implementations ship: in-memory (tests,
 * ephemeral serverless) and a JSON file (a single long-lived Node process).
 */

export type Store = {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  /** Keys under a prefix, sorted. */
  list(prefix: string): Promise<string[]>
  /**
   * Write `value` only if `key` is unset, and report which happened.
   *
   * This is what makes `act` idempotent: the first caller to claim an intent
   * id runs it, everyone else replays. `claimed: false` returns the value
   * already there.
   */
  claim<T>(key: string, value: T): Promise<{ claimed: true } | { claimed: false; existing: T }>
}

export function createMemoryStore(seed: Record<string, unknown> = {}): Store {
  const map = new Map<string, string>()
  for (const [key, value] of Object.entries(seed)) map.set(key, JSON.stringify(value))

  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = map.get(key)
      return raw === undefined ? null : (JSON.parse(raw) as T)
    },
    async set<T>(key: string, value: T): Promise<void> {
      map.set(key, JSON.stringify(value))
    },
    async delete(key: string): Promise<void> {
      map.delete(key)
    },
    async list(prefix: string): Promise<string[]> {
      return [...map.keys()].filter((key) => key.startsWith(prefix)).sort()
    },
    async claim<T>(key: string, value: T) {
      const existing = map.get(key)
      if (existing !== undefined) return { claimed: false as const, existing: JSON.parse(existing) as T }
      map.set(key, JSON.stringify(value))
      return { claimed: true as const }
    },
  }
}

/**
 * A JSON file, rewritten atomically on every mutation.
 *
 * Fine for one process and the volumes an agent service produces; not a
 * database. The whole file is held in memory, so `claim` is genuinely atomic
 * within the process, which is the property that matters for idempotency.
 */
export function createFileStore(path: string): Store {
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    // A missing or unreadable file is an empty store, not a crash: the first
    // write creates it.
    data = {}
  }

  const flush = () => {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`)
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, path)
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      return key in data ? (data[key] as T) : null
    },
    async set<T>(key: string, value: T): Promise<void> {
      data[key] = value
      flush()
    },
    async delete(key: string): Promise<void> {
      delete data[key]
      flush()
    },
    async list(prefix: string): Promise<string[]> {
      return Object.keys(data)
        .filter((key) => key.startsWith(prefix))
        .sort()
    },
    async claim<T>(key: string, value: T) {
      if (key in data) return { claimed: false as const, existing: data[key] as T }
      data[key] = value
      flush()
      return { claimed: true as const }
    },
  }
}

/** `HALLMARK_STORE_PATH` picks the file store; anything else stays in memory. */
export function createDefaultStore(env: Record<string, string | undefined> = process.env): Store {
  const path = env['HALLMARK_STORE_PATH']
  return path ? createFileStore(path) : createMemoryStore()
}
