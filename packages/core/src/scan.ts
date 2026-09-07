/**
 * Client for the 8004scan indexer.
 *
 * Two bases exist and they are not equivalent. The front door proxies the
 * official API and is measurably more generous (180 req/min, 20k/day vs
 * 30 req/min, 1k/day), so it is the default. Neither needs a key.
 *
 * The API intermittently answers `DATABASE_ERROR` on cold or unfiltered
 * queries, so every request goes through a bounded retry. List endpoints
 * always carry a `chain_id`: unfiltered `/feedbacks` times out.
 */

export const SCAN_FRONT_DOOR = 'https://8004scan.io/api/v1'
export const SCAN_OFFICIAL_API = 'https://api.8004scan.io/api/v1'

/** Measured anonymous limits, requests per minute. */
const RATE_PER_MINUTE: Record<string, number> = {
  [SCAN_FRONT_DOOR]: 180,
  [SCAN_OFFICIAL_API]: 30,
}

export type ScanEnvelope<T> = { success: boolean; data: T }

export type ScanChain = {
  chain_key: string
  chain_id: number
  name: string
  is_testnet: boolean
  enabled: boolean
  blockscout_configured: boolean
  etherscan_supported: boolean
  etherscan_keys_present: boolean
  effective_provider: string | null
  provider_status: string
  provider_reason: string
}

export type ScanChainsData = {
  chains: ScanChain[]
  testnet_chain_ids: number[]
  mainnet_chain_ids: number[]
}

export type ChainStat = {
  chain_id: number
  name: string
  is_testnet: boolean
  total_agents: number
  daily_new_agents: number
  total_feedbacks: number
  daily_feedbacks: number
  average_feedback_score: number | null
  mcp_agents: number
  a2a_agents: number
  oasf_agents: number
}

export type ScanSupportedChain = {
  chain_id: number
  name: string
  key: string
  is_testnet: boolean
  enabled: boolean
  has_registry: boolean
}

export type ScanGlobalStats = {
  total_agents: number
  total_users: number
  total_validators: number
  total_feedbacks: number
  total_validations: number
  total_chats: number
  total_messages: number
  daily_new_agents: number
  daily_new_users: number
  daily_feedbacks: number
  daily_validations: number
  average_feedback_score: number | null
  average_validation_score: number | null
  supported_chains: ScanSupportedChain[]
  chain_stats: ChainStat[]
  protocol_distribution: { mcp: number; a2a: number; unknown: number }
  registration_stats: {
    total: number
    resolved: number
    unresolved: number
    owner_verified: number
    reciprocal_verified: number
  }
}

/** The row shape returned by `/agents` — deliberately leaner than the detail view. */
export type ScanAgent = {
  id: string
  /** `"<chainId>:<registry>:<tokenId>"`. */
  agent_id: string
  token_id: string
  chain_id: number
  chain_type: string
  contract_address: string
  is_testnet: boolean
  owner_id: string | null
  owner_address: string
  owner_ens: string | null
  owner_username: string | null
  owner_avatar_url: string | null
  owner_publisher_tier: string | null
  owner_certified_name: string | null
  name: string | null
  description: string | null
  image_url: string | null
  is_verified: boolean
  star_count: number
  supported_protocols: string[]
  x402_supported: boolean
  total_score: number
  rank: number | null
  network_rank: number | null
  health_score: number | null
  total_feedbacks: number
  average_score: number
  cross_chain_versions: unknown
  created_at: string
  updated_at: string
}

export type ScanAgentScores = {
  rank: number | null
  chain_rank: number | null
  is_testnet: boolean
  quality: number
  activity: number
  freshness: number
  popularity: number
  wallet: number
  health_score: number | null
  health_status: string | null
  last_scored_at: string | null
  skipped_reason: string | null
  completeness_tier: string | null
  metadata_completeness: number
  completeness_multiplier: number
}

export type ScanParseNote = {
  code: string
  message: string
  field?: string
}

export type ScanParseStatus = {
  status: string
  info: ScanParseNote[]
  errors: ScanParseNote[]
  warnings: ScanParseNote[]
  llm_attempted?: boolean
  llm_attempted_at?: string | null
  last_parsed_at?: string | null
}

export type ScanOnchainMetadata = {
  key: string
  value: string
  decoded: string | null
}

export type ScanRawMetadata = {
  onchain: ScanOnchainMetadata[]
  offchain_uri: string | null
  /** A string when the indexer kept the body verbatim, an object once it parsed it. */
  offchain_content: string | Record<string, unknown> | null
}

