/**
 * Read-only smoke test against live BSC and the live 8004scan API.
 * Not part of the build. Run it after `pnpm build`:
 *
 *   node scripts/smoke.ts
 */
import { createRegistryReader, createScanClient, endpointsOf } from '../dist/index.js'

const AGENT_IDS = [1n, 7n, 42n]

async function readAgents(): Promise<void> {
  const reader = createRegistryReader(56)
  console.log(`registry  ${reader.chain.contracts.identityRegistry} via ${reader.chain.rpcUrl}`)

  const agents = await reader.getAgents(AGENT_IDS)
  for (const agent of agents) {
    if (agent === null) {
      console.log('  (missing agent)')
      continue
    }
    console.log(`\n  agent ${agent.agentId}`)
    console.log(`    owner     ${agent.owner}`)
    console.log(`    tokenURI  ${agent.tokenUri.slice(0, 72)}${agent.tokenUri.length > 72 ? '...' : ''}`)
    if (!agent.card.ok) {
      console.log(`    card      [${agent.card.kind}] FAILED: ${agent.card.error}`)
      continue
    }
    const card = agent.card.card
    console.log(`    card      [${agent.card.kind}] ${card.name ?? '(unnamed)'} — ${card.description ?? ''}`)
    console.log(`    active=${card.active} x402=${card.x402Support} trust=[${card.supportedTrust.join(', ')}]`)
    for (const endpoint of endpointsOf(card)) {
      console.log(`      ${endpoint.kind.padEnd(6)} ${endpoint.url}`)
    }
    console.log(`    registrations ${JSON.stringify(card.registrations)}`)
    if (agent.card.warnings.length > 0) {
      console.log(`    warnings  ${agent.card.warnings.join(' | ')}`)
    }
  }

  const highest = await reader.highestAgentId({ hint: 300_000n })
  console.log(`\n  highestAgentId(56) = ${highest}`)

  const testnet = createRegistryReader(97)
  console.log(`  highestAgentId(97) = ${await testnet.highestAgentId({ hint: 2_000n })}`)
}

/** Testnet agent 2210 carries a validation and two feedbacks, so it exercises all three registries. */
async function readTestnetAgent(): Promise<void> {
  const reader = createRegistryReader(97)
  const validator = '0x9ff98B99B6B250b3a23961EA932F4ef147B909ab'
  const requestHash = '0xb03d222b4bc5106c12e0b7411936ca3365c785ffb8dfcebe2ec11286de142380'

  console.log('\ntestnet agent 2210')
  const agent = await reader.getAgent(2210n)
  console.log(`  owner        ${agent?.owner}`)
  if (agent?.card.ok === true) {
    console.log(`  card         ${agent.card.card.name ?? '(unnamed)'}`)
    for (const endpoint of endpointsOf(agent.card.card)) {
      console.log(`    ${endpoint.kind.padEnd(6)} ${endpoint.url}`)
    }
  }

  console.log(`  reputation   ${JSON.stringify(await reader.reputationSummary(2210n))}`)
  console.log(`  lastIndex    ${await reader.lastFeedbackIndex(2210n, validator)}`)
  console.log(`  index 0      ${JSON.stringify(await reader.readFeedback(2210n, validator, 0))}`)
  console.log(`  feedback     ${JSON.stringify(await reader.feedbackByClient(2210n, validator))}`)
  console.log(`  validations  ${JSON.stringify(await reader.agentValidations(2210n))}`)
  console.log(`  status       ${JSON.stringify(await reader.validationStatus(requestHash), bigintReplacer)}`)
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

async function readScan(): Promise<void> {
  const scan = createScanClient()

  const stats = await scan.globalStats()
  const bsc = stats.chain_stats.find((row) => row.chain_id === 56)
  console.log('\nscan globalStats')
  console.log(`  total_agents        ${stats.total_agents}`)
  console.log(`  total_users         ${stats.total_users}`)
  console.log(`  total_feedbacks     ${stats.total_feedbacks}`)
  console.log(`  daily_new_agents    ${stats.daily_new_agents}`)
  console.log(`  avg_feedback_score  ${stats.average_feedback_score}`)
  console.log(`  protocols           ${JSON.stringify(stats.protocol_distribution)}`)
  console.log(`  bsc chain_stats     ${JSON.stringify(bsc)}`)

  const page = await scan.listAgents({ chain_id: 56, limit: 3 })
  console.log(`\nscan listAgents(chain_id=56, limit=3) total=${page.total}`)
  for (const agent of page.items) {
    console.log(`  #${agent.token_id.padStart(7)}  ${agent.name ?? '(unnamed)'}`)
    console.log(`     owner=${agent.owner_address} x402=${agent.x402_supported} feedbacks=${agent.total_feedbacks}`)
  }

  console.log(`\nscan rate limit ${JSON.stringify(scan.getRateLimit())}`)
}

async function main(): Promise<void> {
  await readAgents()
  await readTestnetAgent()
  await readScan()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
