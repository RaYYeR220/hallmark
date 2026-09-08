import { canonicalize, isSupportedChainId, type SupportedChainId } from '@hallmark/core'

import { getCachedEcosystem, getCachedHookConfig } from '@/lib/cache'
import { DEMO_CHAIN_ID, getDeployment, scanAgentUrl } from '@/lib/deployments'
import { readEvidence } from '@/lib/evidence'
import { loadBundleText, normaliseHash, verifyBundleText } from '@/lib/evidenceStore'
import { BASE_URL, absoluteUrl, evidenceUrl } from '@/lib/site'

/**
 * The Hallmark validator's machine face.
 *
 * Hallmark spends the whole product arguing that an agent which declares an
 * endpoint should answer on it. That argument only costs us something if we
 * are held to it, so the validator — agent `2210` in the ERC-8004 Identity
 * Registry on chain 97 — declares A2A and MCP endpoints and this is what
 * answers on them. Our own prober scores this service on the same rubric and
 * through the same code path as any stranger's agent, and the score it
 * produces is what we write to the Validation Registry. There is no branch
 * anywhere that treats agent 2210 differently.
 *
 * Three read-only skills, each answering a question a caller would otherwise
 * have to trust us for:
 *
 *   - `verify-evidence` recomputes an evidence bundle's hash from the bytes we
 *     serve, so a client can confirm the document matches the hash on-chain
 *     without implementing keccak256 or RFC-8785 canonicalisation itself.
 *   - `agent-evidence` reports what the gate would do about an agent right
 *     now, read live from `HallmarkHook` rather than from a table of ours.
 *   - `census` reports the ecosystem counts behind our public claims.
 *
 * Deliberately unpaid. The validator sells nothing: an attestor that charges
 * for the answer to "is this evidence real?" has a reason to prefer one
 * answer, and the whole point of publishing content-addressed bundles is that
 * nobody has to pay us to check. The x402 term of the score is therefore zero
 * and the ceiling for this agent is 90, not 100 — which is the honest number
 * and the one we publish.
 */

export const VALIDATOR_SLUG = 'validator'
export const A2A_PROTOCOL_VERSION = '0.3.0'
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** The identity this service claims, and which the registry can confirm. */
export const VALIDATOR_IDENTITY = {
  chainId: 97 as SupportedChainId,
  agentId: 2210,
  /** The address that signs every attestation Hallmark publishes. */
  attestor: '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab',
} as const

export const VALIDATOR_URLS = {
  web: BASE_URL,
  a2a: absoluteUrl('/a2a/validator'),
  mcp: absoluteUrl('/mcp/validator'),
  card: absoluteUrl('/a2a/validator'),
} as const

const NAME = 'Hallmark Validator'

const DESCRIPTION =
  'Probes ERC-8004 agents on BNB Smart Chain, scores what answers, and publishes the evidence to ' +
  'the on-chain Reputation and Validation registries. Every score is backed by a content-addressed ' +
  'evidence bundle whose keccak256 is recorded beside the attestation, so any third party can ' +
  'fetch the document and re-derive the number without asking Hallmark for anything.'

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>

export type ValidatorSkill = {
  id: string
  name: string
  description: string
  tags: string[]
  examples: string[]
  inputSchema: JsonSchema
  run: (input: Record<string, unknown>) => Promise<unknown>
}

/**
 * Read a chain id from caller input.
 *
 * Defaults to the demo chain rather than erroring, because a caller who omits
 * it almost always means "the one Hallmark's escrow is on", and an agent that
 * fails a call over a field it could have inferred is a bad agent.
 */
function chainFrom(value: unknown): SupportedChainId {
  if (value === undefined || value === null || value === '') return DEMO_CHAIN_ID
  const n = Number(value)
  if (!Number.isFinite(n) || !isSupportedChainId(n)) {
    throw new SkillInputError(`chainId must be 56 (BNB Smart Chain) or 97 (BNB testnet), got ${String(value)}`)
  }
  return n
}

export class SkillInputError extends Error {}

