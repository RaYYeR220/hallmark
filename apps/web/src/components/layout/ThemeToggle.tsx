'use client'

import { useEffect, useState } from 'react'

import styles from './layout.module.css'

/**
 * Light / dark / system, in that cycle.
 *
 * The choice is stamped on the root element as `data-theme` and remembered in
 * localStorage; "system" removes the attribute so the media query in
 * tokens.css takes over again. The inline script in the document head applies
 * the stored value before first paint, so this component only ever reflects a
 * decision that has already been made — it never causes a flash.
 */

type Theme = 'light' | 'dark' | 'system'

const ORDER: Theme[] = ['system', 'light', 'dark']
const STORAGE_KEY = 'hallmark-theme'

const LABEL: Record<Theme, string> = {
  system: 'Match system',
  light: 'Light',
  dark: 'Dark',
}

const GLYPH: Record<Theme, string> = {
  system: '◐',
  light: '☀',
  dark: '☾',
}

function readStored(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // Private mode, or storage disabled. Falls back to system.
  }
  return 'system'
}

function apply(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Nothing to do — the attribute is already applied for this page view.
  }
}

export function ThemeToggle() {
  // `null` until mounted so the server and the first client render agree; the
  // real value only exists in the browser.
  const [theme, setTheme] = useState<Theme | null>(null)

  useEffect(() => {
    setTheme(readStored())
  }, [])

  const current = theme ?? 'system'
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'system'

  return (
    <button
      type="button"
      className={styles.themeToggle}
      aria-label={`Colour theme: ${LABEL[current]}. Switch to ${LABEL[next]}.`}
      title={`Theme: ${LABEL[current]}`}
      onClick={() => {
        apply(next)
        setTheme(next)
      }}
    >
      <span aria-hidden="true">{GLYPH[current]}</span>
    </button>
  )
}

/**
 * Applied before first paint, from the document head.
 *
 * Kept as a string rather than a component so it can be injected with
 * `dangerouslySetInnerHTML` in the layout — the one place in the app where
 * that is the correct tool, because the alternative is a visible flash of the
 * wrong theme on every navigation.
 */
export const THEME_BOOTSTRAP_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    if (stored === 'light' || stored === 'dark') {
      document.documentElement.setAttribute('data-theme', stored);
    }
  } catch (e) {}
})();
`.trim()
