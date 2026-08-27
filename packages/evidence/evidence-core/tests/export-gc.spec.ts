import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPILER_REVISION } from '../src/compiler.ts'
import { buildEvidenceExport, explicitSnapshotDigest, verifyEvidenceExport, writeEvidenceExport } from '../src/export.ts'
import { collectEvidenceGarbage } from '../src/gc.ts'
import { snapshotRecord } from '../src/integrity.ts'
import { compiledFixture, header, storeHarness } from './helpers.ts'
import { recordSummaryPayload, registerSuiteSummary } from './summary.ts'

registerSuiteSummary({
  suiteId: 'export-gc',
  acceptanceIds: ['S01-A12', 'S01-A13', 'S01-A14'],
  sessionPersistence: [],
  evidenceStorage: ['memory'],
})

const roots: string[] = []
afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }) })

describe('S01-A12-A14 GC, budget and export', () => {
  it('exports exact canonical committed bytes idempotently with owner-only mode', async () => {
    const record = snapshotRecord(compiledFixture().payload)
    const built = buildEvidenceExport(record)
    expect(verifyEvidenceExport(built.bytes)).toEqual(built.envelope)
    recordSummaryPayload({ export_digest: built.envelope.snapshotDigest, export_bytes: built.bytes.length })
    const root = await mkdtemp(join(tmpdir(), 'dsh-evidence-export-')); roots.push(root)
    const path = await writeEvidenceExport(record, root)
    expect(await readFile(path, 'utf8')).toBe(built.bytes)
    expect((await lstat(path)).mode & 0o777).toBe(0o600)
    expect(await writeEvidenceExport(record, root)).toBe(path)
    await writeFile(path, 'different')
    await expect(writeEvidenceExport(record, root)).rejects.toMatchObject({ code: 'export_target_conflict' })
  })

  it('rejects malformed explicit digests, export bytes and symlink directories', async () => {
    expect(() => explicitSnapshotDigest('SHA256:nope')).toThrow()
    expect(() => verifyEvidenceExport('{}')).toThrow(/newline/)
    const root = await mkdtemp(join(tmpdir(), 'dsh-evidence-symlink-')); roots.push(root)
    const target = join(root, 'target'); const link = join(root, 'link')
    await rm(target, { recursive: true, force: true }).catch(() => {})
    await import('node:fs/promises').then(({ mkdir }) => mkdir(target))
    await symlink(target, link)
    await expect(writeEvidenceExport(snapshotRecord(compiledFixture().payload), link)).rejects.toMatchObject({ code: 'export_directory_invalid' })
  })

  it('gates export on committed history and fails closed for missing, uncommitted or corrupted material', async () => {
    const harness = await storeHarness()
    try {
      const scope = await harness.store.bootstrap(header)
      const fixture = compiledFixture('selection/v1', scope)
      for (const capture of fixture.folded.captures) await harness.store.saveCapture(capture)
      const now = Date.now()
      const row = await harness.store.admitOutbox({
        graphId: scope.graphId, sessionId: header.id, targetNextSeqExclusive: 6,
        firstBoundarySeq: 3, lastBoundarySeq: 5, boundaryCount: 2,
        reasonCounts: { tool_result: 1, code_dispatch: 0, turn_end: 1, startup_scan: 0, retry: 0 },
        firstQueuedAt: now, lastQueuedAt: now, eligibleAfter: now, retryNotBefore: 0, overflowed: false,
      })
      let attempt = await harness.store.dequeue(row, harness.store.currentHead(scope.graphId), {
        canonicalization: 'animalge-c14n-json/v1', identity: 'animalge-identity/v1',
        compiler: COMPILER_REVISION, captureContract: 'animalge-capture/v1', selectionRuleDigest: fixture.selection.digest,
      })
      attempt = await harness.store.startAttempt(attempt.attemptId)
      const head = await harness.store.commit(attempt, { ...fixture.payload, scope })

      const committed = harness.store.committedSnapshot(head.snapshotDigest!)
      const built = buildEvidenceExport(committed)
      expect(built.envelope.snapshotDigest).toBe(head.snapshotDigest)

      // An unpublished orphan record can never pass the committed-history gate.
      const orphan = snapshotRecord(compiledFixture('selection/orphan', scope).payload)
      await harness.store.snapshots.put(orphan.snapshotDigest, orphan)
      expect(() => harness.store.committedSnapshot(orphan.snapshotDigest)).toThrow(/not committed/)

      // A digest with no snapshot at all fails closed as missing.
      const missing = explicitSnapshotDigest('sha256:00000000000000000000000000000000000000000000000000000000000000ff')
      expect(() => harness.store.committedSnapshot(missing)).toThrow()

      // Tampered export bytes carrying a foreign digest fail verification.
      const foreign = built.bytes.replace(committed.snapshotDigest, orphan.snapshotDigest)
      expect(() => verifyEvidenceExport(foreign)).toThrow(/digest/)
      recordSummaryPayload({
        export_committed_gate: true,
        export_committed_digest: head.snapshotDigest ?? null,
        export_orphan_rejected: true,
      })
    } finally { await harness.close() }
  })

  it('aborts GC without deleting when heads changed during the pass', async () => {
    const harness = await storeHarness()
    try {
      const record = snapshotRecord(compiledFixture().payload)
      await harness.store.snapshots.put(record.snapshotDigest, record)
      const scope = await harness.store.bootstrap(header)
      const staleHeads = new Map([[scope.graphId, 'sha256:0000000000000000000000000000000000000000000000000000000000000000@0']])
      const result = await harness.store.deleteGarbage(staleHeads, [], [record.snapshotDigest])
      expect(result).toMatchObject({ deletedStaging: 0, deletedOrphans: 0, aborted: true })
      expect(harness.store.snapshots.get(record.snapshotDigest)).toBeDefined()
      recordSummaryPayload({ gc_head_change_abort: true })
    } finally { await harness.close() }
  })

  it('accounts control bytes and deletes only aged, twice-observed unreferenced objects', async () => {
    const harness = await storeHarness()
    try {
      const record = snapshotRecord(compiledFixture().payload)
      await harness.store.snapshots.put(record.snapshotDigest, record)
      const before = await harness.store.recount()
      expect(before.accountedBytes).toBeGreaterThan(0)
      const first = await collectEvidenceGarbage(harness.store, { stagingGcAgeMs: 0, orphanGcGraceMs: 100 }, 1_000)
      expect(first.deletedOrphans).toBe(0)
      const marker = [...harness.store.quarantine.entries()].map(([, row]) => row).find(row => row.objectKey === record.snapshotDigest)!
      const second = await collectEvidenceGarbage(harness.store, { stagingGcAgeMs: 0, orphanGcGraceMs: 100 }, marker.detectedAt + 101)
      expect(second.deletedOrphans).toBe(1)
      expect(harness.store.snapshots.get(record.snapshotDigest)).toBeUndefined()
    } finally { await harness.close() }
  })
})
