/**
 * Preview Lite and full-file open (SPEC-05 §7, D-144/D-163). The owner re-verifies the frozen
 * quadruple (scope, relation, locator, digest, selector) against the exact Snapshot projection
 * and the current bytes, then returns one bounded fragment of the six frozen kinds. Renderers
 * never read paths or bytes; nothing here writes graph state.
 */

import { computeAnchorSlice, sha256Digest } from '@deepseek-ai/dsh-evidence-core'
import type { ArtifactVersionNodePayloadV1, EvidenceSnapshotPayloadV1, LocationAvailabilityObservationV1, Sha256Digest, SourceAnchorRecordV1 } from '@deepseek-ai/dsh-evidence-core/types'
import type { EvidenceGraphId } from '@deepseek-ai/dsh-evidence-core/types'
import type { Context } from '@deepseek-ai/cordis'
import type FileSystem from '@deepseek-ai/dsh-fs'
import type { EvidenceStore } from '@deepseek-ai/dsh-evidence-core'
import type { PreviewResult, VerificationPair } from './types.ts'

/** D-145 default budgets (Config-adjustable; wired from the service Config in index.ts). */
export interface PreviewBudgets {
  readonly fragmentMaxBytes: number
  readonly textMaxLines: number
  readonly tableMaxRows: number
  readonly tableMaxColumns: number
  readonly tableMaxCells: number
}

export const DEFAULT_PREVIEW_BUDGETS: PreviewBudgets = {
  fragmentMaxBytes: 262_144,
  textMaxLines: 200,
  tableMaxRows: 100,
  tableMaxColumns: 50,
  tableMaxCells: 5_000,
}

interface FrozenCheck {
  readonly frozen: LocationAvailabilityObservationV1 | null
  readonly node: ArtifactVersionNodePayloadV1 | null
}

/** Locate the ArtifactVersion node payload + its frozen location observation (§7.1 item 3). */
export function frozenObservationOf(store: EvidenceStore, payload: EvidenceSnapshotPayloadV1, artifactVersionId: string): FrozenCheck {
  for (const node of payload.nodes) {
    if (node.nodeKind !== 'ArtifactVersion') continue
    const nodePayload = node.payload
    if (nodePayload.artifactVersionId !== artifactVersionId) continue
    return { frozen: store.locationObservations.get(nodePayload.frozenLocationObservationId) ?? null, node: nodePayload }
  }
  return { frozen: null, node: null }
}

/** Read the current bytes at a locator, bounded to the frozen version's byte length: a grown or
 * shrunk file truncates or short-reads and therefore fails the digest check (new bytes never
 * masquerade as the historical version, §7.5). */
async function readCurrentBytes(ctx: Context, locator: string, byteLength: number): Promise<Uint8Array | null> {
  const fs = ctx.fs as FileSystem | undefined
  if (fs === undefined) return null
  try {
    const target = await fs.resolve(locator)
    return await fs.readBytes(target, undefined, byteLength)
  } catch {
    return null
  }
}

/**
 * The owner preview path (§7.1): every failure returns an `unavailable` fragment with the named
 * reason — never a guessed slice. The four-layer verification block carries the Snapshot-frozen
 * observation and the fresh `checkedAt` check side by side (§7.3).
 */
