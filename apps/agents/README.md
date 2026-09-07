# @hallmark/agents

Five BNB Chain agents behind one runtime. Each speaks A2A, MCP and x402; each is
registered in the ERC-8004 Identity Registry with a registration file pointing
at those live URLs. None of them holds a user's private key.

| Agent | Category | Does |
| --- | --- | --- |
| `rebalancer` | Rebalancing | Watches a PancakeSwap v3 position, prices the full reset sequence, executes it |
| `grid` | Grid Trading | Runs a persistent geometric grid over a v3 pair, one order per call |
| `yield` | Yield Optimisation | Compares venues on two independent rate sources, routes the capital |
| `health` | Health Factor Monitoring | Watches a Venus position, repays exactly enough, fails closed |
| `security` | Trading & Security | Proxy-resolved token safety with a measured buy/sell round trip |

```
https://hallmark-agents.vercel.app
  /{agent}/.well-known/agent-card.json   the card
  /a2a/{agent}                           A2A JSON-RPC (a plain GET returns the card)
  /mcp/{agent}                           MCP JSON-RPC, protocol 2025-06-18
  /x402/{agent}/{skill}                  the paid endpoint
  /api/cron/{agent}                      scheduled runs, guarded by CRON_SECRET
  /.well-known/agent-card.json           a directory of all five
```

## The safety spine

**The agent proposes; the session key constrains; the chain enforces.**

An agent here has no user private key and no path to one. Everything that moves
value goes through `executeIntent` in `src/runtime/act.ts`, which hands the
calls to `@hallmark/altana`'s `executeWithSession` under a policy carrying a
**contract allowlist**, a **spend cap** and an **expiry**. There is no other
signing path in the codebase; `src/chain/clients.ts` builds read-only clients
only, and the comment there says why.

Four properties, each with a test that would fail if it stopped holding:

**A refusal is a value, not an exception.** `kind: 'refused'` comes back as a
structured report — what was attempted, which policy line blocked it, the cap
and the headroom left — and nothing retries around it. `test/refusals.test.ts`.

**The scope check happens here, not only downstream.** The relay refuses too,
and so does `executeWithSession`'s preflight, but relying on either would make
the guarantee a property of whichever executor was injected. `executeIntent`
locates the blocking rule itself and returns before the executor is reached.

**`health` cannot borrow.** `venusHealthFactorPolicy` allowlists
`enterMarkets`, `mint`, `repayBorrow` and `redeemUnderlying` by selector, and
does not allowlist `borrow`. That is not the agent behaving; it is what the
account contract will sign. The suite drives a `borrow` attempt and asserts the
refusal, and drives the repay the same policy exists to permit as the control.

**`act` is idempotent.** The intent id is claimed in the store before anything
is sent; a repeat replays the recorded outcome. The claim is released when no
session exists, so a later grant can use the same id.

### Approvals, and why they are refused rather than granted

`mint` on the position manager and `repayBorrow` on an ERC-20 Venus market both
need an ERC-20 allowance, and granting one means calling the *token* — which is
not on any allowlist. The agents report the missing approval as a blocking
precondition with the calldata to satisfy it, and stop.

This looks like friction and is the point. A key that could approve arbitrary
tokens could approve them to anyone.

## Where a language model is allowed to be

Nowhere near a decision.

Every address, amount, selector, tick range and threshold in this service is
computed by deterministic code in `src/agents/*` and `src/chain/*` from chain
reads. A model may do exactly one thing: turn a *finished* decision into
sentences. It receives the decision object and the lines the agent already
wrote, and its output goes into one field — `Analysis.narrative` — which
nothing downstream reads.

The guarantee is structural: `act` takes an `ActInput`, which has no narrative
field, so there is no path from prose to calldata. On top of that,
`src/runtime/narrative.ts` enforces a runtime check — any `0x` address in a
narrator's output must already appear in the decision, and output that invents
one is discarded in favour of the deterministic lines. `test/runtime.test.ts`
drives a hostile narrator through a real `act` and asserts the calls are
unchanged.

## Two derivations, or nothing

The failure this codebase is most afraid of is not a crash. It is a fast,
fluent, confidently wrong number.

Every figure that drives an on-chain action is computed twice by independent
routes and required to agree; a disagreement is a refusal, not a warning. See
`src/chain/reconcile.ts` and the `checks` array on every decision.

| Agent | Primary | Second derivation |
| --- | --- | --- |
| rebalancer | `slot0().sqrtPriceX96` | `slot0().tick` via 1.0001^tick, plus pool balances bounding the position |
| grid | `slot0().sqrtPriceX96` | `slot0().tick`, plus a quote that must be worse than the mid |
| yield | Venus `supplyRatePerBlock` on-chain | DeFiLlama `apyBase` |
| health | Venus oracle `getUnderlyingPrice` | Chainlink, plus health from `getAccountLiquidity` against the per-market sum |
| security | privilege scan of the implementation | the same scan of the stub, which finds nothing — the control |

## What each agent knows that a naive one does not

**No atomic rebalance exists on v3.** Resetting a range is
`decreaseLiquidity → collect → burn → [swap] → mint`, five separate calls. The
rebalancer prices all five plus the ratio swap's live QuoterV2 impact before
proposing anything, and refuses to send a swap it has no quote for rather than
setting `amountOutMinimum` to zero.

