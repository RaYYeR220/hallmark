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

**Source verification is keyless, via Sourcify — and this agent used to claim
it was impossible.** Etherscan's V2 API does charge for BNB Chain, and that
true fact was turned into a false conclusion: "there is no keyless way to
confirm verified source". Sourcify is free, needs no key, and held the
implementation behind that EIP-1167 proxy as an `exact_match`. The check now
runs against the *implementation*, which is the point of resolving the proxy
first: the 45-byte stub is not verified and never would be.

A plausible justification attached to a question nobody asked is exactly the
failure this codebase claims to be better than. It is recorded here rather than
quietly deleted.

**The yield agent takes a mandate, and refuses rather than ranking.** Asked for
"100,000 USDT, withdrawable, no directional exposure", it used to return 100%
into the top of an APR sort with `risks: []`. Two things were wrong: the
constraint had nowhere to live, and an empty risk array reads as "we checked
and there are none", which is the most dangerous sentence it could produce.

Now `maxIlRisk`, `stablecoinOnly`, `allowOutliers`, `minTvlUsd`,
`maxSingleVenuePct` and `requireOnchainVerifiable` are real inputs, evaluated
per venue; a venue that breaks one is *excluded* with the rule that excluded
it, never ranked-and-caveated. `risks` is `string[] | null` and is never `[]` —
`null` plus a reason is what "we could not determine" looks like. With no
mandate the conservative default applies and the output says so.

**Cost fields are total or named.** The rebalancer's `cost.totalUsd` was gas
only while the prose said "plus the ratio swap" — about 133× low on a real
position, and worse than either being wrong alone, because a caller integrates
the field and reads the paragraph. It is now `gasUsd` + `swapCostUsd` =
`totalUsd`, with `swapCostBasis` saying whether the swap leg came from a live
quote or from the fee tier as a floor.

## Proving it on chain — the session-key lifecycle

Everything above demonstrates *the agent proposes* in software. This section
demonstrates *the session key constrains, the chain enforces* on BNB Chain
testnet, with hashes.

`scripts/session.ts` runs the five phases. It is fixed to chain 97 and will not
run against mainnet.

```bash
pnpm session address    # generate the two keys, report the wallet to fund
pnpm session status     # balances, live Keystore fee, current key state
pnpm session all        # grant → act → refuse → revoke → verify
```

The demonstration uses `venusHealthFactorPolicy` deliberately. It is the only
selector-scoped policy of the four, and `borrow` is absent from it — so the
refusal in phase 3 is not a contrived example. It is the agent being told, by
the account contract, that it may not lever a position up.

Two keys, generated into a gitignored `.env.session` on first run and never
combined:

