import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { runCli } from '../src/cli/index.js'
import { keyFlagInArgv, normalizePrivateKey } from '../src/cli/wallet.js'
import type { AgentWalletClient } from '../src/clients.js'
import { OWNER, validConfig } from './fixtures.js'

function capture() {
  const out: string[] = []
  const err: string[] = []
  return {
    io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    out,
    err,
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  }
}

async function tempDirWithConfig(config: unknown = validConfig()): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hallmark-cli-'))
  await writeFile(join(dir, 'hallmark.config.json'), JSON.stringify(config, null, 2), 'utf8')
  return dir
}

/** A wallet that fails the test if anything ever asks it to sign. */
function refusingWallet(chainId: number): AgentWalletClient {
  return {
    account: { address: OWNER },
    chain: { id: chainId },
    writeContract: async () => {
      throw new Error('the CLI broadcast during a dry run')
    },
  }
}

describe('argument handling', () => {
  it('prints usage and fails when no command is given', async () => {
    const io = capture()
    expect(await runCli([], { io: io.io })).toBe(2)
    expect(io.stdout()).toMatch(/Usage/)
  })

  it('rejects an unknown command', async () => {
    const io = capture()
    expect(await runCli(['deploy'], { io: io.io })).toBe(2)
    expect(io.stderr()).toMatch(/unknown command "deploy"/)
  })

  it('prints the version', async () => {
    const io = capture()
    expect(await runCli(['--version'], { io: io.io })).toBe(0)
    expect(io.stdout()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('refuses a private key on the command line', async () => {
    const io = capture()
    expect(await runCli(['publish', '--private-key', '0xdead'], { io: io.io })).toBe(2)
    expect(io.stderr()).toMatch(/refusing to read a private key/)
  })

  it.each(['--private-key', '--pk', '--key', '--mnemonic'])('detects %s anywhere in argv', (flag) => {
    expect(keyFlagInArgv(['publish', '--chain', 'bsc', flag, 'x'])).toBe(flag)
  })

  it('accepts a key that is only in the environment', () => {
    expect(normalizePrivateKey(`0x${'ab'.repeat(32)}`)).toBe(`0x${'ab'.repeat(32)}`)
    expect(() => normalizePrivateKey('hunter2')).toThrow(/32-byte hex/)
  })
})

describe('validate', () => {
  let dir: string
  beforeAll(async () => {
    dir = await tempDirWithConfig()
  })

  it('passes a good config', async () => {
    const io = capture()
    expect(await runCli(['validate'], { cwd: dir, io: io.io })).toBe(0)
    expect(io.stdout()).toMatch(/is a valid agent config/)
  })

  it('reports every problem in a bad config and exits non-zero', async () => {
    const bad = await tempDirWithConfig({ ...validConfig(), services: { web: 'https://example.com' }, skills: [] })
    const io = capture()
    expect(await runCli(['validate'], { cwd: bad, io: io.io })).toBe(1)
    expect(io.stderr()).toMatch(/no a2a or mcp endpoint/)
    expect(io.stderr()).toMatch(/declares no skills/)
  })

  it('emits machine-readable output with --json', async () => {
    const io = capture()
    await runCli(['validate', '--json'], { cwd: dir, io: io.io })
    const parsed = JSON.parse(io.stdout()) as { ok: boolean; chainId: number }
    expect(parsed.ok).toBe(true)
    expect(parsed.chainId).toBe(97)
  })

  it('says where to look when there is no config at all', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'hallmark-empty-'))
    const io = capture()
    expect(await runCli(['validate'], { cwd: empty, io: io.io })).toBe(1)
    expect(io.stderr()).toMatch(/hallmark init/)
  })
})

describe('init', () => {
  it('scaffolds a config and refuses to clobber it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hallmark-init-'))
    const io = capture()
    expect(await runCli(['init'], { cwd: dir, io: io.io })).toBe(0)

    const written = await readFile(join(dir, 'hallmark.config.ts'), 'utf8')
    expect(written).toMatch(/defineAgent/)
    expect(written).toMatch(/requestFrom: 'hallmark'/)

    const second = capture()
    expect(await runCli(['init'], { cwd: dir, io: second.io })).toBe(1)
    expect(second.stderr()).toMatch(/--force/)
  })
})

