import { fileURLToPath } from 'node:url'

import type { NextConfig } from 'next'

/**
 * The monorepo root. Without this, Next walks up until it finds any lockfile
 * and can land outside the repository entirely, which breaks file tracing on
 * a deploy in a way that only shows up at runtime.
 */
const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The Altana SDK and viem ship ESM with deep conditional exports; keeping them
 * out of the server bundle avoids re-bundling a package that already resolves
 * correctly at runtime.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: workspaceRoot,
  serverExternalPackages: ['@altananetwork/sdk', 'porto'],
  images: {
    // Agent card images are arbitrary third-party URLs pulled from tokenURIs.
    // They are rendered with a plain <img> and a referrer policy rather than
    // through next/image, so nothing here needs an allowlist.
    unoptimized: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
}

export default nextConfig
