# hallmark-probe

**Every rating on Hallmark is an on-chain attestation backed by evidence we actually gathered. This is the thing that gathers it.**

`hallmark-probe` sweeps ERC-8004 agents on BNB Smart Chain, resolves each agent's registration file, **calls the endpoints the agent declares**, classifies exactly how each one succeeded or failed, scores the result with a published formula, and writes the outcome back to the ERC-8004 registries as a content-addressed attestation.

The ERC-8004 Validation Registry has never been used by anybody. 8004scan reports `total_validators: 0` and `total_validations: 0` across 60 chains and 816,000+ agents. This service is what makes that number non-zero on BNB Chain.

---

## What it measures

For each agent id, the prober:

1. Reads `ownerOf` and `tokenURI` from the Identity Registry.
2. Resolves the registration file. `tokenURI` in the wild is base64 data URIs, **gzip** data URIs, plain and uppercase http, ipfs, bare addresses and outright garbage — `@hallmark/core`'s `agentCard.ts` handles all of it, including the key-casing drift (`x402Support`/`x402support`, `supportedTrust`/`supportedTrusts`, `services`/`endpoints`).
3. Extracts the declared endpoints and contacts each one with the handler for its protocol.
4. Records what happened, per endpoint, per request.
5. Scores it, hashes it, and stores it under that hash.

| protocol | what the prober actually does | what counts as working |
| --- | --- | --- |
| **A2A** | `GET {endpoint}`; if that is not an agent card and the endpoint looks like a service root, also `GET {origin}/.well-known/agent-card.json`, then `/.well-known/agent.json` | a JSON agent card with a `name`, **at least one skill or enabled capability**, no null endpoint, and no self-declared offline state. Skill names are captured. |
| **MCP** | JSON-RPC `initialize` (protocolVersion `2025-06-18`, real `clientInfo`), `notifications/initialized`, then `tools/list`. Plain JSON **and** SSE-framed responses are parsed; `mcp-session-id` is carried forward | an `initialize` result that names a `protocolVersion` or a non-empty `serverInfo`. Tool names are captured. |
| **x402** | `GET {endpoint}` | a `402` carrying a decodable challenge — v2 in the base64 `payment-required` **response header** (body may be `{}` or empty), or v1 in an `X-PAYMENT`-shaped header, a `WWW-Authenticate: Payment` challenge, or the body. Records `{scheme, network, amountAtomic, asset, payTo, maxTimeoutSeconds}` |
| **web / other** | plain `GET` | a 2xx with a body. An unlabelled endpoint ending in `/mcp` or `/sse` is probed as MCP instead. |

### Failure classification is the product

A single "reachable: false" is useless to a buyer. Every failure gets a distinct label, and the aggregate breakdown is what the marketplace shows.

| class | meaning |
| --- | --- |
| `dns` | the hostname does not resolve |
| `refused` | the host resolved but rejected the connection, or is unroutable |
| `tls` | the TLS handshake or certificate check failed |
| `timeout` | nothing arrived inside the per-request budget |
| `http-4xx` | the server answered, with a client error |
| `http-5xx` | the server answered, with a server error |
| `bad-protocol` | answered 2xx but did not speak the protocol it declared |
| `not-json` | promised JSON, returned something else — usually an HTML landing page |
| `blocked` | a private, loopback or link-local host; **never contacted** |
| `unsupported-scheme` | not http(s) — `did:`, `mailto:`, a bare ENS name |
| `too-large` | the body blew past the 2 MB cap |
| `too-many-redirects` | the redirect chain exceeded the hop cap |
| `network` | a transport error that is none of the above |

---

## Scoring

Deterministic, pure, and versioned. The weights are written down here, in `src/score.ts`, **and inside every evidence bundle** under `scorer`, so any score can be re-derived from the evidence that produced it. Changing a weight requires bumping `PROBER_SCORER_VERSION`.

| dimension | weight | what it measures |
| --- | ---: | --- |
| `reachability` | **35** | share of scoreable endpoints that answered |
| `protocol` | **25** | share that answered *and* spoke the protocol they declared |
| `latency` | **15** | median round trip of the endpoints that answered |
| `capabilities` | **15** | MCP tools and A2A skills actually enumerated — 7.5 each |
| `x402` | **10** | a priced service advertised and quoted with a decodable challenge |
| | **100** | |

