/**
 * Per-session persisted Evidence view preferences (SPEC-05 §9.5, D-140): only the stable
 * filter set and the optional precise focus triple survive reopens — never search, scroll,
 * expansion, details, previews or the return stack. The store is scoped by the conversation
 * slot registration that declares it.
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** The persisted preference shape (versioned schema `dsh.evidence.view/v1`; the engine's
 * draft copy is mutable — actions write through it, snapshots stay readonly). */
export interface EvidenceViewState {
  schemaVersion: 'dsh.evidence.view/v1'
  subtypes: string[]
  focus: {
    snapshotDigest: string
    objectType: string
    objectId: string
  } | null
}

/** Declared write surface for the preference store. */
type EvidenceViewActions = {
  setFilter: (draft: EvidenceViewState, subtypes: readonly string[]) => void
  setFocus: (draft: EvidenceViewState, focus: EvidenceViewState['focus']) => void
}

/** Declares the per-session Evidence view preference store (persist `dsh.evidence.view.v1`). */
export function createEvidenceViewStore(): EngineStoreHandle<EvidenceViewState, EvidenceViewActions> {
  return defineStore({
    init: (): EvidenceViewState => ({ schemaVersion: 'dsh.evidence.view/v1', subtypes: [], focus: null }),
    persist: 'dsh.evidence.view.v1',
    actions: {
      setFilter: (draft, subtypes) => { draft.subtypes = [...subtypes] },
      setFocus: (draft, focus) => { draft.focus = focus },
    },
  })
}