/** The 69-field detail row served by `/agents/{chain_id}/{token_id}` and semantic search. */
export type ScanAgentDetail = {
  id: string
  owner_id: string | null
  owner_address: string
  owner_ens: string | null
  owner_username: string | null
  owner_avatar_url: string | null
  owner_publisher_tier: string | null
  owner_certified_name: string | null
  creator_address: string | null
  agent_id: string
  token_id: string
  chain_id: number
  chain_type: string
  is_testnet: boolean
  contract_address: string
  name: string | null
  description: string | null
  agent_type: string | null
  is_verified: boolean
  star_count: number
  watch_count: number
  supported_protocols: string[]
  agent_wallet: string | null
  x402_supported: boolean
  image_url: string | null
  tags: string[]
  categories: string[]
  services: unknown[] | null
  scores: ScanAgentScores | null
  total_score: number
  cross_chain_links: unknown[]
  cross_chain_versions: unknown
  created_block_number: number | null
  created_tx_hash: string | null
  is_endpoint_verified: boolean
  endpoint_verified_at: string | null
  endpoint_verified_domain: string | null
  endpoint_verification_error: string | null
  endpoint_last_checked_at: string | null
  is_active: boolean
  supported_trust_models: string[]
  health_status: string | null
  health_score: number | null
  health_checked_at: string | null
  total_feedbacks: number
  total_validations: number
  successful_validations: number
  average_score: number
  rank: number | null
  network_rank: number | null
  parse_status: ScanParseStatus | null
  raw_metadata: ScanRawMetadata | null
  field_sources: Record<string, string | null> | null
  ens: string | null
  did: string | null
  mcp_server: string | null
  mcp_version: string | null
  a2a_endpoint: string | null
  a2a_version: string | null
  agent_url: string | null
  quality_score: number
  popularity_score: number
  activity_score: number
  wallet_score: number
  freshness_score: number
  metadata_completeness_score: number
  created_at: string
  updated_at: string
}

export type ScanSemanticAgent = ScanAgentDetail & { similarity_score: number }

export type ScanFeedback = {
  id: string
  feedback_id: string
  agent_id: string
  chain_id: number
  is_testnet: boolean
  score: number | null
  value: string | null
  value_decimals: number | null
  comment: string | null
  feedback_uri: string | null
  transaction_hash: string
  block_number: number
  user_id: string | null
  user_address: string
  agent: {
    token_id: string
    chain_id: number
    registry_address: string
    name: string | null
    ens: string | null
  } | null
  user: {
    address: string
    ens: string | null
    username: string | null
    validator_tier: string | null
  } | null
  endpoint: string | null
  tag1: string | null
  tag2: string | null
  feedback_index: number
  feedback_hash: string | null
  offchain_data: unknown
  parse_status: ScanParseStatus | null
  is_revoked: boolean
  revoked_at: string | null
  submitted_at: string
  created_at: string
  updated_at: string
  replies: unknown
}

export type ScanPage<T> = {
  items: T[]
  total: number
  limit: number
  offset: number
}

