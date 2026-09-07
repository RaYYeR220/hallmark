import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Nothing in the suite needs funds or a relay; the two tests that touch the
    // network are read-only eth_calls against public RPCs.
    testTimeout: 30_000,
  },
})
