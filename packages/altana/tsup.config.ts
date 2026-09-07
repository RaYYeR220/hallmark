import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'es2022',
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // The Altana SDK is ESM-only and viem is large; both stay external so the
  // app resolves a single copy.
  external: ['@altananetwork/sdk', 'viem'],
})