Latency credit is 1.0 at or under **200 ms**, 0.0 at or over **5,000 ms**, linear in between.

Endpoints that cannot be contacted over HTTP at all — `did:`, `mailto:`, a bare ENS name — are marked `scored: false` and left out of both denominators. They are still recorded; they are just not evidence of liveness either way.

**An agent with no scoreable endpoint scores 0.** That is deliberate. The point of this service is that "reachable" can never be vacuously true.

`reachability` and `protocol` are not independent for A2A and MCP: an endpoint that answers but does not speak its protocol is `ok: false`, so it loses both. That is intentional double weighting. They come apart for `web` endpoints (a 2xx with an empty body is reachable but not conformant) and for an A2A endpoint sitting behind a payment wall (reachable and priced, but the card is not readable without paying).

### Two numbers: `reachable` and `protocolLive`

The prober reports both, and they answer different questions. Conflating them is how a marketplace ends up lying.

| metric | definition |
| --- | --- |
| `reachable` | at least one declared endpoint answered. **Includes a plain `web` face returning HTML.** An intermediate funnel step, not a verdict. |
| `protocolLiveAgents` | at least one endpoint is a **working agent protocol**: an A2A card with a non-empty `skills` array (not self-declared offline, no null endpoint), **or** an MCP server that completed `initialize` and enumerated at least one tool, **or** an endpoint that served a decodable x402 challenge. A `web` face never counts. |

**Hallmark quotes `protocolLive` publicly.** `reachable` appears only as a funnel step, always next to the strict number. `publish` refuses to write an attestation for an agent that is not protocol-live unless you pass `--allow-web-only`, so the permissive verdict cannot reach the chain by accident.

The gap is enormous and it is the whole point. On a 6,000-agent mainnet sample: **2,094 reachable (34.9%), 28 protocol-live (0.47%)**. Publishing the first number would be a 75x overstatement.

### Reconciliation with the independent census

An independent census harness sampled 6,000 mainnet agents and reported **23 protocol-live**. This prober's first 6,000-agent run against the same ceiling (338,235) reported **5**. That gap was not sampling noise, and chasing it found a real defect in this package.

**Step 1 — the definitions agree.** Tested directly, outside either sample, the prober was pointed at all three hosts the census named and independently found all three protocol-live via A2A with real skills:

| host | prober verdict | skills found |
| --- | --- | --- |
| `app.singularry.org` | protocol-live | 5 (Autonomous Portfolio Management, Yield Optimization, Funding Rate Arbitrage, Concentrated Liquidity LP, DCA) |
| `api.bortagent.xyz` | protocol-live | 8 (On-chain trading, Live market data, Portfolio, Social signal trading, ...) |
| `bnb-yield.172-104-171-139.nip.io` | protocol-live | 2 (negotiate, notify_funded) |

So given the same agent, the two harnesses return the same verdict. The disagreement was never about the rule.

**Step 2 — the budget-sensitivity test, which found the bug.** Every agent in the sample that declared a protocol but was not live, or timed out, or whose card would not resolve — 1,878 agents — was re-probed at a 4x longer timeout (20s) and a quarter of the concurrency (6):

| | at 5s / 24-wide | at 20s / 6-wide |
| --- | ---: | ---: |
| cards that resolved | — | **+842** |
| agents reachable | — | **+448** |
| agents protocol-live | — | +1 |
| agents that *lost* reachability | — | 0 |

842 of 1,878 registration files — **45%** — had simply failed to fetch. An agent whose card does not resolve has no declared endpoints to probe, so it was being scored 0 with no endpoints rather than being measured at all.

The cause was a genuine design error here, not a rate limit. `resolveAgentCard` was being handed the *endpoint* timeout. But 5,000 ms is not a patience setting for the endpoint probe — it is a **scoring boundary**, deliberately equal to `LATENCY_ZERO_MS`, because how fast an endpoint answers is part of the score. Fetching an off-chain registration file is a one-shot document GET that is not scored at all, and there was never a reason to starve it on the endpoint's latency budget. `PROBE_CARD_TIMEOUT_MS` is now separate and defaults to 15s.

**Step 3 — after the fix, re-running the identical sample (6,000 agents, seed 42, ceiling 338,235):**

