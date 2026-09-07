# @hallmark/altana

Hallmark's authorization surface. Hiring an on-chain agent must never hand it
custody, so activation grants an **Altana session key** instead: an allowlist of
contracts, a spend cap, an expiry, registered in a public Keystore. The user
revokes it in one click. Anyone verifies it with one `eth_call` and no
credentials.

Nothing outside this package touches `@altananetwork/sdk`.

```bash
pnpm build      # tsup → ESM + .d.ts
pnpm typecheck  # tsc --noEmit, strict
pnpm test       # vitest
```

ESM only — the Altana SDK ships an `import`-only exports map, so `require()`
cannot reach it.

## The shape of it

```ts
import {
  createAgentWallet, generateSessionKey, grantAgentSession,
  venusHealthFactorPolicy, validatePolicy, describePolicy,
  executeWithSession, revokeAgentSession, isSessionValid,
} from '@hallmark/altana'

const policy = venusHealthFactorPolicy(56, { ttlSeconds: 7 * 86_400 })
describePolicy(policy)          // the exact sentences the control panel shows
validatePolicy(policy)          // { ok: true } | { ok: false, problems: [...] }

const { wallet, signer } = await createAgentWallet(56, userKey)
const sessionKey = generateSessionKey()          // yours to store; never the SDK's

const grant = await grantAgentSession({
  chainId: 56, wallet, adminSigner: signer, policy, sessionPrivateKey: sessionKey,
})
if (grant.kind !== 'granted') return show(grant) // unfunded / refused / reverted

await isSessionValid(56, grant.walletAddress, grant.publicKey)  // true, from a public RPC
await revokeAgentSession({ chainId: 56, wallet, adminSigner: signer, session: grant.session })
```

## Refusal is a result, not an exception

The headline behaviour. When a session key tries something outside its
allowlist or over its cap, the request is rejected **before it reaches the
chain**, and that is a first-class outcome:

```ts
type ExecuteOutcome =
  | { kind: 'confirmed'; txHash; explorerUrl; statusCode; callsId; detail }
  | { kind: 'pending';   callsId; statusCode; detail }
  | { kind: 'refused';   statusCode; reason; detail; source; callsId? }   // 300–499
  | { kind: 'reverted';  statusCode; detail; txHash?; callsId? }          // 500+
  | { kind: 'unfunded';  detail; requiredWei; address? }
```

`executeWithSession` never throws for any of these. Every variant carries
`detail` a UI can print verbatim, and `describeOutcome` adds a headline and a
tone.

Two things make the refusal path better than a raw relay code:

- **Preflight.** The same permission check the relay runs, run locally first,
  so an out-of-scope call is refused in microseconds with the offending address
  and selector named. `source: 'preflight'` says nothing was sent. Pass
  `preflight: false` to watch the relay do it instead.
- **Honest diagnosis.** The relay reports a band, not a cause. We narrow it
  against the grant we hold — expired, off-allowlist, over the native cap — and
  otherwise report `'unknown'` rather than inventing a reason.

Status bands follow EIP-5792: `100–199` in flight, `200–299` success,
`300–499` rejected before inclusion, `500+` reverted on-chain.

### The band does not cover the two refusals you actually care about

Measured against the live testnet relay, an over-cap spend and an off-allowlist
call **never produce a 300–499 status at all.** The relay rejects both as typed
errors at `wallet_prepareCalls` — `ExceededSpendLimit` and `UnauthorizedCall`,
each naming the key hash, the target and the calldata — because it never gets
as far as building a bundle to give a status to. The 300–499 band belongs to
the execute path, which a refused call never reaches.

`outcomeFromThrow` currently only maps to `refused` when the error text carries
`relay code NNN`, so those two land as `kind: 'reverted', statusCode: 0`. That
is wrong: nothing reverted and nothing reached the chain. The typed error is
better evidence than a status code would have been, but the mapping needs to
recognise it, and until it does **a caller using `executeWithSession` directly
is misled about the two canonical refusals.**

