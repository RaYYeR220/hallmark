import type { Issue } from './schema.js'

/** Base class so a caller can `catch (e) { if (e instanceof HallmarkError) … }`. */
export class HallmarkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** Thrown by `defineAgent` when the config does not validate. Carries every issue, not just the first. */
export class AgentConfigError extends HallmarkError {
  readonly issues: Issue[]

  constructor(issues: Issue[]) {
    super(formatIssues(issues))
    this.issues = issues
  }
}

/** Thrown when the caller asked for a chain the SDK does not support. */
export class UnsupportedChainError extends HallmarkError {}

/** Thrown when a config file could not be found, imported or read as a config. */
export class ConfigFileError extends HallmarkError {}

/** Thrown when publishing cannot safely decide between minting and updating. */
export class PublishError extends HallmarkError {}

/** Thrown by the probe layer when a URL is refused before any request is made. */
export class BlockedUrlError extends HallmarkError {
  readonly url: string
  readonly reason: string

  constructor(url: string, reason: string) {
    super(`refused to fetch ${url}: ${reason}`)
    this.url = url
    this.reason = reason
  }
}

export function formatIssues(issues: Issue[]): string {
  if (issues.length === 0) return 'agent config is invalid'
  const lines = issues.map((issue) => {
    const where = issue.path === '' ? '' : `${issue.path}: `
    const hint = issue.hint === undefined ? '' : `\n      ${issue.hint}`
    return `  - ${where}${issue.message}${hint}`
  })
  const noun = issues.length === 1 ? 'problem' : 'problems'
  return `agent config has ${issues.length} ${noun}:\n${lines.join('\n')}`
}
