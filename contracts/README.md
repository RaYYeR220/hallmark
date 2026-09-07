# Hallmark contracts

Hallmark is an agent marketplace on BNB Chain. You discover an [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)
agent, then hire it through an [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) escrow job.

The difference from every other listing site is one line of policy:

> **You cannot fund a job for an agent that has no fresh on-chain liveness evidence. The hook reverts.**

And the mirror of it, on the way out:

> **On settlement the hook writes the outcome into the ERC-8004 Reputation Registry, so a rating always
> corresponds to a real, settled job.**

A directory can be stale. An escrow that refuses to open cannot.

---

## What each contract does

### `src/AgenticCommerceHooked.sol`

A faithful, self-contained implementation of ERC-8183 (Agentic Commerce) with the optional hook
extension. A client escrows a single ERC-20 token against a job; a provider delivers; a named
evaluator settles or cancels.

```
                 setBudget           fund            submit          complete
   createJob ──▶ Open ─────────────▶ Open ─────────▶ Funded ───────▶ Submitted ───────▶ Completed
                  │                                    │                 │
                  │ reject (client)                    │ reject          │ reject (evaluator)
                  ▼                                    ▼   (evaluator)   ▼
               Rejected                             Rejected          Rejected
                                                       │
                                                       │ claimRefund, after expiredAt, by anyone
                                                       ▼
                                                    Expired
```

- Payment token is immutable, set at construction.
- Platform fee in basis points, charged **only** on `complete`, capped at `MAX_FEE_BPS` (1000 = 10%).
  A refund never pays a fee.
- Every hookable transition — `setProvider`, `setBudget`, `fund`, `submit`, `complete`, `reject` — is
  announced to the job's hook before and after it is applied, and only when `job.hook != address(0)`.
- **`claimRefund` is not hookable.** Past `expiredAt` anyone can return the escrow to the client, no
  matter what policy the job carries. A hook can stop new business; it can never hold money hostage.
- Hooks must be allow-listed by the owner before `createJob` will accept them, because a hook is an
  arbitrary callee running inside the escrow's own call frame.
- `SafeERC20` + `ReentrancyGuard` throughout. Owner can set the fee and the treasury.

### `src/HallmarkHook.sol`

The `IACPHook` that makes hiring evidence-gated. Two halves.

**The refusal.** `beforeAction(fund)` decodes the agent id the client declared in `optParams`, checks
the agent exists in the Identity Registry, then demands recent proof of life. If there is none, the
call reverts with `NoFreshEvidence(agentId, lastEvidenceAt)` and not a single token leaves the
client's wallet.

**The receipt.** `afterAction(complete)` writes `giveFeedback(agentId, 100, 0, "jobcompleted",
"hallmark", …)`; `afterAction(reject)` writes the same shape with value `0` and tag `"jobrejected"`.
Both are wrapped in `try/catch` and emit `FeedbackWriteFailed` on error — a misbehaving registry can
never brick settlement of an already-funded job. The write is also gas-budgeted: below
`MIN_FEEDBACK_GAS` the hook does not attempt it at all and emits `FeedbackSkippedInsufficientGas`
instead, so an under-gassed caller is never mistaken for a hostile registry. See the gas note below —
callers must send a real limit rather than an `eth_estimateGas` result.

The hook also keeps per-agent aggregates earned from real escrow (`jobsFunded`, `jobsCompleted`,
`jobsRejected`, `jobsExpired`, `totalDeliverySeconds`) and measures funding-to-submission time.

### `src/interfaces/`

`IACPHook`, `IAgenticCommerce`, `IIdentityRegistry`, `IReputationRegistry`, `IValidationRegistry` —
minimal, documented, `^0.8.24`.

---

## What the hook enforces

`fund` is refused unless **all** of the following hold:

1. `optParams` is non-empty and decodes to a `uint256` agent id — else `AgentNotDeclared()`.
2. `identity.ownerOf(agentId)` does not revert and is non-zero — else `UnknownAgent(agentId)`.
3. At least one of these two evidence paths is satisfied — else `NoFreshEvidence(agentId, lastEvidenceAt)`:

   **(a) Validation Registry.** A record for this agent written by `attestor`, whose `lastUpdate` is
   within `maxEvidenceAge` and whose `response` is at least `minValidationScore`. The scan walks back
   over at most `VALIDATION_SCAN_LIMIT` (8) records so `fund` stays gas-bounded.

   **(b) Probe + Reputation Registry.** `lastProbeAt[agentId]` within `maxEvidenceAge` with
   `lastProbeScore[agentId] >= minValidationScore`, **and** a
   `getSummary(agentId, [attestor], "reachable", "")` returning `count > 0` and `summaryValue > 0`.

Defaults: `maxEvidenceAge = 24 hours`, `minValidationScore = 50`. Both owner-settable.

### Why Hallmark keeps its own clock

