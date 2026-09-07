# @hallmark/web

The marketplace. Discovery, evidence, the hire flow, the session control panel,
and the public evidence endpoint that on-chain attestations point at.

```bash
pnpm install            # from the repo root
pnpm --filter @hallmark/web dev
pnpm --filter @hallmark/web build
pnpm --filter @hallmark/web test
```

It runs with an entirely empty `.env`. Every variable in `.env.example` widens
what the app can do or raises a rate limit; none of them is required, and the
capabilities that need one say so on screen rather than failing.

---

## Route map

| Route | What it is |
|---|---|
| `/` | The landing surface. One claim, one CTA, live index numbers streamed in behind the fold. |
| `/agents` | Discovery over 300,000+ ERC-8004 agents: category, protocol, evidence status, sort, keyword and semantic search, paged. |
| `/agents/[chainId]/[agentId]` | Everything the chain knows about one agent — evidence timeline, reputation per tag, validation records, the raw registration file and every parser warning. |
| `/hire/[chainId]/[agentId]` | The money flow: task, price, the exact session-key scope, then the wallet path or the sponsored testnet path. |
| `/sessions` | Session keys read live from the public Altana Keystore, with a live scope tester that makes a policy refuse things. |
| `/proof` | Every on-chain artifact, read at request time, each one a link. |
| `/publish` | For agent developers: how to get listed, what the probe scores, what validation asserts and what it does not. |
| `GET /api/agents` | The discovery query as JSON. |
| `GET /api/agents/[chainId]/[agentId]` | One agent, including the live hire preflight. |
| `GET /api/evidence/[hash]` | **The evidence bundle, byte-exact.** See below. |
| `GET /api/sessions/[chainId]/[address]` | Keystore state for any wallet, plus the `cast` commands that reproduce it. |
| `GET /api/jobs/[chainId]/by-tx/[hash]` | The job id a `createJob` transaction produced. |
| `GET /api/stats` | The census and the gate's live configuration. |

Writes are server actions, not routes: `src/app/actions/hire.ts` (the sponsored
hire) and `src/app/actions/scope.ts` (the scope tester).

---

## `/api/evidence/[hash]` — the one route with a hard contract

An evidence bundle is content-addressed. Its name is `keccak256` over an
RFC-8785-style canonical JSON serialisation of itself, and that hash is written
on-chain as `feedbackHash` on the Reputation Registry and `responseHash` on the
Validation Registry. The URI written beside it points here.

So this route must return **the exact bytes that were hashed**. Not an
equivalent object — the same bytes.

```ts
// Correct. Bytes in, bytes out.
return new Response(storedText, { headers: { 'content-type': 'application/json' } })

// Wrong, and silently so. Re-encodes, and the hash stops verifying.
return Response.json(JSON.parse(storedText))
```

Before serving, the route re-derives the hash from the bytes and refuses to
serve a document that does not reproduce its own name — including one that
hashes correctly but is stored non-canonically, because serving that hands a
verifier bytes that will not verify.

`test/evidence-route.test.ts` holds this contract: it fetches a bundle through
the real route handler and recomputes `keccak256(canonicalize(body))` over the
response, asserting it reproduces the stored hash. It also asserts the body is
*not* a `JSON.stringify` round-trip, which is the specific regression that would
otherwise pass every other test in the suite.

Bundles are read from `EVIDENCE_STORE_DIR` (the `evidence/<hash>.json` layout
`apps/prober` writes), or proxied verbatim from `PROBER_BASE_URL`.

---

## Design tokens

**A re-skin is a diff to `src/styles/tokens.css`.** That file holds every
colour, measurement, type step, radius, shadow and duration the application
uses; no component hard-codes a value. Light values sit on the bare `:root`,
and the same semantic names are redefined twice for dark — once under
`prefers-color-scheme` (guarded against an explicit light choice) and once
under `[data-theme="dark"]`, so a user's choice wins in both directions.

`src/styles/base.css` is the reset and the handful of genuinely global
primitives. Everything else is a CSS Module beside its component.

---

## Architectural decisions worth knowing

**There is no database.** Deliberately. Every number on every page is read live
from BNB Chain or from the public 8004scan index, and anyone can rebuild the
whole index from BSC without our cooperation. The cost is real and is paid on
screen: a session granted on another device shows up with its validity but not
its scope, because the Keystore stores no permissions and we keep no
server-side record of what users have authorised.

**Cache aggressively, never present cached data as live.** Caching policy is
listed in `src/lib/cache.ts` with a window chosen per fact. Anything that gates
money — `isHireable`, above all — is never cached. Every surface prints the
timestamp of the read behind it.

**The chain wins.** The index is used for what a chain read cannot do cheaply:
full-text search, embedding search, a count over 300,000 rows, and the
transaction hash that wrote a given feedback row. Where both have an opinion,
the chain's is rendered and the index's is shown beside it, attributed.

**`complete` and `reject` need an explicit ~450,000 gas limit.** The hook wraps
its ERC-8004 reputation write in a `try/catch`; EIP-150 hands an inner call at
most 63/64 of the remaining gas, and a `catch` turns an inner out-of-gas into an
outer success. `eth_estimateGas` therefore converges on a limit under which the
job settles, the provider is paid, and the rating silently never lands. Both the
sponsored path and the wallet path send `SETTLEMENT_GAS_LIMIT` explicitly.

**x402 calls go server-side.** Browser CORS blocks the `X-PAYMENT` header on
third-party endpoints, so anything that pays must run in a route handler or a
server action.

---

## ABI drift, found the hard way

`src/lib/abi.ts` transcribes Hallmark's contracts from `contracts/src/*.sol`
rather than importing them from `@hallmark/core`, because two of core's ABIs do
not describe our deployment:

- `agenticCommerceAbi` describes Altana's canonical ERC-8183 kernel, which has a
  different `createJob` signature and a different `Job` shape from
  `AgenticCommerceHooked`. Using it encodes the wrong calldata.
- `hallmarkHookAbi.agentRecord` declares six flat return values; the deployed
  contract returns a five-field struct. Decoding against the wrong shape
  produces plausible-looking wrong numbers.

Both were verified with live `eth_call`s against chain 97 before being written
down here.

---

## Wallet

Hand-rolled on EIP-1193 with EIP-6963 discovery
(`src/components/wallet/WalletProvider.tsx`). No connector kit: everything the
app needs is three RPC methods and one event, and a kit would bring its own
modal and its own opinions about layout, which the visual pass would then have
to fight.

Note the Altana SDK's own constraint, which shapes the hire page: injected
wallets are not a valid Altana signer type — they refuse the two signatures the
EIP-7702 flow needs. Browser users onboard with a passkey wallet and fund it
from their extension wallet. The escrow flow itself is plain `viem` and works
with any injected wallet.
