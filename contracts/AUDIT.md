# Hallmark contracts — pre-mainnet security review

An internal, adversarial review of `AgenticCommerceHooked` and `HallmarkHook` before mainnet. It was
run as a hostile audit of our own code: the goal was to find our bugs, not to certify the design.

One High was found and fixed during the review itself. The second High, and four of the Mediums,
were fixed in the remediation pass that followed it; that pass is recorded in
**[Remediation](#remediation)** below, finding by finding, with the regression test that covers each.
What was consciously left unfixed is listed there too, as accepted risk with the reasoning.

Status at the end of remediation: **both Highs fixed. M-1, M-2, M-3 and L-3 fixed. I-4 and I-8 fixed.
M-4 and M-5 accepted, with the reasoning recorded. The remaining Lows and Informationals stand as
reported.** The suite is **227 tests, all passing**, up from 194 at the end of the review.

---

## Scope

| | |
|---|---|
| Commit | `df0f8ea67fdc098f9b722179843176e5422b3037` (contracts/ identical since `e007fcf`) |
| In scope | `src/AgenticCommerceHooked.sol`, `src/HallmarkHook.sol`, `src/interfaces/*`, `script/Deploy.s.sol`, `script/Addresses.sol`, `test/**` |
| Out of scope | The ERC-8004 registries (third-party, upgradeable, treated as hostile), the `$U` payment token (third-party ERC-20), the off-chain prober, the indexer |
| Chain | BNB Smart Chain (56) and testnet (97) |

**Trust assumptions carried into the review.** The registries are third-party upgradeable proxies we
do not control: they may revert, return garbage, consume every unit of gas they are handed, or change
behaviour under us. `$U` is an ERC-20 we do not control. Anyone may create a job and name any
whitelisted hook. The hook's `attestor` is our key; the `owner` of both contracts is our deployer key.

## Tooling

| | |
|---|---|
| Foundry | `forge 1.7.1` (`4072e48705af9d93e3c0f6e29e93b5e9a40caed8`) |
| Solidity | `0.8.24`, `evm_version = "cancun"`, optimizer on, 200 runs, no via-IR |
| OpenZeppelin | `5.7.0` (`lib/openzeppelin-contracts`) |
| Static analysis | `slither 0.11.6` |
| Reference | ERC-8183 draft; ERC-8004 draft plus the ChaosChain reference implementation of the Identity, Reputation and Validation registries |

## What was run

- `forge build`, `forge test` — **194 tests passed at the end of the review** (171 shipped before it,
  plus 4 new regression tests in the shipped suite and 19 proof-of-concept tests in
  `test/AuditPoC.t.sol`). After remediation the suite is **227 tests, all passing**.
- `forge test --gas-report`.
- `forge coverage --ir-minimum` (plain `forge coverage` fails with a stack-too-deep in the
  instrumented `MockReputationRegistry`).
- `slither . --exclude-dependencies --filter-paths "lib/|test/"` — ran cleanly, 12 results, all
  triaged below. Nothing it reported was a bug we did not already have on the list.
- A line-by-line read of both contracts against a protocol-typed bug-class sweep: escrow accounting,
  role separation, reentrancy (including read-only and cross-function through the hook callbacks),
  gas griefing and the 63/64 rule, token-handling assumptions, timestamp boundaries, integer edges,
  event completeness, and ownership/initialisation.
- Nineteen adversarial PoCs, all runnable: `forge test --match-path test/AuditPoC.t.sol -vv`. Every
  finding below that is marked *proven* has one; every finding marked *reasoned* does not, and says so.

Nothing was deployed and no transaction was broadcast.

---

## Findings

| # | Severity | Issue | Status |
|---|---|---|---|
| H-1 | High | Anyone can forge or destroy ERC-8004 reputation for any hireable agent, using Hallmark's own trusted writer, for the price of gas | **Fixed in remediation** |
| H-2 | High | A Reputation Registry that burns its stipend and then reverts with a large return-data blob ran the hook out of gas inside its own `catch` and reverted a settlement it is forbidden from blocking | **Fixed in this review** |
| M-1 | Medium | Both evidence reads are O(history), not O(1) or O(8); the gate degrades to a silent, wrong refusal, and our own prober is what grows the history | **Fixed in remediation** |
| M-2 | Medium | A provider who has delivered has no protection: at `expiredAt` anyone can refund the client, and the agent is then marked as having let the job expire | **Fixed in remediation** |
| M-3 | Medium | The platform fee is read at settlement, not snapshotted at funding, so the owner can raise the fee on already-escrowed jobs | **Fixed in remediation** |
| M-4 | Medium | A payment token with a transfer blacklist locks escrow permanently (no rescue path), and one blocked treasury address bricks every completion | Accepted risk |
| M-5 | Medium | Single hot key, single-step, no timelock over both contracts, with broad powers | Accepted risk, deployment-time action |
| L-1 | Low | `evidenceBaseURI` is unbounded and sits inside the settlement gas budget | Partly fixed by H-2's fix |
| L-2 | Low | `isHireable` reports evidence that did not produce the answer it returns | **Fixed in remediation** |
| L-3 | Low | The validation path ignores the record's `tag`; the reputation path filters on one | **Fixed in remediation** |
| L-4 | Low | `renounceOwnership` is inherited and not disabled | Reported |
| L-5 | Low | The hook allow list is a creation-time filter only, and a whitelisted hook may be upgradeable | Reported |
| L-6 | Low | The provider can veto funding indefinitely with `setBudget` | Reported |
| L-7 | Low | `recordExpiry` can consume a job silently, with no event | Reported |
| L-8 | Low | `escrowedTotal()` is linear in `jobCount` with no bound | Reported |
| L-9 | Low | We document a Reputation Registry restriction the reference implementation does not implement | Reported |
| I-1 … I-10 | Informational | See below | I-4 and I-8 fixed in remediation; rest reported |

---

### H-1 — Anyone can forge or destroy ERC-8004 reputation for any hireable agent

**Proven.** `test_PoC_F01_NegativeFeedbackForgedAgainstAThirdPartyAgent`,
`test_PoC_F01_PositiveRecordForgedForYourOwnAgent`,
`test_PoC_F01_PaymentAndReputationCanPointAtDifferentParties`.

**Affected.** `src/HallmarkHook.sol:395-411` (`_beforeFund`), `:433-454` (`_afterSettlement`);
`src/AgenticCommerceHooked.sol:86-109` (`createJob`).

**The issue.** Two gaps compound.

1. Nothing binds the declared agent id to the party that gets paid. `_beforeFund` decodes an
   `agentId` from client-supplied `optParams`, checks it exists and is hireable, and writes
   `jobAgent[jobId] = agentId` (`:410`). It never reads the job from the escrow, so `job.provider`
   and `agentId` are unrelated for the whole life of the job. `IIdentityRegistry.getAgentWallet` is
   declared in our own interface and never called.
2. `createJob` places no constraint on the relationship between `client`, `provider` and
   `evaluator`. One address can hold all three roles.

Together, one EOA can run a complete, real job against an agent id it has never interacted with, and
the hook will write the outcome into the Reputation Registry under `address(hook)` — the address our
indexer and every other consumer treats as authoritative, precisely because it is ours.

**Why it matters.** Our entire pitch is that "an on-chain rating always corresponds to a job that
really settled." The job does really settle. It settles between an attacker and himself, about an
agent he chose off a list. Both directions are available:

- **Against a competitor.** Declare a live agent's id, fund 1 wei, reject as evaluator. The registry
  receives a `value = 0`, `tag1 = "jobrejected"` entry signed by Hallmark, and `_records[victim]
  .jobsRejected` increments. The 1 wei is refunded. Net token cost: zero. Every agent our attestor
  probes is eligible, because passing the evidence gate is the only precondition.
- **For yourself.** Same shape ending in `submit` then `complete`. The PoC mints five `value = 100`
  `"jobcompleted"` entries plus `jobsFunded = 5`, `jobsCompleted = 5`, and an
  `averageDeliverySeconds` of 0 — a flawless, instantaneous record. The platform fee on a 1 wei
  budget floors to zero (I-1), so this costs gas only.

**Exploit path (negative case, verbatim from the PoC).**

```
createJob(provider = attacker, evaluator = attacker, hook = HallmarkHook)
setBudget(jobId, 1)
fund(jobId, 1, abi.encode(VICTIM_AGENT_ID))     // passes: the victim is genuinely live
reject(jobId, "did not deliver")                // attacker is the evaluator
```

**Recommended fix.** Bind the agent to the counterparty, and separate the roles.

- In `_beforeFund`, read `IAgenticCommerce(commerce).getJob(jobId)` and require the declared agent to
  correspond to the job's provider — `identity.getAgentWallet(agentId) == job.provider` is the
  natural check and the function already exists in our interface. Decide deliberately whether the
  binding is to the agent's declared wallet or to `ownerOf(agentId)`; they are not the same thing.
- In `createJob`, reject `evaluator == msg.sender` and `evaluator == provider`, and in `setProvider`
  reject `provider_ == job.evaluator`. This does not close the finding on its own — an attacker can
  use two addresses — but with the agent binding in place it removes the free path.
- Consider making the gate refuse a job whose client is the agent's own owner, which is the spirit of
  the Reputation Registry's own self-review rule.

**Why we did not fix it in the review.** The binding is a product decision, not a patch. Choosing
`getAgentWallet` over `ownerOf` changes which agents can be funded at all, and if our live agents
have not set a wallet the change bricks funding on the deployment we already have on testnet. That
belongs to whoever owns the agent-onboarding flow, with a migration, not to an audit commit.

**Fixed in remediation.** See [H-1 remediation](#h-1-remediation). The decision taken was
`getAgentWallet` with an `ownerOf` fallback, plus a self-dealing check and a minimum attestable
budget. The testnet deployment was treated as disposable.

---

### H-2 — A return-data bomb from the Reputation Registry reverted settled jobs — **fixed**

**Proven, then fixed.** The four regression tests
`test_Complete_SurvivesARegistryThatRevertsWithAReturnDataBomb`,
`test_Complete_SurvivesAReturnDataBombOfAnySize`,
`test_Reject_SurvivesARegistryThatRevertsWithAReturnDataBomb` and
`test_FeedbackWriteFailed_ErrorDataIsBounded` now live in `test/HallmarkHook.t.sol`. All four fail
against the pre-fix `_writeFeedback` and pass against the current one; that was verified by reverting
the change and re-running.

**Affected.** `src/HallmarkHook.sol:464-506` (`_writeFeedback`).

**The issue.** This is the third instance of the family the two BSC-testnet bugs belonged to, and the
one the existing mitigations did not cover. `catch (bytes memory err)` copies the whole of
`returndatasize()` into memory and then pays 8 gas per byte to put it in a log — both out of the
20,000-gas epilogue reserve. A registry that reverts normally is harmless, because a revert hands the
unused stipend back and the hook has plenty left. A registry that **burns its stipend first and then
reverts with a large blob** leaves the hook only its 1/64 share and hands it an unaffordable bill.
The out-of-gas frame lands inside `afterAction`, which the escrow calls without a `try`, so the whole
of `complete` reverts — after the money has already moved.

The registry chooses the blob size and the caller cannot outbid it: the PoC confirmed `complete`
reverting at 450,000, 1,000,000, 5,000,000 and 20,000,000 gas.

**Failure scenario.** The ERC-8004 Reputation Registry is an upgradeable proxy we do not control. If
it is ever hostile or upgraded into this behaviour, `complete` and `reject` revert for every job
carrying `HallmarkHook`. Providers who have delivered cannot be paid; the only remaining exit is
`claimRefund` after expiry, which returns the escrow to the client and leaves the provider with
nothing. `claimRefund` being hook-free is what stops this from being a permanent fund freeze — that
part of the design held.

**The fix.** `_writeFeedback` no longer uses `try/catch`. It encodes the call itself and dispatches
it through inline assembly that copies at most `MAX_FEEDBACK_ERROR_BYTES = 256` bytes of return data,
so the epilogue's cost is a constant the reserve can cover instead of a number the registry picks.
Three properties were deliberately preserved:

- The failure is still reported as `FeedbackWriteFailed(jobId, agentId, err)`, and the diagnostic
  still works: an empty prefix reads as out-of-gas, a populated one as a registry rejection.
- A bare `CALL` to an address with no code succeeds where a high-level call would not, so the
  assembly re-checks `extcodesize(target)` and treats a codeless registry as a failure.
- The stipend is now taken from `gasleft()` read immediately before the call rather than at the top
  of the function, which also closes L-1.

The change is 40 lines in one private function and touches no state, no money path and no event
signature.

---

### M-1 — Both evidence reads are O(history), and the gate lies when starved

**Proven.** `test_PoC_F04a_ScanLimitDoesNotBoundTheArrayCost`,
`test_PoC_F04b_StarvedValidationReadSilentlyDeclaresALiveAgentDead`,
`test_PoC_F04c_ProbeMirrorHistoryGrowsTheGateUnbounded`,
`test_PoC_F04c_FundFailsOnceTheProbeHistoryIsLongEnough`.

**Affected.** `src/HallmarkHook.sol:520-552` (`_validationEvidence`), `:557-569`
(`_reputationEvidence`), `:395-411` (`_beforeFund`).

**The issue.** `VALIDATION_SCAN_LIMIT = 8` bounds the number of `getValidationStatus` calls. It does
not bound the cost of `getAgentValidations`, which returns the agent's **entire** request array and
has to be returned and ABI-decoded before the scan window is even chosen. The reputation path has the
same shape: the reference `getSummary` walks every entry that client has ever left for that agent, in
two passes, with a string tag comparison per entry.

Measured against our mocks:

| history | `isHireable` gas |
|---|---|
| 8 validation records | 32,329 |
| 250 validation records | 108,162 |
| 1,000 validation records | 361,035 |
| 5,000 validation records | 2,006,566 |
| 1 probe mirror | 21,362 |
| 25 probe mirrors | 90,740 |
| 100 probe mirrors | 334,341 |
| 400 probe mirrors | 1,312,261 |

`MIN_EVIDENCE_GAS` is 150,000, and `test_EvidenceGasFloor_CoversAFullyLoadedGateRead` asserts the
read fits under it — with exactly eight records. Nothing enforces eight. Past roughly 250 records the
floor stops bounding anything, and past roughly 1,000 the reads start failing inside their own
`try/catch`, which returns "no evidence found". `fund` then reverts with `NoFreshEvidence` for an
agent that demonstrably has fresh, passing evidence. The PoC sweeps gas limits from 300,000 to
3,000,000 against a live, validated agent and records **three limits where the gate lied**, three
where it failed opaquely out of gas, and **zero** where the loud
`InsufficientGasForEvidenceCheck` fired. That is exactly the silent degradation the floor was added
to prevent; the floor is simply set below the cost it is meant to cover.

**Why it matters more than an attack would.** No attacker is required. On a spec-compliant registry
`validationRequest` is restricted to the agent's owner or operator, so third parties cannot spam an
agent's validation list — we checked, and that closes the griefing direction. But the probe path is
ours: `Base._probe` mirrors every probe as a `"reachable"` feedback entry, and our prober is designed
to probe continuously. At roughly 3,300 gas per mirrored entry in our mock, a single agent probed
hourly makes its own gate unreadable within weeks; against the deployed registry, whose `getSummary`
does two passes with string comparisons, the per-entry cost is likely several times higher and the
horizon correspondingly shorter. This is a scheduled outage of our headline feature, not a
possibility.

**Recommended fix.**

- Stop reading `getSummary` on the hot path. `IReputationRegistry.getLastIndex(agentId, attestor)` is
  already declared in our interface, is unused, and answers "has the attestor ever left feedback for
  this agent" as a single storage read. It loses the `value > 0` check; decide whether that check was
  ever doing work, given the timestamp comes from `lastProbeAt` anyway.
- Have the prober write one `"reachable"` entry per agent and refresh `lastProbeAt` alone thereafter,
  rather than appending an entry per probe.
- For the validation path, ask the registry for a bounded slice. If the deployed registry cannot
  provide one, cache the attestor's latest `requestHash` per agent in the hook (the attestor already
  writes to us via `recordProbe`) and read `getValidationStatus` directly, skipping
  `getAgentValidations` entirely.
- Whatever is chosen, re-derive `MIN_EVIDENCE_GAS` from the resulting worst case and add a test that
  fails when the worst case grows past it. Measure the real curve on BSC testnet against the live
  registry, not against our mocks — the mocks establish the shape, not the constants.

---

### M-2 — A delivered job can be refunded away, and the agent is blamed for it

**Proven.** `test_PoC_F05_DeliveredWorkIsRefundedAwayAndTheAgentIsBlamed`,
`test_PoC_F05_ClaimRefundFrontRunsCompleteAtExpiry`.

**Affected.** `src/AgenticCommerceHooked.sol:239-253` (`claimRefund`), `:182-204` (`complete`);
`src/HallmarkHook.sol:298-310` (`recordExpiry`).

**The issue.** `claimRefund` accepts the `Submitted` state, is permissionless, and has no grace
period after submission. `complete` has no expiry check at all. So at `expiredAt` the two race, and
the client can always win by front-running the evaluator. The provider has delivered, the deliverable
is on-chain, and the escrow goes back to the client. `recordExpiry` then increments the agent's
`jobsExpired` — the agent carries the black mark for the evaluator's inaction.

The evaluator does not need to be malicious. An idle or slow evaluator produces the same outcome, and
since `createJob` lets the client name itself as evaluator (H-1), a client can arrange it
deliberately: hire, receive the work, never evaluate, refund at expiry, and mark the agent down on
the way out.

**Recommended fix.** Give the delivered state some standing. The cheapest version is to refuse
`claimRefund` from `Submitted` until a separate, longer `evaluationDeadline` — set at submission time
as `max(expiredAt, block.timestamp + EVALUATION_WINDOW)` — has also passed, and to have `recordExpiry`
distinguish "expired before delivery" from "expired after delivery" so the agent's record reflects
which party stalled. A blunter alternative is to forbid `claimRefund` from `Submitted` entirely and
require the evaluator to act; that trades a griefing vector for a liveness dependency on the
evaluator, so it is a product call.

---

### M-3 — The platform fee is read at settlement, not snapshotted at funding

**Proven.** `test_PoC_F06_OwnerCanRaiseTheFeeOnAlreadyEscrowedJobs`.

**Affected.** `src/AgenticCommerceHooked.sol:191` (`uint256 fee = (amount * feeBps) /
BPS_DENOMINATOR;`), `:281-285` (`setPlatformFee`).

**The issue.** `complete` reads the live `feeBps`. A provider who accepted work at 2.5% can be paid
at 10%: the owner raises the fee at any point between `fund` and `complete`, with no timelock and no
warning the provider can act on. The PoC shows a provider receiving 90% of a budget agreed at 97.5%.
The cap holds — `MAX_FEE_BPS` is 10% and enforced — so the blast radius is 7.5% of every job in
flight, not the whole escrow.

**Recommended fix.** Snapshot the fee into the `Job` struct at `fund` and settle against the
snapshot. This is a two-line change and removes the class entirely. Failing that, put `setPlatformFee`
behind a timelock long enough that a provider can decline.

---

### M-4 — A blacklisting payment token locks escrow permanently, and one blocked treasury bricks every completion

**Proven.** `test_PoC_F07_BlockedClientLocksTheEscrowForever`,
`test_PoC_F07_BlockedTreasuryBricksEveryCompletion`.

**Affected.** `src/AgenticCommerceHooked.sol:197-198`, `:227`, `:249`.

**The issue.** Every exit is a push transfer with no fallback and no rescue path.

- If the token blocks the **client**, both `reject` and `claimRefund` revert. The job's escrow is
  stuck in the contract forever: there is no sweep, no pull-payment path, and no owner override.
- If the token blocks the **provider**, `complete` reverts and the job can only be refunded at
  expiry — which is M-2's outcome, arrived at differently.
- If the token blocks the **treasury**, `complete` reverts for **every job with a non-zero fee**,
  across the whole contract, until the owner calls `setTreasury`. That one is recoverable but it is a
  contract-wide outage triggered by a third party.

`$U` is an ERC-20 we do not control. It does not blacklist today; USDC and USDT do, and an upgradeable
token can acquire the behaviour.

**Recommended fix.** Make the fee transfer non-blocking — accrue fees to a `pendingFees` counter and
let the treasury pull them — so a blocked treasury cannot stop settlement. For the client and
provider legs, add a pull-based fallback: on a failed push, credit an internal `withdrawable[account]`
and let the account (or a replacement address it nominates) claim later. Do not add an owner sweep of
live escrow; it would be a larger risk than the one it fixes.

---

### M-5 — Single hot key, single step, no timelock, over both contracts

**Reasoned.** No PoC; this is a configuration finding.

**Affected.** `AgenticCommerceHooked` `:281-300`, `HallmarkHook` `:365-389`, `script/Deploy.s.sol:39-46`.

**The issue.** The deploy script leaves the deployer as `owner` of both contracts, and `.env` holds
that key in plaintext on a developer machine. `.env` is correctly gitignored and not tracked — we
checked git history as well as HEAD — so this is a key-custody note, not a leak. The powers behind it
are broad:

- `setPlatformFee` — up to 10% of every escrowed job, applied retroactively (M-3).
- `setTreasury` — redirects all future fees.
- `setHookWhitelisted` — admits new policy contracts, which run inside the escrow's call frame.
- `setAttestor` — instantly invalidates every agent's evidence, or, with a colluding attestor, makes
  any agent hireable.
- `setMinValidationScore` / `setMaxEvidenceAge` — can disable the gate in either direction.

Both contracts use single-step `Ownable`, so a mistyped `transferOwnership` is unrecoverable.

**Recommended fix.** Move ownership to a multisig before mainnet, switch to `Ownable2Step`, and put
`setPlatformFee`, `setAttestor` and `setHookWhitelisted` behind a timelock. Keep the attestor as a
separate hot key — that separation is already right — and document the rotation procedure.

---

### Low

**L-1 — `evidenceBaseURI` is unbounded and sits inside the settlement gas budget.**
`src/HallmarkHook.sol:386`. Before H-2's fix, `FEEDBACK_EPILOGUE_RESERVE` was subtracted from a
`gasleft()` reading taken *before* `feedbackURI()` loaded the owner-set string, so the reserve the
contract believed it was holding back had already been partly spent. Sweeping base-URI lengths
against a gas-burning registry found a real band — at 2,048 bytes, `complete` reverted at every gas
limit from 340,000 to 380,000, where a 30-byte URI never did
(`test_PoC_F03_MinimumSafeGasDependsOnAnOwnerSetString`). The fix re-reads the meter immediately
before the call, and that band is now empty at every length tested. What remains is that nothing
caps the string, so a long enough one can still push the encoding past the whole budget. Add a length
bound in `setEvidenceBaseURI`, and prefer storing a short prefix.

**L-2 — `isHireable` reports evidence that did not produce the answer.**
`src/HallmarkHook.sol:338-339`. `ok` comes from whichever path passed; `lastEvidenceAt` and `score`
come from whichever evidence is *newer*. When a fresher validation fails the score threshold and an
older probe carries the job, the view returns `ok = true` alongside a score below
`minValidationScore` and a timestamp pointing at the failing record
(`test_PoC_F09_IsHireableReportsEvidenceThatDidNotEarnTheAnswer`). Our indexer reads this. Return the
evidence that actually satisfied the gate, and consider returning which path did.

**L-3 — The validation path ignores the record's `tag`.** `src/HallmarkHook.sol:520-552`. Any
attestor validation with a passing score opens the liveness gate, whatever it attests to — a
code-quality score of 80 works (`test_PoC_F09_ValidationPathIgnoresTheTag`). The reputation path
filters on `REACHABLE_TAG`, so the two paths disagree about whether the tag means anything. Filter
the validation path on a liveness tag too, or document why not.

**L-4 — `renounceOwnership` is not disabled.** Both contracts. Renouncing would permanently freeze
`setTreasury`, `setPlatformFee`, `setHookWhitelisted` and every hook setter. In particular, if
ownership were renounced and the attestor key later lost, no agent could ever be funded again.
Override it to revert.

**L-5 — The hook allow list is a creation-time filter only.** `AgenticCommerceHooked:95`, `:296-300`.
This is documented, and it is the right call for in-flight jobs — but the consequence is that
de-whitelisting a hook found to be malicious does not protect the jobs already bound to it, and
nothing stops a whitelisted hook from being an upgradeable proxy whose implementation changes after
approval. A malicious hook cannot touch escrow storage (it is a `CALL`, not a `delegatecall`) and
cannot re-enter (every state-changing function is `nonReentrant`), but it can revert and hold a
pre-expiry job hostage until `claimRefund`. Require whitelisted hooks to be non-upgradeable, or
record the approved implementation's `EXTCODEHASH` at whitelist time and check it in `_before`.

**L-6 — The provider can veto funding.** `AgenticCommerceHooked:128-141`. `setBudget` is callable by
the provider while the job is `Open`, so a provider can move the budget under a client who is about
to `fund` and force a `BudgetMismatch` revert, indefinitely
(`test_PoC_F08_ProviderCanVetoFunding`). No funds are at risk — the `expectedBudget` guard works
exactly as designed — and the client can escape via `setProvider` or `reject`. Worth a note in the
integration docs rather than a code change.

**L-7 — `recordExpiry` can consume a job silently.** `src/HallmarkHook.sol:298-310`. When
`jobAgent[jobId] == 0` (a job that used a different hook, or was never funded through this one), the
function sets `expiryRecorded[jobId] = true` and emits nothing. An indexer sees no event; a later
caller gets `ExpiryAlreadyRecorded`. Emit something on every state change, even the no-op branch.

**L-8 — `escrowedTotal()` is unbounded.** `AgenticCommerceHooked:268-274`. Linear in `jobCount`;
156,966 gas at 400 jobs. It is documented as an off-chain read and nothing on-chain calls it, but it
will eventually exceed an `eth_call` gas cap and break both integrators and
`invariant_EscrowMatchesOpenBudgets`. Maintain a running `totalEscrowed` counter instead.

**L-9 — We document a registry restriction the reference implementation does not implement.**
`src/HallmarkHook.sol:41-43` and `README.md` both state that the Reputation Registry refuses feedback
whose submitter is the agent's own owner or operator, and use that to justify the hook being a
separate contract. The ERC-8004 draft does say `MUST NOT`; the ChaosChain reference implementation we
read does not appear to enforce it. Verify against the deployed bytecode on BSC before relying on the
claim, and adjust the wording either way. The separate-contract decision is still correct for other
reasons.

### Informational

- **I-1 — The fee floors to zero on small budgets.** `AgenticCommerceHooked:191`. Any budget below
  `BPS_DENOMINATOR / feeBps` (40 wei at 250 bps) pays no fee at all
  (`test_PoC_F08_FeeRoundsToZeroOnSmallBudgets`). Rounding is toward the provider, by at most 1 wei
  per job, and splitting a job to farm it costs far more in gas than it saves. Not economically
  exploitable on its own; it is what makes H-1 free.
- **I-2 — Donated tokens are stranded, and the shipped invariant overstates what is enforceable.**
  `invariant_EscrowMatchesOpenBudgets` asserts `balanceOf(escrow) == escrowedTotal()`. Anyone can
  break that with a bare transfer (`test_PoC_F08_DonatedTokensAreStrandedForever`), and the surplus
  is unrecoverable. The property the code can actually guarantee is `>=`. State it that way.
- **I-3 — `createJob` is the only permissionless state-changing function without `nonReentrant`.** It
  makes no external calls, so this is currently harmless; it is worth the modifier for uniformity
  before anyone adds one.
- **I-4 — Counter widths.** `Record`'s `uint32` counters and `uint64` delivery accumulator cannot
  realistically overflow (2^32 funded jobs; 2^64 seconds). One edge: `_afterFund` does not skip
  `agentId == 0` the way `_afterSubmit` and `_afterSettlement` do, so a broken Identity Registry that
  returned a non-zero owner for token 0 would let `_records[0]` be written. Add the same guard.
- **I-5 — `Refunded` is emitted by two different terminal paths.** `reject` and `claimRefund` emit an
  identical event; the indexer must correlate with `JobRejected` / `JobExpired` in the same
  transaction to tell them apart. Resolvable, but worth a distinct event or a reason field.
- **I-6 — `PaymentReleased.amount` is the net payout, not the budget.** An indexer reading `amount`
  as the job's value is wrong by the fee. The fee is emitted alongside so it is recoverable; the name
  is the hazard.
- **I-7 — `setMinValidationScore` accepts values above 100**, which is outside the ERC-8004 scale and
  silently disables the gate's positive path. `recordProbe` likewise accepts a score above 100.
  Bound both.
- **I-8 — The invariant suite is narrower than it looks.** It never attaches a hook (every handler
  job uses `address(0)`), uses one client, one provider and one evaluator, never exercises
  `setProvider` or a mid-flight `setPlatformFee`, and pre-filters every illegal call — so with
  `fail_on_revert = false` the campaign reports zero reverts by construction. A handler that quietly
  stopped doing anything would still pass. Add a hooked handler, multiple actors that can occupy more
  than one role, and an assertion that the campaign actually landed the transitions it claims.
- **I-9 — Deployer key custody.** `.env` holds a live private key that owns both contracts. Correctly
  gitignored and absent from git history; the note is that it is a hot key with the powers listed in
  M-5.
- **I-10 — The deploy path is untested.** `script/Deploy.s.sol` and `script/Addresses.sol` are at 0%
  coverage. The script wires registries by chain id from a hard-coded table and whitelists the hook;
  a wrong address in `Addresses.sol` is silent. Add a test that runs the script against a forked
  chain and asserts the wiring, including that each registry address has code.

### Slither triage

`slither 0.11.6` ran and returned 12 results. All were triaged; none was a bug we did not already
have.

| Detector | Verdict |
|---|---|
| `incorrect-equality` on `record.jobsCompleted == 0` | False positive — an integer count, not a timestamp or a balance. |
| `unused-return` on `getValidationStatus` and `getSummary` | False positive as a bug, true as a smell. The ignored `tag` is L-3; the ignored `summaryValueDecimals` does not matter because only the sign of `summaryValue` is used. |
| `calls-loop` on `_validationEvidence` | True positive, and it is M-1. Each call is individually `try/catch`ed and the loop is bounded at 8, but the array the loop indexes is not. |
| `timestamp` (6 sites) | Accepted. Evidence freshness and job expiry are deliberately wall-clock functions; a validator nudging the timestamp by seconds cannot move a 24-hour window or a multi-day expiry. The lint is excluded in `foundry.toml` with that reasoning. |
| `assembly` in `_writeFeedback` | Expected — introduced by H-2's fix. The block is annotated `memory-safe`, allocates its output buffer through Solidity before entering assembly, and only writes inside that buffer. |
| `reentrancy-events` (pre-fix, on `_writeFeedback` / `_afterSettlement`) | Was reported before the fix and is gone after it. Events after an external call are correct here — the registry cannot corrupt the hook, since `beforeAction` / `afterAction` are `onlyCommerce`, `recordProbe` is `onlyAttestor`, and the only permissionless entry point, `recordExpiry`, is idempotent and reverts unless the escrow itself reports the job as `Expired`. |

---

## What we looked for and did not find

A short findings list is only worth reading if the search behind it was real. These are the classes we
attacked that came back clean.

**Escrow accounting — clean.** We could not construct a double payout, a partial payout, or a
stranded funded job under a well-behaved token. Every terminal transition writes `job.status` before
it moves any tokens (`complete` `:194` before `:197`, `reject` `:222` before `:227`, `claimRefund`
`:245` before `:249`), and each of `Funded` and `Submitted` has exactly one exit per terminal state.
`setBudget` is refused once the job leaves `Open`, so the escrowed amount is frozen at funding. The
sum of budgets over `Funded` and `Submitted` jobs equals the token balance across 8,192 randomised
calls, and it held under our own reading too.

**Rounding — clean, and in the protocol's favour except for dust.** `fee = amount * feeBps /
BPS_DENOMINATOR` floors, so the truncation of at most 1 wei goes to the provider, not the treasury.
It cannot be farmed: the gas cost of splitting a job to stay under the flooring threshold exceeds the
fee saved by orders of magnitude. `payout = amount - fee` cannot underflow because `feeBps <= 1000`.
There is no share math, no exchange rate, no accumulator and no index in this system, so the entire
donation / first-depositor / inverse-rate family has nothing to attach to.

**Reentrancy — clean, including the variants.** Every state-changing external function is
`nonReentrant`, and the hook callbacks run inside that guard, so a hook cannot re-enter `fund`,
`complete`, `reject` or `claimRefund` — the shipped `ReentrantHook` tests prove all three directions.
Read-only reentrancy has nothing to poison: we walked every point at which a hook or a token callback
regains control and checked what `getJob`, `escrowedTotal` and `isHireable` would return there. The
only window where the escrow's books and its balance disagree is between the status write and the
transfer inside `complete` and `reject`, and there the balance is *higher* than the obligation, which
is the safe direction. Cross-function reentrancy through the hook into `createJob` (the one function
without the guard) touches only a fresh job slot. A re-entrant Reputation Registry can reach only
`recordExpiry`, which is idempotent and gated on the escrow's own view of the job.

**Front-running `fund` — the guard holds.** `setProvider` is client-only, so the provider cannot be
swapped under a funder; `setBudget` is client-or-provider, and a provider who moves the budget is
caught by `expectedBudget`, which reverts rather than paying the wrong amount. We fuzzed every wrong
`expectedBudget` value. The residue is L-6, a griefing veto with no funds at risk.

**Malicious-hook blast radius — bounded as designed.** A whitelisted hook is invoked with `CALL`, not
`delegatecall`, so it cannot touch escrow storage. It cannot re-enter. It can revert, and it can burn
gas, and both stop at `claimRefund`, which never calls the hook — the shipped
`test_ClaimRefund_WorksEvenWhenHookReverts` covers it and we confirmed the reasoning by hand. The
remaining exposure is L-5, about *which* hooks get whitelisted, not about what a hook can do once it
is.

**Third-party validation spam against an agent — refuted.** The obvious griefing play was to push
eight junk validation requests at a competitor and evict our attestor's genuine record from the
eight-deep scan window. On a spec-compliant registry this does not work: `validationRequest` is
restricted to the agent's owner or approved operator, re-submitting an existing `requestHash` reverts,
and `lastUpdate` is written only by `validationResponse`, so an unanswered request cannot masquerade
as fresh evidence. The hook's `recordLastUpdate != 0` filter handles that case correctly. The shipped
test that appears to show a third party evicting a record does so only because
`MockValidationRegistry.validationRequest` has no access control — the mock is more permissive than
the registry it stands in for. Worth fixing in the mock so the test asserts what it appears to assert.

**Third-party reputation spam to make an agent unhireable — refuted.** The reference `getSummary`,
given a non-empty `clientAddresses` array, iterates only those clients' entries. Since the hook always
passes `[attestor]`, no third party can inflate the cost of the read. The cost still grows — but from
our own writes, which is M-1.

**Stale probe replay — clean.** `lastProbeAt` is written only by `recordProbe` under `onlyAttestor`,
carries no signature and no nonce to replay, and is a plain overwrite. There is no way to make an old
probe look new: the timestamp is `block.timestamp` at write time and the freshness comparison is
against `block.timestamp` at read time. Rotating the attestor invalidates all prior evidence at once,
which is severe but correct.

**Integer edges, casts and default values — clean.** Solidity 0.8 checked arithmetic covers the
`uint32` counters and the `uint64` accumulator, and reaching either bound requires billions of jobs.
The `uint64(block.timestamp)` and `uint64(recordLastUpdate)` casts are safe for any timestamp this
chain will see. `uint256(validatedAt) + age` cannot overflow because `age <= 30 days`. `agentId == 0`
is rejected by `_requireAgentExists` against any registry whose `ownerOf` behaves like ERC-721.
`hashes[n - 1 - i]` cannot underflow because the scan length is clamped to the array length. The one
default-value note is I-4.

**Expiry boundary — clean.** `claimRefund` reverts strictly below `expiredAt` and succeeds at exactly
`expiredAt`; `createJob` requires `expiredAt >= block.timestamp + 1 hours`, so a job cannot be created
already expired. The `>=` versus `>` choices are consistent. The problem at the boundary is who is
allowed to act there, which is M-2, not the arithmetic.

**Upgradeability and initialisation — nothing to find.** Neither contract is upgradeable or
proxied; all critical wiring is `immutable` and set in constructors that reject the zero address for
every dependency. There is no `initialize`, no storage gap, no `delegatecall` anywhere in either
contract, and no uninitialised state: `evidenceBaseURI` starting empty is handled explicitly by
`feedbackURI`.

**Event completeness — one gap.** Every state transition in the escrow emits, every admin setter
emits, and the two distinct feedback-failure modes are deliberately different events so an indexer
cannot mistake a skipped write for a rejected one. The single silent state change we found is L-7.
The two naming hazards are I-5 and I-6. `OutcomeRecorded` is emitted whether or not the registry
write landed, which is correct — it records Hallmark's own accounting, and the write's fate has its
own event — but integrators should know that `OutcomeRecorded` is not a receipt confirmation.

**Discoverable secrets — clean.** `.env` is gitignored, absent from `git ls-files`, and absent from
git history; `broadcast/`, `cache/` and `out/` are likewise ignored. Only `.env.example` is tracked,
and it holds placeholders.

---

## Coverage

Measured with `forge coverage --ir-minimum` over the shipped suite only (the PoC file is excluded, so
these numbers describe the tests we ship, not the ones written to break things).

| File | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| `src/AgenticCommerceHooked.sol` | 100.00% (137/137) | 100.00% (186/186) | 100.00% (38/38) | 100.00% (17/17) |
| `src/HallmarkHook.sol` | 94.67% (160/169) | 93.81% (197/210) | 88.10% (37/42) | 100.00% (24/24) |
| `script/Addresses.sol` | 0.00% (0/16) | 0.00% (0/15) | 0.00% (0/6) | 0.00% (0/3) |
| `script/Deploy.s.sol` | 0.00% (0/31) | 0.00% (0/40) | 0.00% (0/1) | 0.00% (0/1) |

**The uncovered surface, named.**

- `HallmarkHook` was at 100.00% lines / 98.95% statements / 95.00% branches before this review. The
  drop is entirely attributable to H-2's fix. Nine lines are newly reported as uncovered: seven of
  them are the `assembly` block in `_writeFeedback` and the line that sets up its bound (`:493-502`),
  which `forge coverage` cannot instrument — that code runs on every settlement test in the suite, so
  it is invisible to the instrumenter rather than untested. The other two are the body of the new
  low-gas guard, below.
- Three uncovered branches are defensive guards that are hard or impossible to reach on purpose:
  `attestor == address(0)` in `_validationEvidence` (`:522`) and `_reputationEvidence` (`:559`) —
  unreachable, because the constructor and `setAttestor` both reject the zero address — and the new
  `remaining <= FEEDBACK_EPILOGUE_RESERVE` early return (`:481`), which needs the payload encoding to
  consume between `available - 20,000` and `available` gas. We swept a 600,000-gas band against a
  4 KB base URI without landing in that window and stopped chasing it; it exists to make a pathological
  `evidenceBaseURI` produce a skipped receipt rather than an underflow revert on a settled job.
- `script/` is untested end to end. That is I-10, and it is the largest genuinely uncovered surface:
  the registry address table is hard-coded and a wrong entry would be silent.
- Coverage says nothing about the classes this review actually spent its time on. The escrow is at
  100% on every metric and still has H-1, M-2, M-3 and M-4, all of which are about which calls are
  *allowed*, not which lines execute.

Full suite: **194 tests, 0 failures** (`forge test`).

---

## Limitations of this review

- **It is a self-audit.** It was carried out by the same party that wrote the code, against the same
  mental model. That is the least reliable configuration there is, and it is why the "did not find"
  section above is written out in full: so a reader can judge the search, not just the result.
- **Every registry number here comes from a mock.** `MockReputationRegistry` and
  `MockValidationRegistry` reproduce the shape of the real registries' cost curves, not their
  constants. M-1's timeline in particular — how many probes it takes to break our own gate — must be
  re-measured on BSC testnet against the deployed registries before anyone acts on the number. We did
  read the ERC-8004 reference implementation to establish the access-control and iteration semantics
  the findings depend on, but we did not diff it against the deployed bytecode at
  `0x8004B…` / `0x8004C…`; Sourcify has no verified source for those addresses.
- **No fork testing.** Everything was run against a local EVM with mocks. There is no test that
  exercises the real registries, the real `$U` token, or BSC's actual gas schedule. Given that both
  previously-found bugs and H-2 are gas-schedule bugs, a fork suite against BSC testnet is the single
  highest-value thing to add next.
- **No formal verification and no stateful fuzzing of the hook.** The invariant campaign covers the
  escrow only, and narrowly (I-8). The hook's accounting — that `jobsFunded >= jobsCompleted +
  jobsRejected + jobsExpired`, that `totalDeliverySeconds` only accumulates from completed jobs, that
  `expiryRecorded` is monotonic — is asserted by unit tests, not by a campaign.
- **The economic model was not reviewed.** Whether a 2.5% fee, a 1-hour minimum duration, or a
  24-hour evidence window are the right numbers is out of scope here.

**What a professional audit is still needed for.** An independent reading of the ERC-8183 conformance
claims; a review of the H-1 fix once the agent-to-provider binding is chosen, since that fix changes
who can be funded; adversarial review of the gas budgeting against the deployed registries rather than
mocks, which is where all three of our real bugs have come from; and a look at the hook allow-list
governance (L-5) as an ongoing process rather than a line of code.

---

## Changes made during this review

Two files were modified. Nothing else in the repository was touched, nothing was deployed, and no
existing test was weakened or removed.

- `src/HallmarkHook.sol` — `_writeFeedback` now dispatches the registry call through inline assembly
  that copies at most `MAX_FEEDBACK_ERROR_BYTES = 256` bytes of return data, and takes the epilogue
  reserve from `gasleft()` read immediately before the call. Fixes H-2, and closes the exploitable
  half of L-1. New public constant `MAX_FEEDBACK_ERROR_BYTES`; no other state, money path or event
  signature changed.
- `test/HallmarkHook.t.sol` — four regression tests, plus `test/mocks/ReturnBombReputationRegistry.sol`.
  All four fail against the pre-fix contract.

`test/AuditPoC.t.sol` holds the nineteen proofs-of-concept behind the findings above. It is an audit
artifact rather than part of the product suite. Several of its tests asserted that a bug was present;
those were inverted in place during remediation, keeping their names so the finding-to-proof mapping
survives. See [Remediation](#remediation).

---

# Remediation

Everything below was done after the review, in response to it. Every fix carries the regression test
that covers it; every test named here fails against the pre-remediation contracts. The suite went
from 194 to **227 passing tests**, `forge build` is warning-free and `forge fmt --check` is clean.

The PoCs in `test/AuditPoC.t.sol` were not deleted. Each one that proved a now-fixed bug was inverted
in place: it still sets the attack up exactly as before, and now asserts that it fails. The test names
are unchanged so the mapping from finding to proof survives, and a regression would resurface as a
failure in the test that originally found it.

## H-1 remediation

**Fixed.** Three changes in `src/HallmarkHook.sol`, in the order an attacker meets them.

1. **The agent is bound to the payee.** `_beforeFund` now reads the job and requires the declared
   agent's on-chain payee to be the job's provider, reverting `AgentProviderMismatch(agentId,
   expected, provider)`. The payee is `IIdentityRegistry.getAgentWallet(agentId)`, falling back to
   `ownerOf(agentId)` when no wallet is declared — registration auto-sets the wallet to the
   registrant, so both branches are live against the deployed registry. You can now only ever move
   the reputation of an agent you actually paid.

2. **A self-dealt job earns no attestation.** Binding stops you writing about someone else's agent; it
   does not stop you paying yourself. At funding time the hook classifies the job and caches the
   verdict in `jobBinding[jobId]`. A job whose client is the agent's payee or owner, or whose
   evaluator is the party being paid, is `SelfDealt`: it settles and pays out exactly as before, but
   writes nothing to ERC-8004 and emits `FeedbackSkippedSelfDealt(jobId, agentId, client)`.

   The classification happens at `fund`, not at settlement, for two reasons. The settlement path runs
   inside a gas budget and must not take on more registry reads — that is the failure class this
   contract has already been bitten by twice. And funding is the honest moment to judge the
   relationship: it is when the client chose the counterparty and the money moved.

3. **Dust earns no attestation.** `minAttestableBudget` (default `1e17`, owner-settable, zero
   disables) is the floor below which a settled job records no feedback and emits
   `FeedbackSkippedBudgetTooSmall`. Like the fee, the threshold in force at funding is the one that
   applies, so the owner cannot retroactively disqualify a job that was already escrowed.

**The counters do not increment for a non-attestable job**, which the brief asked us to decide
explicitly. `jobsCompleted` and `jobsRejected` stay put; only `jobsFunded` increments. The reasoning:
`agentRecord` is the surface our own marketplace ranks on and the UI renders beside the registry data.
If it counted jobs that earned no attestation it would simply become a second reputation channel with
the forgery property we just removed from the first — and the cheaper one to attack, since it costs no
registry write. Keeping the counters and the registry in agreement by construction is the whole point.
`jobsFunded` still moves because it is a fact about escrow rather than a claim about quality, and the
gap between `jobsFunded` and `jobsCompleted + jobsRejected` is then a visible on-chain signal that
somebody is running jobs that do not qualify.

**What this does not fix, stated plainly.** An attacker holding three unrelated keys — client, agent
owner, agent wallet — passes every relationship test, because nothing on-chain distinguishes two
strangers from one person with two wallets. That case is *priced*, not detected: with the dust floor
in place a forged attestation costs a real escrowed budget and the platform fee on it. The
relationship checks remove the free path; the budget floor removes the cheap one. Sybil resistance
proper needs an identity signal we do not have.

**Regression tests.**

| Test | Asserts |
|---|---|
| `AuditPoCTest.test_PoC_F01_NegativeFeedbackForgedAgainstAThirdPartyAgent` | the original attack now reverts `AgentProviderMismatch`, and the victim's record and registry entries are untouched |
| `AuditPoCTest.test_PoC_F01_PositiveRecordForgedForYourOwnAgent` | five self-dealt jobs settle and credit nothing: `jobsCompleted == 0`, zero registry entries |
| `AuditPoCTest.test_PoC_F01_PaymentAndReputationCanPointAtDifferentParties` | credit and payment can no longer diverge |
| `AuditPoCTest.test_Fixed_F01_SelfDealtJobSettlesButEarnsNoAttestation` | the money path is untouched and the skip is announced |
| `AuditPoCTest.test_Fixed_F01_DustJobEarnsNoAttestation` | a 1-wei job emits `FeedbackSkippedBudgetTooSmall` and writes nothing |
| `AuditPoCTest.test_Fixed_F01_BindingFallsBackToTheAgentOwner` | an agent with no declared wallet still resolves, via `ownerOf` |
| `HallmarkHookAdminTest.test_Fund_RevertsWhenTheAgentIsNotTheJobsPayee` | the binding in isolation |
| `HallmarkHookAdminTest.test_JobBinding_RecordsTheClientAndVerdict`, `…_FlagsADustJob` | the cached verdict |
| `HallmarkHookAdminTest.test_MinAttestableBudget_IsFixedAtFundingTime`, `…_ZeroDisablesTheFloor`, `…_OnlyOwner` | the threshold's semantics |
| `HookedInvariantTest.invariant_HookedFeedbackIsBackedByEscrow` | every entry the hook wrote is backed by a job funded against that agent |
| `HookedInvariantTest.invariant_HookedOutcomesNeverExceedFundedJobs` | outcomes can never outnumber funded jobs |

## M-1 remediation

**Fixed**, by changing what the gate reads rather than only how much gas it demands.

**The primary evidence path is now O(1).** The hook's own `lastProbeAt` / `lastProbeScore` — written
by the attestor, held in this contract's storage — answers the freshness question in a single storage
read, with no external call at all. If the probe carries the decision, the gate never touches a
registry.

**The reputation mirror left the funding path entirely.** It was the self-inflicted half of the
finding: our prober mirrors every probe into ERC-8004, and `getSummary` walks all of them, so our own
uptime was what would eventually starve the gate. It was removed rather than merely floored, because
it was never a trust control — the same attestor key writes both the mirror and the probe, so
requiring both proved nothing the probe alone does not. What the mirror buys is public visibility, and
visibility belongs in an `eth_call`. It now lives in `hasRegistryMirror(agentId)`, documented as an
off-chain read where an unbounded scan is free.

**The remaining O(history) branch is floored, stipended, and allowed to refuse.** When the probe does
not carry the decision the gate falls back to the Validation Registry, and that branch now:

- checks `gasleft()` against `MIN_VALIDATION_READ_GAS` (400,000) **immediately before** the read it
  pays for, rather than relying on one `MIN_EVIDENCE_GAS` check at entry;
- hands `getAgentValidations` an explicit stipend computed from gas actually remaining, holding back
  the full scan window, so EIP-150's 63/64 rule cannot deliver less than the floor just promised;
- floors and stipends each `getValidationStatus` read inside the scan as well;
- and treats a read that still fails as **indeterminate, never negative** — it reverts
  `EvidenceReadFailed(agentId)` instead of returning "no evidence found".

Identity reads got the same treatment: `_agentOwner` and `_agentPayee` are floored and stipended, so
`UnknownAgent` now means the registry answered "no such agent" rather than "we could not afford to
ask". The escrow read is bounded too — the hook reads `getJobParties`, a new fixed-width accessor on
`AgenticCommerceHooked` (`src/interfaces/IJobParties.sol`), because `getJob` returns the
client-supplied `description` string and nothing bounds its length. Reading that on a money path
would have handed the client control of the gate's gas cost.

**A regression the fix introduced, and closed.** Making the probe the primary path initially broke
attestor rotation: `lastProbeAt` was keyed only by agent, so a probe signed by a retired key still
counted. Probes now record their author (`Probe { at, score, by }`, one slot — cheaper than the two
mappings it replaces) and only count while `by == attestor`. Covered by
`HallmarkHookAdminTest.test_LastProbe_ReadsZeroAfterAttestorRotation`.

**Regression tests.**

| Test | Asserts |
|---|---|
| `AuditPoCTest.test_Fixed_F04_GateNeverLiesUnderAnyGasLimit` | the test the brief asked for: a live agent behind 1,200 validation records and 400 probe mirrors, swept from 300k to 3M gas. `fund` either succeeds or reverts with a named error; it **never** reverts `NoFreshEvidence`. Both outcomes are asserted to occur, so the sweep cannot pass vacuously |
| `AuditPoCTest.test_Fixed_F04_ProbedAgentIsFundableRegardlessOfHistory` | 5,000 validation records, funded at a 500k limit, because the probe path never reads them |
| `AuditPoCTest.test_Fixed_F04_StarvedValidationReadRefusesLoudly` | 20,000 records at a 2M limit reverts `EvidenceReadFailed`, not `NoFreshEvidence` |
| `AuditPoCTest.test_PoC_F04c_FundFailsOnceTheProbeHistoryIsLongEnough` | inverted: 3,000 mirrors, still funded at 900k |
| `HallmarkHookTest.test_Fund_RevertsEvidenceReadFailedWhenTheValidationRegistryIsDown` | indeterminate is distinguishable from negative |
| `HallmarkHookTest.test_Fund_SurvivesBothRegistriesBeingDown` | a probed agent is fundable with both registries refusing to answer |
| `HallmarkHookTest.test_ProbePath_IsCheapAndTouchesNoRegistry` | the primary path costs under 20k gas and makes no registry call |
| `HallmarkHookTest.test_EvidenceGasFloor_CoversAFullyLoadedValidationRead` | the floor is measured against the branch it actually guards, with no probe short-circuiting it |

## M-2 remediation

**Fixed.** Delivering now buys the evaluator a guaranteed window. `submit` sets
`evaluationDeadline[jobId] = max(expiredAt, block.timestamp) + EVALUATION_WINDOW` (3 days) and
`claimRefund` refuses a `Submitted` job until it passes, reverting `EvaluationWindowOpen(jobId,
deadline)`. A `Funded` job is unchanged: it is still refundable at `expiredAt`, because nothing was
delivered.

The deadline is anchored on `expiredAt` rather than on the submission time so that delivering early
is not punished — anchoring on submission would let a client who received the work on day one simply
wait for day seven. `EVALUATION_WINDOW` is a constant rather than an admin lever, because the owner
already holds a great deal of power over live jobs (M-5) and this particular protection exists for
the party with the least.

The hook's bookkeeping was split to match: `recordExpiry` now distinguishes an expiry with nothing
delivered (`jobsExpired`, the agent's fault) from one where the agent delivered and the evaluator
never acted (`jobsStalled`, not the agent's), and `ExpiryRecorded` carries a `delivered` flag. It also
emits on the unbound-job branch now, which closes L-7.

**Regression tests.** `AuditPoCTest.test_PoC_F05_DeliveredWorkIsRefundedAwayAndTheAgentIsBlamed` and
`…_ClaimRefundFrontRunsCompleteAtExpiry` (both inverted),
`AuditPoCTest.test_Fixed_F05_ExpiryAfterDeliveryIsNotTheAgentsFault`,
`AgenticCommerceHookedTest.test_ClaimRefund_RefusedWhileTheEvaluationWindowIsOpen`,
`…_WorksFromSubmittedStateOnceTheEvaluationWindowCloses`, `…test_Submit_SetsTheEvaluationDeadline`,
`HallmarkHookAdminTest.test_RecordExpiry_UndeliveredCountsAgainstTheAgent`,
`…test_RecordExpiry_EmitsForAnUnboundJobToo`.

## M-3 remediation

**Fixed.** `fund` snapshots `jobFeeBps[jobId] = feeBps` and `complete` settles against the snapshot.
The owner can still change the fee; it applies to jobs funded from that point on. Two lines, and the
class is gone.

**Regression test.** `AuditPoCTest.test_PoC_F06_OwnerCanRaiseTheFeeOnAlreadyEscrowedJobs`, inverted:
the owner raises the fee to 10% mid-flight and the provider is still paid at the 2.5% it accepted,
while `feeBps()` confirms the new rate is live for future jobs.

## L-2, L-3, I-4, I-8 remediation

- **L-2 fixed.** `isHireable` returns the evidence that actually satisfied the gate, not whichever
  record happened to be newest. `AuditPoCTest.test_PoC_F09_IsHireableReportsEvidenceThatDidNotEarnTheAnswer`,
  inverted.
- **L-3 fixed.** The validation path filters on a liveness tag (`"liveness"` or `"reachable"`) the way
  the reputation path always did, so a code-quality attestation no longer opens the liveness gate.
  `AuditPoCTest.test_PoC_F09_ValidationPathIgnoresTheTag`, inverted, and it also checks that the same
  record retagged as liveness does open the gate.
- **I-4 fixed.** `_afterFund` now skips `agentId == 0`, matching `_afterSubmit` and `_afterSettlement`.
- **I-8 fixed.** `test/HookedInvariant.t.sol` is a second campaign that attaches the real
  `HallmarkHook`, uses three actors who may occupy more than one role at once (self-dealing included),
  and exercises the gate's refusal path as a first-class handler action. Four invariants: escrow
  accounting, token conservation, outcomes never exceeding funded jobs, and every registry entry being
  backed by escrow.

  The "assert the campaign actually landed the transitions it claims" half is deliberately **not** an
  `afterInvariant` assertion. `afterInvariant` runs once per campaign *run*, so asserting there that a
  settlement occurred demands that every random 64-call sequence happens to contain a full
  create → fund → submit → complete chain, which is a statement about the fuzzer's luck rather than
  about the handler. Instead the handler is driven explicitly by
  `test_Handler_DrivesAFullLifecycle`, `test_Handler_DrivesRejectionAndExpiry` and
  `test_Handler_RefusesAMismatchedAgent`, which prove each transition lands and cannot flake. A
  handler that quietly stopped doing anything fails those three immediately.

## Accepted risks

Listed with the reasoning, not waved through.

- **M-4 — blacklisting payment token.** Accepted for the hackathon deployment. `$U` does not blacklist
  today, and the correct fix (pull-payment fallbacks for the client and provider legs, plus accrued
  rather than pushed fees) is a redesign of every exit path in the escrow — a larger change, with more
  new surface, than the risk it retires on a token that does not currently have the behaviour. The
  contract-wide leg is the sharp one: a blocked treasury bricks `complete` for every job with a
  non-zero fee. It is recoverable in one `setTreasury` call, and the owner is a hot key that can make
  it. **Before mainnet with a blacklisting token, this must be fixed first.**
- **M-5 — single hot key over both contracts.** Accepted as a deployment-time action rather than a code
  change, which is what it is. Before mainnet: move both owners to a multisig, switch to
  `Ownable2Step`, and timelock `setPlatformFee`, `setAttestor` and `setHookWhitelisted`. The
  attestor/owner separation is already right and should stay.
- **L-1 (residual), L-4, L-5, L-6, L-7 (partly closed), L-8, L-9, I-1, I-2, I-3, I-5, I-6, I-7, I-9,
  I-10.** Stand as reported. None is exploitable on its own; each is recorded above with a concrete
  fix for whoever picks it up. L-7 is partly closed by M-2's remediation, which added the missing event
  on the unbound-job branch of `recordExpiry`.

## Files changed in remediation

| File | Change |
|---|---|
| `src/interfaces/IJobParties.sol` | **new.** Fixed-width job accessor, so a hook reading a job on a money path cannot inherit an unbounded client-supplied cost |
| `src/AgenticCommerceHooked.sol` | fee snapshot (M-3); evaluation window (M-2); `getJobParties`; `EvaluationWindowOpen` error; `EvaluationDeadlineSet` event |
| `src/HallmarkHook.sol` | agent/payee binding, self-dealing and dust classification (H-1); O(1) primary evidence, per-read floors and stipends, indeterminate-never-negative (M-1); probe provenance; liveness tag filter (L-3); `jobsStalled` (M-2); `agentId == 0` guard (I-4) |
| `test/HookedInvariant.t.sol` | **new.** Hooked invariant campaign plus deterministic handler drive tests (I-8) |
| `test/AuditPoC.t.sol` | every PoC for a fixed finding inverted in place; three new M-1 sweep tests |
| `test/HallmarkHook.t.sol`, `test/HallmarkHookAdmin.t.sol`, `test/AgenticCommerceHooked.t.sol`, `test/Base.t.sol` | fixture models a correctly onboarded agent (owner and payee distinct); regression tests for every fix above |
