/** Plain-text rendering for the CLI. No colour: output gets pasted into issues. */

export type Line = string

export const MARK = {
  ok: '[ ok ]',
  fail: '[fail]',
  warn: '[warn]',
  info: '[info]',
  skip: '[skip]',
} as const

export function heading(text: string): Line {
  return `\n${text}\n${'-'.repeat(text.length)}`
}

export function kv(label: string, value: string, width = 20): Line {
  return `  ${label.padEnd(width)} ${value}`
}

export function bullet(mark: string, text: string): Line {
  return `  ${mark} ${text}`
}

export function indent(text: string, spaces = 8): string {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n')
}

export function gas(value: bigint | number): string {
  return groupDigits(BigInt(value).toString())
}

export function usd(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 0.01) return `${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

export function bytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(2)} KiB`
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars)`
}

/** JSON with bigints rendered as decimal strings, so `--json` output is always parseable. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item), 2)
}

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
