/**
 * `HallmarkHook`, trimmed to what the prober touches.
 *
 * `recordProbe` is the freshness clock the funding gate reads: the ERC-8004
 * Reputation Registry stores no timestamp at all, so a "reachable" feedback
 * from ten months ago and one from ten minutes ago are indistinguishable
 * through the standard interface. The registry says what was observed; this
 * says when. The read-only entries are here so a write can be verified by
 * reading the state back rather than by trusting a receipt.
 */
export const hallmarkHookAbi = [
  {
    type: 'function',
    name: 'recordProbe',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'score', type: 'uint8' },
    ],
    outputs: [],
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
    type: 'event',
    name: 'ProbeRecorded',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'score', type: 'uint8', indexed: false },
      { name: 'timestamp', type: 'uint64', indexed: false },
    ],
  },
] as const
