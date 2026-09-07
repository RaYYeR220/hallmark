/**
 * The declarative surface. Everything else in the package takes the config
 * this module produces.
 */

import { AgentConfigError } from './errors.js'
import { agentUriBytes, buildRegistrationFile } from './registration.js'
import { checkAgentConfig, type ValidationResult } from './schema.js'
import type { AgentConfig } from './types.js'

/**
 * Validate an untrusted value into an `AgentConfig`, including the checks that
 * need the compiled registration file (card size).
 *
 * Never throws. Use this when you want to report on a config; use
 * `defineAgent` when you want to fail loudly.
 */
export function validateAgentConfig(input: unknown): ValidationResult {
  return checkAgentConfig(input, {
    sizeOf: (config) => agentUriBytes(buildRegistrationFile(config)),
  })
}

/**
 * Declare an agent.
 *
 * ```ts
 * export default defineAgent({
 *   name: 'Venus Health Guard',
 *   // …
 * })
 * ```
 *
 * Validates eagerly and throws `AgentConfigError` listing every problem, not
 * just the first — importing a broken `hallmark.config.ts` should tell you
 * everything that is wrong with it in one go. Warnings are not fatal here;
 * `hallmark validate` prints them.
 */
export function defineAgent(config: AgentConfig): AgentConfig {
  const result = validateAgentConfig(config)
  if (!result.ok) throw new AgentConfigError(result.errors)
  return Object.freeze(result.config)
}