| | before the fix | after the fix | census |
| --- | ---: | ---: | ---: |
| protocol-live agents | 5 | **28** (0.47%) | 23 (0.38%) |
| distinct live hosts | 3 | **5** | 3 |
| agents declaring a protocol | 559 | 604 (10.1%) | 643 (10.7%) |
| unparseable card | 1,324 | 726 (12.1%) | — |
| reachable | 1,749 | 2,094 (34.9%) | — |

**The census was right and this prober was under-counting.** 28 versus 23 is the same order of magnitude and entirely consistent with two different draws: `--seed 42` only reproduces the sampler that consumed it, so the two harnesses drew different agent ids, and the live population is heavily clustered by operator. In this sample `evoevo.ai` alone is declared by **1,656 of 6,000 agents (27.6%)**, `platform-backend.prod.termix.live` by 466, `q402.quackai.ai` by 76. The count of live agents is therefore not a binomial draw from 6,000 independent trials — its effective sample size is the number of distinct *operators*, which is single digits, so whether one live operator's registrations land in your sample moves the count by several.

One more thing the experiment showed, and it is an argument for the strict metric on its own: **`protocolLive` is robust to probe budget and `reachable` is not.** Quadrupling the timeout moved `reachable` by +448 agents and `protocolLive` by +1. A number that swings 25% on a tuning parameter is not a number to publish.

**What we publish.** The strict definition, with the sample, seed, ceiling and host count attached, and never a bare agent count:

> Of ~338,000 ERC-8004 agents registered on BNB Smart Chain, a 6,000-agent sample (seed 42, ceiling 338,235) found **28 agents — 0.47%, one in 214 — serving a working agent protocol, behind 5 distinct hosts.** About 10% of agents declare a machine-callable protocol; under 5% of those answer. An independent census of a different 6,000-agent sample found 23 across 3 hosts.

**Four independent measurements now exist**, from different code paths and different draws:

| sample | protocol-live | rate |
| --- | ---: | ---: |
| census harness, 6,000 agents | 23 | 0.38% |
| this prober, 6,000, seed 42, ceiling 338,235 | 28 | 0.47% |
| this prober, 3,000, seed 20260908 | 6 | 0.20% |
| **combined store, 12,403 agents** | **19** | **0.15%** |

All four land in the same 0.2-0.5% band. The combined 12,403-agent store puts the live population behind **7 distinct hosts** — `api.bortagent.xyz`, `app.singularry.org`, `clawdmint-api.vercel.app`, `clipx.app`, `x402.quickintel.io`, and two `bubbleupdappos.workers.dev` hosts — and the later draws surfaced hosts the earlier ones never saw, which is exactly what operator clustering predicts. Triangulating across samples is how you get an order of magnitude you can defend; no single draw gives you one.

Agent counts are reported with the caveat that they are operator-clustered — "28 live agents" is not 28 independent teams. `stats` prints `protocol-live hosts` directly beneath `PROTOCOL-LIVE (strict)` for exactly this reason.

### Why the rules are strict

A census of 6,000 sampled BSC agents found **23** that answer on a working agent protocol. It also found **506** serving a perfectly well-formed agent card that announces `"skills": []`, `"endpoint": null`, `"presence": "offline"` — a card that says in its own words that there is nothing here to hire. A permissive validity rule scores those as alive and reports 529 instead of 23: a **23× error**, published on chain, under our name.

So the rules refuse them explicitly:

- an A2A card with no skills and no enabled capabilities is `bad-protocol`, not reachable;
- a card that declares itself offline, inactive or disabled is `bad-protocol`;
- a card that declares a null endpoint is `bad-protocol`;
- an `initialize` result that is a bare `{}` is `bad-protocol` — anything can echo JSON-RPC;
- a `402` with no decodable challenge is `bad-protocol`, even though it is technically the right status code.

`test/negative-control.test.ts` exists to keep this honest. It asserts that a host that does not resolve, an endpoint that 404s, an endpoint that returns HTML where JSON was promised, and a card that disclaims itself all classify as **failures**. If that file ever goes green while the endpoints are broken, every rating Hallmark has published is worthless.

---

## Evidence

Each run produces an `EvidenceBundle`: the exact endpoints contacted, every HTTP round trip made on their behalf with status/latency/bytes/redirects, the failure class per endpoint, the discovered capabilities, the score with its full breakdown, the scorer name and version and weights, the agent's owner and card provenance, and the block height and timestamp the chain was at.

