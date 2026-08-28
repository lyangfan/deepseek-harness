/** Session-level "AI candidate extraction" switch: the authoritative store record (SPEC-04 §4.3, D-118/D-155). */

import type { EvidenceGraphId } from '../types.ts'
import type { EvidenceStore } from '../store.ts'

/** Default state: enabled whenever evidenceModel is configured (D-118). */
export const SEMANTIC_SWITCH_DEFAULT = true

/**
 * Read the switch state for one Graph. Absence of a record means the default
 * (enabled); the runtime only consults this when the semantic channel is configured.
 */
export function semanticSwitchEnabled(store: EvidenceStore, graphId: EvidenceGraphId): boolean {
  return store.semanticSwitchFor(graphId)?.enabled ?? SEMANTIC_SWITCH_DEFAULT
}

/** Flip the switch; the single-record update is the only mutation path (§10.1). */
export async function setSemanticSwitchEnabled(store: EvidenceStore, graphId: EvidenceGraphId, enabled: boolean): Promise<void> {
  await store.updateSemanticSwitch(graphId, current => ({
    recordVersion: 'animalge.semantic-switch/v1',
    graphId,
    enabled,
    updatedAt: Date.now(),
    ...(current === undefined ? {} : { updatedAt: Date.now() }),
  }))
}
