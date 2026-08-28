/** Output boundary owner: reservation, plan, formal/diagnostic manifest, finalization (SPEC-03 §8). */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { canonicalDigest } from '../canonical-json.ts'
import { newOutputFinalizationId, newOutputManifestId, newOutputPlanId, newOutputReservationId } from '../identity.ts'
import type { ArtifactProvider } from '../artifact.ts'
import type { EvidenceStore } from '../store.ts'
import type { BoundaryObservationV1, EvidenceRunId, FormalOutputV1, OutputFinalizationRecordV1, OutputManifestV1, OutputPlanV1, OutputReservationV1 } from '../types.ts'

/** Reservation failures surfaced before any process starts (§8.1). */
export class OutputBoundaryError extends Error {
  constructor(readonly code: 'output_collision' | 'output_boundary_ambiguous' | 'output_scope_violation', message: string) {
    super(message)
    this.name = 'OutputBoundaryError'
  }
}

const BOUNDARY_SCAN_MAX_ENTRIES = 10_000

export type OutputIntent =
  | { readonly kind: 'default' }
  | { readonly kind: 'dir'; readonly path: string }
  | { readonly kind: 'prefix'; readonly value: string }
  | { readonly kind: 'paths'; readonly paths: readonly string[] }
  | { readonly kind: 'ambiguous'; readonly hint: string }

/** Does one path fall inside a reserved prefix set (normalized string comparison)? */
function underPrefixes(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(prefix => path === prefix || path.startsWith(prefix))
}

/** Do two reservations overlap in normalized path space (§8.1 mutual exclusion)? */
function boundariesOverlap(left: OutputReservationV1, right: OutputReservationV1): boolean {
  if (underPrefixes(left.boundary.rootDir, [right.boundary.rootDir])
    || underPrefixes(right.boundary.rootDir, [left.boundary.rootDir])) return true
  const leftPaths = [...left.boundary.entries, ...left.boundary.prefixes, left.boundary.rootDir]
  const rightPaths = [...right.boundary.entries, ...right.boundary.prefixes, right.boundary.rootDir]
  return leftPaths.some(path => underPrefixes(path, [...right.boundary.prefixes]) || right.boundary.entries.includes(path))
    || rightPaths.some(path => underPrefixes(path, [...left.boundary.prefixes]) || left.boundary.entries.includes(path))
}

/**
 * Acquire the exclusive, persisted, normalized reservation before process start (§8.1).
 * Anti-overwrite, ambiguity clarification, and scope/symlink checks all happen here.
 */
