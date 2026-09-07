/**
 * ERC-8004 registration, printed rather than sent.
 *
 * Registering an agent id is a two-phase problem the registry does not solve
 * for you: the registration file names its own agent id, but the id is only
 * assigned when `register` mints the token. So:
 *
 *   1. `register(tokenURI)` with a card whose `registrations` array is empty.
 *      The registry mints an ERC-721; the agent id is the token id, which
 *      arrives in `Transfer.topics[3]` — the *third indexed* parameter of
 *      `Transfer(address,address,uint256)`. It is not in the return data of a
 *      transaction receipt, and there is no `totalSupply()` to infer it from,
 *      so the log is the only source.
 *   2. `setAgentURI(agentId, tokenURI)` with the same card, now carrying
 *      `registrations: [{ agentId, agentRegistry: "eip155:56:0x8004…" }]`.
 *
 * This script prints both phases' calldata and a cost estimate. It sends
 * nothing and holds no key: run it, read it, and submit the calldata from the
 * funded wallet yourself.
 *
 *   pnpm register                      # mainnet, default base URL
 *   pnpm register -- --chain 97        # testnet
 *   pnpm register -- --gwei 0.05       # price at a specific gas price
 *   pnpm register -- --verify          # also check the endpoints answer
 */
import { createPublicClient, encodeFunctionData, formatEther, http, type Address, type Hex } from 'viem'
import { caip10, getChain, identityRegistryAbi, isSupportedChainId, type SupportedChainId } from '@hallmark/core'

import { AGENTS } from '../src/registry.js'
import { buildAgentCard, buildRegistrationFile } from '../src/runtime/a2a.js'
import { agentUrls, loadConfig } from '../src/runtime/config.js'

const argv = process.argv.slice(2)
function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}
const has = (name: string) => argv.includes(`--${name}`)

const chainId: SupportedChainId = (() => {
  const raw = Number(flag('chain') ?? 56)
  if (!isSupportedChainId(raw)) throw new Error(`--chain must be 56 or 97; got ${raw}`)
  return raw
})()

const config = loadConfig()
const chain = getChain(chainId)
const registry = chain.contracts.identityRegistry
const client = createPublicClient({ chain: chain.chain, transport: http(chain.rpcUrl) })

/**
 * Measured on BNB Chain: a ~1 KB base64 registration file costs about 891,730
 * gas to register. Used when a live estimate is unavailable, and labelled as
 * an estimate either way.
 */
const MEASURED_REGISTER_GAS = 891_730n

/** keccak256("Transfer(address,address,uint256)"). */
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

const gweiFlag = flag('gwei')
const gasPriceWei = gweiFlag
  ? BigInt(Math.round(Number(gweiFlag) * 1e9))
  : await client.getGasPrice().catch(() => 50_000_000n)

const bnbUsd = await readBnbUsd()

console.log(`# ERC-8004 registration — ${chain.name} (chain ${chainId})`)
console.log(`# registry     ${registry}`)
console.log(`# base URL     ${config.baseUrl}`)
console.log(`# gas price    ${gasPriceWei} wei (${Number(gasPriceWei) / 1e9} gwei)${gweiFlag ? ' [from --gwei]' : ' [live]'}`)
console.log(`# BNB/USD      ${bnbUsd === null ? 'unavailable' : `$${bnbUsd.toFixed(2)}`}`)
console.log('#')
console.log('# Nothing below is sent. Submit the calldata from the funded wallet.')
console.log('# `register(string)` also writes the caller as the agentWallet metadata entry,')
console.log('# so the wallet that submits phase 1 is the wallet the agent is identified by.')

let totalGas = 0n

