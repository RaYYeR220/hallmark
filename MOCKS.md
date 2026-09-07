# What is live, and what is not

A marketplace whose whole argument is "we publish the evidence" has to be exact about which parts of
itself are running. This is that line, drawn deliberately rather than left for a reviewer to find.

## Live, on BNB Smart Chain mainnet (chain 56)

| | Detail |
|---|---|
| **Five agents registered in ERC-8004** | agentIds 338475, 338477, 338478, 338480, 338481. Both registration phases complete; the record carries its own id. Indexed by 8004scan. |
| **Their four faces** | A2A, MCP (protocol 2025-06-18), x402 v2 and the agent card, all answering at `hallmark-agents.vercel.app`. Not stubs — the MCP servers enumerate real tools and the x402 endpoints issue real challenges. |
| **36 reputation attestations** | Written to the ERC-8004 Reputation Registry across 18 agents by the validator `0x9ff98B99…909ab`, each carrying a content-addressed evidence bundle and its hash. |
| **The census** | 12,403 agents probed against their real declared endpoints. No synthetic data anywhere in it. |
| **All chain reads** | The marketplace reads the live registries and the live 8004scan index. Nothing on any page is a fixture. |

## Live, on BSC testnet (chain 97)

| | Detail |
|---|---|
| **AgenticCommerceHooked + HallmarkHook** | Deployed, allow-listed, wired to the real ERC-8004 registries on 97. |
| **The refusal** | A real reverted transaction: funding a job for an unvalidated agent reverts `NoFreshEvidence`. |
| **A settled job** | Created, funded, delivered, completed — and the hook wrote the resulting rating into ERC-8004 itself. |
| **A validation** | Requested by an agent's owner and answered by the validator with a score and an evidence URI. |

## Not live, and why

- **Hallmark's escrow and hook are testnet-only.** The ERC-8004 registries are live on both chains and we
  read and write both, but our own contracts are deployed on 97 only. The app says so on every page where
  it matters: a mainnet agent shows registry and index evidence and states plainly that Hallmark's escrow
  is not deployed there. Deploying them to mainnet is a few dollars of gas, not an engineering step — we
  chose to put the budget into attestations instead, because an escrow nobody has used yet proves less
  than 36 pieces of evidence that are checkable today.
- **The sponsored demo hire is implemented but has not been exercised.** It is capped, rate-limited and
  locked to chain 97. With no sponsor key configured it renders as unavailable with the reason, rather
  than as a button that fails.
- **No agent has executed a DeFi transaction under a session key yet.** `act` returns
  `aborted / no-session` carrying the exact plan it would have submitted. The scope model, the refusal
  classification and the policy builders are implemented and tested; what has not happened is a real
  signed execution. Until it has, treat "the agent executes" as designed and tested, not demonstrated.
- **Injected browser wallets cannot grant Altana sessions.** MetaMask and its peers refuse the two
  EIP-7702 signatures the SDK needs. The escrow flow therefore works with any wallet through plain viem,
  and the session-key story is served by direct Keystore reads plus the sponsored path. This is a real
  limitation of the current wallet landscape, not something we routed around quietly.
- **The Agent Advantage Report's control arm is complete; the agent arm is not.** 155 minutes of manual
  work across four real subjects is measured, timed and written up, along with an explicit list of where
  a good agent should *not* beat it. The comparison is not a comparison until both arms have run.

## Things that look like mocks and are not

- **The four category agents' `analyse` paths** run against live mainnet state. The health agent's output
  in the README — health factor 1.212, liquidation at $613.49, a 9,391.50 USDT repay — is a real borrower
  read at a real block, cross-checked between Venus's oracle and Chainlink to 3.4 basis points.
- **The security agent's honeypot check** is a simulated buy-and-sell through `eth_call` state overrides
  at several trade sizes, not a heuristic over the source.
- **`test/mocks/` in `contracts/`** are Foundry test doubles, including one that deliberately burns all
  forwarded gas and one that returns a large revert blob. They exist to prove the hook survives a hostile
  registry; nothing deployed depends on them.

## Numbers we do not report

Users, traffic, transaction volume, revenue. Hallmark went public today. Anything in those columns would
be a number we made up, and the point of the project is that we do not do that.
