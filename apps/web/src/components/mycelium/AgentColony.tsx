import { COLONY_VIEWBOX, growAgentColony, type AgentColonyInput } from '@/lib/colony'

import styles from './mycelium.module.css'

/**
 * One agent, grown from its own record.
 *
 * The shape is not chosen — it is derived. Branch density is the size of the
 * contract allowlist, reach is the evidence score, roots are declared
 * endpoints, and every lit fruiting body is a job that actually settled. Two
 * agents side by side are therefore comparable before you read a number, and
 * an agent nobody has ever probed grows something visibly stunted.
 *
 * Server-rendered from a deterministic seed, so it appears in the HTML, needs
 * no JavaScript, and cannot hydrate into a different drawing.
 *
 * Decorative by ARIA: everything it encodes is also stated in text beside it.
 */

export type AgentColonyProps = AgentColonyInput & {
  size?: 'small' | 'default' | 'large'
  /** Draw a travelling pulse along the longest hypha. Off in dense lists. */
  animated?: boolean
}

export function AgentColony({
  size = 'default',
  animated = false,
  ...input
}: AgentColonyProps) {
  const colony = growAgentColony(input)

  const sizeClass =
    size === 'small' ? styles.colonySmall : size === 'large' ? styles.colonyLarge : ''

  // The pulse traces a real trunk, not an invented curve.
  const trunk = animated ? colony.paths.find((path) => path.depth >= 3) : undefined

  return (
    <svg
      className={`${styles.colony} ${sizeClass} ${colony.barren ? styles.barren : ''}`}
      viewBox={`0 0 ${COLONY_VIEWBOX.w} ${COLONY_VIEWBOX.h}`}
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
      focusable="false"
    >
      {colony.paths.map((path, index) => (
        <path
          key={`h${index}`}
          className={styles.hyStrong}
          d={path.d}
          strokeWidth={path.w.toFixed(2)}
          opacity={Math.min(0.95, 0.42 + path.depth * 0.11).toFixed(2)}
        />
      ))}

      {colony.fruits.map((fruit, index) => {
        // Lit fruits are settled jobs, cycling through the three signals so a
        // busy agent shows probe, job and attestation together. Everything
        // past the settled count stays dormant grey: an agent cannot look
        // productive without having been.
        const lit = index < colony.litFruits
        const cls = lit ? litClass(index) : (styles.fruitDormant ?? '')
        return (
          <circle
            key={`f${index}`}
            className={cls}
            cx={fruit.x.toFixed(1)}
            cy={fruit.y.toFixed(1)}
            r={(fruit.r * (lit ? 1.3 : 1)).toFixed(2)}
          />
        )
      })}

      {trunk !== undefined && (
        <path
          className={`${styles.pulse} ${styles.pulseProbe}`}
          d={trunk.d}
          strokeWidth="1.5"
          strokeDasharray="14 400"
        />
      )}
    </svg>
  )
}

function litClass(index: number): string {
  const lane = index % 3
  if (lane === 0) return styles.fruitProbe ?? ''
  if (lane === 1) return styles.fruitJob ?? ''
  return styles.fruitAttest ?? ''
}

/**
 * The colour mapping, stated rather than left to be inferred.
 *
 * Shown once wherever colonies first appear on a surface. Without it the three
 * signals are just colours; with it they are a key the reader carries to every
 * other page.
 */
export function ColonyLegend() {
  return (
    <ul className={styles.legend}>
      <li className={styles.legendItem}>
        <span className={`${styles.legendSwatch} ${styles.legendProbe}`} aria-hidden="true" />
        Probe
      </li>
      <li className={styles.legendItem}>
        <span className={`${styles.legendSwatch} ${styles.legendJob}`} aria-hidden="true" />
        Settled job
      </li>
      <li className={styles.legendItem}>
        <span className={`${styles.legendSwatch} ${styles.legendAttest}`} aria-hidden="true" />
        Attestation
      </li>
    </ul>
  )
}
