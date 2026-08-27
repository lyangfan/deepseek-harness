/** Conservative reference-closure garbage collection for private Evidence records. */

import type { EvidenceStore } from './store.ts'
import type { Sha256Digest } from './types.ts'

export interface GcPolicy {
  readonly stagingGcAgeMs: number
  readonly orphanGcGraceMs: number
}

export interface GcResult {
  readonly deletedStaging: number
  readonly deletedOrphans: number
  readonly aborted: boolean
}

/** Delete only aged, re-proven unreferenced staging and unpublished Snapshots. */
export async function collectEvidenceGarbage(store: EvidenceStore, policy: GcPolicy, now = Date.now()): Promise<GcResult> {
  const rootsBefore = new Map([...store.heads.entries()].map(([id, head]) => [id, `${String(head.snapshotDigest)}@${head.headRevision}`]))
  const referencedStaging = new Set([...store.attempts.entries()]
    .map(([, attempt]) => attempt.stagingId)
    .filter((value): value is NonNullable<typeof value> => value !== null))
  const stagingIds = [] as import('./types.ts').StagingId[]
  for (const [id, stage] of store.staging.entries()) {
    if (referencedStaging.has(id) || now - stage.createdAt < policy.stagingGcAgeMs) continue
    stagingIds.push(id)
  }
  const committed = new Set<Sha256Digest>()
  for (const [, head] of store.heads.entries()) {
    if (head.snapshotDigest !== null) committed.add(head.snapshotDigest)
    if (head.previousSnapshotDigest !== null) committed.add(head.previousSnapshotDigest)
  }
  for (const [, record] of store.headCommits.entries()) if (record.snapshotDigest !== null) committed.add(record.snapshotDigest)
  const stagingDigests = new Set([...store.staging.entries()].map(([, stage]) => stage.candidateSnapshotDigest))
  const snapshotDigests: Sha256Digest[] = []
  for (const [digest] of store.snapshots.entries()) {
    if (committed.has(digest) || stagingDigests.has(digest)) continue
    const marker = [...store.quarantine.entries()].map(([, row]) => row).find(row => row.objectTable === 'snapshots' && row.objectKey === digest && row.code === 'orphan_unreferenced')
    if (marker === undefined) {
      await store.quarantineObject(undefined, 'snapshots', digest, 'orphan_unreferenced', 'gc', [digest])
      continue
    }
    if (now - marker.detectedAt < policy.orphanGcGraceMs) continue
    snapshotDigests.push(digest)
  }
  return store.deleteGarbage(rootsBefore, stagingIds, snapshotDigests)
}