export async function buildPreview(
  ctx: Context,
  store: EvidenceStore,
  graphId: EvidenceGraphId,
  payload: EvidenceSnapshotPayloadV1,
  artifactVersionId: string,
  sourceAnchorId: string,
  budgets: PreviewBudgets,
): Promise<PreviewResult> {
  void graphId
  const checkedAt = Date.now()
  const { frozen, node } = frozenObservationOf(store, payload, artifactVersionId)
  const verification = (currentCheck: VerificationPair['currentCheck']): VerificationPair => ({
    snapshotFrozen: frozen === null ? null : { availability: frozen.availability, observedAt: frozen.observedAt },
    currentCheck,
  })
  const unavailableWith = (reason: string): PreviewResult => ({ fragment: { kind: 'unavailable', reason }, checkedAt, verification: verification(null) })
  if (node === null || frozen === null) return unavailableWith('locator_invalid')
  const bytes = await readCurrentBytes(ctx, frozen.locator, node.byteLength)
  if (bytes === null) return unavailableWith('artifact_bytes_unavailable')
  const integrity = sha256Digest(bytes) === node.contentDigest && bytes.byteLength === node.byteLength ? 'matched' : 'content_mismatch'
  if (integrity === 'content_mismatch') {
    return { fragment: { kind: 'unavailable', reason: 'content_mismatch' }, checkedAt, verification: verification({ availability: 'available', integrity, checkedAt }) }
  }
  const verified = verification({ availability: 'available', integrity, checkedAt })

  const anchor = store.sourceAnchors.get(sourceAnchorId)
  if (anchor === undefined || anchor.sourceVersionRef !== artifactVersionId) return unavailableWith('selector_unverifiable')
  let slice: { slice: string; digest: Sha256Digest }
  try {
    slice = computeAnchorSlice(anchor.sourceKind, anchor.selector, bytes)
  } catch {
    return unavailableWith('selector_unverifiable')
  }
  if (anchor.selectedDigest !== null && slice.digest !== anchor.selectedDigest) return unavailableWith('selector_unverifiable')

  if (anchor.sourceKind === 'text') {
    const allLines = slice.slice.split('\n')
    const startLine = textStartLineOf(anchor)
    const capped = allLines.slice(0, budgets.textMaxLines)
    return {
      fragment: {
        kind: 'text',
        lines: capped.map((text, index) => ({ lineNo: startLine + index, text })),
        startLine,
        endLine: startLine + capped.length - 1,
        truncated: allLines.length > budgets.textMaxLines || Buffer.byteLength(slice.slice, 'utf8') > budgets.fragmentMaxBytes,
      },
      checkedAt,
      verification: verified,
    }
  }
  if (anchor.sourceKind === 'csv_table') {
    const parsed = parseCsvTable(anchor, slice.slice, budgets)
    return {
      fragment: {
        kind: 'table',
        columns: parsed.columns,
        rows: parsed.rows,
        totalRows: parsed.totalRows,
        truncated: parsed.truncated,
      },
      checkedAt,
      verification: verified,
    }
  }
  // Registered anchor kinds cover text/csv_table today; document/web anchors are honest named
  // denies until their verifiers exist (§7.2 maps unregistrable kinds to `metadata`/`unavailable`).
  if (anchor.sourceKind === 'pdf' || anchor.sourceKind === 'html') {
    return { fragment: { kind: 'metadata', mediaType: node.mediaType, byteLength: node.byteLength }, checkedAt, verification: verified }
  }
  return unavailableWith('unsupported')
}

function textStartLineOf(anchor: SourceAnchorRecordV1): number {
  const selector = anchor.selector as { kind?: string; startLine?: number }
  return selector.kind === 'text_line_range' && typeof selector.startLine === 'number' ? selector.startLine : 1
}

/** CSV projection under the triple table budget (rows, columns, cells — all simultaneously).
 * The anchor owner's canonical slice for csv_table is the selected cells joined by U+241F
 * (see computeAnchorSlice), row-major over the FULL selector column set — decode against
 * that column count, then project each row down to the budgeted columns. */
interface ParsedTable { columns: string[]; rows: string[][]; totalRows: number; truncated: boolean }

function parseCsvTable(anchor: SourceAnchorRecordV1, slice: string, budgets: PreviewBudgets): ParsedTable {
  if (slice.length === 0) return { columns: [], rows: [], totalRows: 0, truncated: false }
  const selector = anchor.selector as { columns?: Array<string | number> }
  const allColumns = (selector.columns ?? []).map(String)
  const wanted = allColumns.slice(0, budgets.tableMaxColumns)
  const cells = slice.split('\u241f')
  const columnCount = Math.max(1, allColumns.length)
  const totalRows = Math.floor(cells.length / columnCount)
  const rows: string[][] = []
  for (let rowIndex = 0; rowIndex < Math.min(totalRows, budgets.tableMaxRows); rowIndex += 1) {
    if ((rows.length + 1) * wanted.length > budgets.tableMaxCells) break
    rows.push(cells.slice(rowIndex * columnCount, rowIndex * columnCount + columnCount).slice(0, wanted.length))
  }
  return {
    columns: wanted,
    rows,
    totalRows,
    truncated: totalRows > rows.length || allColumns.length > wanted.length,
  }
}

/**
 * Full-file open handoff (§7.5): re-verify the frozen locator still matches the same
 * digest/length, then return the process path for the gated host `openPath` call.
 */
export async function buildOpenTarget(
  ctx: Context,
  store: EvidenceStore,
  payload: EvidenceSnapshotPayloadV1,
  artifactVersionId: string,
): Promise<{ ok: true; path: string; checkedAt: number } | { ok: false; reason: string }> {
  const { frozen, node } = frozenObservationOf(store, payload, artifactVersionId)
  if (node === null || frozen === null) return { ok: false, reason: 'locator_invalid' }
  const bytes = await readCurrentBytes(ctx, frozen.locator, node.byteLength)
  if (bytes === null) return { ok: false, reason: 'artifact_bytes_unavailable' }
  if (sha256Digest(bytes) !== node.contentDigest || bytes.byteLength !== node.byteLength) return { ok: false, reason: 'content_mismatch' }
  const fs = ctx.fs as FileSystem | undefined
  if (fs === undefined) return { ok: false, reason: 'unsupported' }
  try {
    return { ok: true, path: fs.processPath(await fs.resolve(frozen.locator)), checkedAt: Date.now() }
  } catch {
    return { ok: false, reason: 'locator_invalid' }
  }
}
