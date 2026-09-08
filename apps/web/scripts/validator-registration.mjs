#!/usr/bin/env node
/**
 * Derive agent 2210's ERC-8004 registration file from the card the validator
 * actually serves, and optionally write it to the Identity Registry.
 *
 * The failure this exists to prevent has already happened once: the validator
 * was registered with a card naming three endpoints on `hallmark.market`, a
 * domain nobody ever registered. Every probe of it since has scored zero, and
 * the score published for it could not be re-derived from its own card. An
 * agent that declares an endpoint it does not serve is the single most common
 * defect in the census this project publishes, and we were an instance of it.
 *
 * So the registration file is never hand-written again. It is derived, here,
 * from a live `GET` of the A2A endpoint — the same request a prober makes
 * first. If the endpoint is down or its card is malformed, this refuses to
 * produce a URI at all, which is the correct behaviour: there is nothing
 * truthful to register.
 *
 * What goes on-chain is the lean form. ERC-8004 keeps the registration file in
 * contract storage, so every byte is paid for at registration and again on
 * every update; the full card with its JSON Schema per skill runs to several
 * kilobytes and belongs behind the `agent-card` service, which is the
 * separation the standard is built around.
 *
 *   node scripts/validator-registration.mjs                    # print the plan
 *   node scripts/validator-registration.mjs --commit           # send setAgentURI
 *   node scripts/validator-registration.mjs --base http://localhost:3211
 *
 * `--commit` needs AGENT_OWNER_PRIVATE_KEY, the key that owns agent 2210.
 * `setAgentURI` reverts for anybody else.
 */

import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const AGENT_ID = 2210n
const CHAIN_ID = 97
const IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e'
const RPC_URL = process.env['RPC_URL_97'] ?? 'https://bsc-testnet-rpc.publicnode.com'
const DEFAULT_BASE = 'https://hallmark-market.vercel.app'

const SET_AGENT_URI_ABI = [
  {
    type: 'function',
    name: 'setAgentURI',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'tokenURI', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'tokenURI',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'string' }],
  },
]

const argv = process.argv.slice(2)
const commit = argv.includes('--commit')
const baseIndex = argv.indexOf('--base')
const base = (baseIndex >= 0 ? argv[baseIndex + 1] : (process.env['BASE_URL'] ?? DEFAULT_BASE)).replace(/\/+$/, '')

