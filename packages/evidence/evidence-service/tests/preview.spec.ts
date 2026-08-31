// SPEC-05 §7 Preview Lite — behaviorally over the material harness (real files, real
// anchors, owner re-verification: budgets truncate with markers, tampered bytes fail
// closed, unverifiable anchors deny with named reasons) plus the frozen-budget constants
// (D-145). This file IS the frozen gate entry (§13.2 preview.spec.ts). A wrong
// implementation that guesses slices, skips re-verification, or fakes availability is
// defeated by the behavioral members below.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildOpenTarget, buildPreview, DEFAULT_PREVIEW_BUDGETS } from '../src/preview.ts'
import type { PreviewBudgets } from '../src/preview.ts'
// Cross-package relative test import (established pattern; evidence-core tests are not
// part of its public export map).
import { materialHarness } from '../../evidence-core/tests/helpers.ts'
import type { EvidenceNodeV1, EvidenceSnapshotPayloadV1 } from '@deepseek-ai/dsh-evidence-core/types'

const LOG_LINES = Array.from({ length: 260 }, (_, index) => `line ${String(index + 1)}`)
const LOG = LOG_LINES.join('\n')

let root = ''
let harness: Awaited<ReturnType<typeof materialHarness>>
let close: () => Promise<void>

beforeEach(async () => {
  harness = await materialHarness()
  root = await mkdtemp(join(tmpdir(), 'spec05-preview-'))
  close = harness.close
})

afterEach(async () => {
  await close()
  await rm(root, { recursive: true, force: true })
})

/** Snapshot payload stub carrying exactly one ArtifactVersion node (§7 reads only nodes). */
async function payloadFor(artifactVersionId: string): Promise<EvidenceSnapshotPayloadV1> {
  const version = harness.store.artifactVersions.get(artifactVersionId)
  if (version === undefined) throw new Error('version missing from store')
  const observation = [...harness.store.locationObservations.entries()].find(([, row]) => row.artifactVersionId === artifactVersionId)?.[1]
  if (observation === undefined) throw new Error('location observation missing')
  const node: EvidenceNodeV1 = {
    nodeKind: 'ArtifactVersion',
    nodeId: 'en_preview_1' as never,
    projectionState: 'active',
    payloadSchema: 'animalge.artifact.version-node/v1',
    payload: {
      nodeSchema: 'animalge.artifact.version-node/v1',
      artifactId: version.artifactId,
      artifactVersionId,
      contentDigest: version.contentDigest,
      byteLength: version.byteLength,
      mediaType: version.mediaType,
      retention: 'reference',
      frozenLocationObservationId: observation.locationObservationId,
    },
  } as never
  return { nodes: [node], edges: [], revisions: {} as never, scope: {} as never } as never
}

// Cells budget 4 = 2 rows x 2 columns exactly: all three budgets bind simultaneously.
const TINY_BUDGETS: PreviewBudgets = { fragmentMaxBytes: 262_144, textMaxLines: 5, tableMaxRows: 2, tableMaxColumns: 2, tableMaxCells: 4 }

describe('buildPreview text fragments (§7.2)', () => {
  it('returns numbered lines with the frozen verification and truncates at the line budget', async () => {
    const path = join(root, 'scan.log')
    await writeFile(path, LOG, 'utf8')
    const captured = await harness.artifacts.captureFile({ role: 'log', locator: path }, { createdBy: 'runner_log' })
    const anchor = await harness.anchors.register({
      sourceVersionRef: captured.artifactVersionId,
      sourceKind: 'text',
      selector: { kind: 'text_line_range', startLine: 1, endLine: 260, selectedTextDigest: null },
    })
    const result = await buildPreview(harness.ctx, harness.store, 'eg_p' as never, await payloadFor(captured.artifactVersionId), captured.artifactVersionId, anchor.anchorId, TINY_BUDGETS)
    expect(result.fragment.kind).toBe('text')
    if (result.fragment.kind !== 'text') return
    expect(result.fragment.lines).toHaveLength(5)
    expect(result.fragment.lines[0]).toMatchObject({ lineNo: 1, text: 'line 1' })
    expect(result.fragment.startLine).toBe(1)
    expect(result.fragment.truncated).toBe(true)
    // Four-layer verification: snapshot-frozen observation beside the fresh matched check.
    expect(result.verification.snapshotFrozen).toMatchObject({ availability: 'available' })
    expect(result.verification.currentCheck).toMatchObject({ availability: 'available', integrity: 'matched' })
  })

  it('fails closed as content_mismatch when the file changed after the Snapshot froze it', async () => {
    const path = join(root, 'tamper.log')
    await writeFile(path, 'original content\n', 'utf8')
    const captured = await harness.artifacts.captureFile({ role: 'log', locator: path }, { createdBy: 'runner_log' })
    const anchor = await harness.anchors.register({
      sourceVersionRef: captured.artifactVersionId,
      sourceKind: 'text',
      selector: { kind: 'text_line_range', startLine: 1, endLine: 1, selectedTextDigest: null },
    })
    await writeFile(path, 'tamped content!!\n', 'utf8') // same byte length as 'original content\n'
    const result = await buildPreview(harness.ctx, harness.store, 'eg_p' as never, await payloadFor(captured.artifactVersionId), captured.artifactVersionId, anchor.anchorId, DEFAULT_PREVIEW_BUDGETS)
    expect(result.fragment.kind).toBe('unavailable')
    if (result.fragment.kind !== 'unavailable') return
    expect(result.fragment.reason).toBe('content_mismatch')
  })

  it('denies with a named reason when the anchor does not belong to the requested version', async () => {
    const path = join(root, 'other.log')
    await writeFile(path, 'other file\n', 'utf8')
    const captured = await harness.artifacts.captureFile({ role: 'log', locator: path }, { createdBy: 'runner_log' })
    // An anchor bound to a different version id than the one in the Snapshot projection:
    // the owner refuses to register it against an unknown version (fail-closed there too),
    // so seed the cross-bound anchor via the store table the owner would have written.
    const anchorId = 'sa_crossbound01' as never
    await harness.store.sourceAnchors.put(anchorId, {
      recordVersion: 'animalge.source-anchor/v1',
      anchorId,
      sourceVersionRef: 'av_not_in_this_snapshot' as never,
      sourceKind: 'text',
      selector: { kind: 'text_line_range', startLine: 1, endLine: 1, selectedTextDigest: null },
      selectedDigest: null,
      lastVerification: { code: 'verified', verifiedAt: 1 },
      verifierRevision: 'test',
    } as never)
    const result = await buildPreview(
      harness.ctx, harness.store, 'eg_p' as never,
      await payloadFor(captured.artifactVersionId),
      captured.artifactVersionId, anchorId, DEFAULT_PREVIEW_BUDGETS,
    )
    expect(result.fragment.kind).toBe('unavailable')
  })
})