export type ListAgentsParams = {
  chain_id?: number
  is_testnet?: boolean
  owner_address?: string
  owner_publisher_tier?: string
  supported_protocol?: string
  x402_supported?: boolean
  has_mcp?: boolean
  has_a2a?: boolean
  has_oasf?: boolean
  supported_trust?: string
  is_active?: boolean
  is_registered?: boolean
  is_endpoint_verified?: boolean
  oasf_skill?: string[]
  oasf_domain?: string[]
  min_feedbacks?: number
  min_validations?: number
  min_score?: number
  created_after?: string
  created_before?: string
  tags?: string
  categories?: string
  search?: string
  search_type?: string
  search_fields?: string
  sort_by?: string
  sort_order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export type SemanticSearchParams = {
  chain_id?: number
  is_active?: boolean
  semantic_weight?: number
  similarity_threshold?: number
  limit?: number
  offset?: number
}

export type ListFeedbacksParams = {
  chain_id: number
  is_testnet?: boolean
  agent_id?: string
  agent_token_id?: string
  user_address?: string
  min_score?: number
  max_score?: number
  include_revoked?: boolean
  include_replies?: boolean
  tag1?: string
  tag2?: string
  oasf_skill?: string[]
  oasf_domain?: string[]
  sort_by?: string
  sort_order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export type AgentsByWalletParams = {
  limit?: number
  offset?: number
  sort_by?: string
  sort_order?: 'asc' | 'desc'
}

export type RateLimitState = {
  limitMinute: number | null
  remainingMinute: number | null
  limitDay: number | null
  remainingDay: number | null
  /** Populated when the API sends `x-ratelimit-reset` or a `retry-after`. */
  resetAt: Date | null
  retryAfterMs: number | null
  updatedAt: Date | null
}

export type ScanClientOptions = {
  baseUrl?: string
  /**
   * Tried once more after `baseUrl` has exhausted its retries. The two bases
   * are proxied separately and do not fail together: the front door has been
   * seen answering `DATABASE_ERROR` on `/agents` while the official API served
   * the same query. Pass `null` to disable.
   */
  fallbackBaseUrl?: string | null
  apiKey?: string
  fetchImpl?: typeof fetch
  /** Floor on the gap between request starts. Defaults to the measured limit for `baseUrl`. */
  minIntervalMs?: number
  maxRetries?: number
  retryBaseMs?: number
  timeoutMs?: number
}

export class ScanApiError extends Error {
  readonly status: number | null
  readonly code: string | null
  readonly url: string

  constructor(message: string, url: string, status: number | null, code: string | null) {
    super(message)
    this.name = 'ScanApiError'
    this.url = url
    this.status = status
    this.code = code
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const RETRYABLE_CODES = new Set(['DATABASE_ERROR', 'INTERNAL_ERROR', 'TIMEOUT', 'SERVICE_UNAVAILABLE'])

export class ScanClient {
  readonly baseUrl: string
  readonly fallbackBaseUrl: string | null
  readonly minIntervalMs: number

  private readonly apiKey: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly maxRetries: number
  private readonly retryBaseMs: number
  private readonly timeoutMs: number

  private rateLimit: RateLimitState = {
    limitMinute: null,
    remainingMinute: null,
    limitDay: null,
    remainingDay: null,
    resetAt: null,
    retryAfterMs: null,
    updatedAt: null,
  }

  private gate: Promise<void> = Promise.resolve()
  private nextStartAt = 0

  constructor(options: ScanClientOptions = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? SCAN_FRONT_DOOR)
    this.fallbackBaseUrl =
      options.fallbackBaseUrl === undefined
        ? defaultFallback(this.baseUrl)
        : options.fallbackBaseUrl === null
          ? null
          : trimTrailingSlash(options.fallbackBaseUrl)
    this.apiKey = options.apiKey
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new Error('ScanClient needs a fetch implementation')
    }
    this.fetchImpl = fetchImpl
    const perMinute = RATE_PER_MINUTE[this.baseUrl] ?? RATE_PER_MINUTE[SCAN_FRONT_DOOR] ?? 180
    this.minIntervalMs = options.minIntervalMs ?? Math.ceil(60_000 / perMinute)
    this.maxRetries = options.maxRetries ?? 4
    this.retryBaseMs = options.retryBaseMs ?? 400
    this.timeoutMs = options.timeoutMs ?? 45_000
  }

  /** Last rate-limit headers seen, as a snapshot. */
  getRateLimit(): RateLimitState {
    return { ...this.rateLimit }
  }

  async chains(): Promise<ScanEnvelope<ScanChainsData>> {
    return this.request<ScanEnvelope<ScanChainsData>>('/chains')
  }

  async globalStats(): Promise<ScanGlobalStats> {
    return this.request<ScanGlobalStats>('/stats/global')
  }

  async listAgents(params: ListAgentsParams = {}): Promise<ScanPage<ScanAgent>> {
    return this.request<ScanPage<ScanAgent>>('/agents', params)
  }

  async getAgent(chainId: number, tokenId: number | string): Promise<ScanAgentDetail> {
    return this.request<ScanAgentDetail>(`/agents/${chainId}/${tokenId}`)
  }

  async semanticSearch(q: string, params: SemanticSearchParams = {}): Promise<ScanPage<ScanSemanticAgent>> {
    return this.request<ScanPage<ScanSemanticAgent>>('/agents/search/semantic', { q, ...params })
  }

  async listFeedbacks(params: ListFeedbacksParams): Promise<ScanPage<ScanFeedback>> {
    return this.request<ScanPage<ScanFeedback>>('/feedbacks', params)
  }

  async agentsByWallet(address: string, params: AgentsByWalletParams = {}): Promise<ScanPage<ScanAgent>> {
    return this.request<ScanPage<ScanAgent>>(`/wallets/${address}/agents`, params)
  }

  /**
   * Walk `/agents` page by page. `max` bounds the total number of rows yielded
   * so a bad filter cannot turn into an unbounded crawl.
   */
  async *paginate(params: ListAgentsParams = {}, max = 1_000): AsyncGenerator<ScanAgent, void, void> {
    const pageSize = Math.min(params.limit ?? 100, 100)
    let offset = params.offset ?? 0
    let yielded = 0

    for (;;) {
      const page = await this.listAgents({ ...params, limit: pageSize, offset })
      if (page.items.length === 0) return
      for (const item of page.items) {
        yield item
        yielded += 1
        if (yielded >= max) return
      }
      offset += page.items.length
      if (offset >= page.total) return
    }
  }

  async request<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.requestFrom<T>(this.baseUrl, path, params)
    } catch (err) {
      if (this.fallbackBaseUrl === null || !isRetryable(err)) throw err
      return this.requestFrom<T>(this.fallbackBaseUrl, path, params)
    }
  }

  private async requestFrom<T>(base: string, path: string, params: Record<string, unknown>): Promise<T> {
    const url = `${base}${path}${buildQuery(params)}`

    let lastError: unknown = null
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (attempt > 0) await sleep(this.backoffMs(attempt))
      await this.acquireSlot()

      let res: Response
      try {
        res = await this.fetchOnce(url)
      } catch (err) {
        lastError = new ScanApiError(`request failed: ${messageOf(err)}`, url, null, null)
        continue
      }

      this.readRateLimit(res.headers)

      const text = await res.text().catch(() => '')
      const body = parseJson(text)

      if (!res.ok) {
        const code = errorCode(body)
        lastError = new ScanApiError(
          `HTTP ${res.status} from ${url}${code === null ? '' : ` (${code})`}`,
          url,
          res.status,
          code,
        )
        if (RETRYABLE_STATUS.has(res.status)) continue
        throw lastError
      }

      // The front door can answer 200 with an error envelope.
      const code = errorCode(body)
      if (code !== null) {
        lastError = new ScanApiError(`${code} from ${url}`, url, res.status, code)
        if (RETRYABLE_CODES.has(code)) continue
        throw lastError
      }

      if (body === undefined) {
        lastError = new ScanApiError(`unparseable response from ${url}`, url, res.status, null)
        continue
      }

      return body as T
    }

    throw lastError instanceof Error
      ? lastError
      : new ScanApiError(`gave up after ${this.maxRetries + 1} attempts`, url, null, null)
  }

  private async fetchOnce(url: string): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await this.fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
        headers: this.headers(),
      })
    } finally {
      clearTimeout(timer)
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (this.apiKey !== undefined) headers['X-API-Key'] = this.apiKey
    return headers
  }

  private backoffMs(attempt: number): number {
    const retryAfter = this.rateLimit.retryAfterMs
    if (retryAfter !== null && retryAfter > 0) {
      this.rateLimit.retryAfterMs = null
      return Math.min(retryAfter, 30_000)
    }
    const exponential = Math.min(this.retryBaseMs * 2 ** (attempt - 1), 8_000)
    return exponential + Math.floor(Math.random() * Math.min(250, this.retryBaseMs))
  }

  /** Serialises only the pacing, so in-flight requests still overlap. */
  private async acquireSlot(): Promise<void> {
    const wait = this.gate.then(async () => {
      const delay = this.nextStartAt - Date.now()
      if (delay > 0) await sleep(delay)
      this.nextStartAt = Date.now() + this.minIntervalMs
    })
    this.gate = wait.then(
      () => undefined,
      () => undefined,
    )
    await wait
  }

  private readRateLimit(headers: Headers): void {
    const num = (name: string): number | null => {
      const raw = headers.get(name)
      if (raw === null) return null
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : null
    }

    const retryAfter = num('retry-after')
    const reset = num('x-ratelimit-reset')

    this.rateLimit = {
      limitMinute: num('x-ratelimit-limit-minute') ?? num('x-ratelimit-limit'),
      remainingMinute: num('x-ratelimit-remaining-minute') ?? num('x-ratelimit-remaining'),
      limitDay: num('x-ratelimit-limit-day'),
      remainingDay: num('x-ratelimit-remaining-day'),
      resetAt: reset === null ? null : new Date(reset > 1e10 ? reset : Date.now() + reset * 1000),
      retryAfterMs: retryAfter === null ? null : retryAfter * 1000,
      updatedAt: new Date(),
    }
  }
}

export function createScanClient(options: ScanClientOptions = {}): ScanClient {
  return new ScanClient(options)
}

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function buildQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) search.append(key, String(item))
      }
      continue
    }
    search.append(key, String(value))
  }
  const query = search.toString()
  return query === '' ? '' : `?${query}`
}

function parseJson(text: string): unknown {
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function errorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const record = body as Record<string, unknown>
  if (record['success'] !== false) return null
  const error = record['error']
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const code = (error as Record<string, unknown>)['code']
    if (typeof code === 'string') return code
  }
  return 'UNKNOWN_ERROR'
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function defaultFallback(baseUrl: string): string | null {
  if (baseUrl === SCAN_FRONT_DOOR) return SCAN_OFFICIAL_API
  if (baseUrl === SCAN_OFFICIAL_API) return SCAN_FRONT_DOOR
  return null
}

/** True for the failures that are worth re-asking the other base about. */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof ScanApiError)) return false
  if (err.status !== null && RETRYABLE_STATUS.has(err.status)) return true
  if (err.code !== null && RETRYABLE_CODES.has(err.code)) return true
  return err.status === null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
