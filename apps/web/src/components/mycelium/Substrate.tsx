import {
  growSubstrate,
  SUBSTRATE_VIEWBOX,
  type ColonyPath,
} from '@/lib/colony'

import styles from './mycelium.module.css'

/**
 * The colony every page sits on.
 *
 * Rendered on the server from a fixed seed, so it is the same organism on
 * every route — the pages read as windows onto one substrate rather than each
 * carrying its own ornament. No JavaScript is involved: the SVG is in the HTML,
 * the drift and the pulses are CSS, and with motion reduced it settles into a
 * still drawing that was designed to work as one.
 *
 * `aria-hidden` because it carries no information a screen reader needs — every
 * fact it gestures at is stated in words on the surfaces above it.
 */

const HERO_DEPTH = 5

export function Substrate() {
  const colony = growSubstrate()

  // The three travelling signals run along real hyphae rather than invented
  // curves, so a pulse always traces a path that is actually drawn.
  const trunks = colony.paths.filter((path) => path.depth >= HERO_DEPTH).slice(0, 24)

  return (
    <div className={styles.substrate} aria-hidden="true">
      <svg
        className={styles.substrateSvg}
        viewBox={`0 0 ${SUBSTRATE_VIEWBOX.w} ${SUBSTRATE_VIEWBOX.h}`}
        preserveAspectRatio="xMidYMid slice"
        focusable="false"
      >
        <g>
          {colony.paths.map((path, index) => (
            <path
              key={`h${index}`}
              className={path.depth > HERO_DEPTH ? styles.hyStrong : styles.hy}
              d={path.d}
              strokeWidth={path.w.toFixed(2)}
              opacity={Math.min(0.95, 0.34 + path.depth * 0.09).toFixed(2)}
            />
          ))}
        </g>

        <g>
          {colony.fruits.map((fruit, index) => (
            <circle
              key={`f${index}`}
              className={fruitClass(index)}
              cx={fruit.x.toFixed(1)}
              cy={fruit.y.toFixed(1)}
              r={fruit.r.toFixed(2)}
            />
          ))}
        </g>

        {trunks.map((path, index) => (
          <path
            key={`p${index}`}
            className={`${styles.pulse} ${pulseClass(index)}`}
            d={path.d}
            strokeWidth="1.6"
            style={{ animationDelay: `${(-(index * 0.83)).toFixed(2)}s` }}
          />
        ))}
      </svg>
    </div>
  )
}

/**
 * Most fruiting bodies in the background are dormant grey. The lit minority is
 * the point of the image, and the ratio is deliberately unflattering: on this
 * registry the agents that answer really are the exception.
 */
function fruitClass(index: number): string {
  if (index % 5 === 0) return styles.fruitProbe ?? ''
  if (index % 7 === 0) return styles.fruitJob ?? ''
  if (index % 6 === 0) return styles.fruitAttest ?? ''
  return styles.fruitDormant ?? ''
}

function pulseClass(index: number): string {
  const lane = index % 3
  if (lane === 0) return styles.pulseProbe ?? ''
  if (lane === 1) return styles.pulseJob ?? ''
  return styles.pulseAttest ?? ''
}

export type { ColonyPath }
