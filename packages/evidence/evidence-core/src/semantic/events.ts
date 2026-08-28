/** Declaration-merged log-only session event for evidence model requests (SPEC-04 §6.1, D-153). */

import type { SessionEventRefV1 } from '../types.ts'

/** Result-side envelope identity carried by every dispatched model request (D-153/D-164). */
export interface EvidenceModelRequestEventData {
  readonly schemaVersion: 'animalge.evidence.model-request/v1'
  readonly modelCallId: string
  readonly graphId: string
  readonly attemptId: string
  /** v0.1 closed single purpose (SPEC-04 §7.1); SPEC-06 adds its own by versioned increment. */
  readonly purpose: 'candidate-semantics'
  /** Canonical, de-keyed model-visible request bytes — the only input-byte copy (D-164). */
  readonly requestPayload: unknown
  readonly projectionDigest: string
  readonly projectionPolicyRevision: string
  readonly extractorRevision: string
  readonly promptRevision: string
  readonly compilerRevision: string
  readonly schemaRevision: string
  readonly sourceRefs: readonly SessionEventRefV1[]
  readonly targetNextSeqExclusive: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Durable, non-surface record of one evidence model request persisted strictly before
     * dispatch (SPEC-04 §6). Log-only: it is a compiler-internal auxiliary call, never a
     * graph Run and never capture input (design §8.3 / detailed contract §3.6).
     */
    'evidence/model-request': EvidenceModelRequestEventData
  }
}
