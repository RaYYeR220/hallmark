import type { ReactNode } from 'react'

import styles from './ui.module.css'

/**
 * The heading a loading fallback shows.
 *
 * Looks exactly like `SectionHeading` at level 1 but renders a `<p>`, on
 * purpose. A streamed page ships its loading fallback and its real content in
 * the same HTML response, so a fallback that used `<h1>` would put two of them
 * in the served markup — which a screen reader announces and a crawler counts,
 * even though only one survives in the live DOM.
 *
 * `aria-busy` on the container tells assistive technology the region is still
 * being filled rather than finished and empty.
 */
export function LoadingTitle({
  eyebrow,
  title,
  lead,
}: {
  eyebrow?: string
  title: ReactNode
  lead?: ReactNode
}) {
  return (
    <div className={styles.section} aria-busy="true">
      {eyebrow !== undefined && <span className={styles.eyebrow}>{eyebrow}</span>}
      <p className={styles.sectionTitle} style={{ fontSize: 'var(--fs-2xl)' }}>
        {title}
      </p>
      {lead !== undefined && <p className={styles.sectionLead}>{lead}</p>}
    </div>
  )
}
