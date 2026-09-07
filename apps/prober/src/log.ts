/**
 * Logging goes to stderr, always. stdout belongs to `--json`, so a sweep can
 * be piped straight into `jq` while still showing progress on the terminal.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export type Logger = {
  level: LogLevel
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
  child(prefix: string): Logger
}

export type LoggerOptions = {
  level?: LogLevel
  /** Emit one JSON object per line instead of human text. */
  json?: boolean
  prefix?: string
  sink?: (line: string) => void
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info'
  const json = options.json ?? false
  const prefix = options.prefix ?? ''
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`))

  const emit = (at: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[at] < ORDER[level]) return
    const text = prefix === '' ? message : `${prefix} ${message}`
    if (json) {
      sink(JSON.stringify({ at, ts: new Date().toISOString(), msg: text, ...fields }))
      return
    }
    const tail = fields === undefined || Object.keys(fields).length === 0 ? '' : ` ${formatFields(fields)}`
    sink(`${badge(at)} ${text}${tail}`)
  }

  return {
    level,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (childPrefix) =>
      createLogger({
        level,
        json,
        prefix: prefix === '' ? childPrefix : `${prefix} ${childPrefix}`,
        sink,
      }),
  }
}

export const silentLogger: Logger = createLogger({ level: 'error', sink: () => undefined })

function badge(level: LogLevel): string {
  switch (level) {
    case 'debug':
      return '  ·'
    case 'info':
      return '  ›'
    case 'warn':
      return '  !'
    case 'error':
      return '  ✗'
  }
}

function formatFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ')
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value.includes(' ') ? JSON.stringify(value) : value
  if (typeof value === 'bigint') return value.toString()
  if (value === null || value === undefined) return '-'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