const verifyEvidence: ValidatorSkill = {
  id: 'verify-evidence',
  name: 'Verify an evidence bundle',
  description:
    'Fetches the evidence bundle at a hash, re-canonicalises it in the style of RFC 8785, ' +
    'recomputes keccak256 over those exact bytes and reports whether the result reproduces the ' +
    'hash it was asked about. A document that does not reproduce its own name is reported as a ' +
    'mismatch with both hashes shown, never as a soft failure.',
  tags: ['evidence', 'verification', 'erc-8004', 'read-only'],
  examples: [
    'Does 0x0607a4ee… hash to itself?',
    'Verify the evidence behind this attestation before I trust the score.',
  ],
  inputSchema: {
    type: 'object',
    properties: {
      hash: {
        type: 'string',
        pattern: '^0x[0-9a-fA-F]{64}$',
        description:
          'The evidence hash: keccak256 over the bundle’s canonical JSON, exactly as it appears ' +
          'on-chain as `feedbackHash` or `responseHash`.',
      },
    },
    required: ['hash'],
    additionalProperties: false,
  },
  async run(input) {
    const raw = typeof input['hash'] === 'string' ? input['hash'] : ''
    const hash = normaliseHash(raw)
    if (hash === null) {
      throw new SkillInputError(
        'hash must be 0x followed by 64 hex characters — the keccak256 of the bundle’s canonical JSON',
      )
    }

    const lookup = await loadBundleText(hash)
    if (!lookup.found) {
      return {
        hash,
        found: false,
        verdict: 'unfetchable',
        reason: lookup.reason,
        searched: lookup.checked,
        url: evidenceUrl(hash),
      }
    }

    const verified = verifyBundleText(lookup.text, hash)
    const bundle = safeParse(lookup.text)

    return {
      hash,
      found: true,
      verdict: verified.ok ? 'match' : 'mismatch',
      declared: hash,
      computed: verified.ok ? hash : verified.hash,
      // The bundle is canonical iff re-serialising it reproduces the stored
      // bytes byte for byte. Reported separately from the hash match because
      // a document can hash correctly and still not be canonical, and a
      // client re-deriving the hash from a parsed object needs to know.
      canonical: bundle === null ? null : canonicalize(bundle) === lookup.text,
      bytes: Buffer.byteLength(lookup.text, 'utf8'),
      source: lookup.source,
      url: evidenceUrl(hash),
      summary:
        bundle === null
          ? null
          : {
              chainId: numberOrNull(bundle['chainId']),
              agentId: numberOrNull(bundle['agentId']),
              score: numberOrNull(bundle['score']),
              probedAt: typeof bundle['probedAt'] === 'string' ? bundle['probedAt'] : null,
            },
      note:
        'The hash is computed here over the same bytes GET /api/evidence/{hash} returns. Recompute ' +
        'it yourself: keccak256(utf8(canonical JSON)).',
    }
  },
}