The bundle is canonicalised RFC-8785 style — object keys sorted by UTF-16 code unit, no insignificant whitespace, non-ASCII escaped — using `@hallmark/core`'s `canonicalize`. Its `keccak256` **is** the on-chain `feedbackHash` / `responseHash`.

Byte-stability is therefore a correctness requirement, not a nicety. Two things enforce it:

- the stored file is `canonicalize(bundle)` verbatim, never a re-serialisation, and `GET /api/evidence/:hash` re-checks the hash before answering — a document that no longer matches its own name is a `500`, never a `200`;
- `test/evidence.test.ts` shuffles every key in the bundle tree and asserts the hash does not move.

Bundles are served by the marketplace app at `https://hallmark-market.vercel.app/api/evidence/{hash}`, reading from `STORE_DIR/evidence/<hash>.json`. That URL is what goes into `feedbackURI` and `responseURI`.

---

## The two write paths, and why they are not symmetric

This is the core design constraint of the whole service.

**Reputation is unsolicited.** `giveFeedback(agentId, int128 value, uint8 valueDecimals, tag1, tag2, endpoint, feedbackURI, bytes32 feedbackHash)` works from **any address that is not the agent's owner or operator**. We can attest anything we probed, without asking. This is the path that makes the marketplace possible.

**Validation is opt-in.** `validationRequest(validator, agentId, requestURI, requestHash)` reverts `Not authorized` unless the caller owns or operates the agent. So the agent's owner requests validation and names us; only then can we answer with `validationResponse(requestHash, uint8 response, responseURI, responseHash, tag)`. `hallmark-probe publish --kind validation` finds the open request addressed to our validator and answers it; when there is none it says so, with the reason, rather than failing quietly.

### Registry quirks this code knows about

- 🔴 **Reputation feedback indices are 1-based.** `readFeedback(agentId, client, 0)` reverts `index must be > 0`. `getLastIndex` returns the *count*; the valid range is `1..getLastIndex`.
- 🔴 **`getSummary` reverts on an empty `clients` array.** The audience has to be resolved with `getClients(agentId)` first. (`readAllFeedback` does treat empty as a wildcard.)
- The Identity Registry is **not** ERC-721 Enumerable — there is no `totalSupply()`. The highest agent id is found by binary-searching where `ownerOf` starts reverting.
- `readFeedback` does not return the file hash. Only the `NewFeedback` **event** carries `filehash`, which is why `verify` reads the 8004scan index first and falls back to `eth_getLogs`.

Both quirks are covered by `test/registry-semantics.test.ts`, which drives the real `createRegistryReader` through a fake transport and asserts on the calldata that would actually go out.

### What we write on chain, and what it means

The Reputation Registry stores `(int128 value, uint8 valueDecimals)` under a tag, and **the tag is not a label — it is a type.** The standard's example vocabulary is explicit: `starred` is 0-100, `reachable` and `ownerVerified` are booleans, `uptime` is a percent x100, `successRate` is a percent, `responseTime` is milliseconds, `blocktimeFreshness` is blocks.

Writing a graded 0-100 score into `reachable` is non-conformant, and worse, it publishes the exact conflation this service exists to refuse. So one probe run produces **one write per applicable tag**, each carrying a claim that is true on its own terms:

| tag | type | what Hallmark writes | when |
| --- | --- | --- | --- |
| `reachable` | bool | **100** or **0**. 100 = at least one declared endpoint answered at all. | only when the agent declared something contactable, so we actually tried |
| `successRate` | percent | **100** or **0**. 100 = at least one endpoint is protocol-live by the strict rule; 0 = it declares a protocol and none of them speak it. | only when the agent declares a machine-callable protocol, **or** proved one regardless of how its card labelled it |
| `responseTime` | ms | median round trip across the endpoints that answered | opt-in, `--tags …,responseTime` |

`tag2` is always `hallmark`, so our writes are filterable.

Three rules behind that table:

