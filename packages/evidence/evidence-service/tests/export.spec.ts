// SPEC-05 §8 export, behaviorally: a real compiled Snapshot committed through the owner
// store, exported through the service verb, and re-verified externally — digest-bound bytes,
// canonical form, idempotent re-export, and the graph-less named error. A wrong
// implementation that exports unstaged bytes, drifts between exports, or fabricates a
// digest binding is defeated.
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { verifyEvidenceExport } from '@deepseek-ai/dsh-evidence-core'
import { EvidenceService } from '../src/index.ts'
// Cross-package relative test import (established pattern).
import { snapshotRecord } from '../../evidence-core/src/integrity.ts'
import { compiledFixture, graphId as FIXTURE_GRAPH, header, storeHarness } from '../../evidence-core/tests/helpers.ts'

// The compiled fixture binds its own Session/graph identity — the committed history must
// match it for integrity verification to pass.
const SESSION = header.id
const GRAPH = FIXTURE_GRAPH

async function serviceWithCommittedSnapshot(): Promise<{ service: EvidenceService; digest: string; close: () => Promise<void> }> {
  const harness = await storeHarness()
  const ctx = new Context()
  ctx.provide('evidenceStore', harness.store)
  const service = new EvidenceService(ctx, {
    preview: { fragmentMaxBytes: 1, textMaxLines: 1, tableMaxRows: 1, tableMaxColumns: 1, tableMaxCells: 1 },
  })
  const record = snapshotRecord(compiledFixture().payload)
  const digest = record.snapshotDigest
  await harness.store.snapshots.put(digest, record)
  await harness.store.headCommits.put('hc_export01' as never, {
    recordVersion: 'animalge.head-commit/v1',
    graphId: GRAPH,
    headRevision: 1,
    previousSnapshotDigest: null,
    snapshotDigest: digest,
    kind: 'compile',
    operationId: 'op_export01',
    committedAt: 1,
  })
  await harness.store.heads.put(GRAPH, {
    recordVersion: 'animalge.current-head/v1',
    graphId: GRAPH,
    snapshotDigest: digest,
    headRevision: 1,
    previousSnapshotDigest: null,
    previousHeadRevision: null,
  })
  await harness.store.sessionGraphs.put(SESSION, {
    recordVersion: 'animalge.session-graph-bootstrap/v1',
    sessionId: SESSION,
    sessionCreatedAt: 1,
    graphId: GRAPH,
    initialScope: { kind: 'session', graphId: GRAPH, sessionId: SESSION, sessionCreatedAt: 1 },
    state: 'ready',
  })
  return {
    service,
    digest,
    close: async () => {
      await harness.close()
      await ctx.fiber.dispose()
    },
  }
}

const agentOf = (sessionId: string): never => ({ session: { id: sessionId } }) as never

describe('EvidenceService.exportSnapshot (§8)', () => {
  it('returns canonical bytes whose externally recomputed envelope binds the exact requested digest', async () => {
    const face = await serviceWithCommittedSnapshot()
    try {
      const response = face.service.exportSnapshot(agentOf(SESSION), { snapshotDigest: face.digest })
      expect(response.ok).toBe(true)
      if (!response.ok) return
      expect(response.export.filename).toBe(`animalge-evidence-${face.digest.replace(/^sha256:/, '')}.json`)
      // External re-verification (the E03 rule: recompute outside the service): the bytes
      // parse canonically and the envelope's digest equals the request.
      const envelope = verifyEvidenceExport(response.export.canonicalJson)
      expect(envelope.snapshotDigest).toBe(face.digest)
      expect(response.export.canonicalJson.endsWith('\n')).toBe(true)
    } finally { await face.close() }
  })

  it('is idempotent — a second export of the same digest is byte-identical', async () => {
    const face = await serviceWithCommittedSnapshot()
    try {
      const first = face.service.exportSnapshot(agentOf(SESSION), { snapshotDigest: face.digest })
      const second = face.service.exportSnapshot(agentOf(SESSION), { snapshotDigest: face.digest })
      expect(first.ok && second.ok).toBe(true)
      if (!first.ok || !second.ok) return
      expect(second.export.canonicalJson).toBe(first.export.canonicalJson)
      expect(second.export.filename).toBe(first.export.filename)
    } finally { await face.close() }
  })

  it('fails closed with snapshot_not_found for a digest that is not committed history', async () => {
    const face = await serviceWithCommittedSnapshot()
    try {
      const forged = `sha256:${'f'.repeat(64)}`
      const response = face.service.exportSnapshot(agentOf(SESSION), { snapshotDigest: forged })
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error.code).toBe('snapshot_not_found')
    } finally { await face.close() }
  })

  it('returns scope_mismatch for a Session without a graph', async () => {
    const face = await serviceWithCommittedSnapshot()
    try {
      const response = face.service.exportSnapshot(agentOf('sess_none'), { snapshotDigest: face.digest })
      expect(response.ok).toBe(false)
      if (!response.ok) expect(response.error.code).toBe('scope_mismatch')
    } finally { await face.close() }
  })
})
