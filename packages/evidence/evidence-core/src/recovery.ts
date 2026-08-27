/** Startup current-head validation, quarantine and monotonic recovery. */

import { EvidenceIntegrityError, verifyStoredSnapshot } from './integrity.ts'
import type { EvidenceStore } from './store.ts'
import type { Sha256Digest } from './types.ts'

/** Repair each invalid current head from the newest fully verified committed predecessor. */
export async function recoverCurrentHeads(store: EvidenceStore): Promise<void> {
  for (const [graphId, head] of store.heads.entries()) {
    if (head.snapshotDigest === null) continue
    try {
      verifyStoredSnapshot(store.snapshots.get(head.snapshotDigest) ?? (() => { throw new EvidenceIntegrityError('snapshot_missing', 'current Snapshot is missing') })())
      const commitKey = `${graphId}:${head.headRevision}` as `${string}:${number}`
      if (store.headCommits.get(commitKey) === undefined) {
        await store.repairMissingHeadCommit(graphId, head)
      }
      continue
    } catch (error) {
      const code = error instanceof EvidenceIntegrityError ? error.code : 'current_invalid'
      await store.quarantineObject(graphId, 'snapshots', head.snapshotDigest, code, 'startup/current', [head.snapshotDigest])
    }
    let restored: Sha256Digest | null = null
    const candidates = [head.previousSnapshotDigest, ...[...store.headCommits.entries()]
      .map(([, commit]) => commit)
      .filter(commit => commit.graphId === graphId && commit.headRevision < head.headRevision)
      .sort((left, right) => right.headRevision - left.headRevision)
      .map(commit => commit.snapshotDigest)]
    for (const candidate of candidates) {
      if (candidate === null) continue
      try {
        verifyStoredSnapshot(store.snapshots.get(candidate) ?? (() => { throw new Error('missing') })())
        restored = candidate
        break
      } catch {
        // A candidate is usable only after the whole Snapshot verifies.
      }
    }
    await store.recoverHead(graphId, head, restored, head.snapshotDigest)
  }
}
