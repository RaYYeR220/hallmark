'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import styles from './links.module.css'

/**
 * Copy to clipboard, with the confirmation living in the button's own label so
 * it reaches a screen reader without a separate live region.
 *
 * `navigator.clipboard` is unavailable on an insecure origin and can be denied
 * outright, so the failure path is a visible "Press ⌘C" rather than silence.
 */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  const copy = useCallback(async () => {
    if (timer.current !== null) clearTimeout(timer.current)
    try {
      await navigator.clipboard.writeText(value)
      setState('copied')
    } catch {
      setState('failed')
    }
    timer.current = setTimeout(() => setState('idle'), 1_800)
  }, [value])

  const text = state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it' : label

  return (
    <button
      type="button"
      className={`${styles.copy} ${state === 'copied' ? styles.copyDone : ''}`}
      onClick={() => {
        void copy()
      }}
      title={state === 'failed' ? 'Clipboard access was denied' : `${label}: ${value}`}
    >
      {text}
    </button>
  )
}
