/**
 * ABIs for Hallmark's own deployment.
 *
 * These are transcribed from `contracts/src/*.sol` rather than imported from
 * `@hallmark/core`. That is deliberate, and the reason is worth writing down:
 *
 *  - `core`'s `agenticCommerceAbi` describes Altana's canonical ERC-8183
 *    kernel, which has a different `createJob` signature and a different `Job`
 *    shape from Hallmark's `AgenticCommerceHooked`. Using it here would encode
 *    the wrong calldata.
 *  - `core`'s `hallmarkHookAbi` declares `agentRecord` as six flat return
 *    values; the deployed contract returns a five-field struct
 *    (jobsFunded, jobsCompleted, jobsRejected, jobsExpired, totalDeliverySeconds).
 *    Decoding against the wrong shape produces plausible-looking wrong numbers,
 *    which is the worst kind of wrong on a page whose whole claim is accuracy.
 *
 * Both were verified with live `eth_call`s against chain 97 before being
 * written down here.
 *
 * The ERC-8004 registry ABIs are imported from core unchanged — those match
 * the deployed registries.
 */

export const hallmarkHookAbi = [
  {
    type: 'function',
    name: 'isHireable',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [
      { name: 'ok', type: 'bool' },
      { name: 'lastEvidenceAt', type: 'uint64' },
      { name: 'score', type: 'uint8' },
    ],
  },
  {
    type: 'function',
    name: 'agentRecord',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'jobsFunded', type: 'uint32' },
          { name: 'jobsCompleted', type: 'uint32' },
          { name: 'jobsRejected', type: 'uint32' },
          { name: 'jobsExpired', type: 'uint32' },
          { name: 'totalDeliverySeconds', type: 'uint64' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'averageDeliverySeconds',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'lastProbeAt',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'lastProbeScore',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'jobAgent',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'fundedAt',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'submittedAt',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'attestor',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'maxEvidenceAge',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'minValidationScore',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'evidenceBaseURI',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'feedbackURI',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'recordExpiry',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [],
  },
  // Events, for reading the evidence and settlement history off the chain.
  {
    type: 'event',
    name: 'ProbeRecorded',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'score', type: 'uint8', indexed: false },
      { name: 'timestamp', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'JobBound',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'agentId', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'DeliverySubmitted',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'secondsToDeliver', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OutcomeRecorded',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'completed', type: 'bool', indexed: false },
      { name: 'reason', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'FeedbackWriteFailed',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'reason', type: 'bytes', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'FeedbackSkippedInsufficientGas',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'gasLeft', type: 'uint256', indexed: false },
      { name: 'required', type: 'uint256', indexed: false },
    ],
  },
  // Errors. `NoFreshEvidence` is the product's headline behaviour: it is
  // decoded by name on the hire page and rendered as a feature.
  {
    type: 'error',
    name: 'NoFreshEvidence',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'lastEvidenceAt', type: 'uint256' },
    ],
  },
  { type: 'error', name: 'UnknownAgent', inputs: [{ name: 'agentId', type: 'uint256' }] },
  { type: 'error', name: 'AgentNotDeclared', inputs: [] },
  {
    type: 'error',
    name: 'InsufficientGasForEvidenceCheck',
    inputs: [
      { name: 'gasLeft', type: 'uint256' },
      { name: 'required', type: 'uint256' },
    ],
  },
] as const

/**
 * `agentRecord`, with the six-field struct.
 *
 * The deployed hook returns a five-field `Record`; the contract source has
 * since grown a `jobsStalled` counter, inserted before `totalDeliverySeconds`.
 * Both shapes are static structs, so the encoding is a bare run of 32-byte
 * words — decoding six-field data with a five-field ABI silently reads
 * `jobsStalled` as the delivery total, which is a wrong number rather than an
 * error, and wrong numbers are the one thing this product cannot ship.
 *
 * So both are attempted in the same multicall and whichever decodes cleanly is
 * used. It costs one extra entry per agent in a batch that measures at 160ms,
 * and it means the app keeps working across the redeploy without anyone having
 * to remember to change this file on the day.
 */
export const hallmarkHookRecordV2Abi = [
  {
    type: 'function',
    name: 'agentRecord',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'jobsFunded', type: 'uint32' },
          { name: 'jobsCompleted', type: 'uint32' },
          { name: 'jobsRejected', type: 'uint32' },
          { name: 'jobsExpired', type: 'uint32' },
          { name: 'jobsStalled', type: 'uint32' },
          { name: 'totalDeliverySeconds', type: 'uint64' },
        ],
      },
    ],
  },
] as const

