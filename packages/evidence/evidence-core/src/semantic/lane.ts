/** The semantic lane: turn-boundary targets, model calls, and watermark advance (SPEC-04 §9). */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session/types'
import { compileSnapshot, COMPILER_REVISION } from '../compiler.ts'
import { materialSnapshotFor } from '../materialize.ts'
import { verifyStoredSnapshot } from '../integrity.ts'
import { dispatchEvidenceModelCall, outputDigestOf } from './model-call.ts'
import { ModelRequestError, persistModelRequest } from './model-request.ts'
import { buildSemanticProjection } from './projection.ts'
import { validateAndRecordProposals } from './proposals.ts'
import { EXTRACTOR_REVISION, PROMPT_REVISION, semanticSnapshotFor } from './candidates.ts'
import { semanticSwitchEnabled } from './switch.ts'
import type { EvidenceModelRouteV1, SemanticProjectionConfig } from './model-route.ts'
import { validateExtractionOutput } from './output-schema.ts'
import type { EvidenceStore } from '../store.ts'
import type { CompileAttempt } from '../schema.ts'
import type { CaptureSelection } from '../capture.ts'
import type { CurrentHeadV1, EvidenceGraphId, ModelCallId, Sha256Digest } from '../types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Retry backoff bookkeeping for the lane's own scheduling (D-145: ≤5 total, 1/2/4/8s). */
interface SemanticRetryState {
  attempts: number
  notBefore: number
}

/** One drainable semantic work item: a live Session with a completed-turn target (§9.1). */
export interface SemanticBacklogEntry {
  readonly graphId: EvidenceGraphId
  readonly sessionId: SessionId
  readonly target: number
  readonly header: SessionHeader
  readonly session: Session
}

export class SemanticLaneError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SemanticLaneError'
  }
}

/** Retryable semantic failure codes (D-116 layer 1: temporary model/infrastructure family). */
const RETRYABLE_CODES = new Set([
  'flush_unavailable', 'read_temporary', 'backend_busy', 'model_output_invalid',
  // §9.5 layer 1 includes transient persistence-verification failures of the request
  // event (append + readFrom verification, §6.2) — they park on the D-145 ladder.
  'request_event_not_durable',
])

/**
 * The background semantic channel (SPEC-04 §9). Runs inside the runtime's single compile
 * loop AFTER deterministic rows are exhausted, so the global compile concurrency stays one
 * and semantic attempts never share a per-graph outbox row with deterministic work (a
 * parked semantic retry must not block deterministic compilation, D-116).
 */
export class SemanticLane {
  private readonly retries = new Map<EvidenceGraphId, SemanticRetryState>()

  constructor(
    private readonly ctx: Context,
    private readonly store: EvidenceStore,
    private readonly route: EvidenceModelRouteV1,
    private readonly projectionConfig: SemanticProjectionConfig,
    private readonly selection: CaptureSelection,
    private readonly retryDelaysMs: readonly number[],
    private readonly maxRetryAttempts: number,
    private readonly isStopping: () => boolean,
    private readonly abortSignal: AbortSignal,
  ) {}

  /** The semantic input for a deterministic compile: frozen ledger plus tri-state watermark (§8.4). */
  semanticInputFor(graphId: EvidenceGraphId): { ledger: ReturnType<typeof semanticSnapshotFor>; watermark: { kind: 'active'; nextSeqExclusive: number } | { kind: 'disabled'; lastNextSeqExclusive: number } } {
    const laneWatermark = this.store.semanticLaneFor(graphId)?.nextSeqExclusive ?? 0
    const watermark = semanticSwitchEnabled(this.store, graphId)
      ? { kind: 'active' as const, nextSeqExclusive: laneWatermark }
      : { kind: 'disabled' as const, lastNextSeqExclusive: laneWatermark }
    return { ledger: semanticSnapshotFor(this.store, graphId), watermark }
  }

  nextRetryAt(): number | undefined {
    let minimum: number | undefined
    for (const state of this.retries.values()) if (minimum === undefined || state.notBefore < minimum) minimum = state.notBefore
    return minimum
  }

  /** Backlog entries: configured, switch on, live Session, lane watermark behind the last completed turn. */
  backlog(): SemanticBacklogEntry[] {
    if (this.isStopping()) return []
    const result: SemanticBacklogEntry[] = []
    for (const [, graph] of this.store.graphs.entries()) {
      const { graphId, sessionId } = graph.scope
      if (!semanticSwitchEnabled(this.store, graphId)) continue
      const head = this.store.heads.get(graphId)
      if (head === undefined || head.snapshotDigest === null) continue
      const session = this.ctx.sessions.get(sessionId)
      if (session === undefined) continue
      const laneWatermark = this.store.semanticLaneFor(graphId)?.nextSeqExclusive ?? 0
      const target = this.lastCompletedTurnBoundary(session, laneWatermark)
      if (target === undefined || target <= laneWatermark) continue
      const retry = this.retries.get(graphId)
      if (retry !== undefined && (retry.notBefore > Date.now() || retry.attempts >= this.maxRetryAttempts)) continue
      result.push({ graphId, sessionId, target, header: session.header, session })
    }
    return result
  }