**vBNB is not like the other Venus markets.** `repayBorrow()` on vBNB is
payable and takes no arguments (selector `0x4e4d9fea`); every ERC-20 market
takes `repayBorrow(uint256)` (`0x0e752702`). Same name, different selector,
different money path. `buildRepayCall` is the only place that choice is made,
and the policy allowlists each signature only for its own market.

**DeFiLlama's `tvlUsd` for a lending pool is available liquidity, not
deposits.** Measured: Venus reads about $61.6M there against $195.0M actually
supplied. Sizing an allocation off that field misjudges depth threefold, so
depth is read on-chain (`totalSupply × exchangeRateStored`) and both figures
are reported separately.

**The per-block rate constant everyone copies is stale.** Compound forks
publish `supplyRatePerBlock` and leave annualisation to you; 10,512,000 assumes
a three-second block BNB Chain no longer has. Venus's BSC vTokens expose
neither `blocksPerYear()` nor `blocksOrSecondsPerYear()` — both revert — so the
yield agent *measures* block time from two block timestamps and reports the
figure it used.

**A proxy flag from an API is not evidence.** A live BNB Chain token
(`0xc255d8b48eFbCE2Cb821A28517678aE685587777`) is an EIP-1167 minimal proxy —
45 bytes of stub in front of 19,331 bytes of implementation — that a well-known
commercial scanner reports as `is_proxy: 0`. Anything believing that analyses
the stub, finds no mint, no blacklist and no owner, and calls the token clean.
The security agent detects proxies from the bytecode (`PUSH20` + `DELEGATECALL`
under a size bound) and the EIP-1967, EIP-1822 and legacy OpenZeppelin slots,
resolves to the implementation, and says so in the output.

**Sellability is measured, not inferred.** Buy-then-sell round trips are
simulated at several sizes through `eth_call` state overrides — no key, no
funds, no transaction. The fee-on-transfer router entry point returns nothing,
so each leg's output is recovered by binary searching `amountOutMin`, with the
bracket verified at both ends. The result is a *number*: on the token above,
3.00% buy tax, 2.99% sell tax, and a round trip costing 7.28% at 0.05 BNB
rising to 14.70% at 0.5 BNB against $14.7k of liquidity. Nothing reverted; the
verdict is still **no-go**, because a clean contract with hostile economics is
a no.

**Unknown is not clean.** Every check that could not run says so, and any
unknown caps the verdict at `caution`. A green tick that means "we did not
look" is the most dangerous output a scanner can produce.

## Running it

```bash
pnpm install
pnpm test          # 186 tests, no network, no keys
pnpm typecheck
pnpm start         # http://localhost:8787
pnpm prove         # every face, against live BNB Chain mainnet, read-only
pnpm register -- --gwei 0.05 --verify   # prints calldata; sends nothing
```

`pnpm prove` boots the service in-process and exercises the five cards, an MCP
`initialize` + `tools/list` round trip, an unpaid x402 request, and each
agent's `analyse` against a real mainnet subject. It uses the session provider
that always answers "none granted", so nothing it touches can send.

## Configuration

Everything missing degrades to the cautious option, and the startup banner
lists what is not configured.

| Variable | Default | Absent means |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | `https://hallmark-agents.vercel.app` | Cards advertise the production origin |
| `HALLMARK_MARKETPLACE_URL` | `https://hallmark-market.vercel.app` | The `web` service in each card |
| `HALLMARK_CHAIN_ID` | `56` | Mainnet, because agents on the marketplace must be live on BSC |
| `X402_PAY_TO` | — | The x402 face refuses to quote a challenge (503) rather than name the zero address |
| `X402_FACILITATOR_URL` | — | A presented payment is refused with the reason, never served unverified |
| `CRON_SECRET` | — | The scheduled endpoint refuses every request (503); it does not fall back to open |
| `BSCSCAN_API_KEY` | — | Source verification reports `unknown` — Etherscan V2 charges for BNB Chain |
| `HALLMARK_SESSION_<CAT>` / `HALLMARK_SESSION_KEY_<CAT>` | — | `act` answers `aborted / no-session` with the plan it would have sent |
| `HALLMARK_STORE_PATH` | — | State is in memory; set a path for a file-backed store |
| `BSC_RPC_URL` / `BSC_TESTNET_RPC_URL` | public nodes | — |

Session keys are split across two variables per category on purpose: the
serialized half carries no key material and is safe to log or show a user; the
other half is not, and keeping them in one blob is how the key ends up
somewhere it should not be.

## Registration

`scripts/register.ts` prints the two-phase ERC-8004 flow and sends nothing.

Phase 1 is `register(tokenURI)` with `registrations: []`. The agent id is the
minted ERC-721 token id, which arrives in `Transfer.topics[3]` — the registry
is not Enumerable, so there is no `totalSupply()` to infer it from and the log
is the only source. Phase 2 is `setAgentURI(agentId, tokenURI)` with the same
card now naming its own id.

The on-chain registration file is deliberately *not* the full agent card: 1,525
bytes against 10,410, because storage is paid for on every write and the skill
schemas belong behind the `agent-card` endpoint the file points at. Live
estimate at 0.05 gwei: 1,241,909 gas, about $0.046 per agent for phase 1.

`--verify` fetches every endpoint the card declares and refuses to print
calldata for one that does not answer with JSON. A census of 6,000 registered
BNB Chain agents found 46% publishing a valid file with no `services` key at
all, and hundreds more serving a profile page where a card should be. Paying
gas to become another of those is a specific thing worth not doing.
