
import type { SupportedChainId } from '@hallmark/core'

import { publicClientFor } from '../chain/clients.js'
import { rpcUrlFor } from './config.js'
import type { SkillContext } from './types.js'
import type { ChainClient } from '../chain/clients.js'

/**
 * The chain client an agent should read through.
 *
 * The context already carries one, and using it is what makes an agent
 * testable: a fixture can hand over a fake and be sure every read went through
 * it. An agent that builds its own client silently reaches the network from
 * inside a test that was meant to be hermetic, and the test then passes or
 * fails on what BNB Chain happened to look like.
 *
 * A caller asking for a chain other than the context's gets a real client for
 * that chain, because there is nothing else it could sensibly get.
 */
export function clientFor(ctx: SkillContext, chainId: SupportedChainId): ChainClient {
  if (chainId === ctx.chainId) return ctx.client
  return publicClientFor(chainId, rpcUrlFor(ctx.config, chainId))
}
