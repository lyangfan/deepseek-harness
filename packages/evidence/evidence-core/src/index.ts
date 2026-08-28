/** Deterministic, private-owner Evidence Core function plugin. */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { Session, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { canonicalJson } from './canonical-json.ts'
import { completionBoundary, foldCaptures, resolveSelection, validateSuffix } from './capture.ts'
import type { CaptureSelection } from './capture.ts'
import { compileSnapshot, COMPILER_REVISION } from './compiler.ts'
import { materialSnapshotFor } from './materialize.ts'
import { collectEvidenceGarbage } from './gc.ts'
import { recoverCurrentHeads } from './recovery.ts'
import { EvidenceStore, EvidenceStoreError } from './store.ts'
import type { CompileOutbox } from './schema.ts'
import { ArtifactProvider } from './artifact.ts'
import { AcceptanceLane } from './acceptance.ts'
import { RUNNER_PROVIDER_ID } from './receipt.ts'
import { REGISTERED_CAPTURE_PROFILE_IDS } from './runner/profiles.ts'
import { applySciRunCodeTool } from './runner/index.ts'
import { applyProfessionalTools, PROFESSIONAL_CAPTURE_PROFILE_IDS } from './professional/index.ts'
import { SCIENTIFIC_TOOL_PROVIDER_ID } from './professional/runtime.ts'
import { registerActiveEvidenceStore } from './professional/environment.ts'

export type * from './types.ts'
export { canonicalDigest, canonicalJson, parseCanonicalJson, sha256Digest } from './canonical-json.ts'
export { deriveEdgeId, deriveNodeId, deriveObservationId, deriveRunId, deriveArtifactNodeId, deriveContextNodeId, EvidenceEdgeId, EvidenceGraphId, EvidenceNodeId, EvidenceRunId, ObservationId, taggedSha256Digest } from './identity.ts'
export { evidenceEdgeSchema, evidenceGraphScopeSchema, evidenceNodeSchema, evidenceSnapshotPayloadSchema, eventBackedRunPayloadSchema, receiptBackedRunPayloadSchema, artifactVersionNodePayloadSchema, contextEntityNodePayloadSchema, sessionEventRefSchema, sha256DigestSchema, storedSnapshotSchema, toolResultObservationPayloadSchema } from './schema.ts'
export { verifySnapshot, verifyStoredSnapshot } from './integrity.ts'
export { buildEvidenceExport, explicitSnapshotDigest, verifyEvidenceExport, writeEvidenceExport } from './export.ts'
export { ArtifactProvider, ArtifactConflictError } from './artifact.ts'
export { SourceAnchorOwner, AnchorError, REGISTERED_ANCHOR_KINDS, SOURCE_ANCHOR_VERIFIER_REVISION } from './anchor.ts'
export { AcceptanceLane } from './acceptance.ts'
export { ContextEntityOwner } from './context-entity.ts'
export { persistReceiptSubmission, verifyReceiptComponents, meetsReceiptBackedMinimum, RECEIPT_SCHEMA_REVISION, RUNNER_PROVIDER_ID, RUNNER_PROVIDER_VERSION } from './receipt.ts'
export { executeSciRunCode, RunnerInputError } from './runner/execute.ts'
export { BASH_LANGUAGE_PROFILE, registeredProfile } from './runner/profiles.ts'
export { applyProfessionalTools, PROFESSIONAL_CAPTURE_PROFILE_IDS } from './professional/index.ts'
export { SCIENTIFIC_TOOL_PROVIDER_ID } from './professional/runtime.ts'
export { freezeTestedEnvironmentRevision, freezeCurrentEnvironment, registerActiveEvidenceStore, currentEnvironmentRevision, EnvironmentGateError } from './professional/environment.ts'
export { EvidenceStore, EvidenceStoreError } from './store.ts'

export const name = 'evidence-core'
export const inject = ['storageDomain', 'sessionPersistence', 'sessions', 'fs', 'subprocess', 'tools', 'jobs']

/** Exact, revisioned Tool-name rule used by the non-LLM compiler. */
export interface DeterministicRunSelectionConfig {
  /** Deployment-owned revision label included in every selected Run payload. */
  readonly revision: string
  /** Exact case-sensitive Tool names eligible for deterministic projection. */
  readonly exactToolNames: string[]
}

/** Loader configuration for deterministic Evidence capture, publication, retry, retention, and the SPEC-02 material layer. */
export interface Config {
  /** Exact Agent preset ids whose Sessions may create Evidence state. */
  readonly eligibleAgentPresetIds: string[]
  /** Deterministic, non-LLM Tool selection rule bound into Snapshot revisions. */
  readonly deterministicRunSelection: DeterministicRunSelectionConfig
  /** Quiet window after the latest completion boundary before compilation, in milliseconds. */
  readonly idleMergeMs: number
  /** Maximum canonical accounted bytes across durable outbox rows. */
  readonly captureOutboxMaxBytes: number
  /** Maximum unprocessed completion boundaries admitted to one outbox row. */
  readonly captureOutboxMaxBoundaries: number
  /** Accounted-byte threshold that reports soft pressure without stopping an active commit. */
  readonly storageSoftBytes: number
  /** Accounted-byte threshold above which no new compile attempt or staging row starts. */
  readonly storageHardBytes: number
  /** Minimum age before unreferenced staging records are eligible for deletion. */
  readonly stagingGcAgeMs: number
  /** Minimum age after first quarantine observation before an orphan Snapshot is deleted. */
  readonly orphanGcGraceMs: number
  /** Interval between conservative reference-closure garbage-collection passes. */
  readonly gcIntervalMs: number
  /** Maximum total attempts in one no-progress retry chain, including its first attempt. */
  readonly maxRetryAttempts: number
  /** Delay before each successor attempt; length must equal maxRetryAttempts minus one. */
  readonly retryDelaysMs: number[]
  /** Whether the declarative scientific-code Runner Tool is registered (SPEC-02 §11.1). */
  readonly runnerEnabled: boolean
  /** Parent directory of the run-exclusive Runner output directories (SPEC-02 §11.1). */
  readonly runnerOutputRoot: string
  /** Default Runner execution timeout in milliseconds. */
  readonly runnerDefaultTimeoutMs: number
  /** Maximum declared outputs accepted by one Runner call. */
  readonly runnerMaxDeclaredOutputs: number
  /** Per-stream captured log bound in bytes; overflow truncates and marks. */
  readonly runnerLogCaptureMaxBytes: number
  /** Maximum freshness-cache entries for ArtifactVersion hashing reuse. */
  readonly materialHashCacheMaxEntries: number
  /** Whether the four professional adapter Tools are registered (SPEC-03 §12.1). */
  readonly professionalToolsEnabled: boolean
  /** Parent directory of professional run-exclusive output boundaries (SPEC-03 §12.1). */
  readonly professionalOutputRoot: string
  /** Default professional execution timeout in milliseconds. */
  readonly professionalDefaultTimeoutMs: number
  /** Per-stream captured log bound for professional runs; overflow truncates and marks. */
  readonly professionalLogCaptureMaxBytes: number
  /** Maximum roles accepted by one professional Output Plan. */
  readonly professionalMaxPlanOutputs: number
}

export const Config: s<Config> = s.object({
  eligibleAgentPresetIds: s.array(s.string()).min(1).required(),
  deterministicRunSelection: s.object({ revision: s.string().required(), exactToolNames: s.array(s.string()).default([]) }).required(),
  idleMergeMs: s.natural().default(3_000),
  captureOutboxMaxBytes: s.natural().min(1).default(67_108_864),
  captureOutboxMaxBoundaries: s.natural().min(1).default(1_000),
  storageSoftBytes: s.natural().default(1_073_741_824),
  storageHardBytes: s.natural().min(1).default(2_147_483_648),
  stagingGcAgeMs: s.natural().default(86_400_000),
  orphanGcGraceMs: s.natural().default(604_800_000),
  gcIntervalMs: s.natural().min(1).default(86_400_000),
  maxRetryAttempts: s.natural().min(1).default(5),
  retryDelaysMs: s.array(s.natural().min(1)).default([1_000, 2_000, 4_000, 8_000]),
  runnerEnabled: s.boolean().default(true),
  runnerOutputRoot: s.string().default('.evidence-runner-outputs'),
  runnerDefaultTimeoutMs: s.natural().min(1).default(600_000),
  runnerMaxDeclaredOutputs: s.natural().min(1).default(64),
  runnerLogCaptureMaxBytes: s.natural().min(1).default(8_388_608),
  materialHashCacheMaxEntries: s.natural().min(1).default(4_096),
  professionalToolsEnabled: s.boolean().default(true),
  professionalOutputRoot: s.string().default('.evidence-professional-outputs'),
  professionalDefaultTimeoutMs: s.natural().min(1).default(600_000),
  professionalLogCaptureMaxBytes: s.natural().min(1).default(8_388_608),
  professionalMaxPlanOutputs: s.natural().min(1).default(64),
})

interface HotSessionState {
  observedNextSeqExclusive: number
  readonly openTurns: Set<number>
  readonly activeCalls: Set<string>
  readonly activeCodeCalls: Set<string>
}

interface CaptureHint {
  readonly header: SessionHeader
  completionCandidate: boolean
}

function requireSafe(value: number, field: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`evidence-core: ${field} must be a safe integer >= ${minimum}`)
}

