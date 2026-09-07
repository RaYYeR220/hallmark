import Link from 'next/link'
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react'

import styles from './ui.module.css'

/**
 * The shared primitives.
 *
 * All of them are server components with no state — a re-skin changes
 * `ui.module.css` and `tokens.css`, and every page follows without edit.
 */

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent' | 'info'

function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ')
}

/* --- Card ---------------------------------------------------------------- */

export function Card({
  children,
  className,
  flush,
  muted,
  as: Tag = 'section',
  ...rest
}: {
  children: ReactNode
  className?: string
  flush?: boolean
  muted?: boolean
  as?: 'section' | 'div' | 'article' | 'aside'
  id?: string
}) {
  return (
    <Tag
      className={cx(styles.card, flush && styles.cardFlush, muted && styles.cardMuted, className)}
      {...rest}
    >
      {children}
    </Tag>
  )
}

export function CardHeader({
  title,
  meta,
  children,
}: {
  title: ReactNode
  meta?: ReactNode
  children?: ReactNode
}) {
  return (
    <header className={styles.cardHeader}>
      <h3 className={styles.cardTitle}>{title}</h3>
      {meta !== undefined && <span className={styles.cardMeta}>{meta}</span>}
      {children}
    </header>
  )
}

/* --- Section heading ----------------------------------------------------- */

export function SectionHeading({
  eyebrow,
  title,
  lead,
  level = 2,
  id,
}: {
  eyebrow?: string
  title: ReactNode
  lead?: ReactNode
  level?: 1 | 2 | 3
  id?: string
}) {
  const Tag = (`h${level}` as const) satisfies 'h1' | 'h2' | 'h3'
  return (
    <div className={styles.section}>
      {eyebrow !== undefined && <span className={styles.eyebrow}>{eyebrow}</span>}
      <Tag className={styles.sectionTitle} id={id}>
        {title}
      </Tag>
      {lead !== undefined && <p className={styles.sectionLead}>{lead}</p>}
    </div>
  )
}

/* --- Badge --------------------------------------------------------------- */

const TONE_CLASS: Record<Tone, string | undefined> = {
  neutral: undefined,
  ok: styles.badgeOk,
  warn: styles.badgeWarn,
  bad: styles.badgeBad,
  accent: styles.badgeAccent,
  info: styles.badgeInfo,
}

export function Badge({
  children,
  tone = 'neutral',
  dot = false,
  title,
}: {
  children: ReactNode
  tone?: Tone
  dot?: boolean
  title?: string
}) {
  return (
    <span className={cx(styles.badge, TONE_CLASS[tone])} title={title}>
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  )
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <div className={styles.chipRow}>{children}</div>
}

/* --- Button -------------------------------------------------------------- */

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'
type ButtonSize = 'default' | 'large' | 'small'

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  default: undefined,
  primary: styles.buttonPrimary,
  ghost: styles.buttonGhost,
  danger: styles.buttonDanger,
}

const SIZE_CLASS: Record<ButtonSize, string | undefined> = {
  default: undefined,
  large: styles.buttonLarge,
  small: styles.buttonSmall,
}

export function buttonClass(
  variant: ButtonVariant = 'default',
  size: ButtonSize = 'default',
  className?: string,
): string {
  return cx(styles.button, VARIANT_CLASS[variant], SIZE_CLASS[size], className)
}

export function Button({
  variant = 'default',
  size = 'default',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
}) {
  return (
    <button className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </button>
  )
}

export function ButtonLink({
  href,
  variant = 'default',
  size = 'default',
  className,
  children,
  external = false,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string
  variant?: ButtonVariant
  size?: ButtonSize
  external?: boolean
}) {
  const classes = buttonClass(variant, size, className)
  if (external) {
    return (
      <a
        className={classes}
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        {...rest}
      >
        {children}
      </a>
    )
  }
  return (
    <Link className={classes} href={href} {...rest}>
      {children}
    </Link>
  )
}

/* --- Callout ------------------------------------------------------------- */

const CALLOUT_CLASS: Record<Tone, string | undefined> = {
  neutral: undefined,
  ok: styles.calloutOk,
  warn: styles.calloutWarn,
  bad: styles.calloutBad,
  accent: styles.calloutAccent,
  info: styles.calloutInfo,
}

export function Callout({
  title,
  tone = 'neutral',
  children,
  role,
}: {
  title?: ReactNode
  tone?: Tone
  children: ReactNode
  role?: 'status' | 'alert'
}) {
  return (
    <div className={cx(styles.callout, CALLOUT_CLASS[tone])} role={role}>
      {title !== undefined && <p className={styles.calloutTitle}>{title}</p>}
      <div className={styles.calloutBody}>{children}</div>
    </div>
  )
}

/* --- Stats --------------------------------------------------------------- */

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className={styles.statGrid}>{children}</div>
}

export function Stat({
  value,
  label,
  note,
  small,
}: {
  value: ReactNode
  label: ReactNode
  note?: ReactNode
  small?: boolean
}) {
  return (
    <div className={styles.stat}>
      <span className={cx(styles.statValue, small && styles.statValueSmall)}>{value}</span>
      <span className={styles.statLabel}>{label}</span>
      {note !== undefined && <span className={styles.statNote}>{note}</span>}
    </div>
  )
}

/* --- Definition rows ----------------------------------------------------- */

export function Rows({ children }: { children: ReactNode }) {
  return <dl className={styles.rows}>{children}</dl>
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <dt className={styles.rowLabel}>{label}</dt>
      <dd className={styles.rowValue}>{children}</dd>
    </div>
  )
}

/* --- Empty state --------------------------------------------------------- */

export function EmptyState({
  title,
  children,
  action,
}: {
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>{title}</p>
      {children !== undefined && <div className={styles.emptyBody}>{children}</div>}
      {action}
    </div>
  )
}

/* --- Meter --------------------------------------------------------------- */

export function Meter({
  percent,
  left,
  right,
  label,
}: {
  percent: number
  left: ReactNode
  right: ReactNode
  label: string
}) {
  const clamped = Math.max(0, Math.min(100, percent))
  const fillClass =
    clamped >= 90 ? styles.meterFillBad : clamped >= 70 ? styles.meterFillWarn : undefined

  return (
    <div className={styles.meter}>
      <div
        className={styles.meterTrack}
        role="meter"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={cx(styles.meterFill, fillClass)} style={{ width: `${clamped}%` }} />
      </div>
      <div className={styles.meterLabels}>
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  )
}

/* --- Skeleton ------------------------------------------------------------ */

export function Skeleton({ height = '1rem', width = '100%' }: { height?: string; width?: string }) {
  return <div className={styles.skeleton} style={{ height, width }} aria-hidden="true" />
}

/* --- Code ---------------------------------------------------------------- */

export function CodeBlock({ children, wrap }: { children: ReactNode; wrap?: boolean }) {
  return <code className={cx(styles.code, wrap && styles.codeWrap)}>{children}</code>
}

/* --- Misc ---------------------------------------------------------------- */

export function Divider() {
  return <hr className={styles.divider} />
}

export function InlineList({ children }: { children: ReactNode }) {
  return <ul className={styles.inlineList}>{children}</ul>
}

/**
 * Where a number came from. Rendered next to anything that is not a direct
 * chain read, because "we cached this" and "this is live" must never look the
 * same on screen.
 */
export function SourceNote({ children }: { children: ReactNode }) {
  return <p className={styles.sourceNote}>{children}</p>
}

export { cx }
