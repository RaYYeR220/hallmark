import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Every test in the suite runs against fixtures or injected fakes. Nothing
    // here opens a socket, and nothing here needs a key.
    testTimeout: 20_000,
  },
})