Hallmark's own agents are unaffected — `executeIntent` locates the blocking
rule itself before handing anything to the executor, so `act` reports `refused`
with the rule that blocked it. This is written down rather than quietly fixed
because the package's headline claim did not hold and someone should know.

## Policies

`AgentPolicy` is our vocabulary — every rule carries the sentence the UI shows,
every cap carries the decimals it was written against. `toAltanaPermissions`
strips the copy off at the boundary; `fromAltanaPermissions` reads it back.

Four ready-made categories, on chains 56 and 97:

| Builder | Allowlist |
| --- | --- |
| `pancakeRebalancePolicy` | PancakeSwap v3 position manager + swap router |
| `pancakeGridPolicy` | PancakeSwap v3 swap router |
| `yieldRoutingPolicy` | Venus comptroller, vBNB, vUSDT (+ Aave V3 pool on 56) |
| `venusHealthFactorPolicy` | Venus, selector-scoped to de-risking calls only — no `borrow` |

`validatePolicy` catches an empty allowlist, a dead or effectively-permanent
expiry, a millisecond timestamp, missing or zero caps, a missing native cap,
duplicates, malformed signatures — and the **18-vs-6 decimals trap**:

> Spend cap for USDT is 0.0000000001 USDT — that looks like 100 written for a
> 6-decimal token. On BNB Chain USDT has 18 decimals; multiply the limit by
> 10^12.

Native caps are expressed with the `NATIVE_TOKEN` sentinel and map to Altana's
"omit the token" convention. Remember that relay fees come out of the native
cap, so leave headroom.

## Verifying without us

`keystore.ts` is plain viem against a public RPC — no Altana client, no relay,
no key, no funds. That is the point: a judge can reproduce it from a fresh
terminal.

```ts
await isSessionValid(56, wallet, publicKey)     // one eth_call
await listRegisteredKeys(56, wallet)            // every key the wallet has
await estimateGrantCostWei(56)                  // live Keystore fee × 2
keystoreExplorerUrl(56, wallet)                 // shareable evidence
```

`sessionKeyId(publicKey)` is `keccak256` of the SEC1 public key — the id the
Keystore stores.

## Session storage

Never `JSON.stringify` a `Session`: it throws on the bigint limits, and when it
does not, it writes the secret to disk. Split the halves:

```ts
const stored = persistSession(grant.session, { chainId: 56, label: 'Grid bot' })
// stored: JSON-safe, no key material, plus a small Hallmark envelope
await secrets.save('agent-1.key', sessionKey)

const session = restoreSessionFromKey(stored, await secrets.load('agent-1.key'))
```

`restoreSession` refuses a signer that does not match the stored public key —
loudly at restore beats opaquely at the relay.

## Live checks

`scripts/live-check.mjs` runs the four funds-free verifications: the wallet
address equals the signer EOA on both chains, the client's real method surface,
a permissionless Keystore read against mainnet, and a `grantSession` from an
unfunded wallet coming back classified as `unfunded` instead of crashing.

```bash
pnpm build && node scripts/live-check.mjs
```

## Notes from building against the SDK

- The smart-account address **is** the signer's EOA (EIP-7702 delegation), the
  same on 56 and 97. Do not tell users they get a new address.
- `generatePrivateKey` is not an Altana export — it comes from `viem/accounts`.
  `generateSessionKey()` here wraps it.
- `grantSession` is the one entry point that *throws* on a failed relay answer;
  everything else returns a status. `grantAgentSession` normalises both.
- `feeToken` in $U is rejected on testnet. Native fee only.
- The Keystore fee is dynamic, not a constant. Quote it with
  `estimateGrantCostWei`.
- An unfunded wallet surfaces as an execution error with **empty revert data**
  (`Reason: 0x`). That is not a bug to chase; it means fund the wallet.