const agentEvidence: ValidatorSkill = {
  id: 'agent-evidence',
  name: 'What the gate would do about an agent',
  description:
    'Reads HallmarkHook and the ERC-8004 registries live and reports whether funding a job for ' +
    'this agent would pass the evidence gate, the freshest evidence behind that answer, and the ' +
    'settled-job record the escrow has written. This is a read of the chain, not of a Hallmark ' +
    'database — the same read the hook performs inside `fund`.',
  tags: ['evidence', 'erc-8004', 'escrow', 'read-only'],
  examples: [
    'Can I escrow money to agent 2210 right now?',
    'Why did funding a job for this agent revert?',
  ],
  inputSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'integer', minimum: 0, description: 'ERC-8004 Identity Registry agent id.' },
      chainId: {
        type: 'integer',
        enum: [56, 97],
        description: 'BNB Chain id. Defaults to 97, where Hallmark’s escrow and hook are deployed.',
      },
    },
    required: ['agentId'],
    additionalProperties: false,
  },
  async run(input) {
    const chainId = chainFrom(input['chainId'])
    const agentId = Number(input['agentId'])
    if (!Number.isInteger(agentId) || agentId < 0) {
      throw new SkillInputError('agentId must be a non-negative integer')
    }

    const deployment = getDeployment(chainId)
    if (deployment === null) {
      return {
        chainId,
        agentId,
        gateDeployed: false,
        note:
          `HallmarkHook is not deployed on chain ${chainId}, so there is no gate to consult here. ` +
          `The escrow and hook live on chain ${DEMO_CHAIN_ID}.`,
      }
    }

    const [evidence, gate] = await Promise.all([
      readEvidence(chainId, agentId),
      getCachedHookConfig(chainId),
    ])

    const now = Math.floor(Date.now() / 1000)
    const ageSeconds = evidence?.lastEvidenceAt != null ? now - evidence.lastEvidenceAt : null

    return {
      chainId,
      agentId,
      gateDeployed: true,
      hook: deployment.hook,
      commerce: deployment.commerce,
      hireable: evidence?.hireable ?? false,
      score: evidence?.score ?? null,
      lastEvidenceAt:
        evidence?.lastEvidenceAt != null
          ? new Date(evidence.lastEvidenceAt * 1000).toISOString()
          : null,
      evidenceAgeSeconds: ageSeconds,
      gate:
        gate === null
          ? null
          : {
              attestor: gate.attestor,
              maxEvidenceAgeSeconds: gate.maxEvidenceAge,
              minValidationScore: gate.minValidationScore,
              minAttestableBudgetAtomic: gate.minAttestableBudget,
            },
      jobs: {
        funded: evidence?.jobsFunded ?? 0,
        completed: evidence?.jobsCompleted ?? 0,
        rejected: evidence?.jobsRejected ?? 0,
        expired: evidence?.jobsExpired ?? 0,
        stalled: evidence?.jobsStalled ?? 0,
        averageDeliverySeconds: evidence?.averageDeliverySeconds ?? null,
      },
      reason: gateReason(evidence?.hireable ?? false, evidence?.score ?? null, ageSeconds, gate),
      verify: {
        call: `isHireable(uint256) on ${deployment.hook}`,
        scan: scanAgentUrl(chainId, agentId),
      },
    }
  },
}

const census: ValidatorSkill = {
  id: 'census',
  name: 'The registry census',
  description:
    'The ecosystem counts behind Hallmark’s public claims: agents indexed on a chain, how many ' +
    'declare a machine-callable protocol, how many the index has verified as reachable, and the ' +
    'gate’s live configuration. Each figure carries the timestamp of the read that produced it.',
  tags: ['census', 'erc-8004', 'statistics', 'read-only'],
  examples: ['How many ERC-8004 agents are on BSC?', 'How many of them actually answer?'],
  inputSchema: {
    type: 'object',
    properties: {
      chainId: { type: 'integer', enum: [56, 97], description: 'BNB Chain id. Defaults to 97.' },
    },
    additionalProperties: false,
  },
  async run(input) {
    const chainId = chainFrom(input['chainId'])
    const [snapshot, gate] = await Promise.all([
      getCachedEcosystem(chainId),
      getCachedHookConfig(chainId),
    ])

    return {
      chainId,
      chain: snapshot,
      gate:
        gate === null
          ? null
          : {
              maxEvidenceAgeSeconds: gate.maxEvidenceAge,
              minValidationScore: gate.minValidationScore,
              evidenceBaseUri: gate.evidenceBaseUri,
            },
      notes: [
        'Chain figures come from the 8004scan index; `fetchedAt` is the moment of that read, not ' +
          'of this response.',
        'Hallmark keeps no database. Every figure here is derivable from BNB Chain and a public ' +
          'index by anyone who wants to check it.',
      ],
      servedAt: new Date().toISOString(),
    }
  },
}

export const VALIDATOR_SKILLS: readonly ValidatorSkill[] = [verifyEvidence, agentEvidence, census]

// ---------------------------------------------------------------------------
// The A2A card
// ---------------------------------------------------------------------------

