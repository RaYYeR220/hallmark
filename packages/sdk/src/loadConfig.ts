/**
 * Finding and importing `hallmark.config.ts`.
 *
 * Node has stripped TypeScript types natively since 22.6 (on by default from
 * 23.6), so a plain `import()` of a `.ts` config works on a current runtime
 * with no build step and no dependency. On older Node the import fails with a
 * recognisable error, and we fall back to `tsx` if the project happens to have
 * it before giving up with an instruction the developer can actually follow.
 */

import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { validateAgentConfig } from './config.js'
import { AgentConfigError, ConfigFileError } from './errors.js'
import type { ValidationResult } from './schema.js'
import type { AgentConfig } from './types.js'

export const CONFIG_FILENAMES = [
  'hallmark.config.ts',
  'hallmark.config.mts',
  'hallmark.config.mjs',
  'hallmark.config.js',
  'hallmark.config.json',
] as const

export type LoadedConfig = {
  path: string
  config: AgentConfig
  warnings: ValidationResult['warnings']
}

/** First config file present in `dir`, or null. */
export function findConfigFile(dir: string): string | null {
  for (const filename of CONFIG_FILENAMES) {
    const candidate = join(dir, filename)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Load and validate a config.
 *
 * `target` may be a file, a directory to search, or omitted for the current
 * working directory. Throws `ConfigFileError` when nothing usable is found and
 * `AgentConfigError` when what was found does not validate.
 */
export async function loadAgentConfig(target?: string, cwd: string = process.cwd()): Promise<LoadedConfig> {
  const path = resolveConfigPath(target, cwd)
  // A JSON config *is* the config; a module has to be unwrapped first.
  const candidate = path.endsWith('.json') ? await readJson(path) : pickExport(await importModule(path), path)

  const result = validateAgentConfig(candidate)
  if (!result.ok) throw new AgentConfigError(result.errors)
  return { path, config: result.config, warnings: result.warnings }
}

function resolveConfigPath(target: string | undefined, cwd: string): string {
  if (target === undefined) {
    const found = findConfigFile(cwd)
    if (found === null) {
      throw new ConfigFileError(
        `no config found in ${cwd}. Looked for ${CONFIG_FILENAMES.join(', ')}. Run \`hallmark init\` to scaffold one.`,
      )
    }
    return found
  }

  const absolute = isAbsolute(target) ? target : resolve(cwd, target)
  if (!existsSync(absolute)) {
    throw new ConfigFileError(`no such config file: ${absolute}`)
  }
  const found = isDirectory(absolute) ? findConfigFile(absolute) : absolute
  if (found === null) {
    throw new ConfigFileError(`no config in ${absolute}. Looked for ${CONFIG_FILENAMES.join(', ')}.`)
  }
  return found
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new ConfigFileError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function importModule(path: string): Promise<unknown> {
  const url = pathToFileURL(path).href
  try {
    return (await import(/* @vite-ignore */ url)) as unknown
  } catch (err) {
    if (isMissingSdk(err)) {
      throw new ConfigFileError(
        `${path} imports @hallmark/sdk, but it is not installed in this project.\n` +
          'Run `npm install @hallmark/sdk viem` next to the config, or point --config at a config inside a project that has it.',
      )
    }
    if (!isUnknownExtension(err)) throw err
    return importWithTsx(path, err as Error)
  }
}

/** The scaffolded config imports the SDK by name; say so plainly when it is absent. */
function isMissingSdk(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ERR_MODULE_NOT_FOUND' && err.message.includes('@hallmark/sdk')
}

function isUnknownExtension(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ERR_UNKNOWN_FILE_EXTENSION' || /Unknown file extension|Cannot find module.*\.ts/i.test(err.message)
}

const TSX_ESM_API = 'tsx/esm/api'

async function importWithTsx(path: string, original: Error): Promise<unknown> {
  try {
    // Resolved through a variable so TypeScript does not require tsx to be installed.
    const specifier = TSX_ESM_API
    const tsx = (await import(/* @vite-ignore */ specifier)) as {
      tsImport: (specifier: string, parent: string) => Promise<unknown>
    }
    return await tsx.tsImport(pathToFileURL(path).href, import.meta.url)
  } catch {
    throw new ConfigFileError(
      `this Node build cannot import ${path} directly (${original.message}).\n` +
        'Either upgrade to Node 22.18+ / 23.6+, which strips TypeScript types natively, ' +
        'install tsx as a dev dependency, or rename the config to hallmark.config.mjs.',
    )
  }
}

function pickExport(module: unknown, path: string): unknown {
  if (!isRecord(module)) return module

  for (const key of ['default', 'agent', 'config'] as const) {
    const value = module[key]
    if (value !== undefined) {
      // `export default defineAgent(…)` inside a CJS interop wrapper lands one level deeper.
      if (isRecord(value) && 'default' in value && !('name' in value)) return value['default']
      return value
    }
  }

  throw new ConfigFileError(
    `${path} has no default export. Write \`export default defineAgent({ … })\`.`,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
