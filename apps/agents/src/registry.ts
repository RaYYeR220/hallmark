import { rebalancerAgent } from './agents/rebalancer/index.js'
import { gridAgent } from './agents/grid/index.js'
import { yieldAgent } from './agents/yield/index.js'
import { healthAgent } from './agents/health/index.js'
import { securityAgent } from './agents/security/index.js'
import type { AgentDefinition } from './runtime/types.js'

/**
 * The five agents, in the order the marketplace should show them.
 *
 * Four categories the contest names, plus the token-safety agent. They share
 * one runtime and one deployment; what differs between them is the domain
 * logic, not the plumbing, which is the point of building it this way.
 */
export const AGENTS: readonly AgentDefinition[] = [
  rebalancerAgent,
  gridAgent,
  yieldAgent,
  healthAgent,
  securityAgent,
]

export const AGENT_SLUGS = AGENTS.map((agent) => agent.manifest.slug)

export function findAgent(slug: string): AgentDefinition | undefined {
  return AGENTS.find((agent) => agent.manifest.slug === slug)
}

export {
  rebalancerAgent,
  gridAgent,
  yieldAgent,
  healthAgent,
  securityAgent,
}