const chain = {
  id: CHAIN_ID,
  name: 'BNB Smart Chain Testnet',
  nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

async function main() {
  const cardUrl = `${base}/a2a/validator`
  process.stdout.write(`reading  ${cardUrl}\n`)

  const response = await fetch(cardUrl, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(
      `the A2A endpoint answered ${response.status}. Refusing to register a card for an endpoint ` +
        'that is not serving one — that is the exact defect this script exists to prevent.',
    )
  }

  const card = await response.json()
  const registration = toRegistrationFile(card)
  const json = JSON.stringify(registration)
  const uri = `data:application/json;base64,${Buffer.from(json, 'utf8').toString('base64')}`

  process.stdout.write(`\n${JSON.stringify(registration, null, 2)}\n\n`)
  process.stdout.write(`json     ${Buffer.byteLength(json, 'utf8')} bytes\n`)
  process.stdout.write(`uri      ${uri.length} chars\n`)

  // Every declared endpoint has to answer before this is worth writing.
  await checkEndpoints(registration.services)

  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) })
  const [owner, current] = await Promise.all([
    publicClient.readContract({
      address: IDENTITY_REGISTRY,
      abi: SET_AGENT_URI_ABI,
      functionName: 'ownerOf',
      args: [AGENT_ID],
    }),
    publicClient.readContract({
      address: IDENTITY_REGISTRY,
      abi: SET_AGENT_URI_ABI,
      functionName: 'tokenURI',
      args: [AGENT_ID],
    }),
  ])

  process.stdout.write(`\nowner    ${owner}\n`)
  if (current === uri) {
    process.stdout.write('on-chain card already matches this one; nothing to write.\n')
    return
  }

  if (!commit) {
    process.stdout.write('\nDry run. Re-run with --commit to send setAgentURI.\n')
    return
  }

  const key = process.env['AGENT_OWNER_PRIVATE_KEY']
  if (key === undefined || key === '') {
    throw new Error('AGENT_OWNER_PRIVATE_KEY is not set; setAgentURI reverts unless the caller owns the agent')
  }

  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`)
  if (account.address.toLowerCase() !== String(owner).toLowerCase()) {
    throw new Error(`agent ${AGENT_ID} is owned by ${owner}, not ${account.address}`)
  }

  const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) })
  const gas = await publicClient.estimateContractGas({
    address: IDENTITY_REGISTRY,
    abi: SET_AGENT_URI_ABI,
    functionName: 'setAgentURI',
    args: [AGENT_ID, uri],
    account,
  })

  process.stdout.write(`gas      ${gas}\n`)
  const hash = await wallet.writeContract({
    address: IDENTITY_REGISTRY,
    abi: SET_AGENT_URI_ABI,
    functionName: 'setAgentURI',
    args: [AGENT_ID, uri],
    gas: (gas * 12n) / 10n,
  })
  process.stdout.write(`sent     ${hash}\n`)

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 })
  process.stdout.write(`${receipt.status}  block ${receipt.blockNumber}  gas ${receipt.gasUsed}\n`)

  const after = await publicClient.readContract({
    address: IDENTITY_REGISTRY,
    abi: SET_AGENT_URI_ABI,
    functionName: 'tokenURI',
    args: [AGENT_ID],
  })
  process.stdout.write(after === uri ? 'verified: the registry returns exactly this card.\n' : 'MISMATCH after write.\n')
}

/**
 * The lean on-chain form, derived from the served card.
 *
 * Only fields the served card actually carries survive: a registration file
 * asserting a capability the endpoint does not advertise would reintroduce the
 * defect from the other direction.
 */
function toRegistrationFile(card) {
  if (typeof card?.name !== 'string' || !Array.isArray(card.skills) || card.skills.length === 0) {
    throw new Error(
      'the served card has no name or no skills. A prober treats that as "declares nothing", and ' +
        'so should we.',
    )
  }
  if (!Array.isArray(card.services) || card.services.length === 0) {
    throw new Error('the served card declares no services')
  }

  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: card.name,
    description: summarise(card.description, 240),
    services: card.services.map((service) => ({
      name: service.name,
      endpoint: service.endpoint,
      ...(service.version === undefined ? {} : { version: service.version }),
    })),
    skills: card.skills.map((skill) => skill.id ?? skill),
    x402Support: card.x402Support === true,
    active: true,
    supportedTrust: card.supportedTrust ?? ['reputation'],
    registrations: card.registrations ?? [],
  }
}

/**
 * Whole sentences that fit the budget, never a hard slice.
 *
 * Storage is paid for by the byte, so the on-chain description is short — but
 * a description cut mid-word reads as a broken record rather than a brief one,
 * and this file is the first thing an indexer shows a human.
 */
function summarise(text, limit) {
  const sentences = String(text ?? '').split(/(?<=\.)\s+/)
  let out = ''
  for (const sentence of sentences) {
    const next = out === '' ? sentence : `${out} ${sentence}`
    if (next.length > limit) break
    out = next
  }
  return out === '' ? String(text ?? '').slice(0, limit) : out
}

/** A declared endpoint that does not answer is the defect. Check before writing. */
async function checkEndpoints(services) {
  process.stdout.write('\nendpoints\n')
  let bad = 0
  for (const service of services) {
    const method = service.name === 'MCP' ? 'GET' : 'GET'
    try {
      const started = Date.now()
      const response = await fetch(service.endpoint, {
        method,
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      const ms = Date.now() - started
      const ok = response.status < 400
      if (!ok) bad += 1
      process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${String(response.status).padEnd(4)} ${String(ms).padStart(5)}ms  ${service.name} ${service.endpoint}\n`)
    } catch (error) {
      bad += 1
      process.stdout.write(`  FAIL  ---      --ms  ${service.name} ${service.endpoint} — ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
  if (bad > 0) {
    throw new Error(`${bad} declared endpoint(s) did not answer. Refusing to register a card that points at them.`)
  }
}
