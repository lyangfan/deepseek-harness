/** Input bundle normalization into the immutable value object (SPEC-03 §6.1, D-174). */

import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { canonicalDigest } from '../canonical-json.ts'
import { newInputBundleId } from '../identity.ts'
import { ArtifactConflictError, type ArtifactProvider, type UnifiedFileHandle } from '../artifact.ts'
import type { EvidenceStore } from '../store.ts'
import type { InputBundleV1 } from '../types.ts'

export interface BundleHandle {
  readonly role: string
  readonly locator: string
  readonly expectedArtifactVersionRef?: string
}

/** Input-side failures before any process starts (§6.1). */
export class InputBundleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'InputBundleError'
  }
}

/**
 * Normalize one typed input bundle: every component through the SPEC-02 ArtifactProvider
 * unified handle (expected ref fail closed), then persist the immutable value object whose
 * canonical digest covers only the small normalized manifest — never component bytes.
 */
export async function normalizeInputBundle(options: {
  readonly store: EvidenceStore
  readonly artifacts: ArtifactProvider
  readonly bundleKind: string
  readonly schemaRevision: string
  readonly handles: readonly BundleHandle[]
  readonly requiredRoles: readonly string[]
  readonly cwd?: string
  readonly signal: AbortSignal
}): Promise<InputBundleV1> {
  const { store, artifacts, bundleKind, schemaRevision, handles, requiredRoles, cwd, signal } = options
  const present = new Set(handles.map(handle => handle.role))
  const missing = requiredRoles.filter(role => !present.has(role))
  if (missing.length > 0) {
    throw new InputBundleError('bundle_component_missing', `input bundle '${bundleKind}' is missing required roles: ${missing.join(', ')}`)
  }
  const components: {
    role: string
    locator: string
    artifactVersionId: InputBundleV1['components'][number]['artifactVersionId']
    observationId: InputBundleV1['components'][number]['observationId']
    captureBasis: 'full_sha256' | 'freshness_reuse'
  }[] = []
  try {
    for (const handle of handles) {
      const unified: UnifiedFileHandle = {
        role: handle.role,
        locator: handle.locator,
        ...(handle.expectedArtifactVersionRef === undefined
          ? {}
          : { expectedArtifactVersionRef: handle.expectedArtifactVersionRef as never }),
      }
      const captured = await artifacts.captureFile(unified, { createdBy: 'runner_input', ...(cwd === undefined ? {} : { cwd }), signal })
      components.push({
        role: handle.role,
        locator: handle.locator,
        artifactVersionId: captured.artifactVersionId,
        observationId: captured.observationId as InputBundleV1['components'][number]['observationId'],
        captureBasis: captured.observationBasis,
      })
    }
  } catch (error) {
    if (error instanceof ArtifactConflictError) throw new InputBundleError(error.code, error.message)
    throw error
  }
  const manifest: JsonValue = {
    bundleKind,
    schemaRevision,
    components: components.map(component => ({
      role: component.role,
      artifactVersionId: component.artifactVersionId,
    })),
  }
  const bundle: InputBundleV1 = {
    recordVersion: 'animalge.input-bundle/v1',
    bundleId: newInputBundleId(),
    bundleKind,
    schemaRevision,
    components,
    bundleDigest: canonicalDigest(manifest),
    createdAt: Date.now(),
  }
  await store.putMaterialRecord(store.inputBundles, bundle.bundleId, bundle)
  return bundle
}