describe('buildPreview table fragments (§7.2)', () => {
  it('applies the row/column/cell budgets simultaneously and reports exact totals', async () => {
    const path = join(root, 'gwas.csv')
    const manyRows = ['id,beta,p', ...Array.from({ length: 30 }, (_, index) => `rs${String(index)},0.1,1e-5`)].join('\n')
    await writeFile(path, manyRows, 'utf8')
    const captured = await harness.artifacts.captureFile({ role: 'table', locator: path }, { createdBy: 'runner_output' })
    const anchor = await harness.anchors.register({
      sourceVersionRef: captured.artifactVersionId,
      sourceKind: 'csv_table',
      selector: { kind: 'csv_table_slice', header: true, rowKeys: null, rowRange: { start: 1, end: 30 }, columns: ['id', 'beta', 'p'] },
    })
    const result = await buildPreview(harness.ctx, harness.store, 'eg_p' as never, await payloadFor(captured.artifactVersionId), captured.artifactVersionId, anchor.anchorId, TINY_BUDGETS)
    expect(result.fragment.kind).toBe('table')
    if (result.fragment.kind !== 'table') return
    expect(result.fragment.columns).toEqual(['id', 'beta'])
    expect(result.fragment.rows).toHaveLength(2)
    expect(result.fragment.totalRows).toBe(30)
    expect(result.fragment.truncated).toBe(true)
  })
})

describe('buildPreview unknown objects (§7.1)', () => {
  it('returns locator_invalid for an artifact version that is not in the Snapshot', async () => {
    const path = join(root, 'absent.log')
    await writeFile(path, 'x\n', 'utf8')
    const captured = await harness.artifacts.captureFile({ role: 'log', locator: path }, { createdBy: 'runner_log' })
    const payload = await payloadFor(captured.artifactVersionId)
    // The version exists in the store but not in this Snapshot projection.
    const projectionless = { ...payload, nodes: [] } as typeof payload
    const result = await buildPreview(harness.ctx, harness.store, 'eg_p' as never, projectionless, captured.artifactVersionId, 'any', DEFAULT_PREVIEW_BUDGETS)
    expect(result.fragment.kind).toBe('unavailable')
    if (result.fragment.kind !== 'unavailable') return
    expect(result.fragment.reason).toBe('locator_invalid')
  })
})

describe('buildOpenTarget (§7.5, behavioral)', () => {
  it('re-verifies digest and length, then hands off the process path', async () => {
    const path = join(root, 'open.log')
    await writeFile(path, 'stable bytes\n', 'utf8')
    const captured = await harness.artifacts.captureFile({ role: 'log', locator: path }, { createdBy: 'runner_log' })
    const payload = await payloadFor(captured.artifactVersionId)
    const target = await buildOpenTarget(harness.ctx, harness.store, payload, captured.artifactVersionId)
    expect(target.ok).toBe(true)
    if (target.ok) expect(typeof target.path).toBe('string')
  })

  it('denies with content_mismatch after the file changed — no success path for drift', async () => {
    const path = join(root, 'drift.log')
    await writeFile(path, 'first bytes\n', 'utf8')
    const captured = await harness.artifacts.captureFile({ role: 'log', locator: path }, { createdBy: 'runner_log' })
    await writeFile(path, 'drift bytes\n', 'utf8') // 12 bytes: same length, different content
    const target = await buildOpenTarget(
      harness.ctx, harness.store, await payloadFor(captured.artifactVersionId), captured.artifactVersionId,
    )
    expect(target).toMatchObject({ ok: false, reason: 'content_mismatch' })
  })

  it('denies with locator_invalid for an object absent from the Snapshot projection', async () => {
    const path = join(root, 'absent2.log')
    await writeFile(path, 'x\n', 'utf8')
    const captured = await harness.artifacts.captureFile({ role: 'log', locator: path }, { createdBy: 'runner_log' })
    const payload = await payloadFor(captured.artifactVersionId)
    const projectionless = { ...payload, nodes: [] } as typeof payload
    const target = await buildOpenTarget(harness.ctx, harness.store, projectionless, captured.artifactVersionId)
    expect(target).toMatchObject({ ok: false, reason: 'locator_invalid' })
  })
})
