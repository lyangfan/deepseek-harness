// SPEC-05 §11.4-2 backlog verb (owner side): the process action acts only on the persisted
// outbox row — priority raise / resume from the durable compile boundary — and reports the
// four-state outcome. Behavioral counterexamples: a wrong implementation that skips the row
// rewrite, re-arms an overflowed row, tramples a running attempt, or fabricates captures or
// attempts is defeated by the assertions below.
import { describe, expect, it, vi } from 'vitest'
import { processBacklog } from '../src/store.ts'
import { storeHarness } from './helpers.ts'
import type { EvidenceStore } from '../src/store.ts'
import type { CompileAttempt, CompileOutbox } from '../src/schema.ts'

const GRAPH = 'eg_backlog01' as never
const SESSION = 'sess_backlog01' as never

async function seededRow(store: EvidenceStore, overrides: Partial<CompileOutbox> = {}): Promise<CompileOutbox> {
  const row = await store.admitOutbox({
    graphId: GRAPH,
    sessionId: SESSION,
    targetNextSeqExclusive: 33,
    firstBoundarySeq: 20,
    lastBoundarySeq: 32,
    boundaryCount: 2,
    reasonCounts: { tool_result: 1, code_dispatch: 0, turn_end: 1, startup_scan: 0, retry: 0 },
    firstQueuedAt: 1_000,
    lastQueuedAt: 2_000,
    eligibleAfter: 10_000,
    retryNotBefore: 0,
    overflowed: false,
    latestAdmittedTarget: 33,
  })
  if (Object.keys(overrides).length > 0) await store.outbox.put(GRAPH, { ...row, ...overrides })
  return { ...row, ...overrides }
}

describe('processBacklog (§11.4-2)', () => {
  it('raises a merge-window row to runnable-now and wakes the compile loop', async () => {
    const { store, close } = await storeHarness()
    try {
      await seededRow(store) // eligibleAfter=10_000 (idle-merge window), retryNotBefore=0
      const wake = vi.fn()
      store.compileWakeNotifier = wake
      const outcome = await processBacklog(store, GRAPH)
      expect(outcome).toBe('triggered')
      const row = store.outbox.get(GRAPH)
      expect(row).toBeDefined()
      expect(row!.eligibleAfter).toBeLessThanOrEqual(Date.now())
      expect(row!.retryNotBefore).toBe(0)
      expect(wake).toHaveBeenCalledTimes(1)
    } finally { await close() }
  })

  it('re-arms a terminal failure from its persisted compile boundary (retryNotBefore reset)', async () => {
    const { store, close } = await storeHarness()
    try {
      const TERMINAL = Number.MAX_SAFE_INTEGER
      await seededRow(store, { retryNotBefore: TERMINAL, eligibleAfter: TERMINAL })
      const outcome = await processBacklog(store, GRAPH)
      expect(outcome).toBe('triggered')
      const row = store.outbox.get(GRAPH)
      expect(row!.retryNotBefore).toBe(0)
      expect(row!.eligibleAfter).toBeLessThanOrEqual(Date.now())
      // The durable compile boundary is untouched: resume continues from the same target.
      expect(row!.targetNextSeqExclusive).toBe(33)
    } finally { await close() }
  })

  it('collapses a retry backoff to now (resume without waiting out the delay)', async () => {
    const { store, close } = await storeHarness()
    try {
      await seededRow(store, { retryNotBefore: Date.now() + 60_000, eligibleAfter: 1 })
      const outcome = await processBacklog(store, GRAPH)
      expect(outcome).toBe('triggered')
      expect(store.outbox.get(GRAPH)!.retryNotBefore).toBe(0)
    } finally { await close() }
  })

  it('reports busy for a running same-target attempt and leaves the row untouched', async () => {
    const { store, close } = await storeHarness()
    try {
      const row = await seededRow(store)
      const attemptId = 'ca_busy000000000001' as never
      const attempt: CompileAttempt = {
        recordVersion: 'animalge.compile-attempt/v1',
        attemptId,
        graphId: GRAPH,
        sessionId: SESSION,
        fromNextSeqExclusive: row.targetNextSeqExclusive - 10,
        targetNextSeqExclusive: row.targetNextSeqExclusive,
        baseSnapshotDigest: null,
        baseHeadRevision: 0,
        state: 'running',
        stage: 'fold',
        revisions: {
          canonicalization: 'animalge-c14n-json/v1',
          identity: 'animalge-identity/v1',
          compiler: 'test',
          captureContract: 'animalge-capture/v1',
          selectionRuleDigest: `sha256:${'0'.repeat(64)}`,
        },
        retryOf: null,
        startedAt: 1,
        updatedAt: 1,
        terminalError: null,
        stagingId: null,
        resultSnapshotDigest: null,
      }
      await store.attempts.put(attemptId, attempt)
      await store.outbox.put(GRAPH, { ...row, inFlightAttemptId: attemptId })
      const wake = vi.fn()
      store.compileWakeNotifier = wake
      const outcome = await processBacklog(store, GRAPH)
      expect(outcome).toBe('busy')
      const after = store.outbox.get(GRAPH)
      expect(after!.eligibleAfter).toBe(10_000) // unchanged — no priority rewrite under a running attempt
      expect(wake).not.toHaveBeenCalled()
    } finally { await close() }
  })

  it('reports paused for a capture-overflow hold and never re-arms it (§8.1 integrity)', async () => {
    const { store, close } = await storeHarness()
    try {
      await seededRow(store, { overflowed: true, firstRejectedTarget: 40 })
      const outcome = await processBacklog(store, GRAPH)
      expect(outcome).toBe('paused')
      const row = store.outbox.get(GRAPH)
      expect(row!.overflowed).toBe(true)
      expect(row!.retryNotBefore).toBe(0) // untouched by the verb
    } finally { await close() }
  })

  it('reports idle when no backlog row exists', async () => {
    const { store, close } = await storeHarness()
    try {
      const wake = vi.fn()
      store.compileWakeNotifier = wake
      expect(await processBacklog(store, 'eg_none' as never)).toBe('idle')
      expect(wake).not.toHaveBeenCalled()
    } finally { await close() }
  })

  it('is idempotent — a second call never duplicates side effects or re-arms anything new', async () => {
    const { store, close } = await storeHarness()
    try {
      await seededRow(store)
      const first = await processBacklog(store, GRAPH)
      const afterFirst = store.outbox.get(GRAPH)
      const second = await processBacklog(store, GRAPH)
      const afterSecond = store.outbox.get(GRAPH)
      expect(first).toBe('triggered')
      expect(second).toBe('triggered')
      // Semantic stability (lastQueuedAt may advance by wall-clock ms — the only rewrite):
      // the durable boundary stays put and the row stays runnable-now.
      expect(afterSecond!.targetNextSeqExclusive).toBe(afterFirst!.targetNextSeqExclusive)
      expect(afterSecond!.retryNotBefore).toBe(0)
      expect(afterSecond!.eligibleAfter).toBeLessThanOrEqual(Date.now())
      // No duplicate compile work was fabricated.
      expect([...store.attempts.entries()]).toHaveLength(0)
    } finally { await close() }
  })

  it('creates zero captures and zero attempts — the verb never fabricates compile work (§11.4)', async () => {
    const { store, close } = await storeHarness()
    try {
      await seededRow(store)
      await processBacklog(store, GRAPH)
      expect(store.capturesFor(GRAPH)).toHaveLength(0)
      expect([...store.attempts.entries()]).toHaveLength(0)
    } finally { await close() }
  })
})
