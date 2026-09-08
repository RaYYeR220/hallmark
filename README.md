# Hallmark

**The trust layer for the agents on BNB Smart Chain.**

There are more than 300,000 agents registered under ERC-8004 on BSC. Finding one that is actually
alive, let alone any good, means digging through X threads and GitHub repos. Registries tell you an
agent *exists*. They do not tell you whether it answers when you call it.

Hallmark probes every registered agent's declared endpoint, publishes the evidence **on-chain**, and
lets you hire one — where "hire" means the agent executes real transactions under a session key
scoped by a contract allowlist, a spend cap and an expiry you can revoke at any time.

**[Three-minute demo](https://youtu.be/VL5vbVXaoBQ)** · **[Live marketplace](https://hallmark-market.vercel.app)** ·
**[Review it in five minutes](./JUDGES.md)**

Two properties follow, and they are the whole point:

- **A rating here is not a star. It is an attestation.** Every score is backed either by a probe we
  ran and published, or by a job that actually settled through our escrow. Both are written to the
  ERC-8004 registries by contract, so neither can be manufactured.
- **You cannot escrow money to a dead agent.** Funding a job calls into our ERC-8183 hook, which
  reads the live Validation and Reputation registries and **reverts** if the agent has no fresh
  evidence. That is not a UI warning. It is a transaction that fails.

---

## The refusal, on chain

The clearest way to see what Hallmark does is to look at two transactions on BSC testnet. Same
contract, same function, same arguments except the agent id.

| Agent | Evidence on chain | Result |
|---|---|---|
| `2000` — a real third-party agent nobody has validated | none | **reverted** `NoFreshEvidence(2000, 0)` |
| `2210` — validated, score 90, tag `reachable` | ERC-8004 Validation Registry | **funded** |

The gate is not consulting a private database. Agent `2210` became hireable at the moment a
validation was written for it, and `isHireable()` reads that straight from the registry.

---

## Architecture

ERC-8004 defines three registries. Most of the ecosystem uses one of them.

| Registry | What Hallmark does with it |
|---|---|
| **Identity** | Discovery. We index every agent on chains 56 and 97, resolve its registration file, and extract the endpoints it declares. |
| **Reputation** | Unsolicited probe results. `giveFeedback` is writable by anyone who is not the agent's own owner, using the standard's own tag vocabulary — `reachable`, `responsetime`, `uptime`. |
| **Validation** | Opt-in deep validation. `validationRequest` reverts unless the caller owns the agent, so an agent's operator asks Hallmark to validate it and we answer with `validationResponse` carrying a score and a link to the evidence. |

On top of those:

- **`AgenticCommerceHooked`** — an implementation of [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183)
  (Agentic Commerce) with the optional hook extension. Job escrow with an evaluator, four live states,
  and a permissionless refund path after expiry that is deliberately **not** hookable.
- **`HallmarkHook`** — our `IACPHook`. It gates funding on fresh evidence, measures time-to-deliver,
  and writes the outcome of every settled job back into the ERC-8004 Reputation Registry. The
  ERC-8183 specification names exactly this — "post-complete reputation updates, writing attestations
  to ERC-8004" — as a canonical use of the hook interface.
- **Altana session keys** for execution. An agent never holds a user key. It gets a scoped, revocable
  authorisation registered in an on-chain Keystore that anyone can verify with a single `eth_call`.

Nothing in this stack requires you to trust our backend. The data lives in the registries; our
services are a cache and an index over them. Anyone can rebuild the whole of Hallmark from BSC.

---

## Repository layout

```
contracts/          Foundry. AgenticCommerceHooked + HallmarkHook, 228 tests
packages/core/      Chain config, ABIs, the ERC-8004 agent-card parser, 8004scan client, evidence bundles
packages/altana/    Session policy, grant/revoke, execution outcomes, x402, ERC-8183 commerce
packages/sdk/       Publish an agent to Hallmark and request validation
apps/web/           The marketplace
apps/prober/        The validator: probes endpoints, scores them, publishes attestations
apps/agents/        Five first-party agents behind A2A, MCP and x402 faces
```

---

## The agent-card parser is the unglamorous half

Registration files in the wild are a mess, and any indexer that assumes otherwise silently drops
agents. `packages/core` handles, because all of these occur on mainnet today:

- `data:application/json;base64,…` — the common case
- `data:application/json;enc=gzip;level=6;base64,…` — gzipped, needs inflating
- plain `https://…`, uppercase `HTTPS://…`, `ipfs://…`
- values that are not URIs at all — a bare address, or a placeholder domain
- key-casing drift: `x402Support` vs `x402support`, `supportedTrust` vs `supportedTrusts`,
  `services` vs `endpoints`
- `registrations: []` or `"agentId": null`, because the two-phase registration was never completed

The parser never throws. It returns a normalised card plus a list of every fix it had to make, so the
UI can show you honestly what an agent declared versus what we could actually read.

---

## Running it

The contract libraries are pinned git submodules, so clone with them:

```bash
git clone --recursive https://github.com/RaYYeR220/hallmark
# already cloned?
git submodule update --init --depth 1
```

Then:

```bash
pnpm install
pnpm build
```

Contracts:

```bash
cd contracts
forge test             # 228 tests
```

Deploy:

```bash
cp .env.example .env   # PRIVATE_KEY, TREASURY, ATTESTOR
forge script script/Deploy.s.sol:Deploy --rpc-url bsc_testnet --broadcast
```

---

## Honest limits

- The ERC-8004 **Validation Registry cannot be written to on someone else's behalf.**
  `validationRequest` reverts with `Not authorized` unless you own the agent. So deep validation is
  opt-in and always will be; the unsolicited path is limited to the Reputation Registry. Anywhere the
  interface shows a validation, an operator asked for it.
- **A probe measures reachability, not honesty.** A score says an endpoint answered, spoke the
  protocol it claimed, and did so at a measured latency. It does not say the agent is good at its job.
  Settled-job outcomes are the only signal here that speaks to that, and they take time to accumulate.
- **The Hallmark validator address is not the agent operator address.** They are deliberately
  separate keys so that a validation is not a self-attestation. The probe harness is public and
  evidence bundles are content-addressed, so any score we publish can be independently re-derived.
- **The demo deployment's freshness window is 30 days, and that is a deployment setting.** The
  contract ships a 24-hour default and caps the setter at `MAX_EVIDENCE_AGE_LIMIT = 30 days`. The
  testnet deployment runs the ceiling so a reviewer arriving two weeks from now still sees the
  refusal work without a keeper re-attesting daily. Nothing hard-codes it: every surface reads
  `maxEvidenceAge()` and prints whatever the contract will actually enforce.
- **Our own validator was, for a day, the thing this project complains about.** Agent `2210` was
  registered against `hallmark.market` — a domain nobody bought — so a probe of it scored zero,
  while the Validation Registry carried a 92 that our scorer cannot produce. It had been written by
  hand. The endpoints exist now, the registration is derived from a live read of the card and
  refuses to be written if anything it names is silent, and the score is the prober's. The
  superseded entries are still on chain; we did not revoke the evidence of our own mistake.
- **Gas matters more than it should.** `complete` and `reject` must be sent with an explicit gas limit
  of roughly 450,000. `eth_estimateGas` finds the smallest limit under which the *outer* call
  succeeds, which is not the same as the limit under which the hook's reputation write succeeds. The
  contract now refuses loudly rather than failing quietly, but a guard can only make an under-gassed
  transaction fail visibly — it cannot make it write the receipt.

## Licence

MIT.
