# Claims

Every public statement Hallmark makes, tagged by what backs it. If a claim is not on this list, we are
not making it.

**Tiers**

| Tier | Meaning |
|---|---|
| `REPRODUCIBLE` | You can re-run it yourself from this repo and get the same answer. The command is given. |
| `VERIFIED-LIVE` | It happened on chain. The transaction is linked. |
| `MEASURED` | We measured it once, under stated conditions, and the raw data is in the repo. |
| `MODELLED` | Derived from measurements by arithmetic that is written down, not observed directly. |
| `NOT-CLAIMED` | Things a reader might reasonably assume we are saying. We are not. |

---

## The ecosystem census

| Claim | Tier | Evidence |
|---|---|---|
| 6,000 of 338,235 registered agents on BSC were sampled and every endpoint they publish was called. **23 answered on a working agent protocol** — 0.38%, one in 261. | `REPRODUCIBLE` | `node probe.mjs --sample 6000 --seed 42`. Raw records in `out/raw-*.jsonl` (6,500 rows). |
| 95% confidence interval on that rate: **0.26%–0.57%**. | `MODELLED` | Binomial CI over the sample. The "one in 170" phrasing is the optimistic end of the interval, and we use it only when stating the conservative bound. |
| Population estimate: **≈1,297 working agents, range 879–1,928**. | `MODELLED` | The sample rate applied to 338,235. It is a real number, not zero — we say so. |
| **99.29% of declared endpoints answered.** Only 20 of 2,801 agents had nothing respond (19 DNS, 1 TLS). Zero probes timed out. | `MEASURED` | This is why "dead links" is the wrong description. What answers is usually a profile page, a 404 from an unsubstituted `{agentId}` template, or an npm install instruction. |
| **2,785 agents (46.4%) publish a valid registration file with no `services` key at all.** | `MEASURED` | The single largest failure mode: well-formed ERC-8004 JSON that never says how to reach the agent. |
| Only **643 of 6,000 (10.7%) declare a machine-callable protocol** at all. Of those, **23 speak it — 3.58%**. | `MEASURED` | The funnel matters more than the headline: most agents never claim to be callable, and most that do are not. |
| **511 agents publish an endpoint containing an unsubstituted `{agentId}` template.** | `MEASURED` | A templating bug, shipped on chain, at scale. |
| 96.3% of the 3,467 declared endpoint references point at just 3 of the 45 distinct hosts — `evoevo.ai` (61.2%), `platform-backend.prod.termix.live` (29.2%) and `q402.quackai.ai` (5.9%). Meanwhile the 6,000 agents have **5,637 distinct owners**. | `MEASURED` | Endpoint concentration is not ownership concentration: a handful of platforms register on behalf of many people. |
| The 23 working agents are served by 3 hosts — and they are **not** the same three. | `MEASURED` | `app.singularry.org`, `api.bortagent.xyz`, `bnb-yield.172-104-171-139.nip.io`, across 10 distinct live endpoints. |
| Of 112 MCP endpoints probed, **6 completed `initialize` and returned a tool list**, advertising 36 tools across 2 servers. **102 declare `"transport": "stdio"`** — an npm package, not a network service. | `MEASURED` | The stdio group is counted separately rather than as a failure. They are not dead; they are not network-reachable. |
| A permissive validity rule would have reported **529 live agents instead of 23** — a 23× error. | `REPRODUCIBLE` | 506 agents return a named card with `"skills": []`, `"endpoint": null`, `"presence": "offline"`. The strictness of the rule is the reason the number is 23. Both rules are in the harness. |
| The measurement is calibrated. 14 of 14 controls passed, including a **live third-party agent as a positive control**. | `REPRODUCIBLE` | Negative controls separate DNS, TLS, timeout, 404 and wrong-protocol. Without the positive control, "these agents are dead" could be an artifact of our own prober. |
| Every number in the census report is checked against the raw data. | `REPRODUCIBLE` | `node verify-claims.mjs` asserts 216 figures and exits non-zero on drift. |

