/** SourceAnchor owner: versioned selector profiles, verification, and fail-closed re-verification. */

import { canonicalDigest } from './canonical-json.ts'
import { newSourceAnchorId } from './identity.ts'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type { ArtifactVersionId, Sha256Digest, SourceAnchorRecordV1 } from './types.ts'
import { ArtifactConflictError, type ArtifactProvider } from './artifact.ts'
import type { EvidenceStore } from './store.ts'

/** Revision of the two v0.1 selector profiles (text line-range and csv table slice). */
export const SOURCE_ANCHOR_VERIFIER_REVISION = 'animalge-source-anchor-verifier/v1'

/** Registered v0.1 anchor profiles; every other source kind fails closed (SPEC-02 §5.1). */
export const REGISTERED_ANCHOR_KINDS: ReadonlySet<SourceAnchorRecordV1['sourceKind']> = new Set(['text', 'csv_table'])

/** Typed fail-closed anchor verification outcome (SPEC-02 §5.2 named breakpoints). */
export class AnchorError extends Error {
  constructor(
    readonly code: 'unsupported_anchor_kind' | 'anchor_source_unavailable' | 'anchor_digest_mismatch' | 'anchor_selector_out_of_range' | 'anchor_unresolvable' | 'anchor_not_found' | 'invalid_selector',
    message: string,
  ) {
    super(message)
    this.name = 'AnchorError'
  }
}

/** Line-range selector for text/markdown/log/script sources (1-based inclusive). */
export interface TextLineSelector {
  readonly kind: 'text_line_range'
  readonly startLine: number
  readonly endLine: number
  readonly selectedTextDigest: Sha256Digest | null
}

/** Table-slice selector for CSV/TSV: stable row keys or a row range plus a column range. */
export interface CsvTableSelector {
  readonly kind: 'csv_table_slice'
  readonly header: boolean
  readonly rowKeys: readonly string[] | null
  readonly rowRange: { readonly start: number; readonly end: number } | null
  readonly columns: readonly (string | number)[]
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function validateTextSelector(selector: TextLineSelector): void {
  const rangeOk = Number.isSafeInteger(selector.startLine) && Number.isSafeInteger(selector.endLine)
    && selector.startLine >= 1 && selector.startLine <= selector.endLine
  if (!rangeOk) {
    throw new AnchorError('invalid_selector', 'text selector requires 1-based startLine <= endLine')
  }
}

function validateCsvSelector(selector: CsvTableSelector): void {
  if (selector.rowKeys === null && selector.rowRange === null) throw new AnchorError('invalid_selector', 'csv selector requires rowKeys or rowRange')
  if (selector.rowKeys !== null && selector.rowRange !== null) throw new AnchorError('invalid_selector', 'csv selector cannot combine rowKeys and rowRange')
  if (selector.rowRange !== null && (!Number.isSafeInteger(selector.rowRange.start) || !Number.isSafeInteger(
    selector.rowRange.end) || selector.rowRange.start < 1 || selector.rowRange.start > selector.rowRange.end)) {
    throw new AnchorError('invalid_selector', 'csv rowRange requires 1-based start <= end')
  }
  if (selector.columns.length === 0) throw new AnchorError('invalid_selector', 'csv selector requires at least one column')
}

/** Compute the canonical slice bytes for one selector against the exact source version bytes. */
export function computeAnchorSlice(sourceKind: SourceAnchorRecordV1['sourceKind'], selector: JsonValue, source: Uint8Array): { readonly slice: string; readonly digest: Sha256Digest } {
  const text = decodeUtf8(source)
  if (sourceKind === 'text') {
    const value = selector as unknown as TextLineSelector
    validateTextSelector(value)
    const lines = text.split('\n')
    if (value.endLine > lines.length) throw new AnchorError('anchor_selector_out_of_range', `line ${value.endLine} exceeds the ${lines.length}-line source`)
    const slice = lines.slice(value.startLine - 1, value.endLine).join('\n')
    return { slice, digest: canonicalDigest(slice) }
  }
  if (sourceKind === 'csv_table') {
    const value = selector as unknown as CsvTableSelector
    validateCsvSelector(value)
    const records = parseCsvRecords(text)
    let dataRows: string[][]
    let headerRow: string[] | undefined
    if (value.header) {
      headerRow = records[0]
      dataRows = records.slice(1)
    } else {
      dataRows = records
    }
    let selected: string[][]
    if (value.rowKeys !== null) {
      if (headerRow === undefined) throw new AnchorError('invalid_selector', 'rowKeys require a header row')
      const keyIndex = 0
      const wanted = new Set(value.rowKeys)
      selected = dataRows.filter(row => wanted.has(row[keyIndex] ?? ''))
      if (selected.length !== value.rowKeys.length) throw new AnchorError('anchor_selector_out_of_range', 'not every rowKey resolved in the source')
    } else {
      const range = value.rowRange as { readonly start: number; readonly end: number }
      if (range.end > dataRows.length) throw new AnchorError('anchor_selector_out_of_range', `row ${range.end} exceeds the ${dataRows.length}-row body`)
      selected = dataRows.slice(range.start - 1, range.end)
    }
    const cells: string[] = []
    for (const row of selected) {
      for (const column of value.columns) {
        const index = typeof column === 'number' ? column : headerRow?.indexOf(column) ?? -1
        if (index < 0 || index >= row.length) throw new AnchorError('anchor_selector_out_of_range', `column '${String(column)}' did not resolve`)
        cells.push(row[index] ?? '')
      }
    }
    const slice = cells.join('\u241f')
    return { slice, digest: canonicalDigest(slice) }
  }
  throw new AnchorError('unsupported_anchor_kind', `anchor profile '${sourceKind}' is not registered in v0.1`)
}

function parseCsvRecords(text: string): string[][] {
  const rows: string[][] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    rows.push(line.split(',').map(cell => cell.trim()))
  }
  return rows
}