for (const agent of AGENTS) {
  const slug = agent.manifest.slug
  const urls = agentUrls(config, slug)

  // --- phase 1: the card with no registrations ---------------------------
  const phase1Card = buildRegistrationFile({ agent, config, chainId, urls })
  const phase1Uri = toDataUri(phase1Card)
  const phase1Data = encodeFunctionData({
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [phase1Uri],
  })

  // --- phase 2: the same card, now naming its own id ---------------------
  const phase2Card = buildRegistrationFile({
    agent,
    config,
    chainId,
    urls,
    agentId: 0, // placeholder; the real id is substituted below
    identityRegistry: registry,
  })
  // The full card, for comparison: it is what the `agent-card` endpoint
  // serves, and it is far too large to put in contract storage.
  const servedCard = buildAgentCard({ agent, config, chainId, urls })
  const phase2Uri = toDataUri(phase2Card)

  const estimate = await estimateRegisterGas(phase1Data)
  totalGas += estimate.gas

  const costWei = estimate.gas * gasPriceWei
  const costUsd = bnbUsd === null ? null : Number(formatEther(costWei)) * bnbUsd

  console.log(`\n${'='.repeat(78)}`)
  console.log(`${slug} — ${agent.manifest.name}`)
  console.log(`${'='.repeat(78)}`)
  console.log(`category      ${agent.manifest.category} (${agent.manifest.categoryLabel})`)
  console.log(`services      ${(phase1Card['services'] as Array<{ name: string; endpoint: string }>).map((s) => `${s.name} → ${s.endpoint}`).join('\n              ')}`)
  console.log(`skills        ${agent.skills.map((skill) => skill.id).join(', ')}`)
  console.log(`x402Support   ${phase1Card['x402Support']}`)
  console.log(
    `card bytes    on-chain ${byteLength(phase1Uri)} (phase 1) / ${byteLength(phase2Uri)} (phase 2)` +
      ` · served ${byteLength(JSON.stringify(servedCard))} at the agent-card endpoint`,
  )

  if (has('verify')) {
    const reachable = await verifyEndpoints(phase1Card)
    console.log(`endpoints     ${reachable.map((entry) => `${entry.name} ${entry.ok ? 'OK' : `UNREACHABLE (${entry.detail})`}`).join(' · ')}`)
    if (reachable.some((entry) => !entry.ok)) {
      console.log(
        'REFUSING      At least one declared endpoint does not answer. Do not register this\n' +
          '              card: 46% of BNB Chain agents already publish registrations pointing at\n' +
          '              nothing, and this would be another. Fix the endpoint, then re-run.',
      )
      continue
    }
  }

  console.log(`\n--- phase 1: register(string) → mints the agent id ---`)
  console.log(`to            ${registry}`)
  console.log(`value         0`)
  console.log(`gas           ${estimate.gas} (${estimate.source})`)
  console.log(`cost          ${formatEther(costWei)} BNB${costUsd === null ? '' : ` ≈ $${costUsd.toFixed(4)}`}`)
  console.log(`calldata      ${phase1Data}`)

  console.log(`\n--- recover the agent id ---`)
  console.log(`The id is the ERC-721 token id, in the Transfer log's third indexed topic:`)
  console.log(`  topic0 = ${TRANSFER_TOPIC0}   keccak256("Transfer(address,address,uint256)")`)
  console.log(`  topic1 = from (0x0 on a mint)`)
  console.log(`  topic2 = to (your wallet)`)
  console.log(`  topic3 = the agent id  ← BigInt(topics[3])`)
  console.log(`  cast:   cast receipt <tx> --rpc-url ${chain.rpcUrl} | grep -A4 ${registry}`)

  console.log(`\n--- phase 2: setAgentURI(agentId, string) → the card names its own id ---`)
  console.log(`to            ${registry}`)
  console.log(`value         0`)
  console.log(`registrations [{ agentId: <id>, agentRegistry: "${caip10(chainId, registry)}" }]`)
  console.log(
    `calldata      substitute the recovered id into the card, then encode:\n` +
      `              setAgentURI(<id>, "data:application/json;base64,<card>")\n` +
      `              This script prints the phase-2 card with agentId 0; replace that one field.`,
  )
  console.log(`phase 2 card  ${phase2Uri.slice(0, 120)}…`)
  console.log(
    `\nBoth phases decoded (for review):\n` +
      `  phase 1 registrations: ${JSON.stringify(phase1Card['registrations'])}\n` +
      `  phase 2 registrations: ${JSON.stringify(phase2Card['registrations'])}`,
  )
}

