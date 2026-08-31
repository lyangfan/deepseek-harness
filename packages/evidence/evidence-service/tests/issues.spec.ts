// SPEC-05 §6 issue channel — behaviorally through the service's `issues` verb over a
// seeded owner store (unresolved filtering, unread counting from seen rows, resolution
// exposure, unknown-session named error) plus the frozen structural key/revision checks.
// Wrong implementations that leak resolved rows into the default view, count read items
// as unread, or mis-scope another graph's issues are defeated.
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { issueKeyOf, ISSUE_DERIVATION_REVISION } from '@deepseek-ai/dsh-evidence-core'
import { EvidenceService } from '../src/index.ts'
import { storeHarness } from '../../evidence-core/tests/helpers.ts'

const SESSION = 'sess_issues01' as never
const GRAPH = 'eg_issues01' as never

async function serviceHarness(): Promise<{ service: EvidenceService; store: Awaited<ReturnType<typeof storeHarness>>['store']; close: () => Promise<void> }> {
  const harness = await storeHarness()
  const ctx = new Context()
  ctx.provide('evidenceStore', harness.store)
  const service = new EvidenceService(ctx, {
    preview: { fragmentMaxBytes: 1, textMaxLines: 1, tableMaxRows: 1, tableMaxColumns: 1, tableMaxCells: 1 },
  })
  return {
    service,
    store: harness.store,
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

async function seedIssue(store: Awaited<ReturnType<typeof storeHarness>>['store'], key: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await store.issueRecords.put(key, {
    recordVersion: 'animalge.issue-record/v1',
    issueKey: key,
    graphId: GRAPH,
    severity: 'attention',
    conditionCode: 'evidence_stale',
    targetKind: 'graph',
    targetId: String(GRAPH),
    applicableSnapshotDigest: null,
    applicableWatermark: 0,
    firstSeenAt: 1,
    lastSeenAt: 2,
    occurrenceCount: 3,
    resolvedAt: null,
    ...overrides,
  })
}

describe('issueKeyOf (§6.3 closed structural key)', () => {
  it('attention key format', () => {
    expect(issueKeyOf('attention', 'evidence_stale', 'graph', 'eg_1')).toBe('attention:evidence_stale:graph:eg_1')
  })

  it('action_required key format', () => {
    expect(issueKeyOf('action_required', 'evidence_unavailable', 'graph', 'eg_2')).toBe('action_required:evidence_unavailable:graph:eg_2')
  })

  it('object-level key uses targetKind node', () => {
    expect(issueKeyOf('attention', 'software_version_missing', 'node', 'en_abc')).toBe('attention:software_version_missing:node:en_abc')
  })

  it('is the frozen animalge-issue/v1', () => {
    expect(ISSUE_DERIVATION_REVISION).toBe('animalge-issue/v1')
  })
})

describe('EvidenceService.issues (§6.4, behavioral)', () => {
  it('default view hides resolved rows and reports unread from seen rows only', async () => {
    const face = await serviceHarness()
    try {
      await seedGraph(face.store)
      await seedIssue(face.store, 'attention:stale:graph:g1')
      await seedIssue(face.store, 'attention:stale:graph:g2')
      await seedIssue(face.store, 'attention:stale:graph:g3', { resolvedAt: 99 })
      await face.store.issueSeen.put('attention:stale:graph:g1', { recordVersion: 'animalge.issue-seen/v1', issueKey: 'attention:stale:graph:g1', seenAt: 5 })
      const response = face.service.issues(agentOf(String(SESSION)), { includeResolved: false })
      expect(response.ok).toBe(true)
      if (!response.ok) return
      // Resolved hidden by default; the seen one carries seenAt; unread counts only unseen unresolved.
      expect(response.view.items.map(item => item.issueKey).sort()).toEqual(['attention:stale:graph:g1', 'attention:stale:graph:g2'])
      expect(response.view.unread).toBe(1)
      const seenRow = response.view.items.find(item => item.issueKey === 'attention:stale:graph:g1')
      expect(seenRow?.seenAt).toBe(5)
      // includeResolved surfaces the resolved row with its resolution timestamp.
      const withResolved = face.service.issues(agentOf(String(SESSION)), { includeResolved: true })
      expect(withResolved.ok && withResolved.view.items.some(item => item.issueKey === 'attention:stale:graph:g3' && item.resolvedAt === 99)).toBe(true)
    } finally { await face.close() }
  })

  it('scopes strictly per graph — another graph\'s records never appear', async () => {
    const face = await serviceHarness()
    try {
      await seedGraph(face.store)
      await seedIssue(face.store, 'attention:other:graph:othergraph', { graphId: 'eg_other', targetId: 'eg_other' })
      const response = face.service.issues(agentOf(String(SESSION)), { includeResolved: false })
      expect(response.ok).toBe(true)
      if (!response.ok) return
      expect(response.view.items).toHaveLength(0)
      expect(response.view.unread).toBe(0)
    } finally { await face.close() }
  })

  it('returns scope_mismatch for a session without a graph', async () => {
    const face = await serviceHarness()
    try {
      const response = face.service.issues(agentOf('sess_unknown'), { includeResolved: false })
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error.code).toBe('scope_mismatch')
    } finally { await face.close() }
  })
})
