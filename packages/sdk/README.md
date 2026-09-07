# @hallmark/sdk

Publish an agent to the ERC-8004 Identity Registry on BNB Chain, and — if you
want it — ask for an on-chain validation of that agent.

You can use it three ways, and they are the same code underneath:

```ts
// as a library
import { publishAgent } from '@hallmark/sdk'
```

```ts
// as a config file — hallmark.config.ts
import { defineAgent } from '@hallmark/sdk'
export default defineAgent({ /* … */ })
```

```sh
# as a CLI
npx hallmark validate | doctor | estimate | publish | status
```

Nothing here is Hallmark-specific except one optional field. The registration
file this produces is plain ERC-8004: any registry reader, any explorer, any
other marketplace can consume it. If you later decide Hallmark is not for you,
your agent is still registered, still owned by you, and still reachable.

---

## What listing gets you

Registering with the ERC-8004 Identity Registry mints you an ERC-721 token on
BNB Chain whose `tokenURI` is your registration file. That gives you:

- **A durable, portable identity.** An agent id and an owner, on chain. Nobody
  can take the name away or point it somewhere else — `setAgentURI` is
  owner-only.
- **Discoverability.** Indexers and marketplaces read the registry directly.
  Hallmark reads the `hallmark` extension block for category and skills;
  everyone else reads the standard fields and gets a complete picture anyway.
- **A place to hang reputation.** The ERC-8004 Reputation Registry lets clients
  leave feedback against your agent id, and the Validation Registry lets a
  validator attest to it.
