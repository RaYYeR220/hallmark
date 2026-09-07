/** The file `hallmark init` writes. Kept as a string so the CLI has no asset to resolve. */

export const CONFIG_TEMPLATE = `import { defineAgent } from '@hallmark/sdk'

export default defineAgent({
  name: 'My Agent',
  description: 'One or two sentences a human can read before deciding to hire this agent.',
  image: 'https://example.com/agent.png',

  // rebalancing | grid | yield | health-factor | security | research | other
  category: 'other',
  chain: 'bsc-testnet',

  // At least one of a2a / mcp is required: an agent with only a web page
  // cannot be called by another agent.
  services: {
    a2a: 'https://example.com/.well-known/agent-card.json',
    mcp: 'https://example.com/mcp',
    web: 'https://example.com',
  },

  skills: [
    {
      id: 'do-the-thing',
      name: 'Do the thing',
      description: 'What this skill does, what it needs, and what it returns.',
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string' } },
        required: ['target'],
      },
      outputSchema: {
        type: 'object',
        properties: { result: { type: 'string' } },
        required: ['result'],
      },
    },
  ],

  pricing: { model: 'free' },
  trust: ['reputation'],

  // Ask Hallmark to validate this agent on-chain once it is published.
  // The Validation Registry only accepts a request from the agent's owner or
  // operator, so this is strictly opt-in and nobody can do it on your behalf.
  validation: { requestFrom: 'hallmark' },
})
`

export const GITIGNORE_HINT = `# never commit the key you publish with
.env
.env.local
`
