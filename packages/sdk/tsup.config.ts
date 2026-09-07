import { defineConfig } from 'tsup'

const shared = {
  format: ['esm'] as const,
  target: 'es2022',
  platform: 'node' as const,
  sourcemap: true,
  treeshake: true,
  // viem is the peer dependency: the host app must resolve exactly one copy of
  // it, or `WalletClient` instances stop being structurally compatible.
  external: ['viem'],
  // @hallmark/core is a workspace package that is not published on its own, so
  // it is inlined here rather than left as a runtime import nobody can install.
  noExternal: ['@hallmark/core'],
}

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    dts: true,
    clean: true,
  },
  {
    ...shared,
    entry: { cli: 'src/cli/index.ts' },
    dts: false,
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
  },
])