- **A boolean tag gets a boolean value.** `assertTagValue` throws — not warns — on any value that violates its tag's type, and every encoder runs through it. A warning would still let a non-conformant attestation reach the chain, and the chain is not somewhere you can take it back. `--tags liveness` is a hard error that prints the vocabulary.
- **`successRate` is never written for an agent that declares no protocol.** There is no rate to report, and a 0 there would be a slur rather than a measurement. The one exception cuts the other way: an agent whose endpoint is labelled `web` but answers with a valid x402 challenge has *demonstrably* got a working protocol, so it gets `successRate: 100`. Evidence beats the label; a label alone never manufactures a positive claim.
- **We do not invent private tags where the standard has one.** Everything the vocabulary cannot express — the graded score, the per-endpoint breakdown, the failure classification, the discovered capabilities, the block height — lives in the evidence bundle, which every attestation links by URI and commits to by hash. **The chain carries claims that are true and typed; the bundle carries the detail.**

Why `reachable` and `successRate` rather than one number: we measured the difference. Quadrupling the probe timeout moves `reachable` by **+448 agents** and `protocolLive` by **+1**. They are not the same claim and a single tag cannot honestly carry both.

A worked example, as the dry run prints it for a real mainnet agent:

```
reputation agent 6255  score 82
  giveFeedback -> 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63
  arg[1]   100          <- value
  arg[3]   reachable    <- bool: something answered
  gas       320000 @ 50000000 wei     cost 0.000016 BNB

reputation agent 6255  score 82
  arg[1]   100
  arg[3]   successRate  <- percent: the protocol actually worked
  gas       200000 @ 50000000 wei     cost 0.00001 BNB
```

The second write is cheaper because only the first `giveFeedback` for an (agent, client) pair allocates fresh storage — measured 213,948 then 132,140 — and the plan is costed accordingly rather than at a flat rate.

### Choosing what to attest to: verdicts

Sorting by score and taking the top N is structurally optimistic. It selects exactly the agents that make the registry look healthy and never the ones that make it look honest. On the real mainnet store that skim planned **600 `reachable=100` writes and zero `successRate=0`** — while the single most useful thing we know stayed entirely off chain.

Every probed agent falls into one of five verdicts, and the publisher draws across them rather than down a score list:

| verdict | meaning | what it writes | in the 12,403-agent mainnet store |
| --- | --- | --- | ---: |
| `positive` | a declared protocol demonstrably works | `reachable=100`, `successRate=100` | **19** (0.15%) |
| `negative` | declares a protocol, answers, does not speak it | `reachable=100`, **`successRate=0`** | **214** (1.7%) |
| `unreachable` | declared endpoints, none answered | **`reachable=0`**, `successRate=0` if it declared a protocol | **1,198** (9.7%) |
| `reachable-only` | answered, declares no protocol | `reachable=100` only | 3,106 (25%) |
| `inapplicable` | nothing contactable was declared | **nothing at all** | 7,866 (63%) |

`inapplicable` writes nothing on purpose. We never contacted those agents, so `reachable: 0` would describe *our own inaction* as their failure. That restraint is exactly what makes the negatives defensible: when we write `successRate: 0`, it is because the agent told us it speaks a protocol and then did not.

```bash
--verdict both       # default: round-robin across positive / negative / unreachable
--verdict negative   # only the informative half
--negatives          # same thing
--verdict positive   # only the wins
--max-negatives N    # cap the negative side (default 100) so a run cannot be all-negative either
--allow-web-only     # also include reachable-only agents
--seed S             # reproducible draw
```

Within a verdict class the draw is a seeded shuffle, not agent-id order — low ids are old agents, and that is its own bias.

**Spend protection.** The publisher reads the attestor's actual balance at startup and lowers the per-run ceiling to a share of it (`--reserve-balance-pct`, default 20), so a run can never plan to drain the wallet:

```
per-run ceiling lowered to protect the wallet balance
  balance="0.0014854006 BNB" reservePct=20 ceiling="0.00118832048 BNB"
```

Every write beyond that point is skipped with the budget reason attached, not silently dropped.

**`recordProbe` is inapplicable, not failed, where no hook is deployed.** `HallmarkHook` is Hallmark's own contract and lives on testnet only; on mainnet the CLI says so once and does not emit a refusal line per agent.

### Gas: why we do not trust `eth_estimateGas`

A sibling contract in this repo taught this the expensive way. `eth_estimateGas` binary-searches for the smallest limit under which the **outer** call succeeds. When an inner call is wrapped in `try/catch`, the outer call succeeds even though the inner one ran out of gas — so the estimator converges on a limit that starves the write, the transaction mines with `status: success`, and nothing landed.

