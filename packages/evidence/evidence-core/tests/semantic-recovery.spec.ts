/** S04-A15/A17: crash-window reconciliation, idempotent watermark recovery, deterministic survival. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { storeHarness, header } from './helpers.ts'
import { compileSnapshot } from '../src/compiler.ts'
import { materialSnapshotFor } from '../src/materialize.ts'
import { foldCaptures, resolveSelection } from '../src/capture.ts'
import { resolveEvidenceModelRoute, resolveSemanticProjectionConfig } from '../src/semantic/model-route.ts'
import { verifySnapshot } from '../src/integrity.ts'

const selection = resolveSelection('spec04-recovery/v1', ['bash'])

async function seededHarness() {
  const harness = await storeHarness()
  const scope = await harness.store.bootstrap(header)
  return { harness, scope }
}

const events = [
  { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
  { type: 'tool/call', seq: 2, time: 102, data: { turn: 1, step: 1, callId: 'call-r', name: 'bash', arguments: '{}' } },
  { type: 'tool/result', seq: 3, time: 103, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'tool', source: { callId: 'call-r' }, content: [{ type: 'tool-result', toolCallId: 'call-r', content: [{ type: 'text', text: 'ok' }] }] } } },
  { type: 'turn/end', seq: 5, time: 105, data: { turn: 1, reason: { kind: 'completed' } } },
] as SessionEvent[]

describe('S04-A15 crash windows reconcile through the shared attempt skeleton', () => {
  it('a running semantic attempt found at startup settles interrupted and keeps the lane watermark', async () => {
    const { harness, scope } = await seededHarness()
    const graphId = scope.graphId
    try {
      const folded = foldCaptures(scope, header, events, selection)
      for (const capture of folded.captures) await harness.store.saveCapture(capture)
      const head = harness.store.currentHead(graphId)
      const payload = compileSnapshot({
        scope,
        captures: folded.captures,
        baseSnapshotDigest: null,
        targetNextSeqExclusive: 6,
        sourceTimeUpperBound: 105,
        selectionRevision: selection.revision,
        selectionRuleDigest: selection.digest,
      })
      const committedHead = await harness.store.commit({
        recordVersion: 'animalge.compile-attempt/v1',
        attemptId: 'ca_r1' as never, graphId, sessionId: header.id,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 6,
        baseSnapshotDigest: head.snapshotDigest, baseHeadRevision: head.headRevision,
        state: 'succeeded', stage: 'finalize',
        revisions: { canonicalization: 'animalge-c14n-json/v1', identity: 'animalge-identity/v1', compiler: 'animalge-deterministic-compiler/v1', captureContract: 'animalge-capture/v1', selectionRuleDigest: selection.digest },
        retryOf: null, startedAt: 1, updatedAt: 1, terminalError: null, stagingId: null, resultSnapshotDigest: null,
      }, payload)
      expect(committedHead.snapshotDigest).not.toBeNull()
      // Crash window: a running semantic attempt with no outbox linkage is discovered by startup reconcile.
      const crashWindow = await harness.store.startSemanticAttempt({
        graphId, sessionId: header.id, head: committedHead, targetNextSeqExclusive: 6,
        revisions: { canonicalization: 'animalge-c14n-json/v1', identity: 'animalge-identity/v1', compiler: 'animalge-deterministic-compiler/v1', captureContract: 'animalge-capture/v1', selectionRuleDigest: selection.digest, materialContract: 'animalge-material/v1', candidateContract: 'animalge-candidate/v1' },
        semantic: { modelCallId: null, modelRequestEventRef: null, projectionDigest: null, extractorRevision: 'animalge-semantic-extractor/v1', promptRevision: 'animalge-semantic-prompt/v1', outputDigest: null },
      })
      expect(crashWindow.channel).toBe('semantic')
      await harness.store.reconcileAttempts()
      const settled = harness.store.attempts.get(crashWindow.attemptId)
      expect(settled?.state).toBe('interrupted')
      // The lane watermark never advanced — the semantic prefix stays pending.
      expect(harness.store.semanticLaneFor(graphId)?.nextSeqExclusive ?? 0).toBe(0)
    } finally { await harness.close() }
  })

  it('a committed semantic attempt settles succeeded from head evidence (window 5)', async () => {
    const { harness, scope } = await seededHarness()
    const graphId = scope.graphId
    try {
      const folded = foldCaptures(scope, header, events, selection)
      for (const capture of folded.captures) await harness.store.saveCapture(capture)
      const head = harness.store.currentHead(graphId)
      const base = compileSnapshot({
        scope,
        captures: folded.captures,
        baseSnapshotDigest: null,
        targetNextSeqExclusive: 6,
        sourceTimeUpperBound: 105,
        selectionRevision: selection.revision,
        selectionRuleDigest: selection.digest,
        material: materialSnapshotFor(harness.store, graphId),
        semantic: { ledger: { candidates: new Map(), relations: new Map(), runSelections: new Map() }, watermark: { kind: 'active', nextSeqExclusive: 6 } },
      })
      const attempt = await harness.store.startSemanticAttempt({
        graphId, sessionId: header.id, head, targetNextSeqExclusive: 6,
        revisions: { canonicalization: 'animalge-c14n-json/v1', identity: 'animalge-identity/v1', compiler: 'animalge-deterministic-compiler/v1', captureContract: 'animalge-capture/v1', selectionRuleDigest: selection.digest, materialContract: 'animalge-material/v1', candidateContract: 'animalge-candidate/v1' },
        semantic: { modelCallId: null, modelRequestEventRef: null, projectionDigest: null, extractorRevision: 'animalge-semantic-extractor/v1', promptRevision: 'animalge-semantic-prompt/v1', outputDigest: null },
      })
      const committed = await harness.store.commit(attempt, base)
      // Simulate the finalize-crash: the attempt row still reads 'running' though the head
      // moved — keep the committed evidence fields so reconcile can settle from them.
      const postCommit = harness.store.attempts.get(attempt.attemptId) ?? attempt
      await harness.store.attempts.put(attempt.attemptId, { ...postCommit, state: 'running' })
      await harness.store.reconcileAttempts()
      const settled = harness.store.attempts.get(attempt.attemptId)
      expect(settled?.state).toBe('succeeded')
      expect(settled?.resultSnapshotDigest).toBe(committed.snapshotDigest)
      expect(verifySnapshot(base).semanticWatermark).toEqual({ kind: 'active', nextSeqExclusive: 6 })
    } finally { await harness.close() }
  })

  it('C1-03 regression: request_event_not_durable parks on the retry ladder, not forever (B1-05)', async () => {
    const { harness, scope } = await seededHarness()
    const graphId = scope.graphId
    try {
      const folded = foldCaptures(scope, header, events, selection)
      for (const capture of folded.captures) await harness.store.saveCapture(capture)
      const head = harness.store.currentHead(graphId)
      const payload = compileSnapshot({
        scope, captures: folded.captures, baseSnapshotDigest: null,
        targetNextSeqExclusive: 6, sourceTimeUpperBound: 105,
        selectionRevision: selection.revision, selectionRuleDigest: selection.digest,
      })
      await harness.store.commit({
        recordVersion: 'animalge.compile-attempt/v1',
        attemptId: 'ca_retry' as never, graphId, sessionId: header.id,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 6,
        baseSnapshotDigest: head.snapshotDigest, baseHeadRevision: head.headRevision,
        state: 'succeeded', stage: 'finalize',
        revisions: { canonicalization: 'animalge-c14n-json/v1', identity: 'animalge-identity/v1', compiler: 'animalge-deterministic-compiler/v1', captureContract: 'animalge-capture/v1', selectionRuleDigest: selection.digest },
        retryOf: null, startedAt: 1, updatedAt: 1, terminalError: null, stagingId: null, resultSnapshotDigest: null,
      }, payload)
      const failed = await harness.store.startSemanticAttempt({
        graphId, sessionId: header.id, head: harness.store.currentHead(graphId), targetNextSeqExclusive: 6,
        revisions: { canonicalization: 'animalge-c14n-json/v1', identity: 'animalge-identity/v1', compiler: 'animalge-deterministic-compiler/v1', captureContract: 'animalge-capture/v1', selectionRuleDigest: selection.digest, materialContract: 'animalge-material/v1', candidateContract: 'animalge-candidate/v1' },
        semantic: { modelCallId: null, modelRequestEventRef: null, projectionDigest: null, extractorRevision: 'animalge-semantic-extractor/v1', promptRevision: 'animalge-semantic-prompt/v1', outputDigest: null },
      })
      // Route through the REAL failure classifier: the lane's settleFailure must map
      // request_event_not_durable onto the retryable family (RETRYABLE_CODES), not park
      // it forever — this is the guard C1-03 lacked.
      const { SemanticLane } = await import('../src/semantic/lane.ts')
      const { resolveEvidenceModelRoute, resolveSemanticProjectionConfig } = await import('../src/semantic/model-route.ts')
      const route = resolveEvidenceModelRoute({ provider: 'p', model: 'm' }) as NonNullable<ReturnType<typeof resolveEvidenceModelRoute>>
      const lane = new SemanticLane(
        harness.ctx, harness.store, route, resolveSemanticProjectionConfig(undefined),
        selection, [1_000, 2_000, 4_000, 8_000], 5, () => false, new AbortController().signal,
      )
      const settle = (lane as unknown as { settleFailure: (a: unknown, g: unknown, e: unknown) => Promise<void> }).settleFailure
      await settle.call(lane, failed, graphId, Object.assign(new Error('x'), { code: 'request_event_not_durable' }))
      expect(harness.store.attempts.get(failed.attemptId)?.terminalError?.retryable).toBe(true)
      const retries = (lane as unknown as { retries: Map<string, { attempts: number; notBefore: number }> }).retries.get(graphId)
      expect(retries?.notBefore ?? 0).toBeLessThan(Number.MAX_SAFE_INTEGER)
      // The deterministic head is untouched and readable (D-116).
      expect(harness.store.currentHead(graphId).headRevision).toBe(1)
    } finally { await harness.close() }
  })

  it('S04-A17 model-failure survival: the deterministic head stays readable and current (D-116)', async () => {
    const { harness, scope } = await seededHarness()
    const graphId = scope.graphId
    try {
      const folded = foldCaptures(scope, header, events, selection)
      for (const capture of folded.captures) await harness.store.saveCapture(capture)
      const head = harness.store.currentHead(graphId)
      const payload = compileSnapshot({
        scope,
        captures: folded.captures,
        baseSnapshotDigest: null,
        targetNextSeqExclusive: 6,
        sourceTimeUpperBound: 105,
        selectionRevision: selection.revision,
        selectionRuleDigest: selection.digest,
      })
      await harness.store.commit({
        recordVersion: 'animalge.compile-attempt/v1',
        attemptId: 'ca_r2' as never, graphId, sessionId: header.id,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 6,
        baseSnapshotDigest: head.snapshotDigest, baseHeadRevision: head.headRevision,
        state: 'succeeded', stage: 'finalize',
        revisions: { canonicalization: 'animalge-c14n-json/v1', identity: 'animalge-identity/v1', compiler: 'animalge-deterministic-compiler/v1', captureContract: 'animalge-capture/v1', selectionRuleDigest: selection.digest },
        retryOf: null, startedAt: 1, updatedAt: 1, terminalError: null, stagingId: null, resultSnapshotDigest: null,
      }, payload)
      // A failed semantic attempt must not touch the deterministic head.
      const failed = await harness.store.startSemanticAttempt({
        graphId, sessionId: header.id, head: harness.store.currentHead(graphId), targetNextSeqExclusive: 6,
        revisions: { canonicalization: 'animalge-c14n-json/v1', identity: 'animalge-identity/v1', compiler: 'animalge-deterministic-compiler/v1', captureContract: 'animalge-capture/v1', selectionRuleDigest: selection.digest, materialContract: 'animalge-material/v1', candidateContract: 'animalge-candidate/v1' },
        semantic: { modelCallId: null, modelRequestEventRef: null, projectionDigest: null, extractorRevision: 'animalge-semantic-extractor/v1', promptRevision: 'animalge-semantic-prompt/v1', outputDigest: null },
      })
      await harness.store.failAttempt(failed, 'model_output_invalid', true, 1_000)
      expect(harness.store.attempts.get(failed.attemptId)?.state).toBe('failed')
      const after = harness.store.currentHead(graphId)
      expect(after.headRevision).toBe(1)
      expect(verifySnapshot(harness.store.committedSnapshot(after.snapshotDigest as never).payload)).toBeDefined()
      expect(resolveEvidenceModelRoute(undefined)).toBeUndefined()
      expect(resolveSemanticProjectionConfig(undefined).perItemTruncationChars).toBe(16_384)
    } finally { await harness.close() }
  })
})
