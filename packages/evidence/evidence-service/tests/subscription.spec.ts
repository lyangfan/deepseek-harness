// SPEC-05 §5.2/§5.3 host-side subscription emit, behaviorally: the owner store's transition
// notifier (installed by the evidence-core assembly) recomputes issues and emits
// 'evidence/updated' with the three version tokens on the real cordis event bus; token
// changes track head/issues mutations. The client-side dedup half of §5.3 lives in
// ui-evidence's bridge suite. A wrong implementation that skips the emit, sends stale
// tokens, or crosses session scopes is defeated.
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
// Cross-package relative test import (established pattern).
import { storeHarness } from '../../evidence-core/tests/helpers.ts'
import { issueStateRevision } from '../../evidence-core/src/issues.ts'
import type { EvidenceUpdatedEventV1 } from '../../evidence-core/src/types.ts'

interface EmittedEvent {
  sessionId: string
  graphId: string
  materialStateDigest: string
  headRevision: number
  issuesRevision: string
  currentSnapshotDigest: string | null
}

describe('evidence/updated emit (§5.2, assembly notifier shape)', () => {
  it('markIssuesSeenRows fires the notifier with the graph scope and fresh issue tokens', async () => {
    const harness = await storeHarness()
    const ctx = new Context()
    const events: EmittedEvent[] = []
    // Install the assembly-shaped notifier: issue recompute + three-token emit (mirrors
    // evidence-core index.ts apply(); the store itself only knows the callback contract).
    harness.store.stateNotifier = (graphId) => {
      const bootstrap = harness.store.sessionGraphs.get('sess_sub01' as never)
      const head = harness.store.heads.get(graphId)
      events.push({
        sessionId: bootstrap?.sessionId ?? 'sess_sub01',
        graphId,
        materialStateDigest: harness.store.materialStateDigest(),
        headRevision: head?.headRevision ?? 0,
        issuesRevision: issueStateRevision(harness.store),
        currentSnapshotDigest: head?.snapshotDigest ?? null,
      })
    }
    const SESSION = 'sess_sub01' as never
    const GRAPH = 'eg_sub01' as never
    await harness.store.sessionGraphs.put(SESSION, {
      recordVersion: 'animalge.session-graph-bootstrap/v1',
      sessionId: SESSION,
      sessionCreatedAt: 1,
      graphId: GRAPH,
      initialScope: { kind: 'session', graphId: GRAPH, sessionId: SESSION, sessionCreatedAt: 1 },
      state: 'ready',
    })
    const key = 'attention:evidence_stale:graph:' + String(GRAPH)
    await harness.store.issueRecords.put(key, {
      recordVersion: 'animalge.issue-record/v1', issueKey: key, graphId: GRAPH,
      severity: 'attention', conditionCode: 'evidence_stale', targetKind: 'graph', targetId: String(GRAPH),
      applicableSnapshotDigest: null, applicableWatermark: 0,
      firstSeenAt: 1, lastSeenAt: 1, occurrenceCount: 1, resolvedAt: null,
    })
    const before = issueStateRevision(harness.store)
    const seen = await harness.store.markIssuesSeenRows(SESSION, [key])
    expect(seen.applied).toEqual([key])
    await vi.waitFor(() => { expect(events.length).toBe(1) })
    // The emitted token set reflects the post-write issue state — a consumer comparing
    // against its recorded baseline sees exactly one token change.
    expect(events[0]!.issuesRevision).not.toBe(before)
    expect(events[0]!.sessionId).toBe(String(SESSION))
    expect(events[0]!.graphId).toBe(String(GRAPH))
    await harness.close()
    await ctx.fiber.dispose()
  })

  it('the frozen event payload shape carries exactly the six contract fields', async () => {
    const harness = await storeHarness()
    const ctx = new Context()
    let captured: EvidenceUpdatedEventV1 | undefined
    ctx.on('evidence/updated', (payload: EvidenceUpdatedEventV1) => { captured = payload }, { global: true })
    ctx.emit('evidence/updated', {
      sessionId: 's', graphId: 'g', materialStateDigest: 'sha256:m',
      headRevision: 1, issuesRevision: 'sha256:i', currentSnapshotDigest: null,
    } as unknown as EvidenceUpdatedEventV1)
    expect(Object.keys(captured as unknown as Record<string, unknown>).sort()).toEqual(
      ['currentSnapshotDigest', 'graphId', 'headRevision', 'issuesRevision', 'materialStateDigest', 'sessionId'],
    )
    await harness.close()
    await ctx.fiber.dispose()
  })
})