function resolveConfig(input: Config): {
  readonly config: Config
  readonly selection: CaptureSelection
  readonly eligible: ReadonlySet<string>
} {
  const eligible = [...input.eligibleAgentPresetIds].sort()
  if (eligible.length === 0
    || eligible.some(value => value.trim() === '')
    || eligible.some((value, index) => index > 0 && value === eligible[index - 1])) {
    throw new TypeError('evidence-core: eligibleAgentPresetIds must be non-empty, unique, non-blank exact strings')
  }
  for (const field of ['idleMergeMs', 'captureOutboxMaxBytes', 'captureOutboxMaxBoundaries', 'storageSoftBytes', 'storageHardBytes', 'stagingGcAgeMs', 'orphanGcGraceMs', 'gcIntervalMs', 'maxRetryAttempts'] as const) {
    const positive = ['captureOutboxMaxBytes', 'captureOutboxMaxBoundaries', 'storageHardBytes', 'gcIntervalMs', 'maxRetryAttempts'].includes(field)
    requireSafe(input[field], field, positive ? 1 : 0)
  }
  input.retryDelaysMs.forEach((value, index) =>{  requireSafe(value, `retryDelaysMs[${index}]`, 1) })
  if (input.storageSoftBytes >= input.storageHardBytes) throw new TypeError('evidence-core: storageSoftBytes must be less than storageHardBytes')
  if (input.retryDelaysMs.length !== input.maxRetryAttempts - 1) throw new TypeError('evidence-core: retryDelaysMs length must equal maxRetryAttempts - 1')
  return {
    config: input,
    selection: resolveSelection(input.deterministicRunSelection.revision, input.deterministicRunSelection.exactToolNames),
    eligible: new Set(eligible),
  }
}