/**
 * The card served at the A2A endpoint.
 *
 * A prober's first move against an A2A endpoint is a plain GET, so this has to
 * be what a GET returns. It carries both audiences at once: the A2A fields a
 * client reads (`skills`, `url`, `capabilities`) and the ERC-8004 `services`
 * shape a registry reader wants, which is what makes "the registration points
 * at the live URLs" a checkable statement rather than a claim.
 */
export function buildValidatorCard(): Record<string, unknown> {
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    type: 'AgentCard',
    name: NAME,
    description: DESCRIPTION,
    version: '1.0.0',
    url: VALIDATOR_URLS.a2a,
    preferredTransport: 'JSONRPC',
    provider: { organization: 'Hallmark', url: VALIDATOR_URLS.web },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json'],
    skills: VALIDATOR_SKILLS.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: [...skill.tags],
      examples: skill.examples,
      inputModes: ['application/json'],
      outputModes: ['application/json'],
      inputSchema: skill.inputSchema,
    })),
    additionalInterfaces: [
      { transport: 'JSONRPC', url: VALIDATOR_URLS.a2a },
      { transport: 'MCP', url: VALIDATOR_URLS.mcp },
    ],
    securitySchemes: {},
    security: [],
    supportsAuthenticatedExtendedCard: false,

    // --- ERC-8004 registration shape ---------------------------------------
    services: [
      {
        name: 'A2A',
        endpoint: VALIDATOR_URLS.a2a,
        version: A2A_PROTOCOL_VERSION,
        skills: VALIDATOR_SKILLS.map((skill) => skill.id),
      },
      { name: 'MCP', endpoint: VALIDATOR_URLS.mcp, version: MCP_PROTOCOL_VERSION },
      { name: 'web', endpoint: VALIDATOR_URLS.web },
      { name: 'agent-card', endpoint: VALIDATOR_URLS.card },
    ],
    // Every skill here is free and read-only. Saying `false` costs us ten
    // points of our own score, which is the correct price for not lying.
    x402Support: false,
    active: true,
    supportedTrust: ['reputation', 'crypto-economic'],
    registrations: [
      {
        agentId: VALIDATOR_IDENTITY.agentId,
        agentRegistry: `eip155:${VALIDATOR_IDENTITY.chainId}:0x8004A818BFB912233c491871b3d84c89A494BD9e`,
      },
    ],

    'x-hallmark': {
      slug: VALIDATOR_SLUG,
      role: 'validator',
      chainId: VALIDATOR_IDENTITY.chainId,
      attestor: VALIDATOR_IDENTITY.attestor,
      custody: 'none',
      authorization: { model: 'read-only', rationale: 'This service never sends a transaction.' },
      note:
        'Hallmark probes this endpoint on the same rubric as every other agent it indexes, and ' +
        'publishes the resulting score to the ERC-8004 Validation Registry like any other.',
    },
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC, shared by both faces
// ---------------------------------------------------------------------------

export type JsonRpcId = string | number | null

export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

export function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result }
}

export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRpc(
  body: unknown,
): { ok: true; method: string; params: unknown; id: JsonRpcId } | { ok: false; response: unknown } {
  if (!isRecord(body)) {
    return { ok: false, response: rpcError(null, RPC_ERRORS.INVALID_REQUEST, 'Request must be a JSON object') }
  }
  const method = body['method']
  if (typeof method !== 'string') {
    return { ok: false, response: rpcError(null, RPC_ERRORS.INVALID_REQUEST, 'Missing string "method"') }
  }
  const rawId = body['id']
  const id: JsonRpcId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null
  return { ok: true, method, params: body['params'], id }
}

/**
 * Run a skill, turning every failure into a shape the caller can act on.
 *
 * `SkillInputError` is the caller's fault and comes back as invalid params;
 * anything else is ours and comes back as an internal error with the message
 * intact, because a validator that hides its own failure reason is asking to
 * be trusted about the thing it just got wrong.
 */
export async function runSkill(
  skillId: string,
  input: unknown,
): Promise<
  | { ok: true; output: unknown }
  | { ok: false; code: 'unknown-skill' | 'invalid-input' | 'failed'; message: string }
