import { Badge, type Tone } from '@/components/ui'
import type { EvidenceVerdict } from '@/lib/evidence'

/**
 * The evidence verdict, everywhere it appears.
 *
 * Two things are always shown together: the claim and who is making it.
 * "Probed, live" from Hallmark's own hook is a different kind of statement
 * from "Reachable" according to a third-party index, and collapsing them into
 * one green tick would be exactly the sort of laundering this product exists
 * to replace.
 */

const TONE: Record<EvidenceVerdict['tone'], Tone> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  neutral: 'neutral',
}

const SOURCE_LABEL: Record<EvidenceVerdict['source'], string> = {
  hallmark: 'Hallmark probe',
  index: '8004scan',
  none: 'no observation',
}

export function EvidenceBadge({
  verdict,
  showSource = true,
}: {
  verdict: EvidenceVerdict
  showSource?: boolean
}) {
  return (
    <Badge tone={TONE[verdict.tone]} dot title={verdict.detail}>
      {verdict.label}
      {showSource && verdict.source !== 'none' && (
        <span style={{ opacity: 0.7 }}>· {SOURCE_LABEL[verdict.source]}</span>
      )}
    </Badge>
  )
}

export function evidenceSourceLabel(source: EvidenceVerdict['source']): string {
  return SOURCE_LABEL[source]
}