/**
 * SourceAnchor owner (SPEC-02 §5). Anchors are typed reference values in an owner registry —
 * never graph nodes — and every acceptance re-verifies against the exact version bytes.
 */
export class SourceAnchorOwner {
  constructor(
    private readonly store: EvidenceStore,
    private readonly artifacts: ArtifactProvider,
  ) {}

  /**
   * Register one anchor after verifying its selector against the exact source version bytes.
   * @param input Source version ref, registered kind, selector value, and optional abort bound.
   * @returns The persisted anchor record with its slice digest.
   */
  async register(input: {
    readonly sourceVersionRef: ArtifactVersionId
    readonly sourceKind: SourceAnchorRecordV1['sourceKind']
    readonly selector: JsonValue
    readonly signal?: AbortSignal
  }): Promise<SourceAnchorRecordV1> {
    if (!REGISTERED_ANCHOR_KINDS.has(input.sourceKind)) {
      throw new AnchorError('unsupported_anchor_kind', `anchor profile '${input.sourceKind}' is not registered in v0.1`)
    }
    let bytes: Uint8Array
    try {
      bytes = await this.artifacts.readVersionBytes(input.sourceVersionRef, input.signal)
    } catch (error) {
      if (error instanceof AnchorError) throw error
      throw new AnchorError('anchor_source_unavailable', `source version '${input.sourceVersionRef}' bytes are unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const { digest } = computeAnchorSlice(input.sourceKind, input.selector, bytes)
    const record: SourceAnchorRecordV1 = {
      recordVersion: 'animalge.source-anchor/v1',
      anchorId: newSourceAnchorId(),
      sourceVersionRef: input.sourceVersionRef,
      sourceKind: input.sourceKind,
      selector: input.selector,
      verifierRevision: SOURCE_ANCHOR_VERIFIER_REVISION,
      selectedDigest: digest,
      lastVerification: { code: 'verified', verifiedAt: Date.now() },
    }
    await this.store.putMaterialRecord(this.store.sourceAnchors, record.anchorId, record)
    return record
  }

  /** Latest record for one anchor: the canonical row plus any verification-update rows (§10.1). */
  private latest(anchorId: string): SourceAnchorRecordV1 | undefined {
    let latest: SourceAnchorRecordV1 | undefined
    let latestKey = ''
    for (const [key, row] of this.store.sourceAnchors.entries()) {
      if (key !== anchorId && !key.startsWith(`${anchorId}@`)) continue
      if (latest === undefined || key >= latestKey) {
        latest = row
        latestKey = key
      }
    }
    return latest
  }

  /**
   * Owner re-verification (SPEC-02 §5.2): fail closed with a named breakpoint on any drift.
   * @param anchorId The registered anchor.
   * @param options Optional abort bound.
   * @returns `verified`, or the named breakpoint that failed.
   */
  async reverify(anchorId: string, options: { readonly signal?: AbortSignal } = {}): Promise<{ readonly code: 'verified' } | { readonly code: 'anchor_digest_mismatch' | 'anchor_source_unavailable' | 'anchor_selector_out_of_range' | 'anchor_unresolvable' }> {
    const record = this.latest(anchorId)
    if (record === undefined) throw new AnchorError('anchor_not_found', `anchor '${anchorId}' is not registered`)
    let bytes: Uint8Array
    try {
      bytes = await this.artifacts.readVersionBytes(record.sourceVersionRef, options.signal)
    } catch (error) {
      if (error instanceof AnchorError) return { code: 'anchor_source_unavailable' }
      if (error instanceof ArtifactConflictError && error.code === 'content_mismatch') return { code: 'anchor_source_unavailable' }
      return { code: 'anchor_source_unavailable' }
    }
    let digest: Sha256Digest
    try {
      digest = computeAnchorSlice(record.sourceKind, record.selector, bytes).digest
    } catch (error) {
      if (error instanceof AnchorError) {
        if (error.code === 'anchor_selector_out_of_range') return { code: 'anchor_selector_out_of_range' }
        return { code: 'anchor_unresolvable' }
      }
      throw error
    }
    if (record.selectedDigest !== null && digest !== record.selectedDigest) return { code: 'anchor_digest_mismatch' }
    // Verification outcomes append a new versioned record row (§10.1: "验证结果更新走新记录");
    // the selector semantics of every prior row never change.
    await this.store.putMaterialRecord(this.store.sourceAnchors, `${record.anchorId}@${Date.now()}`, { ...record, lastVerification: { code: 'verified', verifiedAt: Date.now() } })
    return { code: 'verified' }
  }
}