class EvidenceRuntime {
  private readonly hot = new Map<SessionId, HotSessionState>()
  private readonly hints = new Map<SessionId, CaptureHint>()
  private captureRun: Promise<void> | undefined
  private compileRun: Promise<void> | undefined
  private stopping = false
  private readonly abort = new AbortController()
  private gcTimer: ReturnType<typeof setInterval> | undefined
  private compileTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly store: EvidenceStore,
    private readonly config: Config,
    private readonly selection: CaptureSelection,
    private readonly eligible: ReadonlySet<string>,
    private readonly lane: AcceptanceLane | undefined,
  ) {}

  async start(): Promise<() => Promise<void>> {
    await this.store.recoverBootstraps()
    await recoverCurrentHeads(this.store)
    await this.store.reconcileAttempts()
    // SPEC-03 §3.2-4: startup recovery conservatively abandons every active reservation
    // (§8.1 — spawn-before/after crashes are indistinguishable in persisted state).
    await this.store.abandonActiveReservations()
    await this.scanCold()
    if (this.lane !== undefined) await this.lane.recoverPending(header => this.isEligible(header))
    const stopEvent = this.ctx.on('session/event', (session, event) => { this.onEvent(session, event) }, { global: true })
    const stopCreated = this.ctx.on('session/created', (session) => { if (this.isEligible(session.header)) this.state(session.header) }, { global: true })
    const stopDisposed = this.ctx.on('session/disposed', (session) => {
      if (this.isEligible(session.header)) this.hint(session.header, true)
      this.hot.delete(session.id)
    }, { global: true })
    for (const session of this.ctx.sessions.list()) if (this.isEligible(session.header)) this.seedLive(session)
    this.gcTimer = setInterval(() => { void this.runGc() }, this.config.gcIntervalMs)
    this.requestCompile()
    return async () => {
      stopEvent(); stopCreated(); stopDisposed()
      this.stopping = true
      this.abort.abort(new Error('evidence-core disposed'))
      if (this.gcTimer !== undefined) clearInterval(this.gcTimer)
      if (this.compileTimer !== undefined) clearTimeout(this.compileTimer)
      // Drain in-flight capture/compile work, then close the Store. The drain is
      // bounded: when disposal tears the Storage Domain's backend out from under a
      // pending domain write, that write's promise can never settle, and an
      // unbounded await would deadlock dispose (§3.2 requires dispose to complete).
      const drain = (async () => {
        await Promise.allSettled([this.captureRun, this.compileRun].filter((value): value is Promise<void> => value !== undefined))
        await this.store.close()
      })()
      await Promise.race([drain.then(() => {}, () => {}), new Promise<void>(resolve => setTimeout(resolve, 2_000))])
    }
  }

  private isEligible(header: SessionHeader): boolean {
    return header.agentPreset !== undefined && this.eligible.has(header.agentPreset)
  }

  private shouldStop(): boolean {
    return this.stopping
  }

  private state(header: SessionHeader): HotSessionState {
    const current = this.hot.get(header.id)
    if (current !== undefined) return current
    const created: HotSessionState = {
      observedNextSeqExclusive: 0,
      openTurns: new Set(),
      activeCalls: new Set(),
      activeCodeCalls: new Set(),
    }
    this.hot.set(header.id, created)
    return created
  }

  private seedLive(session: Session): void {
    const state = this.state(session.header)
    for (const event of session.events) this.foldHot(state, event)
  }

  /** The only synchronous listener path: bounded maps, sets and one microtask request. */
  private onEvent(session: Session, event: SessionEvent): void {
    if (!this.isEligible(session.header)) return
    const state = this.state(session.header)
    this.foldHot(state, event)
    this.hint(session.header, completionBoundary(event) !== undefined)
  }

  private foldHot(state: HotSessionState, event: SessionEvent): void {
    state.observedNextSeqExclusive = Math.max(state.observedNextSeqExclusive, event.seq + 1)
    if (event.type === 'turn/start') state.openTurns.add(event.data.turn)
    else if (event.type === 'turn/end') state.openTurns.delete(event.data.turn)
    else if (event.type === 'tool/call') state.activeCalls.add(event.data.callId)
    else if (event.type === 'tool/result' && event.surfaceOp === 'append') state.activeCalls.delete(event.data.message.source.callId)
    else if (event.type === 'tool/code-dispatch-start') state.activeCodeCalls.add(event.data.subCallId)
    else if (event.type === 'tool/code-dispatch') state.activeCodeCalls.delete(event.data.subCallId)
  }

  private hint(header: SessionHeader, completionCandidate: boolean): void {
    if (this.stopping) return
    const current = this.hints.get(header.id)
    if (current === undefined) this.hints.set(header.id, { header, completionCandidate })
    else current.completionCandidate ||= completionCandidate
    queueMicrotask(() => { this.requestCapture() })
  }

  private requestCapture(): void {
    if (this.stopping || this.captureRun !== undefined) return
    this.captureRun = this.drainCapture().finally(() => {
      this.captureRun = undefined
      if (this.hints.size > 0 && !this.stopping) this.requestCapture()
    })
  }

  private async drainCapture(): Promise<void> {
    while (this.hints.size > 0 && !this.stopping) {
      const entry = this.hints.entries().next().value
      if (entry === undefined) return
      this.hints.delete(entry[0])
      try {
        await this.captureHeader(entry[1].header, false)
      } catch (error: unknown) {
        this.ctx.logger.warn(`evidence-core: capture '${entry[0]}' failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private workspaceFor(sessionId: SessionId): WorkspaceId | undefined {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    const matches = registry.list().filter(workspace => workspace.sessionIds.includes(sessionId))
    if (matches.length > 1) throw new Error(`evidence-core: Session '${sessionId}' belongs to multiple workspaces`)
    return matches[0]?.id
  }

  private async durableSuffix(header: SessionHeader, from: number, cold: boolean) {
    if (!cold) {
      const live = this.ctx.sessions.get(header.id)
      if (live !== undefined && live.header.createdAt === header.createdAt) {
        if (!(await this.ctx.sessions.flush(live))) throw new EvidenceStoreError('flush_unavailable', `no durability listener participated for live Session '${header.id}'`)
        return this.ctx.sessionPersistence.readFrom(header.id, from, this.abort.signal)
      }
    }
    const before = (await this.ctx.sessionPersistence.listSnapshots(this.abort.signal)).find(snapshot => snapshot.header.id === header.id)
    const read = await this.ctx.sessionPersistence.readFrom(header.id, from, this.abort.signal)
    const after = (await this.ctx.sessionPersistence.listSnapshots(this.abort.signal)).find(snapshot => snapshot.header.id === header.id)
    if (before === undefined || after === undefined || before.revision !== after.revision) throw new Error(`cold Session '${header.id}' changed during suffix read`)
    return read
  }

  private async captureHeader(header: SessionHeader, cold: boolean): Promise<void> {
    if (!this.isEligible(header)) return
    // §7.4: within one wake, acceptance processing precedes compilation, so a receipt whose
    // result event just persisted is materialized by the same batch's compile attempt.
    if (this.lane !== undefined && this.store.receiptLaneFor(header.id)?.pendingSubmissions.length) {
      try {
        await this.lane.processSession(header, cold)
      } catch (error) {
        if (!(error instanceof EvidenceStoreError) || (error.code !== 'flush_unavailable' && error.code !== 'read_temporary')) {
          this.ctx.logger.warn(`evidence-core: receipt acceptance '${header.id}' failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    const scope = await this.store.bootstrap(header, this.workspaceFor(header.id))
    const head = this.store.currentHead(scope.graphId)
    const from = this.store.snapshotWatermark(head.snapshotDigest)
    const suffix = await this.durableSuffix(header, from, cold)
    validateSuffix(suffix.meta, header, from, suffix.events)
    if (suffix.events.length === 0) return
    const folded = foldCaptures(scope, suffix.meta, suffix.events, this.selection)
    for (const capture of folded.captures) await this.store.saveCapture(capture)
    if (folded.boundaries.length === 0) return
    const greatest = folded.boundaries.at(-1) as NonNullable<typeof folded.boundaries[number]>
    const target = greatest.seq + 1
    const existing = this.store.outbox.get(scope.graphId)
    const alreadyAdmittedThrough = Math.max(from, existing?.targetNextSeqExclusive ?? from)
    const admitted = folded.boundaries.filter(boundary => boundary.seq >= alreadyAdmittedThrough && boundary.seq < target)
    if (admitted.length === 0) return
    const counts = { tool_result: 0, code_dispatch: 0, turn_end: 0, startup_scan: 0, retry: 0 }
    for (const boundary of admitted) counts[boundary.reason]++
    if (cold) counts.startup_scan++
    const now = Date.now()
    const boundaryCount = admitted.length
    const outboxBytes = [...this.store.outbox.entries()].reduce((total, [key, row]) =>
      total + Buffer.byteLength(key) + Buffer.byteLength(canonicalJson(row as never)), 0)
    const overflowed = outboxBytes >= this.config.captureOutboxMaxBytes
      || (existing?.boundaryCount ?? 0) + boundaryCount > this.config.captureOutboxMaxBoundaries
    await this.store.admitOutbox({
      graphId: scope.graphId, sessionId: header.id, targetNextSeqExclusive: target,
      firstBoundarySeq: admitted[0]?.seq ?? greatest.seq, lastBoundarySeq: greatest.seq, boundaryCount, reasonCounts: counts,
      firstQueuedAt: existing?.firstQueuedAt ?? now, lastQueuedAt: now, eligibleAfter: now + this.config.idleMergeMs,
      retryNotBefore: 0, overflowed, ...(overflowed ? { firstRejectedTarget: target } : {}), latestAdmittedTarget: target,
    })
    this.requestCompile()
  }

  private async scanCold(): Promise<void> {
    for (const snapshot of await this.ctx.sessionPersistence.listSnapshots(this.abort.signal)) {
      if (!this.isEligible(snapshot.header)) continue
      try { await this.captureHeader(snapshot.header, true) } catch (error: unknown) {
        this.ctx.logger.warn(`evidence-core: startup scan '${snapshot.header.id}' failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private requestCompile(): void {
    if (this.stopping || this.compileRun !== undefined) return
    if (this.compileTimer !== undefined) { clearTimeout(this.compileTimer); this.compileTimer = undefined }
    this.compileRun = this.drainCompile().finally(() => {
      this.compileRun = undefined
      this.scheduleCompileWake()
    })
  }

  private scheduleCompileWake(): void {
    if (this.stopping || this.compileTimer !== undefined) return
    const usage = this.store.usage.get('global')
    if (usage !== undefined && usage.accountedBytes >= this.config.storageHardBytes) return
    const next = this.store.nextRunnableAt()
    if (next === undefined) return
    this.compileTimer = setTimeout(() => {
      this.compileTimer = undefined
      this.requestCompile()
    }, Math.max(0, next - Date.now()))
  }

  private idle(row: CompileOutbox): boolean {
    const state = this.hot.get(row.sessionId)
    return state === undefined || (state.openTurns.size === 0 && state.activeCalls.size === 0 && state.activeCodeCalls.size === 0)
  }

  private async drainCompile(): Promise<void> {
    for (;;) {
      if (this.stopping) return
      const usage = this.store.usage.get('global')
      if (usage !== undefined && usage.accountedBytes >= this.config.storageHardBytes) return
      const row = this.store.runnableOutbox(Date.now())
      if (row === undefined || !this.idle(row)) return
      const head = this.store.currentHead(row.graphId)
      const revisions = { canonicalization: 'animalge-c14n-json/v1' as const, identity: 'animalge-identity/v1' as const, compiler: COMPILER_REVISION, captureContract: 'animalge-capture/v1' as const, selectionRuleDigest: this.selection.digest }
      let attempt = await this.store.dequeue(row, head, revisions)
      attempt = await this.store.startAttempt(attempt.attemptId)
      if (this.shouldStop()) { await this.store.cancelAttempt(attempt); return }
      try {
        let boundary: Awaited<ReturnType<SessionPersistence['readFrom']>>
        try {
          boundary = await this.ctx.sessionPersistence.readFrom(row.sessionId, row.targetNextSeqExclusive - 1, this.abort.signal)
        } catch (error) {
          // §8.5: a failing compile-target read is a transient read error unless it already
          // carries a typed EvidenceStore code; this boundary mapping keeps the retryable
          // family reachable. Store-internal failures keep their typed codes, and aborts
          // during dispose pass through untouched for the cancelled settlement.
          if (error instanceof EvidenceStoreError || this.shouldStop()) throw error
          throw new EvidenceStoreError('read_temporary', `boundary read for '${row.sessionId}' failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        const last = boundary.events[0]
        if (last === undefined || last.seq !== row.targetNextSeqExclusive - 1 || completionBoundary(last) === undefined) throw new Error('compile target is not a persisted completion boundary')
        const payload = compileSnapshot({
          scope: this.store.graphs.get(row.graphId)?.scope ?? (() => { throw new Error('Graph scope missing') })(),
          captures: this.store.capturesFor(row.graphId), baseSnapshotDigest: head.snapshotDigest,
          targetNextSeqExclusive: row.targetNextSeqExclusive, sourceTimeUpperBound: last.time,
          selectionRevision: this.selection.revision, selectionRuleDigest: this.selection.digest,
          material: materialSnapshotFor(this.store, row.graphId),
        })
        if (this.shouldStop()) { await this.store.cancelAttempt(attempt); return }
        await this.store.commit(attempt, payload)
      } catch (error: unknown) {
        if (this.shouldStop()) { await this.store.cancelAttempt(attempt); return }
        const code = error instanceof EvidenceStoreError ? error.code : 'unknown_error'
        if (code === 'post_commit_repair_pending') {
          // §7.4(6): the head is already committed; startup reconciliation (§9.2(2)) settles
          // the durable state from the commit evidence, so the attempt must not fail here.
          this.ctx.logger.warn(`evidence-core: compile '${attempt.attemptId}' committed with pending history repair`)
          return
        }
        // §8.5 code-family table: only the temporary family retries; every other code fails closed.
        const retryable = code === 'flush_unavailable' || code === 'read_temporary' || code === 'backend_busy'
        const ordinal = this.store.attemptOrdinal(attempt)
        const retryDelay = retryable && ordinal < this.config.maxRetryAttempts ? this.config.retryDelaysMs[ordinal - 1] : undefined
        await this.store.failAttempt(attempt, code, retryable, retryDelay)
        this.ctx.logger.warn(`evidence-core: compile '${attempt.attemptId}' failed with '${code}': ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async runGc(): Promise<void> {
    if (this.stopping) return
    try { await collectEvidenceGarbage(this.store, this.config) } catch (error: unknown) {
      this.ctx.logger.warn(`evidence-core: GC failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Mount the private Evidence owner, the SPEC-02 material layer, and the bounded Session listeners. */
export async function apply(ctx: Context, input: Config): Promise<void> {
  const { config, selection, eligible } = resolveConfig(input)
  const store = await EvidenceStore.open(ctx)
  store.hardLimitBytes = config.storageHardBytes
  // §3.2: the material layer requires ctx.fs and the Runner additionally requires the
  // subprocess service; both are declared in `inject`, so activation waits for them.
  const artifacts = new ArtifactProvider(ctx, store)
  const lane = new AcceptanceLane(ctx, store, {
    // SPEC-03 §11.4-1: the lane registry gains the professional producer versioned-incrementally.
    providers: new Set([RUNNER_PROVIDER_ID, SCIENTIFIC_TOOL_PROVIDER_ID]),
    profiles: new Set([...REGISTERED_CAPTURE_PROFILE_IDS, ...PROFESSIONAL_CAPTURE_PROFILE_IDS]),
  })
  registerActiveEvidenceStore(store)
  const runtime = new EvidenceRuntime(ctx, store, config, selection, eligible, lane)
  const cleanup = await runtime.start()
  ctx.effect(() => cleanup, 'evidence-core.runtime()')
  if (config.runnerEnabled) {
    applySciRunCodeTool(ctx, {
      store,
      artifacts,
      lane,
      config: {
        runnerOutputRoot: config.runnerOutputRoot,
        runnerDefaultTimeoutMs: config.runnerDefaultTimeoutMs,
        runnerMaxDeclaredOutputs: config.runnerMaxDeclaredOutputs,
        runnerLogCaptureMaxBytes: config.runnerLogCaptureMaxBytes,
      },
    })
  }
  if (config.professionalToolsEnabled) {
    applyProfessionalTools(ctx, {
      store,
      artifacts,
      lane,
      config: {
        professionalOutputRoot: config.professionalOutputRoot,
        professionalDefaultTimeoutMs: config.professionalDefaultTimeoutMs,
        professionalLogCaptureMaxBytes: config.professionalLogCaptureMaxBytes,
        professionalMaxPlanOutputs: config.professionalMaxPlanOutputs,
      },
    })
  }
}