| | |
| --- | --- |
| admin wallet (the user's) | `0x330eb8FFc68d549057fC5115218a6590b39e8531` |
| session key (the agent's) | `0xf86cd72824AA708501360416e16A26b9A960d7Aa` |
| key id — `keccak256(publicKey)` | `0x209a9c04a3196ca74a04cb47caa521feefe1760d206aff858bd82278454be0ee` |
| Keystore (chain 97) | `0x6b8361C29d05D498b1a12B54A37310f94171E94A` |

### The scope being granted

```
Scope: Hallmark demo — Venus health-factor defence (testnet)
Can call: Enter Venus markets (0x94d1…b77D), only `enterMarkets(address[])`
Can call: Supply BNB collateral (0x2E72…De62c), only `mint()`
Can call: Repay BNB debt (0x2E72…De62c), only `repayBorrow()`
Can call: Withdraw supplied BNB (0x2E72…De62c), only `redeemUnderlying(uint256)`
Can call: Supply USDT collateral (0xb752…441A), only `mint(uint256)`
Can call: Repay USDT debt (0xb752…441A), only `repayBorrow(uint256)`
Can call: Withdraw supplied USDT (0xb752…441A), only `redeemUnderlying(uint256)`
Can spend: up to 5 $U per day
Can spend: up to 0.02 BNB per day (relay fees come out of this too)
Expires: 24 hours from the grant
Cannot: hold your funds, or act on anything outside the list above.
Revocable: one transaction, effective immediately, provable on-chain.
```

Seven rules, every one selector-scoped, and no `borrow` among them.

### Before the grant

Read with plain viem against a public node — no Hallmark code in the path:

```
keystore    0x6b8361C29d05D498b1a12B54A37310f94171E94A
wallet      0x330eb8FFc68d549057fC5115218a6590b39e8531
keyId       0x209a9c04a3196ca74a04cb47caa521feefe1760d206aff858bd82278454be0ee
isValidKey  false
getKeys     []
```

The Keystore fee, quoted live rather than assumed — `estimateGrantCostWei`
reads `getRegistrationFeeInWei` off the Controller and doubles it, because a
first grant makes two Controller calls:

```
grant cost (live)  0.001360586516267102 tBNB
```

### Reproducing the verification yourself

The whole point of the Keystore is that a stranger can check the claim:

```bash
cast call 0x6b8361C29d05D498b1a12B54A37310f94171E94A   "isValidKey(address,bytes32)(bool)"   0x330eb8FFc68d549057fC5115218a6590b39e8531   0x209a9c04a3196ca74a04cb47caa521feefe1760d206aff858bd82278454be0ee   --rpc-url https://bsc-testnet-rpc.publicnode.com
```

`pnpm session verify` prints that command with the current values, and the
Keystore explorer renders the same fact at
`https://testnet.altana.network/key/<keyId>`.

### It ran. Here is what happened.

| phase | transaction |
| --- | --- |
| grant | [`0x8e5c0023b27153df25d9dc1bd880afa67a8cbcb698c81b74e773cd7687b856b4`](https://testnet.bscscan.com/tx/0x8e5c0023b27153df25d9dc1bd880afa67a8cbcb698c81b74e773cd7687b856b4) |
| act — Venus `mint()`, 0.001 tBNB | [`0xbb50ff72f71a2b0b782842fb9b036ea53e2c737c472b29ae9b72935fbc78fd76`](https://testnet.bscscan.com/tx/0xbb50ff72f71a2b0b782842fb9b036ea53e2c737c472b29ae9b72935fbc78fd76) |
| revoke | [`0xc5572b8f4f4e68518abd4594874e6a2cf39cd920475cb7ed2fca3b4cfdf3d2f6`](https://testnet.bscscan.com/tx/0xc5572b8f4f4e68518abd4594874e6a2cf39cd920475cb7ed2fca3b4cfdf3d2f6) |

The Keystore across the sequence, read with plain viem each time:

```
before the grant   isValidKey(...) = false     getKeys = []
after the grant    isValidKey(...) = true
after the revoke   isValidKey(...) = false
```

### The two refusals

Both went out with `preflight: false`. That flag is load-bearing and is
commented as such in the script: with our own scope check on, it answers first
and the relay never gets to speak. The artifact is the *authorization layer*
refusing, not us declining to ask it.

**Over-cap.** The call is allowlisted; the amount is not. Sized deliberately
so the cap is the only possible explanation — 0.03 tBNB against a 0.02/day cap,
with 0.0586 tBNB in the wallet, because an amount larger than the balance would
have been refused for want of funds and proved nothing.

```
Native cap right now: 0.02 tBNB per day; 0.001 tBNB spent by phase 2; 0.019 tBNB of headroom left.
→ Denied because it would have exceeded 0.02 tBNB per day with 0.019 tBNB left:
  it asked for 0.03 tBNB, which is 0.011 tBNB beyond the headroom.
  The wallet held 0.0586 tBNB at the time, so funds were not the reason — the cap was.

Reason: ExceededSpendLimit
Details: ExceededSpendLimit(ExceededSpendLimit { token: 0x0000000000000000000000000000000000000000 })
```

**Off-allowlist.** `borrow(uint256)` on vUSDT — the market is allowlisted, the
selector is not, for any market. This is the property that makes the health
agent unable to lever a position up, enforced by the account contract rather
than by the agent behaving.

```
Reason: UnauthorizedCall
Details: UnauthorizedCall(UnauthorizedCall {
  keyHash: 0xf26346eee130ebf0b3d9dcdd0623134a210cef383896b8f6f1a5a5c69993ff04,
  target:  0xb7526572ffe56ab9d7489838bf2e18e3323b441a,
  data:    0xc5ebeaec0000000000000000000000000000000000000000000000000de0b6b3a7640000 })
```

### One finding worth passing upstream

Both refusals come back from `@hallmark/altana` as `kind: 'reverted',
statusCode: 0`. That is wrong: nothing reverted and nothing reached the chain.
`outcomeFromThrow` only maps to `refused` when the error message carries
`relay code NNN`, and the Altana relay signals a policy refusal as a *typed
error at `wallet_prepareCalls`* — `ExceededSpendLimit`, `UnauthorizedCall` —
with no numbered status, because it never gets as far as building a bundle.

So the 300–499 band belongs to the execute path, not to prepare-time rejection,
and the package's headline claim — refusals are first-class results — currently
does not hold for the two canonical refusals. This service is unaffected:
`executeIntent` locates the blocking rule itself before the executor is
reached, so `act` always reports `refused` correctly. Anyone calling
`executeWithSession` directly would be misled.

## Deploying

The serverless entry point in `api/index.ts` is a hand-written Node-to-Web
adapter rather than `@hono/node-server/vercel`, and the reason is worth
knowing before someone swaps it back.

That adapter builds the request body with `Readable.toWeb(incoming)`. Vercel's
Node runtime has already read the body to populate `req.body` before the
function runs, so the stream handed over is drained; converting it yields a
body that either resolves empty or never settles. In production it never
settled, and the symptom was exact: **every route that reads a body hung, and
every route that does not read one worked.** The cards and `GET /a2a/{slug}`
were fine. An unpaid `POST /x402/...` was fine, because it answers 402 before
touching the body. `POST /mcp/{slug}` never answered.

So the body is taken from where the platform actually put it, and every wait
is bounded — the body read, the skill, and the request — because a face that
hangs is scored dead by a prober while one that returns 504 is merely slow.
`test/vercel-handler.test.ts` drives the exported handler with the exact
production request shape, so this cannot come back through a test that only
exercises `app.fetch`.

## Running it

```bash
pnpm install
pnpm test          # 241 tests, no network, no keys
pnpm typecheck
pnpm start         # http://localhost:8787
pnpm prove         # every face, against live BNB Chain mainnet, read-only
pnpm register -- --gwei 0.05 --verify   # prints calldata; sends nothing
pnpm session all   # the on-chain session lifecycle, testnet only
```

`GET /sessions` renders the authorization surface: every agent that can act,
its policy, and a live Keystore read of whether its key is currently valid.
Ungranted agents appear too, carrying the policy a grant *would* authorise —
a page that only lists live keys answers the wrong question, because what a
user wants to know before agreeing is what the thing could do to them.

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
| `BSCSCAN_API_KEY` | — | Optional. Source verification uses Sourcify, which is keyless |
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