const totalWei = totalGas * gasPriceWei
console.log(`\n${'='.repeat(78)}`)
console.log(
  `Total for ${AGENTS.length} agents, phase 1 only: ${totalGas} gas = ${formatEther(totalWei)} BNB` +
    `${bnbUsd === null ? '' : ` ≈ $${(Number(formatEther(totalWei)) * bnbUsd).toFixed(4)}`}`,
)
console.log(
  'Phase 2 (`setAgentURI`) costs roughly the same again per agent, since it stores the\n' +
    'same card a second time. Budget about double the figure above for both phases.',
)
console.log('\nNothing was sent. No key was loaded.')

// ---------------------------------------------------------------------------

function toDataUri(card: Record<string, unknown>): string {
  const json = JSON.stringify(card)
  return `data:application/json;base64,${Buffer.from(json, 'utf8').toString('base64')}`
}

function byteLength(value: string): string {
  return `${Buffer.byteLength(value, 'utf8').toLocaleString('en-US')} B`
}

async function estimateRegisterGas(data: Hex): Promise<{ gas: bigint; source: string }> {
  // Estimated from an address with no balance: `register` moves no value, so
  // most nodes will price it. A refusal falls back to the measured figure.
  const probe: Address = '0x000000000000000000000000000000000000dead'
  try {
    const gas = await client.estimateGas({ account: probe, to: registry, data })
    return { gas, source: 'eth_estimateGas, live' }
  } catch (error) {
    return {
      gas: MEASURED_REGISTER_GAS,
      source:
        `measured; live estimate refused: ${
          error instanceof Error ? (error.message.split('\n')[0] ?? '').slice(0, 90) : String(error)
        }`,
    }
  }
}

async function readBnbUsd(): Promise<number | null> {
  try {
    const [round, decimals] = await Promise.all([
      client.readContract({
        address: chain.chainlink.bnbUsd,
        abi: [
          {
            type: 'function',
            name: 'latestRoundData',
            stateMutability: 'view',
            inputs: [],
            outputs: [
              { name: 'roundId', type: 'uint80' },
              { name: 'answer', type: 'int256' },
              { name: 'startedAt', type: 'uint256' },
              { name: 'updatedAt', type: 'uint256' },
              { name: 'answeredInRound', type: 'uint80' },
            ],
          },
        ] as const,
        functionName: 'latestRoundData',
      }),
      client.readContract({
        address: chain.chainlink.bnbUsd,
        abi: [
          { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
        ] as const,
        functionName: 'decimals',
      }),
    ])
    // The SVR trap: a second, 18-decimal aggregator exists for some pairs.
    if (Number(decimals) !== 8) return null
    const answer = (round as readonly bigint[])[1]
    if (answer === undefined || answer <= 0n) return null
    return Number(answer) / 10 ** Number(decimals)
  } catch {
    return null
  }
}

/**
 * Check that every endpoint the card declares actually answers.
 *
 * A census of 6,000 registered agents found 46% publishing a valid file with
 * no `services` key at all, and hundreds more pointing at endpoints that serve
 * a profile page instead of a card. Writing one of those on-chain costs real
 * gas to become another dead entry, so `--verify` refuses to print calldata
 * for a card whose endpoints do not respond.
 */
async function verifyEndpoints(
  card: Record<string, unknown>,
): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
  const services = card['services'] as Array<{ name: string; endpoint: string }>
  const out: Array<{ name: string; ok: boolean; detail: string }> = []
  for (const service of services) {
    if (service.name === 'web') continue
    try {
      const res = await fetch(service.endpoint, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      })
      const body = await res.text()
      const looksJson = body.trimStart().startsWith('{')
      out.push({
        name: service.name,
        ok: res.ok && looksJson,
        detail: res.ok ? (looksJson ? `HTTP ${res.status}` : `HTTP ${res.status}, not JSON`) : `HTTP ${res.status}`,
      })
    } catch (error) {
      out.push({
        name: service.name,
        ok: false,
        detail: error instanceof Error ? error.message.slice(0, 60) : String(error),
      })
    }
  }
  return out
}
