/** SPEC-05 §6 issue channel: deterministic owner-side derivation, issueKeys, seen state and the
 * issuesRevision token. All mutations stay inside EvidenceStore's serialized queue; this module
 * holds the pure derivation and the thin owner wrappers (single-writer discipline, D-130). */

import { canonicalDigest } from './canonical-json.ts'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session/types'
import { graphStatusFacts } from './derive.ts'
import { verifyStoredSnapshot } from './integrity.ts'
import type { CandidateRelationRecordV1, EvidenceGraphId, IssueRecordV1, IssueSeenV1, Sha256Digest } from './types.ts'
import type { EvidenceStore } from './store.ts'
import { candidateNodeIdOf } from './semantic/candidates.ts'

/** Derivation revision: bump when a condition row or key shape changes (SPEC-05 §6.3). */
export const ISSUE_DERIVATION_REVISION = 'animalge-issue/v1'

/** A condition that currently holds for one Graph, before ledger reconciliation. */
export interface DerivedIssue {
  readonly issueKey: string
  readonly severity: 'attention' | 'action_required'
  readonly conditionCode: string
  readonly targetKind: string
  readonly targetId: string
  readonly applicableSnapshotDigest: Sha256Digest | null
  readonly applicableWatermark: number
}

/** Closed structural key: {severity}:{conditionCode}:{targetKind}:{targetId} (§6.3; graph-level rows use targetKind 'graph'). */
export function issueKeyOf(severity: 'attention' | 'action_required', conditionCode: string, targetKind: string, targetId: string): string {
  return `${severity}:${conditionCode}:${targetKind}:${targetId}`
}

/** The version-constraint token over both issue tables (§5.3); any issue-table write must advance it. */
export function issueStateRevision(store: EvidenceStore): string {
  const state: Record<string, unknown> = {}
  for (const [name, table] of [['issue_records', store.issueRecords], ['issue_seen', store.issueSeen]] as const) {
    const rows: Array<[string, unknown]> = [...table.entries()].map(([key, value]) => [key, value as unknown])
    rows.sort((left, right) => left[0].localeCompare(right[0]))
    state[name] = rows
  }
  return canonicalDigest(state as JsonValue)
}

/** Unread rule: attention/action_required, unresolved, and unseen-or-seen-before-last occurrence (§6.3). */
export function unreadIssueCount(store: EvidenceStore, graphId: EvidenceGraphId): number {
  let unread = 0
  for (const [, record] of store.issueRecords.entries()) {
    if (record.graphId !== graphId || record.resolvedAt !== null) continue
    const seen = store.issueSeen.get(record.issueKey)
    if (seen === undefined || seen.seenAt < record.lastSeenAt) unread++
  }
  return unread
}

/** Open attention/action_required count for the status summary (§4.2). */
export function openIssueCount(store: EvidenceStore, graphId: EvidenceGraphId): number {
  let open = 0
  for (const [, record] of store.issueRecords.entries()) {
    if (record.graphId === graphId && record.resolvedAt === null) open++
  }
  return open
}

/**
 * Derive the conditions that currently hold for one Graph (§6.2 frozen table):
 * - evidence_unavailable (action_required): never a valid Snapshot and the current update terminal-failed;
 * - evidence_stale (attention): uncovered increment terminal-failed while the last Snapshot stays readable;
 * - snapshot breakpoints (attention): each named breakpoint row of the committed Snapshot payload
 *   (the SPEC-01..04 frozen word list is the conditionCode domain; an empty array honestly yields no rows);
 * - candidate_conflict (attention): candidates targeted by an active `contradicts` edge.
 * SPEC-06 conditions (user-candidate confirmation, CorrectionMatch uncertain, CAS conflicts) are
 * enumerated placeholders in the spec table and intentionally produce no rows here.
 */