export async function reserveOutputBoundary(options: {
  readonly ctx: Context
  readonly store: EvidenceStore
  readonly runId: EvidenceRunId
  readonly attempt: number
  readonly outputRoot: string
  readonly intent: OutputIntent
  readonly allowedScopeRoot: string
  readonly signal: AbortSignal
}): Promise<OutputReservationV1> {
  const { ctx, store, runId, attempt, outputRoot, intent, allowedScopeRoot, signal } = options
  const scopeTarget = await ctx.fs.resolve(allowedScopeRoot)
  let kind: OutputReservationV1['kind']
  let rootDir: string
  const entries: string[] = []
  let prefixes: string[] = []
  if (intent.kind === 'default') {
    kind = 'run_exclusive_dir'
    const rootTarget = await ctx.fs.resolve(outputRoot)
    const runsParent = `${ctx.fs.processPath(rootTarget)}/runs`
    rootDir = `${runsParent}/${runId}`
  } else if (intent.kind === 'dir') {
    kind = 'user_specified'
    rootDir = ctx.fs.processPath(await ctx.fs.resolve(intent.path))
    prefixes = [`${rootDir}/`]
  } else if (intent.kind === 'prefix') {
    kind = 'user_specified'
    const normalized = ctx.fs.processPath(await ctx.fs.resolve(intent.value))
    rootDir = normalized.slice(0, normalized.lastIndexOf('/'))
    prefixes = [normalized]
  } else if (intent.kind === 'paths') {
    kind = 'user_specified'
    for (const path of intent.paths) entries.push(ctx.fs.processPath(await ctx.fs.resolve(path)))
    if (entries.length === 0) throw new OutputBoundaryError('output_boundary_ambiguous', 'empty explicit path set')
    const parents = new Set(entries.map(path => path.slice(0, path.lastIndexOf('/'))))
    rootDir = [...parents][0] as string
  } else {
    throw new OutputBoundaryError('output_boundary_ambiguous', `the output intent '${intent.hint}' cannot be classified as directory, file prefix, or exact paths; ask the user`)
  }
  // Scope and symlink-escape: every boundary path must resolve inside the allowed scope.
  const boundaryPaths = [...entries, ...prefixes, rootDir]
  for (const path of boundaryPaths) {
    const target = await ctx.fs.resolve(path)
    if (!ctx.fs.contains(scopeTarget, target)) {
      throw new OutputBoundaryError('output_scope_violation', `output target '${path}' escapes the allowed scope '${allowedScopeRoot}'`)
    }
  }
  if (intent.kind === 'default') {
    const rootTarget = await ctx.fs.resolve(outputRoot)
    const runsParent = `${ctx.fs.processPath(rootTarget)}/runs`
    await mkdir(runsParent, { recursive: true })
    try {
      await mkdir(rootDir, { recursive: false, mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new OutputBoundaryError('output_collision', `run directory '${rootDir}' already exists and is never reused`)
      }
      throw error
    }
  } else {
    // Anti-overwrite: any already-existing file at an entry or under a prefix blocks the call.
    await mkdir(rootDir, { recursive: true })
    const existing = await scanBoundaryFiles(ctx, rootDir, signal)
    for (const file of existing) {
      if (entries.includes(file) || underPrefixes(file, prefixes)) {
        throw new OutputBoundaryError('output_collision', `output target '${file}' already exists; old bytes are never overwritten`)
      }
    }
  }
  // Mutual exclusion against every active reservation AND every abandoned boundary (§8.1:
  // an abandoned boundary is never re-opened in v0.1; released boundaries stop blocking as
  // sets — their residual files still block through the anti-overwrite scan above).
  for (const [, other] of store.outputReservations.entries()) {
    if (other.state === 'released') continue
    if (other.runId === runId && other.attempt === attempt) continue
    const draft: OutputReservationV1 = {
      recordVersion: 'animalge.output-reservation/v1',
      reservationId: newOutputReservationId(), runId, attempt, kind,
      boundary: { rootDir, entries, prefixes }, state: 'active', createdAt: 0, releasedAt: null, releaseBasis: null,
    }
    if (boundariesOverlap(draft, other)) {
      throw new OutputBoundaryError('output_collision', `output boundary overlaps the ${other.state} reservation '${other.reservationId}'`)
    }
  }
  const reservation: OutputReservationV1 = {
    recordVersion: 'animalge.output-reservation/v1',
    reservationId: newOutputReservationId(),
    runId,
    attempt,
    kind,
    boundary: { rootDir, entries, prefixes },
    state: 'active',
    createdAt: Date.now(),
    releasedAt: null,
    releaseBasis: null,
  }
  await store.putMaterialRecord(store.outputReservations, reservation.reservationId, reservation)
  return reservation
}

/** Release after in-process settlement with proven termination (§8.1: the only release path). */
export async function releaseOutputBoundary(store: EvidenceStore, reservationId: string, basis: 'completed' | 'failed' | 'cancelled_confirmed'): Promise<void> {
  await store.updateOutputReservation(reservationId, current => ({ ...current, state: 'released', releasedAt: Date.now(), releaseBasis: basis }))
}

/** Every concrete target this reservation claims (plan collision checks, §8.2). */
export function boundaryTargetsOf(reservation: OutputReservationV1): readonly string[] {
  return [...reservation.boundary.entries, ...reservation.boundary.prefixes, reservation.boundary.rootDir]
}

/** Persist one immutable Output Plan generated by hook slot 4 before spawn (§8.2). */
export async function persistOutputPlan(options: {
  readonly store: EvidenceStore
  readonly runId: EvidenceRunId
  readonly planRevision: string
  readonly generatedByHook: string
  readonly roles: OutputPlanV1['roles']
  readonly bundles: OutputPlanV1['bundles']
}): Promise<OutputPlanV1> {
  const { store, runId, planRevision, generatedByHook, roles, bundles } = options
  const plan: OutputPlanV1 = {
    recordVersion: 'animalge.output-plan/v1',
    planId: newOutputPlanId(),
    runId,
    planRevision,
    generatedByHook,
    roles,
    bundles,
    createdAt: Date.now(),
  }
  await store.putMaterialRecord(store.outputPlans, plan.planId, plan)
  return plan
}

/** Recursively list regular files under one root (bounded; §8.3 boundary scan). */
async function scanBoundaryFiles(ctx: Context, rootDir: string, signal: AbortSignal): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    if (found.length >= BOUNDARY_SCAN_MAX_ENTRIES) return
    const entries = await ctx.fs.listDir(await ctx.fs.resolve(dir), signal)
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`
      if (entry.type === 'directory') await walk(path)
      else if (entry.type === 'file') found.push(path)
      if (found.length >= BOUNDARY_SCAN_MAX_ENTRIES) return
    }
  }
  await walk(rootDir)
  return found.sort((left, right) => left.localeCompare(right))
}

/** Classify one scanned file against the plan rules (exact match first, then prefixes). */
function matchRole(plan: OutputPlanV1, file: string): OutputPlanV1['roles'][number] | undefined {
  const exact = plan.roles.filter(role => role.pathRule.kind === 'exact' && role.pathRule.value === file)
  if (exact.length > 0) return exact[0]
  return plan.roles.filter(role => role.pathRule.kind === 'prefix' && file.startsWith(role.pathRule.value))[0]
}

export interface SettleResult {
  readonly manifest: OutputManifestV1
  readonly finalization: OutputFinalizationRecordV1 | null
  readonly outputCompleteness: 'complete' | 'incomplete' | 'unknown'
  readonly outputCompletenessReason: string | null
  readonly validatedRoles: readonly { readonly role: string; readonly artifactVersionId: string }[]
}

/**
 * Settle the reserved boundary after the process ends (§8.3—§8.5): classify files against
 * the plan, validate declared outputs through the bounded hook, capture ArtifactVersions,
 * emit the formal/diagnostic manifest, and — only when every required bundle member
 * validates — publish the idempotent OutputFinalizationRecord.
 */
export async function settleOutputBoundary(options: {
  readonly ctx: Context
  readonly store: EvidenceStore
  readonly artifacts: ArtifactProvider
  readonly reservation: OutputReservationV1
  readonly plan: OutputPlanV1 | null
  readonly validateOutput: ((role: string, locator: string, bytes: Uint8Array) => { readonly passed: boolean }) | null
  readonly signal: AbortSignal
}): Promise<SettleResult> {
  const { ctx, store, artifacts, reservation, plan, validateOutput, signal } = options
  const files = await scanBoundaryFiles(ctx, reservation.boundary.rootDir, signal)
  const observations: BoundaryObservationV1[] = []
  const formalOutputs: FormalOutputV1[] = []
  const validatedRoles: { readonly role: string; readonly artifactVersionId: string }[] = []
  if (plan === null) {
    for (const file of files) {
      const stat = await ctx.fs.stat(await ctx.fs.resolve(file), signal)
      observations.push({
        locator: file,
        fileType: stat === undefined ? null : 'file',
        byteLength: stat === undefined ? 0 : stat.size ?? 0,
        observedAt: Date.now(),
        observationBasis: 'boundary_scan',
      })
    }
    const manifestBase = {
      recordVersion: 'animalge.output-manifest/v1' as const,
      manifestId: newOutputManifestId(),
      kind: 'diagnostic' as const,
      reason: 'output_plan_absent' as const,
      runId: reservation.runId,
      attempt: reservation.attempt,
      reservationId: reservation.reservationId,
      outputPlanId: null,
      formalOutputs: [] as const,
      unclassifiedBoundaryObservations: observations,
      generatedAt: Date.now(),
    }
    const manifest: OutputManifestV1 = { ...manifestBase, manifestDigest: canonicalDigest(manifestBase as unknown as JsonValue) }
    await store.putMaterialRecord(store.outputManifests, manifest.manifestId, manifest)
    return { manifest, finalization: null, outputCompleteness: 'unknown', outputCompletenessReason: 'output_plan_absent', validatedRoles }
  }
  const roleFiles = new Map<string, string[]>()
  for (const file of files) {
    const role = matchRole(plan, file)
    if (role === undefined) {
      const stat = await ctx.fs.stat(await ctx.fs.resolve(file), signal)
      observations.push({
        locator: file,
        fileType: stat === undefined ? null : 'file',
        byteLength: stat === undefined ? 0 : stat.size ?? 0,
        observedAt: Date.now(),
        observationBasis: 'boundary_scan',
      })
      continue
    }
    roleFiles.set(role.role, [...(roleFiles.get(role.role) ?? []), file])
  }
  for (const role of plan.roles) {
    const matches = roleFiles.get(role.role) ?? []
    if (matches.length === 0) continue
    for (const locator of role.cardinality === 'one' ? matches.slice(0, 1) : matches) {
      const bytes = await ctx.fs.readBytes(await ctx.fs.resolve(locator), signal, 1_073_741_824)
      const validatorResult = validateOutput === null
        ? { validator: role.validator, passed: true }
        : { validator: role.validator, ...validateOutput(role.role, locator, bytes) }
      const captured = await artifacts.captureFile({ role: role.role, locator }, { createdBy: 'runner_output', signal })
      if (validatorResult.passed) validatedRoles.push({ role: role.role, artifactVersionId: captured.artifactVersionId })
      formalOutputs.push({
        role: role.role,
        locator,
        artifactVersionId: captured.artifactVersionId,
        contentDigest: captured.contentDigest,
        byteLength: captured.byteLength,
        captureBasis: 'provider_verified',
        validatorResult,
        bundle: role.bundle,
        disposition: validatorResult.passed ? 'finalized' : 'residual_integrity_unknown',
      })
    }
  }
  const validatedRoleSet = new Set(validatedRoles.map(item => item.role))
  const bundlesComplete = plan.bundles.every(bundle => bundle.requiredRoles.every(role => validatedRoleSet.has(role)))
  const requiredRolesComplete = plan.roles.filter(role => role.required).every(role => validatedRoleSet.has(role.role))
  const canFinalize = bundlesComplete && requiredRolesComplete && formalOutputs.length > 0
  const manifestBase = {
    recordVersion: 'animalge.output-manifest/v1' as const,
    manifestId: newOutputManifestId(),
    kind: 'formal' as const,
    reason: null,
    runId: reservation.runId,
    attempt: reservation.attempt,
    reservationId: reservation.reservationId,
    outputPlanId: plan.planId,
    formalOutputs,
    unclassifiedBoundaryObservations: observations,
    generatedAt: Date.now(),
  }
  const manifest: OutputManifestV1 = { ...manifestBase, manifestDigest: canonicalDigest(manifestBase as unknown as JsonValue) }
  await store.putMaterialRecord(store.outputManifests, manifest.manifestId, manifest)
  let finalization: OutputFinalizationRecordV1 | null = null
  if (canFinalize) {
    // §8.4 idempotency key runId/attempt: a repeat delivery HITS the existing record; the
    // first publication stays the only commit marker for this attempt.
    const existing = store.outputFinalizations.get(`${reservation.runId}:${reservation.attempt}`)
    if (existing !== undefined) {
      finalization = existing
    } else {
      const base = {
        recordVersion: 'animalge.output-finalization/v1' as const,
        finalizationId: newOutputFinalizationId(),
        runId: reservation.runId,
        attempt: reservation.attempt,
        manifestId: manifest.manifestId,
        manifestDigest: manifest.manifestDigest,
        finalizedRoles: [...validatedRoleSet].sort((left, right) => left.localeCompare(right)),
        finalizedAt: Date.now(),
      }
      finalization = { ...base, finalizationDigest: canonicalDigest(base) }
      await store.putMaterialRecord(store.outputFinalizations, `${reservation.runId}:${reservation.attempt}`, finalization)
    }
  }
  return {
    manifest,
    finalization,
    outputCompleteness: canFinalize ? 'complete' : 'incomplete',
    outputCompletenessReason: canFinalize ? null : 'required_output_incomplete',
    validatedRoles,
  }
}
