import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { compileSnapshot, COMPILER_REVISION } from '../src/compiler.ts'
import { EvidenceGraphId } from '../src/identity.ts'
import type { GraphRecord, SessionGraphBootstrap } from '../src/schema.ts'
import { recoverCurrentHeads } from '../src/recovery.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { compiledFixture, header, storeHarness } from './helpers.ts'
import { recordSummaryPayload, registerSuiteSummary } from './summary.ts'

registerSuiteSummary({
  suiteId: 'store-contract',
  acceptanceIds: ['S01-A02', 'S01-A07', 'S01-A08', 'S01-A09', 'S01-A10', 'S01-A11'],
  sessionPersistence: [],
  evidenceStorage: ['memory'],
})

const revisions = (digest: ReturnType<typeof compiledFixture>['selection']['digest']) => ({
  canonicalization: 'animalge-c14n-json/v1' as const,
  identity: 'animalge-identity/v1' as const,
  compiler: COMPILER_REVISION,
  captureContract: 'animalge-capture/v1' as const,
  selectionRuleDigest: digest,
})

async function queued(store: Awaited<ReturnType<typeof storeHarness>>['store'], target = 6) {
  const scope = await store.bootstrap(header)
  const now = Date.now()
  const row = await store.admitOutbox({
    graphId: scope.graphId, sessionId: header.id, targetNextSeqExclusive: target,
    firstBoundarySeq: 3, lastBoundarySeq: target - 1, boundaryCount: 2,
    reasonCounts: { tool_result: 1, code_dispatch: 0, turn_end: 1, startup_scan: 0, retry: 0 },
    firstQueuedAt: now, lastQueuedAt: now, eligibleAfter: now, retryNotBefore: 0,
    overflowed: false, latestAdmittedTarget: target,
  })
  return { scope, row }
}