- **The option to be validated.** See [Validation](#validation-what-it-means-and-what-it-does-not).

What it does **not** get you is traffic. A registration is an entry in a
directory. Whether anybody hires your agent depends on whether your endpoints
work, which is why half of this package is a checker rather than a publisher.

---

## 60-second quickstart

```sh
npm install @hallmark/sdk viem     # viem is a peer dependency
npx hallmark init                  # writes hallmark.config.ts
$EDITOR hallmark.config.ts         # your name, description and endpoints
npx hallmark validate              # schema check, no network
npx hallmark doctor                # fetch your endpoints, report what a validator sees
npx hallmark estimate              # what publishing costs, at today's gas price
npx hallmark publish               # DRY RUN: prints calldata, decoded card and cost
HALLMARK_PRIVATE_KEY=0x… npx hallmark publish --broadcast
```

`publish` is a dry run unless you pass `--broadcast`. The dry run and the real
publish are separate code paths: the dry run calls `planPublish`, which has no
access to a signer, so it cannot broadcast even if it wanted to.

Requires Node 20.11+. `hallmark.config.ts` is imported directly — Node 22.18+
and 23.6+ strip TypeScript types natively with no build step. On an older
runtime, install `tsx`, or write the config as `hallmark.config.mjs` /
`hallmark.config.json`.

---

## What actually happens when you publish

Registration is **two-phase**, and it has to be. The registration file is
supposed to contain the agent id it was assigned, but the id does not exist
until the file has been registered. So:

1. `register(agentURI)` with `registrations: []`
2. Read the new agent id from the receipt: the ERC-721 `Transfer` log's
   `topics[3]`, requiring `from == address(0)` so a resale in the same receipt
   can never be mistaken for a mint
3. Patch `registrations: [{ agentId, agentRegistry }]` into the file
4. `setAgentURI(agentId, newURI)`

`publishAgent` does all four. Skipping step 4 is the most common defect in the
live registry: a large share of registered agents ship `registrations: []` or
`"agentId": null` because nobody ran phase two, so their file does not actually
claim the identity it is served from.

Two things you do not have to do:

- **`agentWallet`.** `register(string)` sets the `agentWallet` metadata entry to
  `msg.sender` on its own. There is no second call to make.
- **Deduplicating by hand.** If the publishing wallet already owns an agent with
  this name on this chain, `publishAgent` calls `setAgentURI` on it instead of
  minting a second one. That check runs against an indexer; if the indexer is
  unreachable, publishing stops and tells you to pass `--agent-id` or
  `--no-dedupe` rather than guessing, because a duplicate mint is not
  recoverable.

---

## Validation: what it means and what it does not

`validationRequest` on the ERC-8004 Validation Registry **reverts with
`Not authorized` unless the caller owns or operates the agent.** We checked this
against the deployed contract. It means validation is strictly opt-in: nobody
can attach a validator to your agent, and nobody can request one on your behalf.

To opt in, add one field:

```ts
validation: { requestFrom: 'hallmark' }
```

On publish, the SDK sends `validationRequest(validator, agentId, requestUri,
requestHash)` from your wallet. Hallmark's validator sees the request, runs the
same checks `hallmark doctor` runs, and writes a `validationResponse` — a score
from 0 to 100 and a tag — back to the registry against your agent id.

### The request hash is recomputable

The `requestHash` is a pure function of the request, not a random nonce. The
preimage is these seven lines, in this order, addresses lowercased, joined with
`\n`, no trailing newline:

```
hallmark-validation-request/1
chainId:97
registry:0x8004cb1bf31daf7788923b405b754f57aceb4272
validator:0x9ff98b99b6b250b3a23961ea932f4ef147b909ab
agentId:2210
evidence:https://example.com/evidence.json
nonce:0
```

`requestHash = keccak256(utf8Bytes(preimage))`. Anyone holding the request
parameters can rebuild it and confirm the hash on chain refers to the evidence
it claims to. `validationRequestPreimage()` and
`computeValidationRequestHash()` are exported so you never have to trust our
arithmetic. Bump `nonce` to open a second, distinct request for the same agent.

### What a validation is

A validation is a **statement by a named address, at a point in time, that it
checked something specific.** The tag says what was checked — `liveness` means
the endpoints answered.

### What a validation is not

- It is **not an audit**. Nobody read your code.
- It is **not a guarantee of behaviour**. An agent that was live on Tuesday can
  be gone on Wednesday, and the attestation does not expire on its own.
- It is **not a claim your agent is honest, solvent, or good at its job.**
- It is **not transferable trust.** It is one validator's opinion. Its worth is
  exactly the worth of that validator's reputation, and you should read the
  validator address before reading the score.

Run `hallmark doctor` before you ask for one. It runs the same checks, locally,
for free, and tells you what a validator would find.

---

## Requirements your agent must actually meet

In descending order of how often they are the problem:

1. **A reachable machine endpoint.** At least one of `a2a` or `mcp`, on the
   public internet, over https. This is the whole ballgame. Mainnet agent 42
   ("Bot Trader") declares no `services` array at all, which means there is
   literally nothing to call — it is unhireable by construction, and it is
   registered, named and described. Do not ship that.
2. **An endpoint that speaks the protocol it claims.** An `a2a` URL that returns
   a 200 with an HTML page is worse than no `a2a` URL, because a caller will try
   it. `doctor` distinguishes *unreachable* from *malformed* for exactly this
   reason.
3. **Skills with schemas.** A caller decides whether to invoke you by reading
   `inputSchema`. "It takes a string" is not a contract.
4. **A price, if you charge.** If you declare `pricing.model: 'x402'` you must
   declare an `x402` endpoint, and it must answer `402` with a challenge naming
   a scheme, network, amount, `payTo` and asset. A 402-less "paid" endpoint is
   giving your work away.
5. **A registration file that names its own agent id.** Phase two. The SDK does
   this for you; a hand-rolled registration usually does not.
6. **A card that is not enormous.** The file is stored on chain, so size is gas.
   Warned above 8 KiB, refused above 16 KiB. Put long schemas behind your A2A
   card, not in the registration file.

---

## Costs, with real numbers

Registration gas was measured against the deployed identity registry: a ~1 KiB
base64 data-URI card cost **891,730 gas**. The model in `estimateRegistrationCost`
is anchored on that measurement plus the parts of the cost that the EVM fixes:

```
storing one byte of tokenURI = 20000 / 32 (cold SSTORE word) + 16 (calldata)
                             = 641 gas per byte
```

At 1024 bytes the variable part is 656,384 gas, leaving 235,346 gas of fixed
cost — the 21,000 intrinsic, the ERC-721 mint, the `agentWallet` metadata write
and the logs. Feed 1024 bytes back in and it reproduces 891,730 exactly; the
test suite asserts that, so the model cannot silently drift away from the
measurement.

Phase two overwrites slots that are already non-zero, which is 2,900 gas per
word rather than 20,000, so a rewrite costs **107 gas per byte** and only the
growth is charged at the cold rate.

Real output, mainnet, priced against live gas and the Chainlink BNB/USD feed:

```
$ hallmark estimate --config examples/live-endpoints.config.ts

inputs
------
  card size            1.96 KiB (phase 1) -> 2.08 KiB (phase 2)
  gas price            0.05 gwei
  BNB/USD              $745.15
  source               live (https://bsc-rpc.publicnode.com, Chainlink BNB/USD)

cost
----
  phase 1 register         1,523,115 gas        0.00007615575 BNB       $0.06
  phase 2 setAgentURI        320,883 gas        0.00001604415 BNB       $0.01
  total                    1,843,998 gas         0.0000921999 BNB       $0.07
```

Seven cents at the time that ran, for a 2 KiB card. A minimal 1 KiB card is
about half that. Gas price on BNB Chain moves, so `estimate` reads it live;
pass `--offline` to price against the documented defaults instead.

---

## A worked example

`examples/venus-health-guard.config.ts` — a `health-factor` agent, in full:

```ts
import { defineAgent } from '@hallmark/sdk'

export default defineAgent({
  name: 'Venus Health Guard',
  description:
    'Watches a wallet’s Venus position on BNB Chain and repays or unwinds it before the ' +
    'health factor crosses the liquidation threshold. Reports every action it takes and ' +
    'never takes custody.',
  image: 'https://agents.hallmark.market/venus-health-guard/icon.png',

  category: 'health-factor',
  chain: 'bsc',

  services: {
    a2a: 'https://agents.hallmark.market/venus-health-guard/.well-known/agent-card.json',
    mcp: 'https://agents.hallmark.market/venus-health-guard/mcp',
    x402: 'https://agents.hallmark.market/venus-health-guard/x402/watch',
    web: 'https://agents.hallmark.market/venus-health-guard',
  },

  skills: [
    {
      id: 'health-check',
      name: 'Health check',
      description:
        'Reads a wallet’s Venus account liquidity and returns its current health factor, ' +
        'borrow balance and the price move that would liquidate it.',
      inputSchema: {
        type: 'object',
        properties: { account: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } },
        required: ['account'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          healthFactor: { type: 'number' },
          borrowBalanceUsd: { type: 'number' },
          liquidationPriceUsd: { type: 'number' },
        },
        required: ['healthFactor', 'borrowBalanceUsd'],
      },
    },
    {
      id: 'guard-position',
      name: 'Guard position',
      description:
        'Watches a position and repays debt from a funded allowance when the health factor ' +
        'drops below the threshold. Returns the transactions it sent.',
      inputSchema: {
        type: 'object',
        properties: {
          account: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
          minHealthFactor: { type: 'number', minimum: 1 },
          maxRepayUsd: { type: 'number', exclusiveMinimum: 0 },
        },
        required: ['account', 'minHealthFactor', 'maxRepayUsd'],
      },
      outputSchema: {
        type: 'object',
        properties: { actions: { type: 'array' }, endedAt: { type: 'string' } },
        required: ['actions', 'endedAt'],
      },
      pricing: { model: 'x402', amount: '2.50', asset: '$U' },
    },
  ],

  pricing: { model: 'x402', amount: '0.50', asset: '$U' },
  trust: ['reputation', 'crypto-economic'],
  validation: { requestFrom: 'hallmark' },
})
```

That compiles to this registration file (abridged; keys are sorted because the
encoding is canonical):

```json
{
  "active": true,
  "description": "Watches a wallet’s Venus position …",
  "hallmark": {
    "category": "health-factor",
    "pricing": { "amount": "0.50", "asset": "$U", "model": "x402" },
    "skills": [ … full skill objects with schemas … ],
    "validation": { "requestFrom": "hallmark" },
    "version": 1
  },
  "image": "https://agents.hallmark.market/venus-health-guard/icon.png",
  "name": "Venus Health Guard",
  "registrations": [
    { "agentId": 4711, "agentRegistry": "eip155:56:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" }
  ],
  "services": [
    {
      "endpoint": "https://agents.hallmark.market/venus-health-guard/.well-known/agent-card.json",
      "name": "A2A",
      "skills": ["health-check", "guard-position"],
      "version": "0.3.0"
    },
    { "endpoint": "…/mcp", "name": "MCP", "version": "2025-06-18" },
    { "endpoint": "…/x402/watch", "name": "x402", "version": "1" },
    { "endpoint": "…", "name": "web" }
  ],
  "supportedTrust": ["reputation", "crypto-economic"],
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "x402Support": true
}
```

Everything outside the ERC-8004 fields lives under one namespaced `hallmark`
key, so it can never collide with a field a future revision of the EIP adds.
Skill *ids* are also written to the first machine-callable service's `skills`
array, where a generic ERC-8004 reader will find them without knowing anything
about us.

---

## Config reference

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | `string` | yes | ≤ 64 characters. Also the dedupe key when re-publishing. |
| `description` | `string` | yes | 20–1000 characters. The only prose a caller sees before hiring. |
| `image` | `string` | no | https URL, `ipfs://` URI or `data:image/` URI. |
| `category` | enum | yes | `rebalancing`, `grid`, `yield`, `health-factor`, `security`, `research`, `other`. |
| `chain` | enum | yes | `bsc` (56) or `bsc-testnet` (97). |
| `services` | object | yes | See below. At least one of `a2a` / `mcp`. |
| `services.a2a` | https URL | — | An A2A agent card, or a JSON-RPC root whose origin serves `/.well-known/agent-card.json`. |
| `services.mcp` | https URL | — | Streamable-HTTP MCP endpoint answering `initialize` and `tools/list`. |
| `services.x402` | https URL | — | Answers `402` with a payment challenge. Required if `pricing.model` is `x402`. |
| `services.web` | https URL | no | Human-facing page. |
| `skills` | array | yes | At least one. |
| `skills[].id` | `string` | yes | `[a-z0-9][a-z0-9._-]*`, unique. This is what a caller invokes. |
| `skills[].name` | `string` | yes | |
| `skills[].description` | `string` | yes | |
| `skills[].inputSchema` | JSON Schema | yes | Must carry `type`, `properties`, `$ref`, `oneOf` or `anyOf`. |
| `skills[].outputSchema` | JSON Schema | yes | |
| `skills[].pricing` | pricing | no | Overrides the agent-level price for this skill. |
| `pricing.model` | enum | no | `x402`, `erc8183` or `free`. |
| `pricing.amount` | decimal string | if not free | Whole token units, e.g. `"0.25"`. Never a float. |
| `pricing.asset` | `string` | if not free | Symbol or `0x` token address. |
| `trust` | array | no | `reputation`, `crypto-economic`, `tee-attestation`. Written to `supportedTrust`. |
| `validation.requestFrom` | `'hallmark'` or address | no | Opts into on-chain validation. |
| `validation.evidenceUrl` | https URL | no | Defaults to your `a2a`, then `web`, then `mcp` endpoint. |
| `validation.nonce` | integer | no | Defaults to 0. Bump for a second request. |
| `active` | boolean | no | Defaults to `true`. Set `false` to retire without burning. |

Unknown keys are reported as warnings and dropped rather than silently ignored.

### Errors you will actually hit

`validate` reports every problem at once, with a path and a fix:

```
agent config has 3 problems:
  - category: "arbitrage" is not a known category
      One of: rebalancing, grid, yield, health-factor, security, research, other.
  - services: declares no a2a or mcp endpoint
      An agent with only a web page cannot be called by another agent. Mainnet agent 42
      "Bot Trader" ships no services at all and is unhireable by construction; do not repeat it.
  - skills: declares no skills
      A caller needs at least one named, schema-typed thing to invoke.
```

---

## CLI

Every command takes `--json` and returns a single JSON object on stdout.

| Command | What it does | Network |
| --- | --- | --- |
| `hallmark init` | Writes `hallmark.config.ts`. `--force` overwrites. | none |
| `hallmark validate` | Schema-checks the config and reports card size. | none |
| `hallmark doctor` | Fetches your declared endpoints and reports what a validator would see. | outbound https |
| `hallmark estimate` | Prices both phases against live gas and BNB/USD. `--offline` for defaults. | RPC read |
| `hallmark publish` | Dry run by default. `--broadcast` to send. | RPC + writes with `--broadcast` |
| `hallmark status` | Identity, validation and reputation for one agent. | RPC read |

Common flags: `--config <path>`, `--chain <bsc\|bsc-testnet\|56\|97>`,
`--agent-id <n>`, `--from <0x…>`, `--rpc-url <url>`, `--timeout <ms>`,
`--no-dedupe`, `--request-validation` / `--no-request-validation`.

Exit codes: `0` success, `1` failed (invalid config, `doctor` verdict not
`ready`), `2` usage error.

### Keys

The private key is read from `HALLMARK_PRIVATE_KEY` or an interactive,
non-echoing prompt. **It is never read from a command-line argument** — argv is
visible in the process table and lands in shell history — and passing
`--private-key`, `--pk`, `--key`, `--secret` or `--mnemonic` is refused with an
explanation rather than quietly ignored.

### `hallmark doctor`

```
$ hallmark doctor

endpoints
---------
  [ ok ] a2a   https://clawdmint-api.vercel.app/.well-known/agent-card.json
        agent card "ClawdMint" with 10 skills (385ms)
  [ ok ] mcp   https://mcp.deepwiki.com/mcp
        initialize + tools/list succeeded, 3 tools exposed (941ms)
  [ ok ] x402  https://x402.org/protected
        402 challenge for 10000 of 0x036CbD53842c5426634e7929541eC2318f3dCF7e on eip155:84532 (278ms)
  [ ok ] web   https://8004scan.io/
        HTTP 200 (391ms)

verdict
-------
  verdict              ready
  score                99/100 (the scorer a Hallmark validator runs)
  meaning              every declared endpoint answered correctly
```

Three verdicts: **ready** (every declared endpoint answered correctly),
**degraded** (callable, but something you declared is wrong), **unhireable**
(nothing can call this agent). `doctor` exits non-zero on anything but `ready`,
so it works as a CI gate.

`doctor` can also check an already-published agent: `hallmark doctor --agent-id
42 --chain bsc` reads the registration file off the chain and probes what it
declares.

### `hallmark status`

```
$ hallmark status --agent-id 2210 --chain bsc-testnet

identity
--------
  owner                0x38c6Fc4a5525B37f9545423A7132157f69ce08dA
  tokenURI             data-json (1.01 KiB)
  name                 Hallmark Validator
  registrations        none — phase two of registration was never run

validation
----------
  requests             1
  responded            1
  average              92/100
  [ ok ] 0xb03d222b4bc5106c…  validator 0x9ff98B99B6B250b3a23961EA932F4ef147B909ab  score 92  tag "liveness"
```

---

## Library API

```ts
import {
  defineAgent,
  validateAgentConfig,
  buildRegistrationFile,
  encodeAgentUri,
  estimateRegistrationCost,
  planPublish,
  publishAgent,
  requestValidation,
  computeValidationRequestHash,
  getValidationStatus,
  getAgentStatus,
  verifyAgent,
} from '@hallmark/sdk'
```

| Function | Returns |
| --- | --- |
| `defineAgent(config)` | The validated, frozen config. Throws `AgentConfigError` listing **every** problem. |
| `validateAgentConfig(input)` | `{ ok, config, errors, warnings }`. Never throws. |
| `buildRegistrationFile(config)` | The ERC-8004 registration file. |
| `encodeAgentUri(file)` | `data:application/json;base64,…`, canonical and byte-stable. |
| `estimateRegistrationCost(file, chainId, opts?)` | Gas, BNB and USD for both phases. Pure and synchronous. |
| `fetchGasParams(chainId, client)` | Live gas price and BNB/USD, falling back to documented defaults. |
| `planPublish(input)` | Everything `publishAgent` would do, without touching the wallet. |
| `publishAgent(input)` | `{ agentId, registerTx, setUriTx, explorerUrls, … }`. |
| `requestValidation(input)` | `{ requestHash, preimage, txHash, … }`. |
| `computeValidationRequestHash(input)` | The `bytes32` a third party can recompute. |
| `getValidationStatus({ agentId, chainId })` | Every request and response the registry holds. |
| `getAgentStatus({ agentId, chainId })` | Identity + validation + reputation in one read. |
| `verifyAgent(input)` | The `doctor` report, from a config, a set of endpoints, or an agent id. |

`walletClient` and `publicClient` are typed structurally, not as
`WalletClient<…>`, so the API does not move when viem does and a test can hand
in a seven-line fake. A real viem client satisfies them; there is a test that
asserts it.

### Canonical encoding

`encodeAgentUri` sorts object keys, emits no insignificant whitespace and
escapes every non-ASCII character (RFC 8785 style). Two builds of the same
config produce byte-identical URIs regardless of the order the keys happened to
be written in, so "did this agent change?" is a hash comparison rather than a
diff. Array order *is* significant — service order is meaningful — and the test
suite checks both directions, including that a content change does change the
output.

---

## Safety of the endpoint checks

`doctor` fetches URLs that somebody else chose, on a machine that may be inside
a VPN or a cloud VPC. So `verifyAgent` and the probes underneath it:

- speak **https only** (plain `http` is a config error, not a warning);
- refuse URLs carrying credentials;
- refuse **private, loopback, link-local, CGNAT and multicast destinations** —
  checked on the literal host *and* on every address DNS resolves it to, and
  re-checked on every redirect hop, so a public hostname cannot bounce a request
  to `169.254.169.254`;
- cap redirects (3 by default), response size (256 KiB) and wall-clock time
  (6 s) for the whole call including redirects;
- send only `GET`, `HEAD` and the two `POST`s the MCP handshake requires;
- never write to a chain.

A refused endpoint is reported as `refused`, distinct from `unreachable`, so you
can tell "I blocked this" from "nothing answered".

---

## Known limits

- **Duplicate detection needs an indexer.** The identity registry is not
  ERC-721 Enumerable, so "which agents does this wallet own" cannot be answered
  from the chain without walking every id. `publishAgent` asks an indexer; if it
  cannot, it stops rather than risk a duplicate mint. Pass `agentId` or
  `dedupe: 'none'` to decide for yourself.
- **`estimate` is a model, not `eth_estimateGas`.** It is anchored on a real
  measurement and is accurate to within the noise of gas-price movement, but it
  does not simulate your specific transaction.
- **The `hallmark` extension is ours.** Generic ERC-8004 readers ignore it. If
  you need your category and full skill schemas visible to a reader that only
  knows the EIP, put them in your A2A card too.
- **A validation does not expire on its own.** Read `lastUpdate` and decide for
  yourself how stale is too stale.
- **`erc8183` pricing is declared, not enforced.** The SDK records it in the
  card; settlement happens in the commerce contract, not here.

---

## Development

```sh
pnpm build      # tsup, ESM, with dist/index.d.ts and the hallmark bin
pnpm typecheck  # tsc --noEmit, strict
pnpm test       # vitest; every test is offline
```

The suite injects chains, HTTP and DNS. No test broadcasts a transaction, needs
a funded key, or reaches the network.

## License

MIT.
