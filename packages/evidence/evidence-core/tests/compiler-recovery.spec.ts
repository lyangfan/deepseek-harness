import { describe, expect, it } from 'vitest'
import { canonicalDigest } from '../src/canonical-json.ts'
import { compileSnapshot } from '../src/compiler.ts'
import { EvidenceIntegrityError, snapshotRecord, verifySnapshot, verifyStoredSnapshot } from '../src/integrity.ts'
import { recoverCurrentHeads } from '../src/recovery.ts'
import { compiledFixture, storeHarness } from './helpers.ts'
import { recordSummaryPayload, registerSuiteSummary } from './summary.ts'

registerSuiteSummary({
  suiteId: 'compiler-recovery',
  acceptanceIds: ['S01-A05', 'S01-A08', 'S01-A10'],
  sessionPersistence: [],
  evidenceStorage: ['memory'],
})

describe('S01-A05/A08 deterministic compiler and recovery', () => {
  it('replays to identical nodes, edges and digest without LLM state', () => {
    const fixture = compiledFixture()
    const replay = compileSnapshot({
      scope: fixture.scope, captures: fixture.folded.captures, baseSnapshotDigest: null,
      targetNextSeqExclusive: 6, sourceTimeUpperBound: 105,
      selectionRevision: fixture.selection.revision, selectionRuleDigest: fixture.selection.digest,
    })
    expect(replay).toEqual(fixture.payload)
    expect(canonicalDigest(replay as never)).toBe(canonicalDigest(fixture.payload as never))
    expect(new Set(replay.nodes.map(node => node.nodeKind))).toEqual(new Set(['Observation', 'Run']))
    expect(replay.edges.map(edge => edge.edgeType)).toEqual(['generated_by'])
    recordSummaryPayload({ compiler_replay_digest: canonicalDigest(fixture.payload as never) })
  })

  it('rejects identity, endpoint, ordering, watermark and digest damage', () => {
    const { payload } = compiledFixture()
    const reversed = { ...payload, nodes: [...payload.nodes].reverse() }
    expect(() => verifySnapshot(reversed)).toThrow(EvidenceIntegrityError)
    const badWatermark = { ...payload, deterministicWatermark: { nextSeqExclusive: 3 } }
    expect(() => verifySnapshot(badWatermark)).toThrow(/watermark/)
    const record = snapshotRecord(payload)
    expect(() => verifyStoredSnapshot({ ...record, snapshotDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' })).toThrow(/digest/)
  })

  it('recovers corrupt current to the newest verified committed predecessor', async () => {
    const harness = await storeHarness()
    try {
      const initial = compiledFixture()
      const scope = await harness.store.bootstrap({ version: 0, id: initial.scope.sessionId, createdAt: initial.scope.sessionCreatedAt })
      const fixture = compiledFixture('selection/v1', scope)
      const now = Date.now()
      const row1 = await harness.store.admitOutbox({
        graphId: scope.graphId,
        sessionId: scope.sessionId,
        targetNextSeqExclusive: 6,
        firstBoundarySeq: 3,
        lastBoundarySeq: 5,
        boundaryCount: 2,
        reasonCounts: { tool_result: 1, code_dispatch: 0, turn_end: 1, startup_scan: 0, retry: 0 },
        firstQueuedAt: now,
        lastQueuedAt: now,
        eligibleAfter: now,
        retryNotBefore: 0,
        overflowed: false,
      })
      const revisions = fixture.payload.revisions
      let first = await harness.store.dequeue(row1, harness.store.currentHead(scope.graphId), revisions)
      first = await harness.store.startAttempt(first.attemptId)
      const firstHead = await harness.store.commit(first, { ...fixture.payload, scope })
      const row2 = await harness.store.admitOutbox({
        graphId: scope.graphId,
        sessionId: scope.sessionId,
        targetNextSeqExclusive: 7,
        firstBoundarySeq: 6,
        lastBoundarySeq: 6,
        boundaryCount: 1,
        reasonCounts: { tool_result: 0, code_dispatch: 0, turn_end: 1, startup_scan: 0, retry: 0 },
        firstQueuedAt: now,
        lastQueuedAt: now,
        eligibleAfter: now,
        retryNotBefore: 0,
        overflowed: false,
      })
      let second = await harness.store.dequeue(row2, firstHead, revisions)
      second = await harness.store.startAttempt(second.attemptId)
      const secondPayload = {
        ...fixture.payload,
        scope,
        baseSnapshotDigest: firstHead.snapshotDigest,
        deterministicWatermark: { nextSeqExclusive: 7 },
        sourceTimeUpperBound: 106,
      }
      const secondHead = await harness.store.commit(second, secondPayload)
      const damaged = harness.store.snapshots.get(secondHead.snapshotDigest!)!
      await harness.store.snapshots.put(secondHead.snapshotDigest!, { ...damaged, canonicalByteLength: damaged.canonicalByteLength + 1 })
      await recoverCurrentHeads(harness.store)
      expect(harness.store.currentHead(scope.graphId)).toMatchObject({ snapshotDigest: firstHead.snapshotDigest, headRevision: 3 })
      expect(harness.store.quarantine.size).toBeGreaterThan(0)
      recordSummaryPayload({
        recovery_quarantined_digest: secondHead.snapshotDigest ?? null,
        recovery_restored_digest: firstHead.snapshotDigest ?? null,
        recovery_restored_head_revision: 3,
      })
    } finally { await harness.close() }
  })

  it('falls back to a null head and unavailable when no valid history remains', async () => {
    for (const damage of ['corrupt_payload', 'missing_digest'] as const) {
      const harness = await storeHarness()
      try {
        const initial = compiledFixture()
        const scope = await harness.store.bootstrap({ version: 0, id: initial.scope.sessionId, createdAt: initial.scope.sessionCreatedAt })
        const fixture = compiledFixture('selection/v1', scope)
        const now = Date.now()
        const row = await harness.store.admitOutbox({
          graphId: scope.graphId,
          sessionId: scope.sessionId,
          targetNextSeqExclusive: 6,
          firstBoundarySeq: 3,
          lastBoundarySeq: 5,
          boundaryCount: 2,
          reasonCounts: { tool_result: 1, code_dispatch: 0, turn_end: 1, startup_scan: 0, retry: 0 },
          firstQueuedAt: now,
          lastQueuedAt: now,
          eligibleAfter: now,
          retryNotBefore: 0,
          overflowed: false,
        })
        let attempt = await harness.store.dequeue(row, harness.store.currentHead(scope.graphId), fixture.payload.revisions)
        attempt = await harness.store.startAttempt(attempt.attemptId)
        const head = await harness.store.commit(attempt, { ...fixture.payload, scope })
        expect(head.snapshotDigest).not.toBeNull()
        if (damage === 'corrupt_payload') {
          const damaged = harness.store.snapshots.get(head.snapshotDigest!)!
          await harness.store.snapshots.put(head.snapshotDigest!, { ...damaged, canonicalByteLength: damaged.canonicalByteLength + 1 })
        } else {
          await harness.store.snapshots.delete(head.snapshotDigest!)
        }
        await recoverCurrentHeads(harness.store)
        const recovered = harness.store.currentHead(scope.graphId)
        expect(recovered).toMatchObject({ snapshotDigest: null, previousSnapshotDigest: head.snapshotDigest })
        expect(recovered.headRevision).toBeGreaterThan(head.headRevision)
        expect(harness.store.graphs.get(scope.graphId)).toMatchObject({ status: 'unavailable' })
        expect(harness.store.quarantine.size).toBeGreaterThan(0)
        recordSummaryPayload({ [`recovery_no_valid_history_${damage}`]: true })
      } finally { await harness.close() }
    }
  })

  it('derives a new Snapshot from current when the selection rule changes without rewinding watermarks', async () => {
    const harness = await storeHarness()
    try {
      const initial = compiledFixture()
      const scope = await harness.store.bootstrap({ version: 0, id: initial.scope.sessionId, createdAt: initial.scope.sessionCreatedAt })
      const first = compiledFixture('selection/v1', scope)
      const now = Date.now()
      const row = await harness.store.admitOutbox({
        graphId: scope.graphId,
        sessionId: scope.sessionId,
        targetNextSeqExclusive: 6,
        firstBoundarySeq: 3,
        lastBoundarySeq: 5,
        boundaryCount: 2,
        reasonCounts: { tool_result: 1, code_dispatch: 0, turn_end: 1, startup_scan: 0, retry: 0 },
        firstQueuedAt: now,
        lastQueuedAt: now,
        eligibleAfter: now,
        retryNotBefore: 0,
        overflowed: false,
      })
      let attempt = await harness.store.dequeue(row, harness.store.currentHead(scope.graphId), first.payload.revisions)
      attempt = await harness.store.startAttempt(attempt.attemptId)
      const head1 = await harness.store.commit(attempt, { ...first.payload, scope })
      const firstBytes = JSON.stringify(harness.store.committedSnapshot(head1.snapshotDigest!))

      const revised = compiledFixture('selection/v2', scope)
      const secondPayload = compileSnapshot({
        scope, captures: first.folded.captures, baseSnapshotDigest: head1.snapshotDigest,
        targetNextSeqExclusive: 6, sourceTimeUpperBound: 105,
        selectionRevision: revised.selection.revision, selectionRuleDigest: revised.selection.digest,
      })
      const successor = {
        ...attempt,
        attemptId: `${attempt.attemptId}-rule-v2` as typeof attempt.attemptId,
        baseSnapshotDigest: head1.snapshotDigest,
        baseHeadRevision: head1.headRevision,
        revisions: secondPayload.revisions,
      }
      const head2 = await harness.store.commit(successor, secondPayload)
      expect(head2.snapshotDigest).not.toBe(head1.snapshotDigest)
      expect(head2).toMatchObject({ headRevision: 2, previousSnapshotDigest: head1.snapshotDigest })
      expect(harness.store.snapshotWatermark(head2.snapshotDigest)).toBe(6)
      expect(JSON.stringify(harness.store.committedSnapshot(head1.snapshotDigest!))).toBe(firstBytes)
      recordSummaryPayload({ rule_change_new_snapshot: true, rule_change_head_revision: head2.headRevision })
    } finally { await harness.close() }
  })
})
