/** ArtifactVersion Provider: reference-only identity, four-layer state, freshness-bounded hashing. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { canonicalDigest } from './canonical-json.ts'
import { newArtifactId, newArtifactVersionId, newLocationObservationId } from './identity.ts'
import type { ArtifactVersionCoreV1, ArtifactVersionId, LocationAvailabilityObservationV1, Sha256Digest } from './types.ts'
import { EvidenceStore, EvidenceStoreError } from './store.ts'

/** Versioned media-type inference table (implementation-constant; unknown extensions fall back to octet-stream). */
export const MEDIA_TYPES_REVISION = 'animalge-media-types/v1'
const MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', json: 'application/json',
  csv: 'text/csv', tsv: 'text/tab-separated-values', sh: 'text/x-shellscript',
  r: 'text/x-r', py: 'text/x-python', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  pdf: 'application/pdf', html: 'text/html',
})

/** v0.1 hashing bound: files above this cap stay untracked candidates rather than buffering unbounded bytes. */
export const ARTIFACT_HASH_MAX_BYTES = 1_073_741_824

export function inferMediaType(displayPath: string): string {
  const dot = displayPath.lastIndexOf('.')
  if (dot <= 0) return 'application/octet-stream'
  return MEDIA_TYPES[displayPath.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream'
}

/** Unified file handle (SPEC-02 §4.5): the version guard is a field on the handle, not a second input mode. */
export interface UnifiedFileHandle {
  readonly role: string
  readonly locator: string
  readonly expectedArtifactVersionRef?: ArtifactVersionId
}

export type CaptureCreatedBy = 'runner_output' | 'runner_input' | 'runner_log' | 'runner_code' | 'explicit_registration'

/** Successful capture result: which version backs the handle and how it was observed. */
export interface CaptureResult {
  readonly artifactId: string
  readonly artifactVersionId: ArtifactVersionId
  readonly contentDigest: Sha256Digest
  readonly byteLength: number
  readonly mediaType: string
  readonly observationId: string
  readonly observationBasis: 'full_sha256' | 'freshness_reuse'
  readonly createdNewVersion: boolean
}

/** Structured identity-conflict outcome the caller must resolve (A04: never silently continue). */
export class ArtifactConflictError extends Error {
  constructor(
    readonly code: 'content_mismatch' | 'content_changed' | 'symlink_locator_rejected' | 'not_regular_file' | 'source_absent' | 'artifact_too_large',
    message: string,
    readonly existing?: {
      readonly artifactId: string
      readonly artifactVersionId: ArtifactVersionId
      readonly contentDigest: Sha256Digest
    },
  ) {
    super(message)
    this.name = 'ArtifactConflictError'
  }
}

function sha256Bytes(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * Private reference-only Artifact owner (SPEC-02 §4). No Artifact bytes are copied, hosted,
 * content-addressed, or deduplicated; only identity, digest, length, and observations persist.
 */
export class ArtifactProvider {
  constructor(
    private readonly ctx: Context,
    private readonly store: EvidenceStore,
  ) {}

  private async resolveRegular(
    locator: string,
    cwd: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ target: FsTarget; size: number | undefined; version: string | null }> {
    // §11.2: path normalization and final-component symlink rejection happen at resolve time.
    const lstatOpts = cwd === undefined ? {} : { cwd }
    const resolveOpts = { ...(cwd === undefined ? {} : { cwd }), ...(signal === undefined ? {} : { signal }) }
    const pathInfo = await this.ctx.fs.lstat(locator, lstatOpts, signal)
    if (pathInfo?.type === 'symlink') throw new ArtifactConflictError('symlink_locator_rejected', `locator '${locator}' is a symbolic link`)
    const target = await this.ctx.fs.resolve(locator, resolveOpts)
    const info = await this.ctx.fs.stat(target, signal)
    if (info === undefined) throw new ArtifactConflictError('source_absent', `locator '${locator}' does not exist`)
    if (info.type !== 'file') throw new ArtifactConflictError('not_regular_file', `locator '${locator}' is not a regular file`)
    return { target, size: info.size, version: info.version }
  }

  private async readFull(target: FsTarget, signal: AbortSignal | undefined): Promise<Uint8Array> {
    let bytes: Uint8Array
    try {
      bytes = await this.ctx.fs.readBytes(target, signal, ARTIFACT_HASH_MAX_BYTES)
    } catch (error) {
      if (error instanceof ArtifactConflictError) throw error
      throw new EvidenceStoreError('read_temporary', `artifact read failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (bytes.byteLength >= ARTIFACT_HASH_MAX_BYTES) throw new ArtifactConflictError('artifact_too_large', 'artifact exceeds the v0.1 hashing bound and stays an untracked candidate')
    return bytes
  }

  private async persistObservation(version: ArtifactVersionCoreV1, target: FsTarget, freshness: string | null, integrity: LocationAvailabilityObservationV1['integrity'], basis: LocationAvailabilityObservationV1['observationBasis']): Promise<string> {
    const observation: LocationAvailabilityObservationV1 = {
      recordVersion: 'animalge.location-observation/v1',
      locationObservationId: newLocationObservationId(),
      artifactVersionId: version.artifactVersionId,
      locator: target.displayPath,
      availability: 'available',
      integrity,
      observedAt: Date.now(),
      freshnessToken: freshness,
      continuityBasis: 'provider_verified',
      observationBasis: basis,
    }
    await this.store.putMaterialRecord(this.store.locationObservations, observation.locationObservationId, observation)
    return observation.locationObservationId
  }

  private async createVersion(target: FsTarget, bytes: Uint8Array, freshness: string | null, createdBy: CaptureCreatedBy, parent: ArtifactVersionId | null, supersedesReason: ArtifactVersionCoreV1['supersedesReason']): Promise<CaptureResult> {
    const contentDigest = sha256Bytes(bytes)
    const artifactId = parent === null ? newArtifactId() : (this.store.artifactVersions.get(parent)?.artifactId ?? newArtifactId())
    if (parent === null && this.store.artifacts.get(artifactId) === undefined) {
      await this.store.putMaterialRecord(this.store.artifacts, artifactId, { recordVersion: 'animalge.artifact/v1', artifactId, createdAt: Date.now(), createdBy })
    }
    const version: ArtifactVersionCoreV1 = {
      recordVersion: 'animalge.artifact-version/v1',
      artifactId,
      artifactVersionId: newArtifactVersionId(),
      contentDigest,
      byteLength: bytes.byteLength,
      mediaType: inferMediaType(target.displayPath),
      retention: 'reference',
      parentVersionId: parent,
      supersedesReason,
      createdAt: Date.now(),
      createdBy,
    }
    await this.store.putMaterialRecord(this.store.artifactVersions, version.artifactVersionId, version)
    const observationId = await this.persistObservation(version, target, freshness, 'matched', 'full_sha256')
    return {
      artifactId, artifactVersionId: version.artifactVersionId, contentDigest, byteLength: version.byteLength,
      mediaType: version.mediaType, observationId, observationBasis: 'full_sha256', createdNewVersion: true,
    }
  }

  /**
   * Passive capture of one unified handle (SPEC-02 §4.4-1/§4.5). Reuses the version on an
   * unchanged digest or freshness token; fails closed on changed bytes unless the caller
   * explicitly allows a version advance.
   * @param handle The unified file handle with its optional expected-version guard.
   * @param options Creator role, cwd, abort bound, and version-advance permission.
   * @returns The capture result naming the exact backing version and observation.
   */
  async captureFile(handle: UnifiedFileHandle, options: {
    readonly createdBy: CaptureCreatedBy
    readonly cwd?: string
    readonly signal?: AbortSignal
    readonly allowAdvance?: boolean
  }): Promise<CaptureResult> {
    const { target, version: freshness } = await this.resolveRegular(handle.locator, options.cwd, options.signal)
    const prior = this.store.latestObservationForTarget(target.displayPath)
    if (prior !== undefined) {
      const priorVersion = this.store.artifactVersions.get(prior.artifactVersionId)
      if (priorVersion !== undefined && prior.availability === 'available' && prior.integrity === 'matched' && prior.freshnessToken !== null && freshness !== null && prior.freshnessToken === freshness) {
        if (handle.expectedArtifactVersionRef !== undefined && handle.expectedArtifactVersionRef !== priorVersion.artifactVersionId) {
          throw new ArtifactConflictError('content_mismatch', `expected version '${handle.expectedArtifactVersionRef}' but locator still holds '${priorVersion.artifactVersionId}'`, { artifactId: priorVersion.artifactId, artifactVersionId: priorVersion.artifactVersionId, contentDigest: priorVersion.contentDigest })
        }
        const observationId = await this.persistObservation(priorVersion, target, freshness, 'matched', 'freshness_reuse')
        return {
          artifactId: priorVersion.artifactId, artifactVersionId: priorVersion.artifactVersionId,
          contentDigest: priorVersion.contentDigest, byteLength: priorVersion.byteLength, mediaType: priorVersion.mediaType,
          observationId, observationBasis: 'freshness_reuse', createdNewVersion: false,
        }
      }
    }
    const bytes = await this.readFull(target, options.signal)
    const digest = sha256Bytes(bytes)
    if (prior !== undefined) {
      const priorVersion = this.store.artifactVersions.get(prior.artifactVersionId)
      if (priorVersion !== undefined) {
        const expectedRef = handle.expectedArtifactVersionRef
        if (expectedRef !== undefined && expectedRef !== priorVersion.artifactVersionId && priorVersion.contentDigest !== digest) {
          throw new ArtifactConflictError('content_mismatch', `expected version '${handle.expectedArtifactVersionRef}' but locator holds different bytes`, { artifactId: priorVersion.artifactId, artifactVersionId: priorVersion.artifactVersionId, contentDigest: priorVersion.contentDigest })
        }
        if (priorVersion.contentDigest === digest) {
          if (handle.expectedArtifactVersionRef !== undefined && handle.expectedArtifactVersionRef !== priorVersion.artifactVersionId) {
            throw new ArtifactConflictError('content_mismatch', `expected version '${handle.expectedArtifactVersionRef}' but locator holds '${priorVersion.artifactVersionId}'`, { artifactId: priorVersion.artifactId, artifactVersionId: priorVersion.artifactVersionId, contentDigest: priorVersion.contentDigest })
          }
          const observationId = await this.persistObservation(priorVersion, target, freshness, 'matched', 'full_sha256')
          return {
            artifactId: priorVersion.artifactId, artifactVersionId: priorVersion.artifactVersionId,
            contentDigest: priorVersion.contentDigest, byteLength: priorVersion.byteLength, mediaType: priorVersion.mediaType,
            observationId, observationBasis: 'full_sha256', createdNewVersion: false,
          }
        }
        if (options.allowAdvance === true) {
          return this.createVersion(target, bytes, freshness, options.createdBy, priorVersion.artifactVersionId, 'content_change')
        }
        if (handle.expectedArtifactVersionRef !== undefined) {
          throw new ArtifactConflictError('content_mismatch', `expected version '${handle.expectedArtifactVersionRef}' but locator bytes changed`, { artifactId: priorVersion.artifactId, artifactVersionId: priorVersion.artifactVersionId, contentDigest: priorVersion.contentDigest })
        }
        // §4.5: known locator with changed bytes and no expected ref — return the structured
        // conflict; the caller must decide explicitly before a new Version is created.
        throw new ArtifactConflictError('content_changed', `locator '${handle.locator}' holds different bytes than version '${priorVersion.artifactVersionId}'`, { artifactId: priorVersion.artifactId, artifactVersionId: priorVersion.artifactVersionId, contentDigest: priorVersion.contentDigest })
      }
    }
    if (handle.expectedArtifactVersionRef !== undefined) {
      throw new ArtifactConflictError('content_mismatch', `expected version '${handle.expectedArtifactVersionRef}' but the locator was never captured`)
    }
    return this.createVersion(target, bytes, freshness, options.createdBy, null, null)
  }

  /**
   * Explicit semantic commit (SPEC-02 §4.4-2 / §4.1 rules 3/4/7): always reads and hashes the
   * current bytes and creates a NEW version even when the digest matches (`save/rerun/publish`),
   * chained onto the current chain head. `restore_as_new` records the restored_from lineage.
   * @param locator The file locator to register.
   * @param options Creator, advance reason, cwd, and abort bound.
   * @returns The newly created version's capture result.
   */
  async registerExplicit(locator: string, options: {
    readonly createdBy: CaptureCreatedBy
    readonly reason: 'explicit_commit' | 'restore_as_new'
    readonly cwd?: string
    readonly signal?: AbortSignal
  }): Promise<CaptureResult> {
    const { target, version: freshness } = await this.resolveRegular(locator, options.cwd, options.signal)
    const bytes = await this.readFull(target, options.signal)
    const prior = this.store.latestObservationForTarget(target.displayPath)
    const priorVersion = prior === undefined ? undefined : this.store.artifactVersions.get(prior.artifactVersionId)
    const parent = priorVersion === undefined
      ? null
      : this.store.currentArtifactVersion(priorVersion.artifactId)?.artifactVersionId ?? priorVersion.artifactVersionId
    return this.createVersion(target, bytes, freshness, options.createdBy, parent, options.reason)
  }

  /**
   * Owner re-observation of one registered version (four-layer state layer two): reports the
   * current availability/integrity without ever rewriting the version core or old snapshots.
   * @param artifactVersionId The exact version to re-observe.
   * @param options Optional abort bound.
   * @returns The appended observation record.
   */
  async reobserve(
    artifactVersionId: ArtifactVersionId,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LocationAvailabilityObservationV1> {
    const version = this.store.artifactVersions.get(artifactVersionId)
    if (version === undefined) throw new EvidenceStoreError('snapshot_missing', `ArtifactVersion '${artifactVersionId}' is not registered`)
    const latest = this.store.latestObservation(artifactVersionId)
    if (latest === undefined) throw new EvidenceStoreError('material_identity_conflict', `ArtifactVersion '${artifactVersionId}' has no observations`)
    const resolveOpts = options.signal === undefined ? {} : { signal: options.signal }
    const stat = await this.ctx.fs.stat(await this.ctx.fs.resolve(latest.locator, resolveOpts), options.signal)
    const base = {
      recordVersion: 'animalge.location-observation/v1' as const,
      locationObservationId: newLocationObservationId(),
      artifactVersionId,
      locator: latest.locator,
      observedAt: Date.now(),
      freshnessToken: stat?.version ?? null,
      continuityBasis: 'provider_verified' as const,
    }
    let observation: LocationAvailabilityObservationV1
    if (stat === undefined || stat.type !== 'file') {
      observation = { ...base, availability: 'missing', integrity: 'not_checked', observationBasis: 'no_read' }
    } else {
      const opts = options.signal === undefined ? {} : { signal: options.signal }
      const target = await this.ctx.fs.resolve(latest.locator, opts)
      const bytes = await this.readFull(target, options.signal)
      const matched = sha256Bytes(bytes) === version.contentDigest && bytes.byteLength === version.byteLength
      observation = { ...base, availability: 'available', integrity: matched ? 'matched' : 'content_mismatch', observationBasis: 'full_sha256' }
    }
    await this.store.putMaterialRecord(this.store.locationObservations, observation.locationObservationId, observation)
    return observation
  }

  /**
   * Read the verified bytes of one version (anchor re-verification input).
   * @param artifactVersionId The exact version.
   * @param signal Optional abort bound.
   * @returns The full bytes, after matching the version digest.
   */
  async readVersionBytes(artifactVersionId: ArtifactVersionId, signal?: AbortSignal): Promise<Uint8Array> {
    const version = this.store.artifactVersions.get(artifactVersionId)
    if (version === undefined) throw new EvidenceStoreError('snapshot_missing', `ArtifactVersion '${artifactVersionId}' is not registered`)
    const latest = this.store.latestObservation(artifactVersionId)
    if (latest === undefined) throw new EvidenceStoreError('material_identity_conflict', `ArtifactVersion '${artifactVersionId}' has no observations`)
    const target = await this.ctx.fs.resolve(latest.locator, signal === undefined ? {} : { signal })
    const bytes = await this.readFull(target, signal)
    if (sha256Bytes(bytes) !== version.contentDigest) throw new ArtifactConflictError('content_mismatch', `locator bytes no longer match version '${artifactVersionId}'`)
    return bytes
  }
}

/** Digest of the version-chain material used by acceptance-fixture determinism checks. */
export function versionChainDigest(versions: readonly ArtifactVersionCoreV1[]): Sha256Digest {
  const material = versions.map(version => ({
    v: version.artifactVersionId,
    p: version.parentVersionId,
    d: version.contentDigest,
  }))
  return canonicalDigest(material)
}
