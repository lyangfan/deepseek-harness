// SPEC-05 §11.4-2 service surface: the processBacklog remote verb resolves the Session's
// Graph, delegates to the evidence-core owner function, and returns the typed outcome union
// (scope_mismatch for graph-less Sessions). Behavioral: a wrapper that drops the owner call,
// fabricates an outcome, or resolves the wrong Graph is defeated.
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { EvidenceService } from '../src/index.ts'
// Cross-package relative test import (same pattern as evidence-core's own helpers.ts
// importing storage-domain's test memory backend).
import { storeHarness } from '../../evidence-core/tests/helpers.ts'

const SESSION = 'sess_svc_backlog01' as never
const GRAPH = 'eg_svc_backlog01' as never

interface Face {
  service: EvidenceService
  store: Awaited<ReturnType<typeof storeHarness>>['store']
  wake: ReturnType<typeof vi.fn>
  close: () => Promise<void>
}

async function serviceHarness(): Promise<Face> {
  const harness = await storeHarness()
  const ctx = new Context()
  ctx.provide('evidenceStore', harness.store)
  const service = new EvidenceService(ctx, {
    preview: { fragmentMaxBytes: 1, textMaxLines: 1, tableMaxRows: 1, tableMaxColumns: 1, tableMaxCells: 1 },
  })
  const wake = vi.fn()
  harness.store.compileWakeNotifier = wake
  return {
    service,
    store: harness.store,
    wake,
    close: async () => {
      await harness.close()
      await ctx.fiber.dispose()
    },
  }
}

const agentOf = (sessionId: string): never => ({ session: { id: sessionId } }) as never

async function seedGraph(store: Awaited<ReturnType<typeof storeHarness>>['store']): Promise<void> {
  await store.sessionGraphs.put(SESSION, {
    recordVersion: 'animalge.session-graph-bootstrap/v1',
    sessionId: SESSION,
    sessionCreatedAt: 1,
    graphId: GRAPH,
    initialScope: { kind: 'session', graphId: GRAPH, sessionId: SESSION, sessionCreatedAt: 1 },
    state: 'ready',
  })
}

describe('EvidenceService.processBacklog (§11.4-2)', () => {
  it('returns scope_mismatch for a Session without a Graph', async () => {
    const face = await serviceHarness()
    try {
      const response = await face.service.processBacklog(agentOf('sess_unknown'))
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error.code).toBe('scope_mismatch')
      expect(face.wake).not.toHaveBeenCalled()
    } finally { await face.close() }
  })

  it('delegates to the owner verb: triggered outcome lowers the persisted row and wakes compile', async () => {
    const face = await serviceHarness()
    try {
      await seedGraph(face.store)
      await face.store.admitOutbox({
        graphId: GRAPH,
        sessionId: SESSION,
        targetNextSeqExclusive: 12,
        firstBoundarySeq: 10,
        lastBoundarySeq: 11,
        boundaryCount: 1,
        reasonCounts: { tool_result: 0, code_dispatch: 0, turn_end: 1, startup_scan: 0, retry: 0 },
        firstQueuedAt: 1,
        lastQueuedAt: 1,
        eligibleAfter: Date.now() + 60_000,
        retryNotBefore: 0,
        overflowed: false,
        latestAdmittedTarget: 12,
      })
      const response = await face.service.processBacklog(agentOf(SESSION))
      expect(response.ok).toBe(true)
      if (response.ok) expect(response.outcome).toBe('triggered')
      const row = face.store.outbox.get(GRAPH)
      expect(row).toBeDefined()
      expect(row!.eligibleAfter).toBeLessThanOrEqual(Date.now())
      expect(face.wake).toHaveBeenCalledTimes(1)
    } finally { await face.close() }
  })

  it('reports idle through the typed union when the Graph has no backlog', async () => {
    const face = await serviceHarness()
    try {
      await seedGraph(face.store)
      const response = await face.service.processBacklog(agentOf(SESSION))
      expect(response.ok).toBe(true)
      if (response.ok) expect(response.outcome).toBe('idle')
      expect(face.wake).not.toHaveBeenCalled()
    } finally { await face.close() }
  })
})