export function deriveIssues(store: EvidenceStore, graphId: EvidenceGraphId, now: number): readonly DerivedIssue[] {
  const issues: DerivedIssue[] = []
  const facts = graphStatusFacts(store, graphId, now)
  if (!facts.hasValidSnapshot && facts.pending === 'failed') {
    issues.push({
      issueKey: issueKeyOf('action_required', 'evidence_unavailable', 'graph', graphId),
      severity: 'action_required', conditionCode: 'evidence_unavailable', targetKind: 'graph', targetId: graphId,
      applicableSnapshotDigest: null, applicableWatermark: 0,
    })
  } else if (facts.hasValidSnapshot && facts.pending === 'failed') {
    issues.push({
      issueKey: issueKeyOf('attention', 'evidence_stale', 'graph', graphId),
      severity: 'attention', conditionCode: 'evidence_stale', targetKind: 'graph', targetId: graphId,
      applicableSnapshotDigest: facts.headSnapshotDigest, applicableWatermark: facts.coveredWatermark,
    })
  }
  if (facts.headSnapshotDigest !== null) {
    let breakpoints: readonly { code: string; stableKey: string; relatedObjectIds: readonly string[] }[] = []
    try {
      breakpoints = verifyStoredSnapshot(store.committedSnapshot(facts.headSnapshotDigest)).breakpoints
    } catch {
      breakpoints = []
    }
    for (const breakpoint of breakpoints) {
      issues.push({
        issueKey: issueKeyOf('attention', breakpoint.code, 'node', breakpoint.relatedObjectIds[0] ?? breakpoint.stableKey),
        severity: 'attention', conditionCode: breakpoint.code, targetKind: 'node',
        targetId: breakpoint.relatedObjectIds[0] ?? breakpoint.stableKey,
        applicableSnapshotDigest: facts.headSnapshotDigest, applicableWatermark: facts.coveredWatermark,
      })
    }
  }
  const relations: CandidateRelationRecordV1[] = []
  for (const [, relation] of store.candidateRelations.entries()) {
    if (relation.graphId === graphId) relations.push(relation)
  }
  for (const [, record] of store.candidateRecords.entries()) {
    if (record.graphId !== graphId) continue
    // Re-derive conflict from the ledger (the Snapshot copy is a projection); mirror of SPEC-04 §8.3.
    const nodeId = candidateNodeIdOf(graphId, record.candidateId)
    if (!relations.some(relation => relation.edgeType === 'contradicts' && relation.toNodeId === nodeId)) continue
    issues.push({
      issueKey: issueKeyOf('attention', 'candidate_conflict', 'candidate', record.candidateId),
      severity: 'attention', conditionCode: 'candidate_conflict', targetKind: 'candidate', targetId: record.candidateId,
      applicableSnapshotDigest: facts.headSnapshotDigest, applicableWatermark: facts.coveredWatermark,
    })
  }
  return issues
}

/** Owner wrapper for the single notification write (§6.4); resolves the Graph and delegates to the store. */
export function markIssuesSeen(
  store: EvidenceStore, sessionId: SessionId, issueKeys: readonly string[],
): Promise<{ applied: readonly string[]; seenAt: number }> {
  return store.markIssuesSeenRows(sessionId, issueKeys)
}

/** Read one Graph's current issue rows (service query input; §6.4). */
export function issueRecordsFor(store: EvidenceStore, graphId: EvidenceGraphId): IssueRecordV1[] {
  const rows: IssueRecordV1[] = []
  for (const [, record] of store.issueRecords.entries()) {
    if (record.graphId === graphId) rows.push(record)
  }
  rows.sort((left, right) => left.issueKey.localeCompare(right.issueKey))
  return rows
}

/** Read the seen timestamps for the given keys (service query input). */
export function issueSeenFor(store: EvidenceStore, keys: readonly string[]): Map<string, IssueSeenV1> {
  const seen = new Map<string, IssueSeenV1>()
  for (const key of keys) {
    const row = store.issueSeen.get(key)
    if (row !== undefined) seen.set(key, row)
  }
  return seen
}