The Reputation Registry exposes no timestamp. `getSummary` returns a count and an aggregate and
nothing about *when* those entries were written — a ten-month-old `"reachable"` feedback and a
ten-minute-old one are indistinguishable through the standard interface. So `recordProbe(agentId,
score)`, callable only by the `attestor`, is the authoritative freshness clock, and the registry
entry is the public, standard-visible mirror of the same observation. The registry says *what* was
observed; the hook says *when*.

The Validation Registry does expose `lastUpdate`, so path (a) is self-timestamping and needs no
mirror.

### One thing worth stating plainly

The Reputation Registry refuses feedback whose submitter is the agent's own owner or operator.
`HallmarkHook` is a standalone contract owned by the marketplace and is never an agent controller, so
its writes are always accepted. Do not deploy this hook from an address that also controls agents.

### Gas: send a real limit to `complete` and `reject`, do not trust `eth_estimateGas`

**Integrators should send a gas limit of at least ~450,000 to `complete` (and `reject`) on a job that
carries this hook.** This is not defensive padding; an estimate will silently under-fund the receipt.

Here is the failure we hit on BSC testnet, because it is a nice trap and worth knowing about.

`_writeFeedback` wraps the Reputation Registry call in `try/catch`, deliberately, so a broken registry
can never unwind a job that has already paid out. But EIP-150 gives an inner call at most 63/64 of the
gas remaining, and a `catch` turns an inner out-of-gas into an outer *success*. `eth_estimateGas`
binary-searches for the smallest limit under which the **outer** call succeeds — so it converges on a
limit that starves the **inner** one, and reports that limit as sufficient.

The result: `complete` mines happily, the job reaches `Completed`, the provider is paid — and the
ERC-8004 receipt never lands. The only trace is a `FeedbackWriteFailed` with **empty** revert data,
which is exactly what an out-of-gas frame produces. Our headline feature would have quietly not worked
for every wallet that trusts its own estimate.

The arithmetic, measured on BSC testnet against the live registry:

| | gas |
|---|---|
| `complete` itself, receipt excluded | ~66,000 |
| `giveFeedback`, first write for a (client, agent) pair | ~214,000 |
| `giveFeedback`, subsequent writes for the same pair | ~132,000 |
| `complete` with the receipt landing | ~280,000 |
| `MIN_FEEDBACK_GAS`, the floor the hook checks | 250,000 |
| **recommended limit** | **450,000** |

450k leaves the hook well clear of its 250,000 floor after `complete`'s own ~66k, with room for the
63/64 clamp and the 20,000 epilogue reserve.

Two mitigations are in the contract, and one limitation stays:

- **The floor.** The hook checks `gasleft()` before attempting the write. Below `MIN_FEEDBACK_GAS` it
  emits `FeedbackSkippedInsufficientGas(jobId, agentId, gasLeft, required)` and returns. A skipped
  write can no longer masquerade as a rejected one — "send more gas" and "the registry refused us" are
  now different events.
- **The stipend.** The registry call gets an explicit `gasleft() - FEEDBACK_EPILOGUE_RESERVE`. Without
  it the registry receives 63/64 of everything and leaves the hook 1/64 to finish, so a registry that
  burns its whole allowance could run the hook out of gas *after* the money moved and revert a
  settlement it is forbidden from blocking.
- **The limitation.** A guard cannot make an under-gassed transaction write the receipt. It can only
  make the failure loud. Send the gas limit.

The funding gate takes the same problem and answers it in the opposite direction, on purpose. Its
evidence reads are also wrapped in `try/catch`, so a starved read would degrade to "no evidence" and
refuse a perfectly live agent. Before money moves, the safe answer to "I could not evaluate this" is
to refuse, so `fund` reverts with `InsufficientGasForEvidenceCheck(gasLeft, required)` below
`MIN_EVIDENCE_GAS` (150,000) instead of guessing. Reverting also keeps `eth_estimateGas` honest there:
the estimator raises the limit until the gate has room to actually run.

**After settlement is final, fail quietly and say so. Before money moves, refuse loudly.**

### Escape hatches

- `claimRefund` bypasses the hook entirely. Test `test_ClaimRefund_WorksEvenWhenHookReverts` proves a
  deliberately hostile hook cannot block it.
- `recordExpiry(jobId)` is permissionless and only writes if the escrow itself reports the job as
  `Expired`, because expiry is not observable from a callback.

---

## Addresses

### ERC-8004 registries (CREATE2, identical vanity prefixes per registry)

| | BSC mainnet (56) | BSC testnet (97) |
|---|---|---|
| IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |
| ValidationRegistry | `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` |

The Identity Registry is ERC-721 based but **not** Enumerable — there is no `totalSupply()`, and
agent ids do not form a dense range. Never iterate them.

### Altana's ERC-8183 deployment