> {
  const skill = VALIDATOR_SKILLS.find((entry) => entry.id === skillId)
  if (skill === undefined) {
    return { ok: false, code: 'unknown-skill', message: `Unknown skill "${skillId}"` }
  }
  const args = isRecord(input) ? input : {}
  try {
    return { ok: true, output: await skill.run(args) }
  } catch (error) {
    if (error instanceof SkillInputError) {
      return { ok: false, code: 'invalid-input', message: error.message }
    }
    return {
      ok: false,
      code: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Pull the skill and its input out of an A2A message.
 *
 * A2A carries an arbitrary payload in message parts, so a convention is
 * needed. Ours matches the rest of Hallmark: a `data` part shaped
 * `{ skill, input }`, with `params.skillId` accepted directly for callers
 * driving this by hand.
 */
export function extractInvocation(
  params: unknown,
): { ok: true; skill: string; input: unknown } | { ok: false; message: string } {
  if (!isRecord(params)) return { ok: false, message: '"params" must be an object' }

  if (typeof params['skillId'] === 'string') {
    return { ok: true, skill: params['skillId'], input: params['input'] ?? {} }
  }

  const message = params['message']
  if (!isRecord(message) || !Array.isArray(message['parts'])) {
    return {
      ok: false,
      message:
        'expected params.message (A2A) or params.skillId. Send a data part shaped ' +
        '{ "kind": "data", "data": { "skill": "census", "input": {} } }',
    }
  }

  for (const part of message['parts']) {
    if (!isRecord(part) || part['kind'] !== 'data') continue
    const data = part['data']
    if (!isRecord(data)) continue
    const skill = data['skill'] ?? data['skillId']
    if (typeof skill === 'string') return { ok: true, skill, input: data['input'] ?? {} }
  }

  return { ok: false, message: 'no data part named a skill' }
}

/** MCP tool names are the skill ids with the characters MCP disallows removed. */
export function toolName(skillId: string): string {
  return skillId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function validatorTools(): Array<Record<string, unknown>> {
  return VALIDATOR_SKILLS.map((skill) => ({
    name: toolName(skill.id),
    title: skill.name,
    description: `${skill.description}\n\nRead-only and free. Performs no transaction.`,
    inputSchema: skill.inputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }))
}

export const VALIDATOR_SERVER_INFO = {
  name: 'hallmark-validator',
  title: NAME,
  version: '1.0.0',
} as const

export const VALIDATOR_INSTRUCTIONS =
  `${DESCRIPTION}\n\n` +
  'Every tool is a read of BNB Chain or of a content-addressed document, and every answer names ' +
  'what it read so you can check it yourself. Nothing here is authoritative because Hallmark says ' +
  'so; `verify-evidence` exists precisely so you do not have to take our word for a score.'

/* ------------------------------------------------------------------ */
/* internals                                                           */
/* ------------------------------------------------------------------ */

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function gateReason(
  hireable: boolean,
  score: number | null,
  ageSeconds: number | null,
  gate: { maxEvidenceAge: number; minValidationScore: number } | null,
): string {
  if (gate === null) return 'The gate configuration could not be read.'
  if (hireable) {
    return (
      `Funding would pass: evidence scoring ${score ?? '?'} was written ${ageSeconds ?? '?'}s ago, ` +
      `inside the ${gate.maxEvidenceAge}s window and at or above the minimum score of ` +
      `${gate.minValidationScore}.`
    )
  }
  if (ageSeconds === null) {
    return 'Funding would revert NoFreshEvidence: nothing has ever been written about this agent by the attestor.'
  }
  if (ageSeconds > gate.maxEvidenceAge) {
    return (
      `Funding would revert NoFreshEvidence: the freshest evidence is ${ageSeconds}s old and the ` +
      `window is ${gate.maxEvidenceAge}s.`
    )
  }
  if (score !== null && score < gate.minValidationScore) {
    return (
      `Funding would revert NoFreshEvidence: the evidence scores ${score}, below the minimum of ` +
      `${gate.minValidationScore}.`
    )
  }
  return 'Funding would revert NoFreshEvidence.'
}
