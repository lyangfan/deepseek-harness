/** S02-A05: typed SourceAnchor profiles, owner verification, and fail-closed re-verification. */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSuiteSummary } from './summary.ts'
import { materialHarness } from './helpers.ts'
import { AnchorError } from '../src/anchor.ts'
import type { SourceAnchorOwner } from '../src/anchor.ts'
import type { EvidenceStore } from '../src/store.ts'
import { evidenceNodeSchema } from '../src/schema.ts'

let root = ''
let anchors: SourceAnchorOwner
let store: EvidenceStore
let artifacts: import('../src/artifact.ts').ArtifactProvider
let close: () => Promise<void>

beforeEach(async () => {
  const harness = await materialHarness()
  root = await mkdtemp(join(tmpdir(), 'spec02-anchors-'))
  anchors = harness.anchors
  store = harness.store
  artifacts = harness.artifacts
  close = harness.close
})

afterEach(async () => {
  await close()
  await rm(root, { recursive: true, force: true })
})

const LOG = ['header line', 'SNP rs1 p=1e-9', 'SNP rs2 p=1e-7', 'footer'].join('\n')
const TABLE = ['id,beta,p\nrs1,0.25,1e-9\nrs2,0.31,1e-7\nrs3,0.11,0.05'].join('\n')

describe('S02-A05 text profile', () => {
  it('registers and re-verifies a line-range anchor with a slice digest', async () => {
    const path = join(root, 'scan.log')
    await writeFile(path, LOG, 'utf8')
    const captured = await artifacts.captureFile({ role: 'log', locator: path }, { createdBy: 'runner_log' })
    const anchor = await anchors.register({
      sourceVersionRef: captured.artifactVersionId,
      sourceKind: 'text',
      selector: { kind: 'text_line_range', startLine: 2, endLine: 3, selectedTextDigest: null },
    })
    expect(anchor.selectedDigest).toMatch(/^sha256:/)
    expect(await anchors.reverify(anchor.anchorId)).toMatchObject({ code: 'verified' })
  })

  it('rejects out-of-range line selectors under the named breakpoint', async () => {
    const path = join(root, 'short.log')
    await writeFile(path, 'one\n', 'utf8')
    const captured = await artifacts.captureFile({ role: 'log', locator: path }, { createdBy: 'runner_log' })
    await expect(anchors.register({
      sourceVersionRef: captured.artifactVersionId,
      sourceKind: 'text',
      selector: { kind: 'text_line_range', startLine: 1, endLine: 9, selectedTextDigest: null },
    })).rejects.toMatchObject({ code: 'anchor_selector_out_of_range' })
  })
})

describe('S02-A05 csv_table profile', () => {
  it('anchors a row by stable key and column name, and re-verifies after the owner round trip', async () => {
    const path = join(root, 'gwas.csv')
    await writeFile(path, TABLE, 'utf8')
    const captured = await artifacts.captureFile({ role: 'table', locator: path }, { createdBy: 'runner_output' })
    const anchor = await anchors.register({
      sourceVersionRef: captured.artifactVersionId,
      sourceKind: 'csv_table',
      selector: { kind: 'csv_table_slice', header: true, rowKeys: ['rs2'], rowRange: null, columns: ['id', 'p'] },
    })
    expect(anchor.selectedDigest).toMatch(/^sha256:/)
    expect((await anchors.reverify(anchor.anchorId) as { code: string }).code).toBe('verified')
  })

  it('fails closed with anchor_digest_mismatch when a stored anchor no longer matches its selector digest', async () => {
    const path = join(root, 'mut.csv')
    await writeFile(path, TABLE, 'utf8')
    const captured = await artifacts.captureFile({ role: 'table', locator: path }, { createdBy: 'runner_output' })
    const anchor = await anchors.register({
      sourceVersionRef: captured.artifactVersionId,
      sourceKind: 'text',
      selector: { kind: 'text_line_range', startLine: 2, endLine: 2, selectedTextDigest: null },
    })
    const tampered = { ...anchor, selectedDigest: 'sha256:' + '0'.repeat(64) as `sha256:${string}` }
    await store.putMaterialRecord(store.sourceAnchors, `${tampered.anchorId}@${Date.now()}`, tampered)
    expect(await anchors.reverify(anchor.anchorId)).toMatchObject({ code: 'anchor_digest_mismatch' })
  })
})

describe('S02-A05 fail-closed boundaries', () => {
  it('rejects unregistered anchor kinds and unknown row keys', async () => {
    const path = join(root, 'x.log')
    await writeFile(path, LOG, 'utf8')
    const captured = await artifacts.captureFile({ role: 'log', locator: path }, { createdBy: 'runner_log' })
    await expect(anchors.register({
      sourceVersionRef: captured.artifactVersionId,
      sourceKind: 'pdf',
      selector: { page: 3 },
    })).rejects.toMatchObject({ code: 'unsupported_anchor_kind' })
    await expect(anchors.register({
      sourceVersionRef: captured.artifactVersionId,
      sourceKind: 'csv_table',
      selector: { kind: 'csv_table_slice', header: false, rowKeys: ['missing'], rowRange: null, columns: [0] },
    })).rejects.toBeInstanceOf(AnchorError)
  })

  it('reports anchor_source_unavailable when the source bytes no longer match the version', async () => {
    const path = join(root, 'gone.log')
    await writeFile(path, LOG, 'utf8')
    const captured = await artifacts.captureFile({ role: 'log', locator: path }, { createdBy: 'runner_log' })
    const anchor = await anchors.register({
      sourceVersionRef: captured.artifactVersionId,
      sourceKind: 'text',
      selector: { kind: 'text_line_range', startLine: 1, endLine: 1, selectedTextDigest: null },
    })
    await writeFile(path, 'replaced bytes', 'utf8')
    expect(await anchors.reverify(anchor.anchorId)).toMatchObject({ code: 'anchor_source_unavailable' })
  })

  it('keeps SourceAssertion nodes fail closed (anchors are values, not graph nodes)', () => {
    const result = evidenceNodeSchema.safeParse({
      schemaVersion: 'animalge.evidence.node/v1',
      nodeId: 'en_x', graphId: 'eg_x', nodeKind: 'SourceAssertion',
      payloadSchema: 'animalge.source.assertion/v1', projectionState: 'active',
      identityRevision: 'animalge-identity/v1', sourceEventRefs: [], compiler: {},
      payload: {},
    })
    expect(result.success).toBe(false)
  })
})

registerSuiteSummary({ suiteId: 'source-anchor', acceptanceIds: ['S02-A05'], sessionPersistence: [''], evidenceStorage: ['memory'] })
