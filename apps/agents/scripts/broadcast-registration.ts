/**
 * Registers the Hallmark agents in the ERC-8004 Identity Registry.
 *
 * `register.ts` prints calldata and refuses to print it for an agent whose
 * endpoints do not answer. This one submits, and inherits the same refusal:
 * an agent that cannot be reached is not registered, because a registration
 * without a working endpoint is exactly the dead entry the marketplace exists
 * to filter out.
 *
 * Registration is two phase because the record has to carry the id it was
 * assigned. Phase one mints and yields the id from the Transfer log; phase two
 * writes the record back with `registrations` filled in. An agent left after
 * phase one is not broken, but it is incomplete, and the index will show it
 * that way.
 *
 *   pnpm tsx scripts/broadcast-registration.ts --chain 56 [--only slug] [--dry]
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { getChain, identityRegistryAbi, isSupportedChainId, caip10, type SupportedChainId } from '@hallmark/core'

import { AGENTS } from '../src/registry.js'
import { buildRegistrationFile } from '../src/runtime/a2a.js'
import { agentUrls, loadConfig } from '../src/runtime/config.js'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? undefined : argv[i + 1]
}
const has = (name: string) => argv.includes(`--${name}`)

const chainId: SupportedChainId = (() => {
  const raw = Number(flag('chain') ?? 97)
  if (!isSupportedChainId(raw)) throw new Error(`--chain must be 56 or 97; got ${raw}`)
  return raw
})()

const only = flag('only')
const dry = has('dry')

const chain = getChain(chainId)
const rpcUrl = flag('rpc') ?? process.env[`RPC_URL_${chainId}`] ?? chain.rpcUrl
const registry = chain.contracts.identityRegistry
const config = loadConfig()

const key = process.env['REGISTRAR_PRIVATE_KEY']
if (!key && !dry) throw new Error('REGISTRAR_PRIVATE_KEY is not set. Run with --dry to see the plan.')

const account = key ? privateKeyToAccount(key as Hex) : undefined
const publicClient = createPublicClient({ chain: chain.chain, transport: http(rpcUrl) })
const wallet = account
  ? createWalletClient({ account, chain: chain.chain, transport: http(rpcUrl) })
  : undefined

const encode = (file: unknown): string =>
  `data:application/json;base64,${Buffer.from(JSON.stringify(file), 'utf8').toString('base64')}`

/** An endpoint that answers. A 402 carrying a challenge is a working x402 face. */
async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (res.status === 402) return res.headers.get('payment-required') !== null || res.headers.get('x-payment') !== null
    if (!res.ok) return false
    return (await res.text()).trimStart().startsWith('{')
  } catch {
    return false
  }
}

console.log(`# registering on ${chain.name} (chain ${chainId})`)
console.log(`# registry ${registry}`)
console.log(`# rpc      ${rpcUrl}`)
console.log(`# wallet   ${account?.address ?? '(dry run)'}`)
console.log('')

const results: { slug: string; agentId?: bigint; register?: Hex; setUri?: Hex; skipped?: string }[] = []

for (const agent of AGENTS) {
  const slug = agent.manifest.slug
  if (only && slug !== only) continue

  const urls = agentUrls(config, slug)
  const phase1 = buildRegistrationFile({ agent, config, chainId, urls })

  const machine = (phase1['services'] as { name: string; endpoint: string }[]).filter(
    (s) => s.name !== 'web',
  )
  const checks = await Promise.all(machine.map((s) => answers(s.endpoint)))
  const dead = machine.filter((_, i) => !checks[i])
  if (dead.length > 0) {
    const why = `endpoints do not answer: ${dead.map((s) => s.name).join(', ')}`
    console.log(`${slug.padEnd(12)} SKIPPED — ${why}`)
    results.push({ slug, skipped: why })
    continue
  }

  const uri1 = encode(phase1)
  if (dry || !wallet || !account) {
    console.log(`${slug.padEnd(12)} would register, card ${Buffer.byteLength(uri1)} B`)
    results.push({ slug })
    continue
  }

  const hash1 = await wallet.writeContract({
    address: registry as Address,
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [uri1],
    gas: 2_000_000n,
  })
  const receipt1 = await publicClient.waitForTransactionReceipt({ hash: hash1 })
  const minted = parseEventLogs({ abi: identityRegistryAbi, eventName: 'Transfer', logs: receipt1.logs }).find(
    (log) => (log.args as { from?: Address }).from === '0x0000000000000000000000000000000000000000',
  )
  const agentId = (minted?.args as { tokenId?: bigint } | undefined)?.tokenId
  if (agentId === undefined) throw new Error(`${slug}: no mint Transfer log in ${hash1}`)

  const phase2 = {
    ...phase1,
    registrations: [{ agentId: Number(agentId), agentRegistry: caip10(chainId, registry) }],
  }
  const hash2 = await wallet.writeContract({
    address: registry as Address,
    abi: identityRegistryAbi,
    functionName: 'setAgentURI',
    args: [agentId, encode(phase2)],
    gas: 1_200_000n,
  })
  await publicClient.waitForTransactionReceipt({ hash: hash2 })

  console.log(`${slug.padEnd(12)} agentId ${agentId}  register ${hash1}  setAgentURI ${hash2}`)
  results.push({ slug, agentId, register: hash1, setUri: hash2 })
}

console.log('')
console.log(JSON.stringify({ chainId, registry, results: results.map((r) => ({ ...r, agentId: r.agentId?.toString() })) }, null, 2))