So:

- every write sends an **explicit gas limit** sized from measurement, and takes `max(measured floor, estimate × 1.25)`;
- every write is confirmed by **reading the resulting state back**, never by trusting a receipt.

| call | measured on BSC | limit sent | post-condition read back |
| --- | ---: | ---: | --- |
| `giveFeedback` | 213,948 first write per client, 132,140 after | 320,000 | `getLastIndex` incremented by exactly 1, and `readFeedback` at that index returns the tag and value we wrote |
| `validationRequest` | 210,287 | 320,000 | `getValidationStatus` names our validator |
| `validationResponse` | 132,366 | 220,000 | `getValidationStatus` returns our `response` **and** our `responseHash` |
| `recordProbe` | — | 140,000 | `lastProbeAt != 0` and `lastProbeScore` equals what we sent |

A full validation cycle costs about **$0.013** at 0.05 gwei with BNB at $744.57.

### The budget guard

We are working with about 0.005 BNB on mainnet, so this is genuinely careful.

- **Dry run by default.** Nothing is signed without `--commit`.
- A hard ceiling per run (`BUDGET_WEI_PER_RUN`, default 0.0015 BNB) and across every run the store remembers (`BUDGET_WEI_TOTAL`, default 0.0035 BNB), checked **before every write** and again after the gas estimate.
- A dry run **holds the reservation too**, so a plan for ten agents shows exactly where the ceiling stops it rather than costing each write in isolation.
- A gas price above 5 gwei is refused as a fee spike rather than paid.
- Reservations are settled against what was *actually* spent (`gasUsed × effectiveGasPrice`), not what was estimated.
- **No write is ever silently skipped.** Every skip produces a reason, logged and appended to `published.jsonl` next to the writes that did happen.

`--as 0x…` plans a dry run as if that address were signing, so the funded key never has to be on the machine doing the planning.

---

## Safety

The prober takes a URL out of an untrusted on-chain record and fetches it. That is textbook SSRF, so:

- **Read-only verbs only.** `GET`, plus the MCP `initialize` / `notifications/initialized` / `tools/list` handshake, which is a read. It never calls a tool. `guardedFetch` throws on anything but GET and POST.
- **No credentials, ever.** A URL carrying inline credentials is refused outright.
- **Private hosts are refused before a socket opens**: `localhost`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (including the cloud metadata address), `100.64/10`, `0/8`, `224/4`, `240/4`, broadcast, `::1`, `::`, IPv6 ULA `fc00::/7`, link-local `fe80::/10`, `::ffff:` mapped v4, and the `.local` / `.internal` / `.lan` / `.home.arpa` suffixes. Obfuscated forms (`2130706433`, `0x7f000001`, `0177.0.0.1`) are refused rather than decoded.
- **DNS rebinding is checked.** Every hostname is resolved and *every* address it points at is classified. A public hostname whose A record is `169.254.169.254` is refused. (The live testnet sweep found five real endpoints on public hostnames resolving into `172.22.0.0/16`.)
- **Redirects are re-guarded on every hop**, not just the first — otherwise a redirect is a bypass of the guard. Capped at 3 hops. A redirected POST is demoted to GET on 301/302/303 and replayed only on 307/308.
- **Bodies are capped at 2 MB**, refused up front on `Content-Length` and cut off mid-stream otherwise, so a hostile endpoint cannot exhaust memory.
- **One deadline for the whole redirect chain**, 5 s by default, and one retry only on a genuinely transient transport error.

`PROBE_CHECK_DNS=false` (or `--no-dns`) turns off the rebinding check. It logs a warning when you do. Outside Node, where `node:dns` is unavailable, the syntactic checks still apply but rebinding is not defensible — this is stated rather than papered over.

### Finding: registered agents pointing into private network space

The DNS check is not hypothetical. Sweeping all 2,218 agents on BSC testnet, the guard refused **300 endpoints**, and five of them were the interesting kind — public hostnames whose A records resolve into RFC-1918 space:

| endpoint host | resolves to | agents |
| --- | --- | ---: |
| `poc8004-agents.fe.kfkshore.org` | `172.22.1.210` | 3 |
| `bnbagent-api.fe.kfkshore.org` | `172.22.3.42` | 2 |