describe('publish', () => {
  it('is a dry run by default and never signs', async () => {
    const dir = await tempDirWithConfig()
    const io = capture()
    const code = await runCli(['publish', '--no-dedupe'], {
      cwd: dir,
      io: io.io,
      env: {},
      walletClient: refusingWallet(97),
    })

    expect(code).toBe(0)
    const text = io.stdout()
    expect(text).toMatch(/DRY RUN/)
    expect(text).toMatch(/phase 1\s+register\(agentURI\)/)
    expect(text).toMatch(/phase 2\s+setAgentURI/)
    expect(text).toMatch(/data\s+0x/)
    expect(text).toMatch(/"type": "https:\/\/eips.ethereum.org\/EIPS\/eip-8004#registration-v1"/)
    expect(io.stderr()).toBe('')
  })

  it('marks the dry run explicitly in --json output', async () => {
    const dir = await tempDirWithConfig()
    const io = capture()
    await runCli(['publish', '--json', '--no-dedupe'], {
      cwd: dir,
      io: io.io,
      env: {},
      walletClient: refusingWallet(97),
    })
    const parsed = JSON.parse(io.stdout()) as { dryRun: boolean; broadcast: boolean; calls: unknown[] }
    expect(parsed.dryRun).toBe(true)
    expect(parsed.broadcast).toBe(false)
    expect(parsed.calls.length).toBeGreaterThan(0)
  })

  it('shows the validation request it would open when the config opts in', async () => {
    const dir = await tempDirWithConfig(validConfig({ validation: { requestFrom: 'hallmark' } }))
    const io = capture()
    await runCli(['publish', '--no-dedupe'], { cwd: dir, io: io.io, env: {}, walletClient: refusingWallet(97) })
    expect(io.stdout()).toMatch(/validation request/)
    expect(io.stdout()).toMatch(/0x9ff98B99B6B250b3a23961EA932F4ef147B909ab/)
    expect(io.stdout()).toMatch(/Not authorized/)
  })

  it('notes that the owner is a placeholder when no address is known', async () => {
    const dir = await tempDirWithConfig()
    const io = capture()
    await runCli(['publish', '--no-dedupe'], { cwd: dir, io: io.io, env: {} })
    expect(io.stdout()).toMatch(/no publisher address known/)
    expect(io.stdout()).toContain('0x0000000000000000000000000000000000000000')
  })

  it('uses --from for the dry run when one is given', async () => {
    const dir = await tempDirWithConfig()
    const io = capture()
    await runCli(['publish', '--no-dedupe', '--from', OWNER], { cwd: dir, io: io.io, env: {} })
    expect(io.stdout()).toContain(OWNER)
    expect(io.stdout()).not.toMatch(/no publisher address known/)
  })
})

describe('doctor', () => {
  it('reports each endpoint and exits non-zero when the agent is not hireable', async () => {
    const dir = await tempDirWithConfig()
    const io = capture()
    const code = await runCli(['doctor', '--timeout', '250'], {
      cwd: dir,
      io: io.io,
      env: {},
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch,
    })
    expect(code).toBe(1)
    expect(io.stdout()).toMatch(/verdict\s+unhireable/)
    expect(io.stdout()).toMatch(/nothing can call this agent/)
  })
})

describe('--dry-run', () => {
  it('is accepted explicitly even though it is the default', async () => {
    const dir = await tempDirWithConfig()
    const io = capture()
    expect(
      await runCli(['publish', '--dry-run', '--no-dedupe'], {
        cwd: dir,
        io: io.io,
        env: {},
        walletClient: refusingWallet(97),
      }),
    ).toBe(0)
    expect(io.stdout()).toMatch(/DRY RUN/)
  })

  it('refuses to be combined with --broadcast', async () => {
    const io = capture()
    expect(await runCli(['publish', '--dry-run', '--broadcast'], { io: io.io, env: {} })).toBe(2)
    expect(io.stderr()).toMatch(/contradict each other/)
  })
})

describe('config loading', () => {
  it('surfaces a config that fails to import as a message, not a stack trace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hallmark-bare-'))
    await writeFile(
      join(dir, 'hallmark.config.mjs'),
      "import x from 'definitely-not-a-real-package-xyz'\nexport default x\n",
      'utf8',
    )

    const io = capture()
    expect(await runCli(['validate'], { cwd: dir, io: io.io })).toBe(1)
    expect(io.stderr()).toMatch(/^error: /m)
    expect(io.stderr()).toMatch(/definitely-not-a-real-package-xyz/)
  })

  it('rejects a config module with no default export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hallmark-nodefault-'))
    await writeFile(join(dir, 'hallmark.config.mjs'), 'export const something = 1\n', 'utf8')

    const io = capture()
    expect(await runCli(['validate'], { cwd: dir, io: io.io })).toBe(1)
    expect(io.stderr()).toMatch(/no default export/)
  })

  it('reads a config from an explicit path outside the working directory', async () => {
    const dir = await tempDirWithConfig()
    const io = capture()
    expect(
      await runCli(['validate', '--config', join(dir, 'hallmark.config.json')], {
        cwd: tmpdir(),
        io: io.io,
      }),
    ).toBe(0)
  })
})