  /** The semantic target: the last completed persisted turn end after the lane watermark (§9.1). */
  private lastCompletedTurnBoundary(session: Session, from: number): number | undefined {
    let target: number | undefined
    for (const event of session.events) {
      if (event.type === 'turn/end' && event.seq + 1 > from) target = event.seq + 1
    }
    return target
  }

  /**
   * Run one semantic attempt (§9.2): freeze the prefix window, build the bounded projection,
   * persist + durability-verify the model request, dispatch through the explicit route,
   * validate proposals into the ledgers, commit the snapshot, and only then advance the
   * semantic watermark. Failures keep the watermark and park a retry (§9.5); the
   * deterministic channel is never blocked.
   */
  async runOne(entry: SemanticBacklogEntry): Promise<boolean> {
    const head = this.store.currentHead(entry.graphId)
    const deterministicTarget = this.store.snapshotWatermark(head.snapshotDigest)
    // §8.4: the semantic channel only covers prefixes the head already covers.
    const target = Math.min(entry.target, deterministicTarget)
    const windowStart = this.store.semanticLaneFor(entry.graphId)?.nextSeqExclusive ?? 0
    if (target <= windowStart) return false
    if (!semanticSwitchEnabled(this.store, entry.graphId)) return false
    const attempt = await this.store.startSemanticAttempt({
      graphId: entry.graphId,
      sessionId: entry.sessionId,
      head,
      targetNextSeqExclusive: target,
      revisions: {
        canonicalization: 'animalge-c14n-json/v1',
        identity: 'animalge-identity/v1',
        compiler: COMPILER_REVISION,
        captureContract: 'animalge-capture/v1',
        selectionRuleDigest: this.selection.digest,
        materialContract: 'animalge-material/v1',
        candidateContract: 'animalge-candidate/v1',
      },
      semantic: {
        modelCallId: null,
        modelRequestEventRef: null,
        projectionDigest: null,
        extractorRevision: EXTRACTOR_REVISION,
        promptRevision: PROMPT_REVISION,
        outputDigest: null,
      },
    })
    try {
      await this.runAttempt(attempt, entry, head, windowStart, target)
      this.retries.delete(entry.graphId)
      return true
    } catch (error) {
      await this.settleFailure(attempt, entry.graphId, error)
      return false
    }
  }

