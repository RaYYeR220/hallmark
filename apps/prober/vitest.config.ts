import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The prober's whole job is talking to the network; a unit test that
    // reaches it is a flake, so the suite runs with fetch stubbed and this
    // keeps an accidental real call from hanging the run.
    testTimeout: 10_000,
  },
})
