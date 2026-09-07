import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Every test in the suite is offline: chains, HTTP endpoints and DNS are
    // injected. Nothing here broadcasts a transaction or needs a funded key.
    testTimeout: 20_000,
  },
})