These are ERC-8004 agents whose on-chain registration file directs any client that reads it at an address inside a private network. A naive indexer or marketplace that fetches declared endpoints server-side turns that record into an SSRF primitive against its own infrastructure; one that runs client-side turns every visitor's browser into a probe of their LAN. It is very probably a staging deployment someone forgot to repoint rather than an attack — but the registry has no way to tell the difference, and neither does anyone reading it.

The remaining 295 were the blunt cases: 270 `localhost`, 22 `127.0.0.1`, 3 `.local` hostnames.

The corollary matters too. `bnb-yield.172-104-171-139.nip.io` — one of the live mainnet agents — **is allowed**, because `172.104.0.0/16` is public Linode space and the private range is only `172.16.0.0/12`. A guard that pattern-matches on `172.` would wrongly refuse a working agent. The check is by CIDR, not by prefix string.

---

## Commands

```bash
# probe a reproducible random sample
hallmark-probe sweep --chain 97 --sample 500 --seed hallmark --concurrency 24

# probe every agent on testnet (about 2,200 today)
hallmark-probe sweep --chain 97 --sample 3000 --seed full-testnet

# probe the newest agents from the 8004scan index
hallmark-probe sweep --chain 56 --recent 200

# re-probe a specific set, e.g. everything that timed out, with a bigger budget
hallmark-probe sweep --chain 56 --agents-file ids.txt --timeout 20000 --concurrency 6

# one agent, verbose: every endpoint, every request, the score breakdown
hallmark-probe probe --agent 2210 --chain 97

# what would be written on chain, and what it would cost. Signs nothing.
hallmark-probe publish --chain 97 --limit 10 --min-score 60 --as 0x9ff9…

# actually write it
hallmark-probe publish --chain 97 --limit 10 --min-score 60 --commit

# audit: fetch a bundle, re-hash it, and check it against the chain
hallmark-probe verify 0x<evidence-hash> --chain 97
hallmark-probe verify https://hallmark-market.vercel.app/api/evidence/0x… --chain 56

# summarise the local store
hallmark-probe stats --chain 97

# the HTTP surface
hallmark-probe serve --port 8787
```

Every command takes `--json`. Every command except `publish --commit` is read-only and needs no key.

`verify` exit codes are meaningful, because it is the script a judge runs against us:

| code | meaning |
| ---: | --- |
| `0` | the document hashes to its own name, is canonical, and an ERC-8004 record carries that hash |
| `1` | the document does not match its hash, or is not stored canonically |
| `2` | the document could not be fetched |
| `3` | the document is sound but no on-chain record references it yet |

### HTTP surface

| route | |
| --- | --- |
| `GET /health` | liveness, uptime, whether cron is configured |
| `GET /api/agents/:chainId/:agentId/evidence` | the latest run record and bundle for one agent |
| `GET /api/evidence/:hash` | **the bundle, byte-identical to what was hashed.** This is what `feedbackURI` resolves to. Public, immutable, cacheable forever |
| `GET /api/stats` | the aggregate reachability numbers |
| `POST /api/cron/sweep` | a bounded sweep, behind a `CRON_SECRET` bearer token compared in constant time |

Built on Hono, so the same app runs under Node and as a Vercel Function.

---

## Storage

**There is no private database, and that is deliberate.** The truth about an agent's rating is the attestation on BNB Chain. This directory is a cache and a place to keep the document the on-chain hash commits to. Delete it and nothing that was published stops being true — it just has to be re-derived by re-running the sweep.

```
<STORE_DIR>/
  evidence/<hash>.json          canonical bytes, byte-identical to what was hashed
  chain-<id>/runs.jsonl         append-only history, one run per line
  chain-<id>/latest/<id>.json   newest run per agent
  chain-<id>/published.jsonl    every on-chain write and every skip, with its reason and cost
```

`EvidenceStore` is an interface (`createFileStore`, `createMemoryStore`) so a blob store can be dropped in without anything above it noticing.

---

## Environment

Copy `.env.example`. Everything has a working default except the keys, and the keys are only read by `publish --commit`.