describe('S01-A02/A07-A11 Evidence Store', () => {
  it('bootstraps exactly one Graph and binds Workspace monotonically', async () => {
    const harness = await storeHarness()
    try {
      const first = await harness.store.bootstrap(header)
      const second = await harness.store.bootstrap(header, WorkspaceId('workspace-1'))
      expect(second.graphId).toBe(first.graphId)
      expect(second.workspaceId).toBe(WorkspaceId('workspace-1'))
      expect(harness.store.graphs.size).toBe(1)
      expect(harness.store.heads.size).toBe(1)
      await expect(harness.store.bootstrap(header, WorkspaceId('workspace-2'))).rejects.toMatchObject({ code: 'scope_workspace_conflict' })
      await expect(harness.store.bootstrap({ ...header, createdAt: header.createdAt + 1 })).rejects.toMatchObject({ code: 'session_lifecycle_conflict' })
    } finally { await harness.close() }
  })

  it('preserves an un-dequeued ticket and resumes a linearized queued attempt', async () => {
    const harness = await storeHarness()
    try {
      const { scope, row } = await queued(harness.store)
      const attempt = await harness.store.dequeue(
        row,
        harness.store.currentHead(scope.graphId),
        revisions(compiledFixture().selection.digest),
      )
      expect(harness.store.runnableOutbox(Date.now())?.inFlightAttemptId).toBe(attempt.attemptId)
      const resumed = await harness.store.dequeue(
        harness.store.outbox.get(scope.graphId)!,
        harness.store.currentHead(scope.graphId),
        attempt.revisions,
      )
      expect(resumed.attemptId).toBe(attempt.attemptId)
    } finally { await harness.close() }
  })

  it('commits immutable Snapshot bytes through digest+revision CAS', async () => {
    const harness = await storeHarness()
    try {
      const { scope, row } = await queued(harness.store)
      const fixture = compiledFixture('selection/v1', scope)
      for (const capture of fixture.folded.captures) await harness.store.saveCapture(capture)
      let attempt = await harness.store.dequeue(row, harness.store.currentHead(scope.graphId), revisions(fixture.selection.digest))
      attempt = await harness.store.startAttempt(attempt.attemptId)
      const head = await harness.store.commit(attempt, { ...fixture.payload, scope })
      expect(head).toMatchObject({ headRevision: 1, previousSnapshotDigest: null })
      expect(harness.store.committedSnapshot(head.snapshotDigest!)).toBeDefined()
      recordSummaryPayload({ store_cas_committed_snapshot_digest: head.snapshotDigest ?? null })

      const stale = { ...attempt, attemptId: `${attempt.attemptId}-stale` as typeof attempt.attemptId }
      // §8.4 covered-target no-op: the same target and revisions are already committed,
      // so the duplicate request settles as a no-op success without a new revision.
      const settled = await harness.store.commit(stale, { ...fixture.payload, scope })
      expect(settled).toEqual(head)
      expect(harness.store.currentHead(scope.graphId)).toEqual(head)
      expect(harness.store.headCommits.size).toBe(1)
      expect(harness.store.attempts.get(stale.attemptId)).toMatchObject({ state: 'succeeded', resultSnapshotDigest: head.snapshotDigest })
      recordSummaryPayload({
        store_cas_committed_snapshot_digest: head.snapshotDigest ?? null,
        store_covered_noop_head_revision: head.headRevision,
      })
    } finally { await harness.close() }
  })

  it('rejects each single-stale CAS dimension for an uncovered target', async () => {
    const harness = await storeHarness()
    try {
      const { scope, row } = await queued(harness.store)
      const fixture = compiledFixture('selection/v1', scope)
      for (const capture of fixture.folded.captures) await harness.store.saveCapture(capture)
      let attempt = await harness.store.dequeue(row, harness.store.currentHead(scope.graphId), revisions(fixture.selection.digest))
      attempt = await harness.store.startAttempt(attempt.attemptId)
      const head = await harness.store.commit(attempt, { ...fixture.payload, scope })
      const uncovered = compileSnapshot({
        scope, captures: fixture.folded.captures, baseSnapshotDigest: head.snapshotDigest,
        targetNextSeqExclusive: 7, sourceTimeUpperBound: 106,
        selectionRevision: fixture.selection.revision, selectionRuleDigest: fixture.selection.digest,
      })
      const staleDigest = { ...attempt, attemptId: `${attempt.attemptId}-sd` as typeof attempt.attemptId, baseSnapshotDigest: null, baseHeadRevision: head.headRevision, targetNextSeqExclusive: 7 }
      await expect(harness.store.commit(staleDigest, uncovered)).rejects.toMatchObject({ code: 'head_cas_conflict' })
      expect(harness.store.currentHead(scope.graphId)).toEqual(head)
      const staleRevision = { ...attempt, attemptId: `${attempt.attemptId}-sr` as typeof attempt.attemptId, baseSnapshotDigest: head.snapshotDigest, baseHeadRevision: head.headRevision - 1, targetNextSeqExclusive: 7 }
      await expect(harness.store.commit(staleRevision, uncovered)).rejects.toMatchObject({ code: 'head_cas_conflict' })
      expect(harness.store.currentHead(scope.graphId)).toEqual(head)
      expect(harness.store.headCommits.size).toBe(1)
      recordSummaryPayload({ cas_single_stale_dimensions_rejected: 2 })
    } finally { await harness.close() }
  })

  it('replays bootstrap crash prefixes onto the same GraphId', async () => {
    for (const prefix of ['after_intent', 'after_graph', 'after_null_head'] as const) {
      const harness = await storeHarness()
      try {
        const sessionId = SessionId(`spec-01-${prefix}`)
        const createdAt = 1_700_000_001_000
        const headerX = { version: 0, id: sessionId, createdAt }
        const graphIdX = EvidenceGraphId(`eg_prefix_${prefix}`)
        const intent: SessionGraphBootstrap = {
          recordVersion: 'animalge.session-graph-bootstrap/v1',
          sessionId, sessionCreatedAt: createdAt, graphId: graphIdX,
          initialScope: { kind: 'session', graphId: graphIdX, sessionId, sessionCreatedAt: createdAt },
          state: 'initializing',
        }
        await harness.store.sessionGraphs.put(sessionId, intent)
        if (prefix !== 'after_intent') {
          const graph: GraphRecord = { recordVersion: 'animalge.evidence-graph/v1', scope: intent.initialScope, status: 'ready' }
          await harness.store.graphs.put(graphIdX, graph)
        }
        if (prefix === 'after_null_head') {
          await harness.store.heads.put(graphIdX, { recordVersion: 'animalge.current-head/v1', graphId: graphIdX, snapshotDigest: null, headRevision: 0, previousSnapshotDigest: null, previousHeadRevision: null })
        }
        const scope = await harness.store.bootstrap(headerX)
        expect(scope.graphId).toBe(graphIdX)
        expect(harness.store.sessionGraphs.get(sessionId)?.state).toBe('ready')
        expect(harness.store.graphs.size).toBe(1)
        expect(harness.store.heads.size).toBe(1)
        const again = await harness.store.bootstrap(headerX)
        expect(again.graphId).toBe(graphIdX)
        expect(harness.store.graphs.size).toBe(1)
      } finally { await harness.close() }
    }
  })

  it('fails closed on a ready bootstrap with missing or mismatched companions', async () => {
    const harness = await storeHarness()
    try {
      const sessionId = SessionId('spec-01-ready-broken')
      const createdAt = 1_700_000_002_000
      const headerX = { version: 0, id: sessionId, createdAt }
      const gid = EvidenceGraphId('eg_ready_broken')
      const intent: SessionGraphBootstrap = {
        recordVersion: 'animalge.session-graph-bootstrap/v1',
        sessionId, sessionCreatedAt: createdAt, graphId: gid,
        initialScope: { kind: 'session', graphId: gid, sessionId, sessionCreatedAt: createdAt },
        state: 'ready',
      }
      await harness.store.sessionGraphs.put(sessionId, intent)
      await expect(harness.store.bootstrap(headerX)).rejects.toMatchObject({ code: 'bootstrap_corrupt' })
      await harness.store.recoverBootstraps()
      expect(harness.store.quarantine.size).toBeGreaterThan(0)
      const mismatchId = SessionId('spec-01-ready-mismatch')
      const mismatched = { ...intent, sessionId: mismatchId, graphId: EvidenceGraphId('eg_other') }
      await harness.store.sessionGraphs.put(mismatchId, {
        ...mismatched, initialScope: { ...mismatched.initialScope, sessionId: mismatchId },
      })
      await expect(harness.store.bootstrap({ version: 0, id: mismatchId, createdAt })).rejects.toMatchObject({ code: 'bootstrap_corrupt' })
    } finally { await harness.close() }
  })

  it('cancels an attempt before CAS without advancing the head and still commits a successor', async () => {
    const harness = await storeHarness()
    try {
      const { scope, row } = await queued(harness.store)
      const fixture = compiledFixture('selection/v1', scope)
      let attempt = await harness.store.dequeue(row, harness.store.currentHead(scope.graphId), revisions(fixture.selection.digest))
      attempt = await harness.store.startAttempt(attempt.attemptId)
      await harness.store.cancelAttempt(attempt)
      expect(harness.store.attempts.get(attempt.attemptId)?.state).toBe('cancelled')
      expect(harness.store.currentHead(scope.graphId)).toMatchObject({ snapshotDigest: null, headRevision: 0 })
      expect(harness.store.outbox.get(scope.graphId)?.inFlightAttemptId).toBeNull()
      const requeued = harness.store.outbox.get(scope.graphId)!
      const successor = await harness.store.dequeue(requeued, harness.store.currentHead(scope.graphId), revisions(fixture.selection.digest))
      expect(successor.retryOf).toBe(attempt.attemptId)
      const head = await harness.store.commit(successor, { ...fixture.payload, scope })
      expect(head).toMatchObject({ headRevision: 1 })
      recordSummaryPayload({ cancel_before_cas_successor_head_revision: head.headRevision })
    } finally { await harness.close() }
  })

  it('ignores a late cancel after the commit point', async () => {
    const harness = await storeHarness()
    try {
      const { scope, row } = await queued(harness.store)
      const fixture = compiledFixture('selection/v1', scope)
      let attempt = await harness.store.dequeue(row, harness.store.currentHead(scope.graphId), revisions(fixture.selection.digest))
      attempt = await harness.store.startAttempt(attempt.attemptId)
      const head = await harness.store.commit(attempt, { ...fixture.payload, scope })
      await harness.store.cancelAttempt(harness.store.attempts.get(attempt.attemptId) ?? attempt)
      expect(harness.store.attempts.get(attempt.attemptId)?.state).toBe('succeeded')
      expect(harness.store.currentHead(scope.graphId)).toEqual(head)
      expect(harness.store.headCommits.size).toBe(1)
    } finally { await harness.close() }
  })

  it('keeps the overflowed marker and pause across outbox merges', async () => {
    const harness = await storeHarness()
    try {
      const { scope } = await queued(harness.store)
      const now = Date.now()
      const merged = await harness.store.admitOutbox({
        graphId: scope.graphId, sessionId: header.id, targetNextSeqExclusive: 9,
        firstBoundarySeq: 6, lastBoundarySeq: 8, boundaryCount: 1,
        reasonCounts: { tool_result: 0, code_dispatch: 0, turn_end: 1, startup_scan: 0, retry: 0 },
        firstQueuedAt: now, lastQueuedAt: now, eligibleAfter: now, retryNotBefore: 0,
        overflowed: true, firstRejectedTarget: 9, latestAdmittedTarget: 9,
      })
      expect(merged.overflowed).toBe(true)
      expect(merged.firstRejectedTarget).toBe(9)
      expect(harness.store.runnableOutbox(Date.now())).toBeUndefined()
      expect(harness.store.nextRunnableAt()).toBeUndefined()
      recordSummaryPayload({ overflow_marker_preserved_across_merge: true })
    } finally { await harness.close() }
  })

  it('repairs the CAS-success/commit-history crash prefix idempotently', async () => {
    const harness = await storeHarness()
    try {
      const { scope, row } = await queued(harness.store)
      const fixture = compiledFixture('selection/v1', scope)
      let attempt = await harness.store.dequeue(row, harness.store.currentHead(scope.graphId), revisions(fixture.selection.digest))
      attempt = await harness.store.startAttempt(attempt.attemptId)
      const head = await harness.store.commit(attempt, { ...fixture.payload, scope })
      await harness.store.headCommits.delete(`${scope.graphId}:${head.headRevision}`)
      await recoverCurrentHeads(harness.store)
      const repaired = harness.store.headCommits.get(`${scope.graphId}:${head.headRevision}`)
      expect(repaired).toMatchObject({ kind: 'compile', operationId: attempt.attemptId, snapshotDigest: head.snapshotDigest })
      await recoverCurrentHeads(harness.store)
      expect(harness.store.headCommits.size).toBe(1)
    } finally { await harness.close() }
  })

  it('keeps fair ticket order across restart and moves interrupted work to the tail', async () => {
    const pool = new MemoryMediaPool()
    const first = await storeHarness(pool)
    const one = await queued(first.store)
    const secondHeader = { ...header, id: SessionId('spec-01-session-b'), createdAt: header.createdAt + 10 }
    const secondScope = await first.store.bootstrap(secondHeader)
    const now = Date.now()
    await first.store.admitOutbox({
      graphId: secondScope.graphId,
      sessionId: secondHeader.id,
      targetNextSeqExclusive: 1,
      firstBoundarySeq: 0,
      lastBoundarySeq: 0,
      boundaryCount: 1,
      reasonCounts: { tool_result: 0, code_dispatch: 0, turn_end: 1, startup_scan: 0, retry: 0 },
      firstQueuedAt: now,
      lastQueuedAt: now,
      eligibleAfter: now,
      retryNotBefore: 0,
      overflowed: false,
    })
    let attempt = await first.store.dequeue(
      one.row,
      first.store.currentHead(one.scope.graphId),
      revisions(compiledFixture().selection.digest),
    )
    attempt = await first.store.startAttempt(attempt.attemptId)
    await first.close()

    const restarted = await storeHarness(pool)
    try {
      await restarted.store.reconcileAttempts()
      expect(restarted.store.attempts.get(attempt.attemptId)?.state).toBe('interrupted')
      expect(restarted.store.runnableOutbox(Date.now())?.graphId).toBe(secondScope.graphId)
    } finally { await restarted.close() }
  })

  it('creates a new successor attempt with retryOf and consumes a new fair ticket', async () => {
    const harness = await storeHarness()
    try {
      const fixture = compiledFixture()
      const { scope, row } = await queued(harness.store)
      let first = await harness.store.dequeue(row, harness.store.currentHead(scope.graphId), revisions(fixture.selection.digest))
      first = await harness.store.startAttempt(first.attemptId)
      await harness.store.failAttempt(first, 'backend_temporary', true, 1)
      const requeued = harness.store.outbox.get(scope.graphId)!
      expect(requeued.fairTicket).toBeGreaterThan(row.fairTicket)
      expect(requeued.reasonCounts.retry).toBe(1)
      await harness.store.outbox.put(scope.graphId, { ...requeued, retryNotBefore: 0 })
      const second = await harness.store.dequeue(
        harness.store.outbox.get(scope.graphId)!,
        harness.store.currentHead(scope.graphId),
        first.revisions,
      )
      expect(second.retryOf).toBe(first.attemptId)
      expect(harness.store.attemptOrdinal(second)).toBe(2)
    } finally { await harness.close() }
  })

  it('updates only selection metadata for revision-only recompilation', async () => {
    const harness = await storeHarness()
    try {
      const first = compiledFixture('selection/v1').folded.captures[0]!
      const revised = compiledFixture('selection/v2').selection
      const second = { ...first, selectionRuleDigest: revised.digest }
      await harness.store.saveCapture(first)
      await expect(harness.store.saveCapture(second)).resolves.toBeUndefined()
      expect(harness.store.captures.get(first.runId)?.selectionRuleDigest).toBe(second.selectionRuleDigest)
      await expect(harness.store.saveCapture({ ...second, endedAt: second.endedAt + 1 })).rejects.toMatchObject({ code: 'capture_identity_conflict' })
    } finally { await harness.close() }
  })
})
