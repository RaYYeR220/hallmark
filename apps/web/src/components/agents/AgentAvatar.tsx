'use client'

import { useState } from 'react'

/**
 * An agent's picture, or its initials when there isn't one.
 *
 * The URL comes out of a third party's registration file, so a large share of
 * them 404, have expired TLS, or point at a domain that no longer resolves —
 * that is the ecosystem this product is about. A broken-image glyph would be
 * both ugly and misleading, so a failed load falls back to initials silently
 * and the *reason* the agent looks unreliable is reported where it belongs, in
 * the evidence panel, not by a broken picture.
 *
 * `referrerPolicy="no-referrer"` because these are attacker-choosable URLs and
 * there is no reason to tell them which agent a visitor is looking at. They
 * are never routed through the image optimiser for the same reason: that would
 * make our server fetch whatever address a stranger put in a tokenURI.
 */
export function AgentAvatar({
  src,
  name,
  className,
  fallbackClassName,
}: {
  src: string | null
  name: string
  // CSS-module lookups are `string | undefined` under noUncheckedIndexedAccess,
  // and a missing class is a styling bug, not a crash.
  className: string | undefined
  fallbackClassName: string | undefined
}) {
  const [failed, setFailed] = useState(false)
  const usable = src !== null && src.trim() !== '' && !failed

  if (!usable) {
    return (
      <span className={`${className} ${fallbackClassName}`} aria-hidden="true">
        {name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '??'}
      </span>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      aria-hidden="true"
      onError={() => setFailed(true)}
    />
  )
}