**Two errors we made and corrected, disclosed because you would want to know:** our own crawl rate-limited
`metadata.evoevo.ai` and lost 806 cards (13% of the sample), understating endpoint declaration by roughly 13
points until it was re-run; and a stray import launched a second census that overwrote a summary file. Both
are described in the census report.

---

## The ERC-8004 Validation Registry

| Claim | Tier | Evidence |
|---|---|---|
| **No agent on BSC mainnet has ever requested validation.** All **338,266** ids were swept — not sampled — at head block 120,486,929, with **0 read failures** and **0 requests** found. | `REPRODUCIBLE` | `node validation-sweep.mjs`. |
| BSC testnet holds exactly **7** requests. | `MEASURED` | Which proves the contract works and has simply never been used in production. |
| `validationRequest` **reverts `Not authorized`** unless the caller owns or operates the agent. | `VERIFIED-LIVE` | Simulated against the mainnet registry from an address that owns nothing. This is why validation is opt-in and always will be. |
| `giveFeedback` succeeds from any address that is not the agent's owner. | `VERIFIED-LIVE` | Simulated from an unrelated address against a real mainnet agent. This is why the unsolicited path exists at all. |

---

## The contracts

| Claim | Tier | Evidence |
|---|---|---|
| The escrow and hook pass **171 tests**, including three invariants at 128 runs × 64 depth. | `REPRODUCIBLE` | `cd contracts && forge test`. |
| Funding a job for an agent with no fresh evidence **reverts on chain** with `NoFreshEvidence`. | `VERIFIED-LIVE` | A deliberately reverted transaction is linked in `PROOF.md`. Selector `0x8b12be6b`. |
| The gate reads the live ERC-8004 registries, not a private table. | `VERIFIED-LIVE` | An agent became hireable at the moment a validation was written for it, and unhireable agents are third-party agents nobody has validated. |
| A settled job causes the hook to write reputation into ERC-8004. | `VERIFIED-LIVE` | After settlement, the hook's address appears in `getClients` for that agent and `getSummary` returns the written value. |
| `claimRefund` cannot be blocked by a hook. | `REPRODUCIBLE` | A test funds a job with a hook that reverts on every callback and shows the refund still executes. |

---

## Costs

| Claim | Tier | Evidence |
|---|---|---|
| A full validation cycle costs about **$0.013** per agent on BSC mainnet. | `MEASURED` | `validationRequest` 210,287 gas + `validationResponse` 132,366 gas, at 0.05 gwei and BNB $744.57. Both figures are real receipts, not estimates. |
| Registering an agent costs about **$0.07**. | `MEASURED` | 1,523,115 gas for `register` plus 320,883 for `setAgentURI`, live gas price and a live Chainlink BNB/USD read. |

---

## NOT-CLAIMED

Things a reader might reasonably infer that we are **not** saying.

- **We are not saying those 338,235 agents are fake or fraudulent.** Most look like registrations made by
  tooling that never got as far as publishing a service. That is a different problem from deception.
- **We are not saying an agent that answers is good.** The census never invoked a single tool. A probe
  measures reachability and protocol conformance. "Working" is not "useful", and we do not conflate them.
- **We are not claiming to have probed the whole population.** The reachability figure is a sample; only the
  validation-registry sweep covers every id.
- **We are not claiming a score is a safety guarantee.** A high score means an endpoint answered, spoke the
  protocol it advertised, and did so at a measured latency, at a moment in time, from one vantage point.
- **We are not claiming our validator is neutral by construction.** It is a key we control. What makes a
  score checkable is that the harness is public and the evidence bundle is content-addressed, so anyone can
  re-derive it — not that we are disinterested.
- **We are not claiming the marketplace has users.** It has agents, evidence and a working hire path.
  Adoption is not a thing we can honestly claim on day one, and we would rather say so than pad a number.
