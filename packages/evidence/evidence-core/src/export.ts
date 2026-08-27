/** Exact committed-Snapshot canonical export builder, verifier and atomic writer. */

import { lstat, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { canonicalDigest, canonicalJson, parseCanonicalJson } from './canonical-json.ts'
import { evidenceSnapshotPayloadSchema } from './schema.ts'
import { verifyStoredSnapshot } from './integrity.ts'
import type { EvidenceExportV1, Sha256Digest, StoredSnapshotV1 } from './types.ts'

/** Stable coded error returned by committed-Snapshot export operations. */
export class EvidenceExportError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'EvidenceExportError'
  }
}

/**
 * Build stable export bytes from an already resolved and verified committed record.
 * @param record Committed Snapshot record selected by exact digest.
 * @returns Verified export envelope and its canonical bytes.
 */
export function buildEvidenceExport(record: StoredSnapshotV1): { readonly envelope: EvidenceExportV1; readonly bytes: string } {
  const snapshot = verifyStoredSnapshot(record)
  const envelope: EvidenceExportV1 = { exportFormat: 'animalge.evidence.export/v1', snapshotDigest: record.snapshotDigest, canonicalization: 'animalge-c14n-json/v1', snapshot }
  return { envelope, bytes: `${canonicalJson(envelope as unknown as JsonValue)}\n` }
}

/**
 * Parse export bytes, recompute the Snapshot digest and validate every internal reference.
 * @param bytes Complete canonical export bytes including the final newline.
 * @returns Verified export envelope.
 */
export function verifyEvidenceExport(bytes: string): EvidenceExportV1 {
  if (!bytes.endsWith('\n') || bytes.endsWith('\n\n')) throw new EvidenceExportError('export_newline_invalid', 'Evidence export must end with exactly one newline')
  const value = parseCanonicalJson(bytes.slice(0, -1))
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new EvidenceExportError('export_schema_invalid', 'Evidence export is not an object')
  const record = value as Record<string, JsonValue>
  if (record.exportFormat !== 'animalge.evidence.export/v1' || record.canonicalization !== 'animalge-c14n-json/v1' || typeof record.snapshotDigest !== 'string') throw new EvidenceExportError('export_schema_invalid', 'Evidence export envelope is unsupported')
  const snapshot = evidenceSnapshotPayloadSchema.parse(record.snapshot)
  const digest = canonicalDigest(snapshot as unknown as JsonValue)
  if (digest !== record.snapshotDigest) throw new EvidenceExportError('snapshot_digest_mismatch', 'Evidence export Snapshot digest does not match')
  return { exportFormat: 'animalge.evidence.export/v1', snapshotDigest: digest, canonicalization: 'animalge-c14n-json/v1', snapshot }
}

/**
 * Write a fixed-name export without following links or overwriting different bytes.
 * @param record Committed Snapshot record selected by exact digest.
 * @param destinationDirectory Existing real directory that owns the export.
 * @returns Absolute or caller-relative path of the written export file.
 */
export async function writeEvidenceExport(record: StoredSnapshotV1, destinationDirectory: string): Promise<string> {
  const directory = await lstat(destinationDirectory).catch(() => undefined)
  if (directory === undefined || !directory.isDirectory() || directory.isSymbolicLink()) throw new EvidenceExportError('export_directory_invalid', 'destination must be an existing real directory')
  const { bytes } = buildEvidenceExport(record)
  const hex = record.snapshotDigest.slice('sha256:'.length)
  const filename = join(destinationDirectory, `animalge-evidence-${hex}.json`)
  if (basename(filename) !== `animalge-evidence-${hex}.json`) throw new EvidenceExportError('export_target_invalid', 'invalid export filename')
  return withFileLock(filename, async () => {
    const target = await lstat(filename).catch(() => undefined)
    if (target !== undefined) {
      if (!target.isFile() || target.isSymbolicLink()) throw new EvidenceExportError('export_target_conflict', 'export target is not a regular file')
      const existing = await readFile(filename, 'utf8')
      if (existing !== bytes) throw new EvidenceExportError('export_target_conflict', 'export target contains different bytes')
      return filename
    }
    await writeFileAtomic(filename, bytes, { mode: 0o600 })
    return filename
  })
}

/**
 * Validate a caller-supplied digest before Store resolution.
 * @param value Candidate tagged SHA-256 digest.
 * @returns Branded digest safe to use for exact Store lookup.
 */
export function explicitSnapshotDigest(value: string): Sha256Digest {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new EvidenceExportError('snapshot_digest_invalid', 'Snapshot digest must be lowercase sha256 hex')
  return value as Sha256Digest
}
