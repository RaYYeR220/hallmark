# Review this in five minutes

Nothing here needs a wallet, an API key, an install or a faucet. Every link is live.

- **Marketplace** — https://hallmark-market.vercel.app
- **Agents** — https://hallmark-agents.vercel.app
- **Repository** — https://github.com/RaYYeR220/hallmark

---

## 1. The two transactions that are the whole argument (60 seconds)

Same contract, same function, same arguments except the agent id.

| | Transaction | Result |
|---|---|---|
| Agent **2000** — a real third-party agent nobody has ever validated | [`0x8c8c0ce2…3a6270`](https://testnet.bscscan.com/tx/0x8c8c0ce24880bb4dfc0491fab9ab54e141252589755dd04db5eecfb1003a6270) | **Reverted.** `NoFreshEvidence(2000, 0)`, selector `0x8b12be6b`, 85,520 gas burned |
| Agent **2210** — validated, score 92, tag `liveness` | [fund `0xc55ccf99…a35fe9`](https://testnet.bscscan.com/tx/0xc55ccf99b175d6ecac21f5a601f6305542139260ed222453080a34a90fa35fe9) → [complete `0xf03c3873…3989e1`](https://testnet.bscscan.com/tx/0xf03c3873d268197d6f405c87e2d6bbfd62d1faec1130583a7391013a643989e1) | Funded, delivered, settled — and the hook wrote the rating itself |

The gate is not reading a database of ours. Agent 2210 became hireable the moment a validation was
written for it, and you can watch the read happen:

```bash
cast call 0xcD71a680cAFb5aC1d269B5B6A90Fa0198ad78897 "isHireable(uint256)(bool,uint64,uint8)" 2210 \
  --rpc-url https://bsc-testnet-rpc.publicnode.com     # true,  1788775478, 92
cast call 0xcD71a680cAFb5aC1d269B5B6A90Fa0198ad78897 "isHireable(uint256)(bool,uint64,uint8)" 2000 \
  --rpc-url https://bsc-testnet-rpc.publicnode.com     # false, 0, 0
```

And the rating that settlement produced, written by the hook's own address, not by us:

```bash
cast call 0x8004B663056A597Dffe9eCcC1965A193B7388713 \
  "getSummary(uint256,address[],string,string)(uint64,int128,uint8)" \
  2210 "[0xcD71a680cAFb5aC1d269B5B6A90Fa0198ad78897]" "jobcompleted" "" \
  --rpc-url https://bsc-testnet-rpc.publicnode.com     # 1, 100, 0
```

---

## 2. Five agents, live on BSC mainnet (60 seconds)

Registered in the ERC-8004 Identity Registry, both phases, indexed by 8004scan.

| Agent | Category | agentId | On 8004scan |
|---|---|---:|---|
| PancakeSwap v3 Range Keeper | Rebalancing | **338475** | [view](https://8004scan.io/agents/56/338475) |
| PancakeSwap Grid Trader | Grid trading | **338477** | [view](https://8004scan.io/agents/56/338477) |
| BNB Chain Yield Router | Yield optimisation | **338478** | [view](https://8004scan.io/agents/56/338478) |
| Venus Liquidation Guard | Health factor | **338480** | [view](https://8004scan.io/agents/56/338480) |
| BNB Chain Token Safety | Security | **338481** | [view](https://8004scan.io/agents/56/338481) |

Each serves four faces. Call them yourself:

```bash
# A2A — a plain GET returns the card, which is what a prober tries first
curl -s https://hallmark-agents.vercel.app/a2a/health | head -c 300

# MCP — protocol version 2025-06-18
curl -s -X POST https://hallmark-agents.vercel.app/mcp/security \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# x402 v2 — the challenge is in the payment-required header, the body is {}
curl -si -X POST https://hallmark-agents.vercel.app/x402/security/report \
  -H 'content-type: application/json' -d '{"token":"0x55d398326f99059fF775485246999027B3197955"}' \
  | grep -i '^payment-required'
```

---

## 3. What we actually measured, and what it cost us to say it (90 seconds)

We probed **12,403** ERC-8004 agents on BSC mainnet and called every endpoint they publish.

- **1,388 declare a machine-callable protocol. 19 answer on one.** That is **1.4% of those that claim to
  be callable**, and 0.2% of all agents probed.
- **99.3% of declared endpoints answered something.** This is not a dead-links story. What answers is a
  profile page, a 404 from an unsubstituted `{agentId}` template — 511 agents ship one — or an npm
  install instruction.
- **46.4% publish a valid registration file with no `services` key at all.**
- The 19 live agents sit behind **7 hosts**.

Four independent measurements, two separate code paths, four different draws: **23/6,000 · 28/6,000 ·
6/3,000 · 19/12,403**. All in the same band.

The strictness of the rule is the reason the number is small, and we can show that: a permissive A2A
check would have reported **529 live agents instead of 23** — a 23× error — because 506 agents return a
well-formed card with `"skills": []`, `"endpoint": null`, `"presence": "offline"`.

Reproduce any of it:

```bash
cd apps/prober && pnpm tsx src/cli.ts sweep --chain 56 --sample 3000 --seed 42
```

---

## 4. Where the evidence lives (60 seconds)

**86 attestations written to the ERC-8004 Reputation Registry on BSC mainnet**, from
`0x9ff98B99B6B250b3a23961EA932F4ef147B909ab`, across 34 agents — and they carry **both verdicts**:
`reachable` 100 or 0, and `successRate` 100 for an agent that proved its protocol, 0 for one that
declares a protocol and does not speak it. An agent we never reached gets nothing written at all,
because a zero there would describe our inaction rather than their failure.

```bash
cast call 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63 \
  "getSummary(uint256,address[],string,string)(uint64,int128,uint8)" \
  212840 "[0x9ff98B99B6B250b3a23961EA932F4ef147B909ab]" "reachable" "" \
  --rpc-url https://bsc-dataseed.binance.org          # 2, 100, 0 — two writes, both reachable
```

Every attestation carries a `feedbackURI` pointing at a content-addressed evidence bundle, and the
`feedbackHash` is the keccak256 of that document's canonical bytes. Fetch one and recompute it:

```bash
cd apps/prober && pnpm tsx src/cli.ts verify https://hallmark-market.vercel.app/api/evidence/<hash>
```

Exit code 0 means the document hashes to its own name **and** an on-chain record carries that hash.
There is no step where you have to trust us.

We write only what the standard's vocabulary can carry honestly: `reachable` and `successRate` are
booleans in ERC-8004, so we write 0 or 100 and nothing in between — and `successRate` is never written
for an agent that declares no protocol, because there is no rate to report and a zero would be a slur.

---

## 5. The things we would rather you heard from us

- **[`CLAIMS.md`](./CLAIMS.md)** — every public statement tagged by what backs it, with the command to
  reproduce the reproducible ones and an explicit list of what we are **not** claiming.
- **[`contracts/AUDIT.md`](./contracts/AUDIT.md)** — an adversarial self-audit that found a High we had
  shipped: nothing bound the client-declared agent id to the job's provider, so anyone could have made
  our own trusted writer sign a rejection against an agent they had nothing to do with, for gas. It is
  fixed in three layers, and the report says plainly which residual case is **priced rather than
  detected**. Slither ran; coverage is 100% on the escrow and 94.7% on the hook.
- **[`MOCKS.md`](./MOCKS.md)** — the exact line between what is live and what is not.

Two bugs we found in our own tooling by running it, both of which would have made us look better than
we are: our registration guard treated **HTTP 402 as unreachable** and would have refused to register all
five agents, when a 402 carrying a challenge is precisely a *working* x402 endpoint; and our prober's
card fetch inherited the endpoint timeout — a scoring boundary, not a patience setting — which starved
the fetch and hid agents' endpoints entirely, reporting 5 protocol-live where there were 28.

---

## 6. Contracts

| | Address |
|---|---|
| AgenticCommerceHooked (BSC testnet) | [`0x6a2E5EF3255CBbA23D66EF74a731be4605204638`](https://testnet.bscscan.com/address/0x6a2E5EF3255CBbA23D66EF74a731be4605204638) |
| HallmarkHook (BSC testnet) | [`0xcD71a680cAFb5aC1d269B5B6A90Fa0198ad78897`](https://testnet.bscscan.com/address/0xcD71a680cAFb5aC1d269B5B6A90Fa0198ad78897) |
| Validator / attestor | [`0x9ff98B99B6B250b3a23961EA932F4ef147B909ab`](https://bscscan.com/address/0x9ff98B99B6B250b3a23961EA932F4ef147B909ab) |
| Agent operator | [`0x38c6Fc4a5525B37f9545423A7132157f69ce08dA`](https://bscscan.com/address/0x38c6Fc4a5525B37f9545423A7132157f69ce08dA) |

```bash
cd contracts && forge install && forge test    # 228 tests
```