| variable | |
| --- | --- |
| `RPC_URL_56`, `RPC_URL_97` | default to the public nodes `@hallmark/core` ships with. **Set `RPC_URL_56` before committing any write** — see below |
| `SCAN_API_KEY` | optional; without it the anonymous 8004scan limits apply |
| `EVIDENCE_BASE_URL` | `https://hallmark-market.vercel.app/api/evidence`. This exact prefix ends up inside every on-chain attestation |
| `STORE_DIR` | `./data` |
| `ATTESTOR_PRIVATE_KEY` | writes reputation feedback and `recordProbe` |
| `VALIDATOR_PRIVATE_KEY` | writes `validationResponse`. Must be the same address as the attestor for the hook's gate to open |
| `AGENT_OWNER_PRIVATE_KEY` | optional; only for `validationRequest` on agents we own |
| `HALLMARK_HOOK_97`, `HALLMARK_HOOK_56` | testnet defaults to the deployed hook; mainnet is unset |
| `CRON_SECRET` | bearer token for `POST /api/cron/sweep`. The route is disabled while unset |
| `PORT` | `8787` |
| `BUDGET_WEI_PER_RUN`, `BUDGET_WEI_TOTAL` | `0.0015` / `0.0035` BNB |
| `PROBE_TIMEOUT_MS`, `PROBE_CONCURRENCY`, `PROBE_MAX_REDIRECTS`, `PROBE_MAX_BODY_BYTES`, `PROBE_CHECK_DNS`, `PROBE_RESOLVE_OFFCHAIN` | probe tuning |

### ⚠️ The default mainnet RPC cannot confirm a transaction

`bsc-rpc.publicnode.com` — `@hallmark/core`'s default for chain 56 — **refuses `eth_getTransactionReceipt`** with *"Archive requests require a personal token"*. Reads are fine; anything that waits for a receipt breaks against it, which means every write path: `waitForTransactionReceipt` throws, the publisher records `receipt not observed`, and the post-condition read never runs even though the transaction landed.

These serve receipts and are known good for writes:

```
RPC_URL_56=https://bsc-dataseed.binance.org
# also fine: https://bsc-dataseed1.defibit.io, https://bsc-dataseed1.ninicoin.io
```

The general point is worth stating: **a node that is adequate for a sweep is not necessarily adequate for a publish.** A prober does millions of cheap `eth_call`s and wants a generous read endpoint; a publisher does a handful of transactions and needs receipts and reliable nonces. Those are different products, and `@hallmark/core` shipping one default for both is a sharp edge — worth splitting into a read URL and a write URL there rather than papering over it here.

---

## What a score does and does not mean

**A score of 84 means:** at the moment stamped in the bundle, at the block height stamped in the bundle, this prober contacted the endpoints this agent declared on chain, and this many answered, this fast, speaking the protocols they claimed, exposing these tools and skills. Every one of those claims is re-derivable from the bundle the on-chain hash commits to. You do not have to trust us — run `hallmark-probe verify`.

**A score of 84 does not mean:**

- **that the agent is good at its job.** This measures liveness and protocol conformance. It says nothing about whether the rebalancing advice is any good, whether the yield numbers are real, or whether the operator is honest. A well-run scam scores 100.
- **that the agent is live now.** It is a point-in-time measurement. That is precisely why `HallmarkHook` keeps its own `lastProbeAt` clock: the Reputation Registry exposes no timestamp at all, so a ten-month-old "reachable" and a ten-minute-old one are indistinguishable through the standard interface. The registry says *what* was observed; the hook says *when*.
- **that the agent is safe to give money to.** The prober never authenticates, never pays, and never calls a tool. It cannot see anything behind a login or a paywall — an agent behind x402 is recorded as priced and reachable, not as verified.
- **that a low score means the agent is bad.** It very often means the agent was registered by someone testing the standard and never deployed. `no contactable endpoint` and `unparseable card` are the two largest buckets on both chains, by a distance.
- **that the sample is the population.** A sweep reports the sample it drew, the seed it drew it with, and the ceiling it drew against. Mainnet grows by 1,600–2,200 agents a day; pin `--max-id` to reproduce an older run exactly.

The prober measures one narrow thing carefully and refuses to imply more. That is the whole design.

---

## Development

```bash
pnpm install
pnpm --filter @hallmark/prober test        # vitest, network fully stubbed
pnpm --filter @hallmark/prober typecheck
```

The suite mocks every network call. A unit test that reaches the internet is a flake, and a flaky liveness prober is a contradiction in terms.

Node ≥ 22.6 — the CLI runs TypeScript directly through Node's type stripping, so there is no build step.