| | BSC mainnet (56) | BSC testnet (97) |
|---|---|---|
| commerce | `0xEa4DAa3100A767e86FDed867729ae7446476EBA6` | `0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE` |
| router (EvaluatorRouter) | `0x51895229E12F9876011789B04f8698af06cCD6DA` | `0xD7d36D66d2F1B608A0F943f722D27e3744f66F25` |
| policy (OptimisticPolicy) | `0x9C01845705b3078Aa2e8cfF7520a6376FD766dE5` | `0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA` |
| paymentToken ($U, 18 dec) | `0xcE24439F2D9C6a2289F741120FE202248B666666` | `0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565` |

All of these live in `script/Addresses.sol`, keyed by `block.chainid`.

---

## Build, test, deploy

Dependencies are vendored under `lib/` and are git-ignored, so on a fresh clone:

```bash
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts --no-git
```

Then:

```bash
forge build
forge test              # 171 tests
forge test -vv
forge fmt
forge coverage
```

`evm_version` is `cancun`; BNB Chain has supported the full Cancun opcode set since the Pascal
hardfork. Optimizer on, 200 runs, `via_ir` off.

### Deploy

Copy `.env.example` to `.env` and fill in `PRIVATE_KEY`, `TREASURY` and `ATTESTOR`. Then, for testnet:

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url bsc_testnet \
  --broadcast \
  --verify \
  -vvvv
```

Swap `--rpc-url bsc_testnet` for `--rpc-url bsc` to go to mainnet. Verification uses the unified
Etherscan v2 endpoint (`https://api.etherscan.io/v2/api`) with `ETHERSCAN_API_KEY`.

The script deploys `AgenticCommerceHooked`, deploys `HallmarkHook` wired to the ERC-8004 registries
for the chain, allow-lists the hook on the escrow, optionally sets `EVIDENCE_BASE_URI`, and prints
every address. You can dry-run the whole thing with no network at all:

```bash
forge script script/Deploy.s.sol:Deploy --chain 97
```

### After deploying

1. Point the prober at the deployed hook and call `recordProbe(agentId, score)` from `ATTESTOR` on
   every sweep, mirroring each probe as a `"reachable"` feedback entry in the Reputation Registry.
2. Clients call `createJob(..., hook)` with the deployed hook, then
   `fund(jobId, budget, abi.encode(agentId))`.

---

## Tests

171 passing tests across four suites.

| Suite | Tests | Covers |
|---|---|---|
| `AgenticCommerceHookedTest` | 78 | ERC-8183 state machine, authorisation, fee maths, hook call contract, reentrancy, fuzz |
| `HallmarkHookAdminTest` | 50 | Access control, selector routing, configuration, view surface |
| `HallmarkHookTest` | 40 | The evidence gate, the settlement receipt, and the gas budgeting around both |
| `EscrowInvariantTest` | 3 | Escrow accounting invariants under randomised action sequences |

The ones that carry the pitch:

- `test_Fund_RevertsWhenAgentHasNoEvidence` — an unprobed agent cannot be funded.
- `test_Fund_RevertsWhenEvidenceIsStale` — evidence past `maxEvidenceAge` is worthless.
- `test_Fund_RevertsWhenValidationScoreBelowMinimum` — a failing probe is not evidence.
- `test_ClaimRefund_WorksEvenWhenHookReverts` — policy can never trap money.
- `test_Complete_SurvivesAReputationRegistryFailure` — the registry can never trap money either.
- `invariant_EscrowMatchesOpenBudgets` — the escrow's token balance always equals the sum of the
  budgets of every `Funded` or `Submitted` job.
- `test_Complete_EmitsFeedbackSkippedWhenGasIsInsufficient` — an under-gassed receipt is loud, not
  silent.
- `test_Complete_SurvivesARegistryThatBurnsAllForwardedGas` — a registry that consumes every unit of
  gas it is handed still cannot unwind a settled job. Its gas limit is chosen so the epilogue reserve
  is load-bearing: set `FEEDBACK_EPILOGUE_RESERVE` to zero and the test fails.
- `test_Fund_RevertsWhenGasIsInsufficientForEvidenceCheck` — a gate that cannot read its evidence
  refuses rather than guessing.

Registries are mocked in `test/mocks/` and mirror the real behaviour that matters: the Identity
Registry reverts on an unregistered agent, the Validation Registry stamps `lastUpdate` on every
write, and both registries can be told to revert so the hook's defensive paths are exercised rather
than assumed.

---

## Deviations from the ERC-8183 text

Two errors are added beyond the standard's list, both needed by functions the standard specifies:

- `BudgetMismatch(uint256 expected, uint256 actual)` — raised by `fund` when the on-chain budget does
  not match the `expectedBudget` the client passed. The standard mandates the front-run guard but
  names no error for it.
- `NotYetExpired()` — raised by `claimRefund` before `expiredAt`.

`MIN_JOB_DURATION` is set to 1 hour; the standard requires `ExpiryTooShort` but leaves the threshold
to the implementation.
