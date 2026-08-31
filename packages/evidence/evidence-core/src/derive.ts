/** SPEC-05 §11.2 status derivation: the single implementation of the pending-increment and
 * freshness projections. Shared by the issue owner module (unavailable/stale conditions) and the
 * read service; deterministic from Store facts only. */

import type { EvidenceGraphId, Sha256Digest } from './types.ts'
import type { EvidenceStore } from './store.ts'

export type PendingIncrement = 'none' | 'capture_pending' | 'compile_queued' | 'compiling' | 'retrying' | 'failed'
export type Freshness = 'current' | 'updating' | 'stale' | 'unavailable'

/** Terminal-no-retry marker used by the outbox scheduler (failAttempt writes MAX_SAFE_INTEGER). */
const TERMINAL_RETRY_NOT_BEFORE = Number.MAX_SAFE_INTEGER

export interface GraphStatusFacts {
  readonly hasValidSnapshot: boolean
  readonly headSnapshotDigest: Sha256Digest | null
  readonly headRevision: number
  readonly coveredWatermark: number
  readonly pendingTarget: number | null
  readonly pending: PendingIncrement
  readonly freshness: Freshness
}

/**
 * Pending increment (§11.2): `capture_pending` is an admitted outbox row still inside its idle
 * merge window; queue/compile/retry/failed come from the persistent queue, lease and typed
 * errors only. No row means nothing uncovered.
 */
export function pendingIncrementOf(store: EvidenceStore, graphId: EvidenceGraphId, now: number): PendingIncrement {
  const row = store.outbox.get(graphId)
  if (row === undefined) return 'none'
  if (row.inFlightAttemptId !== null) return 'compiling'
  if (row.retryNotBefore >= TERMINAL_RETRY_NOT_BEFORE) return 'failed'
  if (row.retryNotBefore > now) return 'retrying'
  if (row.eligibleAfter > now) return 'capture_pending'
  return 'compile_queued'
}

/**
 * Freshness (§11.2): covered → current; newer persisted input being worked → updating; terminal
 * uncovered failure → stale (Snapshot readable) or unavailable (no valid Snapshot ever).
 */
export function freshnessOf(hasValidSnapshot: boolean, pending: PendingIncrement): Freshness {
  if (pending === 'failed') return hasValidSnapshot ? 'stale' : 'unavailable'
  return pending === 'none' ? 'current' : 'updating'
}

/** All status facts for one Graph in one deterministic read (shared by issues + service). */
export function graphStatusFacts(store: EvidenceStore, graphId: EvidenceGraphId, now: number): GraphStatusFacts {
  const head = store.heads.get(graphId)
  const headSnapshotDigest = head?.snapshotDigest ?? null
  const hasValidSnapshot = headSnapshotDigest !== null
  const coveredWatermark = hasValidSnapshot ? store.snapshotWatermark(headSnapshotDigest) : 0
  const row = store.outbox.get(graphId)
  const pendingTarget = row?.latestAdmittedTarget ?? row?.targetNextSeqExclusive ?? null
  const pending = pendingIncrementOf(store, graphId, now)
  return {
    hasValidSnapshot,
    headSnapshotDigest,
    headRevision: head?.headRevision ?? 0,
    coveredWatermark,
    pendingTarget,
    pending,
    freshness: freshnessOf(hasValidSnapshot, pending),
  }
}