  private async runAttempt(attempt: CompileAttempt, entry: SemanticBacklogEntry, head: CurrentHeadV1, windowStart: number,
    target: number): Promise<void> {
    if (process.env.S04_DEBUG_DISPATCH === '1') process.stderr.write(`LANE runAttempt window=${String(windowStart)} target=${String(target)}\n`)
    if (head.snapshotDigest === null) throw new SemanticLaneError('head_missing', 'semantic attempt requires a committed head')
    // §6.2/D-153: outer-await flush before the prefix read; the attempt's frozen window is
    // [windowStart, target) — complete persisted turns newly covered since the lane watermark.
    if (!(await this.ctx.sessions.flush(entry.session))) throw new SemanticLaneError('flush_unavailable', 'no durability listener participated')
    const read = await this.ctx.sessionPersistence.readFrom(entry.header.id, windowStart, this.abortSignal)
    const prefix = read.events.filter(event => event.seq < target)
    const captures = this.store.capturesFor(entry.graphId)
    const selectedRunIds = new Set(captures.filter(capture => capture.selection === 'selected').map(capture => capture.runId))
    const existingCandidates = [...this.store.candidateRecords.entries()].map(([, row]) => row).filter(row => row.graphId === entry.graphId)
    const projection = buildSemanticProjection({
      header: entry.header,
      graphId: entry.graphId,
      events: prefix,
      fromNextSeqExclusive: windowStart,
      targetNextSeqExclusive: target,
      captures,
      selectedRunIds,
      existingCandidates,
      route: this.route,
      config: this.projectionConfig,
    })
    // The switch may have flipped since admission: no dispatch, no fake request event (D-155).
    if (!semanticSwitchEnabled(this.store, entry.graphId)) {
      await this.store.cancelAttempt(attempt)
      return
    }
    if (process.env.S04_DEBUG_DISPATCH === '1') process.stderr.write('LANE persisting model request\n')
    const request = await persistModelRequest({
      ctx: this.ctx,
      session: entry.session,
      header: entry.header,
      graphId: entry.graphId,
      attemptId: attempt.attemptId,
      requestPayload: projection.requestPayload,
      projectionDigest: projection.projectionDigest,
      sourceRefs: projection.sourceRefs,
      targetNextSeqExclusive: target,
      signal: this.abortSignal,
    })
    const call = await dispatchEvidenceModelCall({ ctx: this.ctx, route: this.route, request, signal: this.abortSignal })
    const output = call.terminal === 'succeeded' && call.output !== null ? validateExtractionOutput(call.output) : null
    const startedAt = Date.now()
    await this.store.putMaterialRecord(this.store.modelCalls, request.modelCallId, {
      recordVersion: 'animalge.model-call/v1',
      modelCallId: request.modelCallId as ModelCallId,
      graphId: entry.graphId,
      attemptId: attempt.attemptId,
      purpose: 'candidate-semantics',
      provider: this.route.provider,
      model: this.route.model,
      generationConfig: projection.requestPayload,
      requestEventRef: request.requestEventRef,
      startedAt,
      endedAt: Date.now(),
      outcome: call.terminal === 'succeeded' && output === null ? 'failed' : call.terminal,
      errorDigest: (call.errorDigest === null && output === null ? 'fnv1a:invalid_output' : call.errorDigest),
      usage: call.usage,
      acceptedOutputDigest: output === null ? null : (outputDigestOf(output) as Sha256Digest),
    })
    // Settled cancellation: the switch flipped while the call was in flight — discard the
    // output, settle cancelled, keep the watermark (§4.3).
    if (!semanticSwitchEnabled(this.store, entry.graphId)) {
      await this.store.cancelAttempt(attempt)
      return
    }
    if (output === null) {
      throw new SemanticLaneError('model_output_invalid', `model call settled '${call.terminal}' without a valid structured output`)
    }
    await validateAndRecordProposals({
      store: this.store,
      graphId: entry.graphId,
      attemptId: attempt.attemptId,
      fromNextSeqExclusive: windowStart,
      targetNextSeqExclusive: target,
      prefixEvents: prefix,
      captures,
      provenance: {
        modelCallId: request.modelCallId,
        modelRequestEventRef: request.requestEventRef,
        provider: this.route.provider,
        model: this.route.model,
        extractorRevision: EXTRACTOR_REVISION,
        promptRevision: PROMPT_REVISION,
        projectionDigest: projection.projectionDigest,
        attemptId: attempt.attemptId,
      },
      output,
    })
    // The snapshot keeps the base's deterministic coverage and time bound; only the semantic
    // projection moves forward (ledger delta + advanced semantic watermark, §8.4).
    const base = verifyStoredSnapshot(this.store.committedSnapshot(head.snapshotDigest))
    const payload = compileSnapshot({
      scope: this.store.graphs.get(entry.graphId)?.scope ?? (() => { throw new SemanticLaneError('graph_missing', 'Graph scope missing') })(),
      captures,
      baseSnapshotDigest: head.snapshotDigest,
      targetNextSeqExclusive: base.deterministicWatermark.nextSeqExclusive,
      sourceTimeUpperBound: base.sourceTimeUpperBound,
      selectionRevision: this.selection.revision,
      selectionRuleDigest: this.selection.digest,
      material: materialSnapshotFor(this.store, entry.graphId),
      semantic: { ledger: semanticSnapshotFor(this.store, entry.graphId), watermark: { kind: 'active' as const, nextSeqExclusive: target } },
    })
    await this.store.commit(attempt, payload)
    // §9.2 hard rule: the watermark advances only after the whole frozen prefix succeeded.
    await this.store.updateSemanticLane(entry.graphId, () => ({
      recordVersion: 'animalge.semantic-lane/v1',
      graphId: entry.graphId,
      nextSeqExclusive: target,
      updatedAt: Date.now(),
    }))
  }

  private async settleFailure(attempt: CompileAttempt, graphId: EvidenceGraphId, error: unknown): Promise<void> {
    const code = error instanceof SemanticLaneError || error instanceof ModelRequestError
      ? error.code
      : typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'semantic_unknown_error'
    const retryable = RETRYABLE_CODES.has(code)
    await this.store.failAttempt(attempt, code, retryable, undefined)
    const state = this.retries.get(graphId) ?? { attempts: 0, notBefore: 0 }
    const nextAttempts = state.attempts + 1
    const ladderDelay = this.retryDelaysMs[nextAttempts - 1] ?? this.retryDelaysMs.at(-1) ?? 1_000
    const delay = retryable && nextAttempts < this.maxRetryAttempts ? ladderDelay : Number.MAX_SAFE_INTEGER
    this.retries.set(graphId, { attempts: nextAttempts, notBefore: Date.now() + delay })
    this.ctx.logger.warn(`evidence-core: semantic attempt '${attempt.attemptId}' failed with '${code}': ${error instanceof Error ? error.message : String(error)}`)
  }
}
