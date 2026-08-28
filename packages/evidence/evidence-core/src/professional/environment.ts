/** TestedEnvironmentRevision owner: real-probe freezing, pointer state, and the per-call gate (SPEC-03 §7). */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { newTestedEnvironmentRevisionId } from '../identity.ts'
import type { EvidenceStore } from '../store.ts'
import { runManagedProcess } from './runtime.ts'
import type { ProbeObservationV1, Sha256Digest, TestedEnvironmentRevisionV1 } from '../types.ts'

/** Environment gate failures surfaced before any professional process starts (§7.2). */
export class EnvironmentGateError extends Error {
  constructor(readonly code: 'environment_not_ready' | 'environment_revision_mismatch' | 'unsupported_input_revision', message: string) {
    super(message)
    this.name = 'EnvironmentGateError'
  }
}

/** Deterministic digest of one local file's exact bytes (probe material, §7.1). */
async function fileDigest(ctx: Context, locator: string, signal: AbortSignal): Promise<Sha256Digest> {
  const bytes = await ctx.fs.readBytes(await ctx.fs.resolve(locator), signal, 1_073_741_824)
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export interface ProbeRequest {
  readonly component: string
  readonly resolvedPath: string
  readonly parseVersion?: (output: string) => string | null
}

/**
 * Probe one environment component deterministically (§7.1): full byte digest of the
 * resolved executable/package plus, when a version parser is supplied, the parsed
 * `--version` output captured through the single Runtime spawn site.
 */
export async function probeComponent(options: {
  readonly ctx: Context
  readonly request: ProbeRequest
  readonly signal: AbortSignal
  readonly timeoutMs?: number
}): Promise<ProbeObservationV1> {
  const { ctx, request, signal } = options
  const timeoutMs = options.timeoutMs ?? 15_000
  let digest: ProbeObservationV1['executableDigest']
  try {
    digest = await fileDigest(ctx, request.resolvedPath, signal)
  } catch (error) {
    if (error instanceof EnvironmentGateError) throw error
    throw new EnvironmentGateError('environment_not_ready', `probe of '${request.resolvedPath}' could not read bytes: ${error instanceof Error ? error.message : String(error)}`)
  }
  let versionOutputText = ''
  let parsedVersion: string | null = null
  if (request.parseVersion !== undefined) {
    const managed = await runManagedProcess({
      ctx,
      argv: [request.resolvedPath, '--version'],
      cwd: process.cwd(),
      env: {},
      timeoutMs,
      logCaptureMaxBytes: 65_536,
      abortSignal: signal,
      stdoutLogPath: null,
      stderrLogPath: null,
      captureStdoutText: true,
    })
    if (managed.kind !== 'spawned') {
      throw new EnvironmentGateError('environment_not_ready', `version query for '${request.resolvedPath}' could not run`)
    }
    versionOutputText = managed.stdoutText ?? ''
    parsedVersion = request.parseVersion(versionOutputText)
    if (parsedVersion === null) {
      throw new EnvironmentGateError('environment_not_ready', `version output of '${request.resolvedPath}' could not be parsed`)
    }
  }
  return {
    component: request.component,
    resolvedPath: request.resolvedPath,
    executableDigest: digest,
    versionOutput: versionOutputText,
    parsedVersion,
    observedAt: Date.now(),
  }
}

export interface FreezeRevisionInput {
  readonly environmentSpecRevision: string
  readonly components: readonly {
    readonly name: string
    readonly kind: 'executable' | 'r_package' | 'conda_package'
    readonly resolvedPath: string
    readonly sourceRef: string | null
  }[]
  readonly parseVersion?: (component: string, output: string) => string | null
  readonly inputSchemaRevisions: readonly string[]
  readonly signal: AbortSignal
}

/** Freeze one TestedEnvironmentRevision from real probe results only (§7.1). */
export async function freezeTestedEnvironmentRevision(options: {
  readonly ctx: Context
  readonly store: EvidenceStore
  readonly input: FreezeRevisionInput
}): Promise<TestedEnvironmentRevisionV1> {
  const { ctx, store, input } = options
  const probes: ProbeObservationV1[] = []
  for (const component of input.components) {
    probes.push(await probeComponent({
      ctx,
      signal: input.signal,
      request: {
        component: component.name,
        resolvedPath: component.resolvedPath,
        ...(component.kind === 'executable' && input.parseVersion !== undefined
          ? { parseVersion: (output: string) => input.parseVersion?.(component.name, output) ?? null }
          : {}),
      },
    }))
  }
  const frozenComponents: {
    name: string
    kind: 'executable' | 'r_package' | 'conda_package'
    identity: { version: string; digest: Sha256Digest; sourceRef: string | null }
    resolvedPath: string
  }[] = []
  for (const component of input.components) {
    const probe = probes.find(item => item.component === component.name)
    if (probe === undefined) {
      throw new EnvironmentGateError('environment_not_ready', `probe missing for component '${component.name}'`)
    }
    if (component.kind === 'executable' && probe.parsedVersion === null) {
      throw new EnvironmentGateError('environment_not_ready', `executable component '${component.name}' has no parseable version`)
    }
    frozenComponents.push({
      name: component.name,
      kind: component.kind,
      identity: {
        // r_package/conda_package identity anchors on the digest (§7.1: non-null, from
        // the frozen probe bytes); executables additionally carry the parsed version.
        version: probe.parsedVersion ?? 'not-versioned',
        digest: probe.executableDigest,
        sourceRef: component.sourceRef,
      },
      resolvedPath: ctx.fs.processPath(await ctx.fs.resolve(component.resolvedPath)),
    })
  }
  const revision: TestedEnvironmentRevisionV1 = {
    recordVersion: 'animalge.tested-environment/v1',
    revisionId: newTestedEnvironmentRevisionId(),
    environmentSpecRevision: input.environmentSpecRevision,
    platform: { os: process.platform, arch: process.arch },
    components: frozenComponents,
    inputSchemaRevisions: [...input.inputSchemaRevisions],
    frozenAt: Date.now(),
    frozenFromProbe: probes,
  }
  await store.putMaterialRecord(store.environmentRevisions, revision.revisionId, revision)
  await store.updateEnvironmentState(() => ({
    recordVersion: 'animalge.environment-state/v1',
    currentRevisionId: revision.revisionId,
    updatedAt: Date.now(),
  }))
  return revision
}

/** The plugin's live store instance for same-process composition drivers (§7.1). */
let activeStore: EvidenceStore | undefined

/** Register the plugin-owned store; called once from apply(). */
export function registerActiveEvidenceStore(store: EvidenceStore): void {
  activeStore = store
}

/**
 * Freeze the environment through the plugin's own live store (REAL composition drivers).
 * Same owner, same domain instance, no second writer.
 */
export async function freezeCurrentEnvironment(options: {
  readonly ctx: Context
  readonly input: FreezeRevisionInput
}): Promise<TestedEnvironmentRevisionV1> {
  if (activeStore === undefined) throw new EnvironmentGateError('environment_not_ready', 'the evidence-core plugin is not active in this process')
  return freezeTestedEnvironmentRevision({ ctx: options.ctx, store: activeStore, input: options.input })
}

export function currentEnvironmentRevision(store: EvidenceStore): TestedEnvironmentRevisionV1 | undefined {
  const pointer = store.environmentStateNow()
  if (pointer === undefined || pointer.currentRevisionId === null) return undefined
  return store.environmentRevisions.get(pointer.currentRevisionId)
}

/** Verify the environment gate for one call's bound components (§7.2): fail before spawn. */
export async function verifyEnvironmentGate(options: {
  readonly ctx: Context
  readonly store: EvidenceStore
  readonly componentNames: readonly string[]
  readonly inputBundleSchemaRevision: string
  readonly parseVersion?: (component: string, output: string) => string | null
  readonly signal: AbortSignal
}): Promise<{ readonly revision: TestedEnvironmentRevisionV1; readonly probes: readonly ProbeObservationV1[] }> {
  const { ctx, store, componentNames, inputBundleSchemaRevision, signal } = options
  const revision = currentEnvironmentRevision(store)
  if (revision === undefined) {
    throw new EnvironmentGateError('environment_not_ready', 'no TestedEnvironmentRevision is frozen for this environment')
  }
  if (!revision.inputSchemaRevisions.includes(inputBundleSchemaRevision)) {
    throw new EnvironmentGateError('unsupported_input_revision', `input schema '${inputBundleSchemaRevision}' is not accepted by the frozen environment revision`)
  }
  const probes: ProbeObservationV1[] = []
  for (const name of componentNames) {
    const component = revision.components.find(item => item.name === name)
    if (component === undefined) {
      throw new EnvironmentGateError('environment_not_ready', `component '${name}' is not part of the frozen environment revision`)
    }
    let probe: ProbeObservationV1
    try {
      probe = await probeComponent({
        ctx,
        signal,
        request: {
          component: name,
          resolvedPath: component.resolvedPath,
          ...(component.kind === 'executable' && options.parseVersion !== undefined
            ? { parseVersion: (output: string) => options.parseVersion?.(name, output) ?? null }
            : {}),
        },
      })
    } catch (error) {
      if (error instanceof EnvironmentGateError) throw error
      throw new EnvironmentGateError('environment_not_ready', `probe of component '${name}' failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (probe.executableDigest !== component.identity.digest) {
      throw new EnvironmentGateError('environment_revision_mismatch', `component '${name}' digest drifted from the frozen environment revision`)
    }
    if (component.kind === 'executable' && probe.parsedVersion !== null && probe.parsedVersion !== component.identity.version) {
      throw new EnvironmentGateError('environment_revision_mismatch', `component '${name}' version drifted from the frozen environment revision`)
    }
    const resolvedNow = ctx.fs.processPath(await ctx.fs.resolve(component.resolvedPath))
    if (resolvedNow !== component.resolvedPath) {
      throw new EnvironmentGateError('environment_revision_mismatch', `component '${name}' resolution drifted from the frozen path`)
    }
    probes.push(probe)
  }
  return { revision, probes }
}