/**
 * `AgenticCommerceHooked` — Hallmark's ERC-8183 escrow.
 *
 * Note `createJob(provider, evaluator, expiredAt, description, hook)`: five
 * arguments, no payment token (it is immutable on the contract) and no budget
 * (set separately). This is the shape the deployed contract has.
 */
export const hallmarkCommerceAbi = [
  {
    type: 'function',
    name: 'createJob',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'provider', type: 'address' },
      { name: 'evaluator', type: 'address' },
      { name: 'expiredAt', type: 'uint256' },
      { name: 'description', type: 'string' },
      { name: 'hook', type: 'address' },
    ],
    outputs: [{ name: 'jobId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'setProvider',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'provider_', type: 'address' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'setBudget',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'fund',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'expectedBudget', type: 'uint256' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'submit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'deliverable', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'complete',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'reason', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'reject',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'jobId', type: 'uint256' },
      { name: 'reason', type: 'bytes32' },
      { name: 'optParams', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'claimRefund',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'getJob',
    stateMutability: 'view',
    inputs: [{ name: 'jobId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'id', type: 'uint256' },
          { name: 'client', type: 'address' },
          { name: 'provider', type: 'address' },
          { name: 'evaluator', type: 'address' },
          { name: 'description', type: 'string' },
          { name: 'budget', type: 'uint256' },
          { name: 'expiredAt', type: 'uint256' },
          { name: 'status', type: 'uint8' },
          { name: 'hook', type: 'address' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'jobCount',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'paymentToken',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'feeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'treasury',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'isHookWhitelisted',
    stateMutability: 'view',
    inputs: [{ name: 'hook', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'JobCreated',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'client', type: 'address', indexed: true },
      { name: 'provider', type: 'address', indexed: true },
      { name: 'evaluator', type: 'address', indexed: false },
      { name: 'expiredAt', type: 'uint256', indexed: false },
      { name: 'description', type: 'string', indexed: false },
      { name: 'hook', type: 'address', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'JobFunded',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'client', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'JobSubmitted',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'provider', type: 'address', indexed: true },
      { name: 'deliverable', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'JobCompleted',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'evaluator', type: 'address', indexed: true },
      { name: 'reason', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'JobRejected',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'caller', type: 'address', indexed: true },
      { name: 'reason', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'PaymentReleased',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'provider', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Refunded',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'client', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
] as const

/** Minimal ERC-20 surface: balance, allowance, approve. */
export const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const

/** Testnet $U faucet: `requestTokens()` hands out 10 $U per call. */
export const uTokenFaucetAbi = [
  {
    type: 'function',
    name: 'requestTokens',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const

/**
 * Altana Keystore, read-only. Anyone can verify a session key with these two
 * calls and no credentials — that is the point, so /sessions reads them
 * directly rather than trusting anything the app remembers.
 */
export const keystoreAbi = [
  {
    type: 'function',
    name: 'isValidKey',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'keyId', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'getKeys',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
  {
    type: 'function',
    name: 'getPublicKey',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'keyId', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes' }],
  },
] as const

/** ERC-8183 job status, by index, as the escrow's enum orders them. */
export const JOB_STATUS_NAMES = [
  'Open',
  'Funded',
  'Submitted',
  'Completed',
  'Rejected',
  'Expired',
] as const

export type JobStatusName = (typeof JOB_STATUS_NAMES)[number]

export function jobStatusName(status: number): JobStatusName {
  return JOB_STATUS_NAMES[status] ?? 'Open'
}

/**
 * `complete` and `reject` must be sent with an explicit gas limit.
 *
 * `eth_estimateGas` binary-searches for the smallest limit under which the
 * OUTER call succeeds. The hook wraps its Reputation Registry write in a
 * try/catch, and EIP-150 hands an inner call at most 63/64 of the remaining
 * gas — so an out-of-gas inner frame is caught and reported as an outer
 * success. The estimator therefore converges on a limit that starves the
 * receipt: the job settles, the provider is paid, and the ERC-8004 rating
 * silently never lands.
 *
 * The contract's own floor is MIN_FEEDBACK_GAS = 250,000, checked after
 * `complete`'s ~66,000. 450,000 clears it with room for the 63/64 clamp and
 * the 20,000 epilogue reserve. Measured on chain 97 against the live registry.
 */
export const SETTLEMENT_GAS_LIMIT = 450_000n

/** `fund` refuses below MIN_EVIDENCE_GAS (150,000) rather than guessing. */
export const FUND_GAS_LIMIT = 400_000n
