/** Deterministic Receipt acceptance lane (SPEC-02 §7): persisted pairing verification before any materialization. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { JsonValue, SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'
import { canonicalDigest } from './canonical-json.ts'
import { deriveRunId, newReceiptAcceptanceId } from './identity.ts'
import { eventRef, runIdentityMaterial, validateSuffix } from './capture.ts'
import { meetsReceiptBackedMinimum, verifyReceiptComponents } from './receipt.ts'
import type { ComponentKey, ReceiptIdentityFailure, ComponentVerdict } from './receipt.ts'
import type { ReceiptSubmission } from './schema.ts'
import { EvidenceStore, EvidenceStoreError } from './store.ts'
import type { EvidenceRunId, InvocationEventBasisV1, ReceiptAcceptanceRecordV1, SessionEventRefV1 } from './types.ts'
import { ReceiptSubmissionId as brandReceiptSubmissionId } from './identity.ts'

/** Registered capture profiles the lane will accept as producers (v0.1: runner:bash). */
export interface LaneProducerRegistry {
  readonly providers: ReadonlySet<string>
  readonly profiles: ReadonlySet<string>
}

interface PairedBasis {
  readonly basis: InvocationEventBasisV1
  readonly derivedRunId: EvidenceRunId
  readonly startRef: SessionEventRefV1
  readonly resultRef: SessionEventRefV1
  readonly resultSeq: number
}

function appendSurface(event: SessionEvent): boolean {
  return 'surfaceOp' in event && event.surfaceOp === 'append'
}

/** Placeholder refs for an invalid pairing: the claimed start ref (or a synthetic absent marker). */
function pairedResultRefsFor(
  submission: ReceiptSubmission,
  events: readonly SessionEvent[],
  header: SessionHeader,
): { readonly startRef: SessionEventRefV1; readonly resultRef: SessionEventRefV1 } {
  const callId = submission.invocationBasis.kind === 'direct' ? submission.invocationBasis.callId : submission.invocationBasis.subCallId
  const start = events.find((event): event is SessionEvent<'tool/call'> | SessionEvent<'tool/code-dispatch-start'> => (event.type === 'tool/call' && event.data.callId === callId) || (event.type === 'tool/code-dispatch-start' && event.data.subCallId === callId))
  const result = events.find((event): event is SessionEvent<'tool/result'> | SessionEvent<'tool/code-dispatch'> => (event.type === 'tool/result' && appendSurface(event) && event.data.message.source.callId === callId) || (event.type === 'tool/code-dispatch' && event.data.subCallId === callId))
  const claimed = submission.invocationBasis.startEventRef
  return {
    startRef: start !== undefined ? eventRef(header, start) : claimed ?? eventRef(header, events[0] as SessionEvent),
    resultRef: result !== undefined ? eventRef(header, result) : claimed ?? eventRef(header, events[0] as SessionEvent),
  }
}

function claimedResultSeq(submission: ReceiptSubmission, events: readonly SessionEvent[]): number {
  const callId = submission.invocationBasis.kind === 'direct' ? submission.invocationBasis.callId : submission.invocationBasis.subCallId
  const result = events.find((event): event is SessionEvent<'tool/result'> | SessionEvent<'tool/code-dispatch'> => (event.type === 'tool/result' && appendSurface(event) && event.data.message.source.callId === callId) || (event.type === 'tool/code-dispatch' && event.data.subCallId === callId))
  return result?.seq ?? submission.invocationBasis.startEventRef?.seq ?? 0
}

/**
 * The acceptance lane: a deterministic background consumer of the persisted Session prefix
 * that closes the two-phase Receipt delivery. It rides the same outer-awaited-flush +
 * inclusive-readFrom admission discipline and the single owner queue as the SPEC-01 compile
 * path; it never advances the deterministic watermark and never materializes anything.
 */
export class AcceptanceLane {
  constructor(
    private readonly ctx: Context,
    private readonly store: EvidenceStore,
    private readonly registry: LaneProducerRegistry,
  ) {}

  /**
   * Register one freshly persisted Submission as pending (called before the tool result settles).
   * @param sessionId The owning Session.
   * @param receiptId The freshly persisted Submission identity.
   */
  async registerPending(sessionId: SessionId, receiptId: string): Promise<void> {
    await this.store.updateReceiptLane(sessionId, current => ({
      recordVersion: 'animalge.receipt-lane/v1',
      sessionId,
      nextSeqExclusive: current?.nextSeqExclusive ?? 0,
      pendingSubmissions: [...(current?.pendingSubmissions ?? []), brandReceiptSubmissionId(receiptId)],
      updatedAt: Date.now(),
    }))
  }

  private async durableSuffix(
    header: SessionHeader,
    from: number,
    cold: boolean,
  ): Promise<{ readonly meta: SessionHeader; readonly events: readonly SessionEvent[] }> {
    if (!cold) {
      const live: Session | undefined = this.ctx.sessions.get(header.id)
      if (live !== undefined && live.header.createdAt === header.createdAt) {
        if (!(await this.ctx.sessions.flush(live))) throw new EvidenceStoreError('flush_unavailable', `no durability listener participated for live Session '${header.id}'`)
        return this.ctx.sessionPersistence.readFrom(header.id, from)
      }
    }
    const before = (await this.ctx.sessionPersistence.listSnapshots()).find(snapshot => snapshot.header.id === header.id)
    const read = await this.ctx.sessionPersistence.readFrom(header.id, from)
    const after = (await this.ctx.sessionPersistence.listSnapshots()).find(snapshot => snapshot.header.id === header.id)
    if (before === undefined || after === undefined || before.revision !== after.revision) throw new Error(`cold Session '${header.id}' changed during suffix read`)
    return read
  }

  /**
   * Process every pending Submission for one Session (SPEC-02 §7.1/§7.2). The read starts at
   * the lane watermark; a claimed start ref below the watermark falls back to one full scan so
   * pairing never depends on events already consumed.
   * @param header The Session header whose pending deliveries are processed.
   * @param cold Whether to use the cold double-snapshot admission path.
   */
  async processSession(header: SessionHeader, cold: boolean): Promise<void> {
    const lane = this.store.receiptLaneFor(header.id)
    if (lane === undefined || lane.pendingSubmissions.length === 0) return
    const pending = lane.pendingSubmissions
      .map(receiptId => this.store.receiptSubmissions.get(receiptId))
      .filter((value): value is ReceiptSubmission => value !== undefined)
    if (pending.length === 0) {
      await this.store.updateReceiptLane(header.id, current => current === undefined ? { recordVersion: 'animalge.receipt-lane/v1', sessionId: header.id, nextSeqExclusive: 0, pendingSubmissions: [], updatedAt: Date.now() } : { ...current, pendingSubmissions: [], updatedAt: Date.now() })
      return
    }
    const needsFullScan = pending.some(submission =>
      submission.invocationBasis.startEventRef !== null
      && submission.invocationBasis.startEventRef.seq < lane.nextSeqExclusive)
    const from = needsFullScan ? 0 : lane.nextSeqExclusive
    const suffix = await this.durableSuffix(header, from, cold)
    validateSuffix(suffix.meta, header, from, suffix.events)
    const events = suffix.events
    let maxSettledSeq = lane.nextSeqExclusive - 1
    for (const submission of pending) {
      const paired = this.findPairedBasis(submission, events, suffix.meta)
      if (paired.state === 'pending') continue // result event not persisted yet: delivery stays pending
      if (paired.state === 'invalid') {
        await this.recordRejection(submission, pairedResultRefsFor(submission, events, suffix.meta), 'paired_events_missing')
        maxSettledSeq = Math.max(maxSettledSeq, claimedResultSeq(submission, events))
        continue
      }
      const settled = await this.verifyAndRecord(submission, paired)
      maxSettledSeq = Math.max(maxSettledSeq, paired.resultSeq)
      if (settled !== undefined) await this.requeueForMaterialization(submission, paired)
    }
    if (maxSettledSeq >= lane.nextSeqExclusive) {
      await this.store.updateReceiptLane(header.id, current => current === undefined ? { recordVersion: 'animalge.receipt-lane/v1', sessionId: header.id, nextSeqExclusive: maxSettledSeq + 1, pendingSubmissions: [], updatedAt: Date.now() } : {
        ...current,
        nextSeqExclusive: maxSettledSeq + 1,
        pendingSubmissions: current.pendingSubmissions.filter(id => this.store.acceptanceFor(id) === undefined),
        updatedAt: Date.now(),
      })
    }
  }

  /**
   * `pending` means the result event is not persisted yet (delivery stays pending);
   * `invalid` means a result exists for the claimed call identity but the pairing fails
   * the SPEC-01 §6.2 rules — a core-identity failure that rejects the whole delivery.
   */
  private findPairedBasis(submission: ReceiptSubmission, events: readonly SessionEvent[], header: SessionHeader): { readonly state: 'pending' } | { readonly state: 'invalid' } | ({ readonly state: 'ok' } & PairedBasis) {
    const basis = submission.invocationBasis
    if (basis.kind === 'direct') {
      const call = events.find((event): event is SessionEvent<'tool/call'> => event.type === 'tool/call' && event.data.callId === basis.callId)
      const result = events.find((event): event is SessionEvent<'tool/result'> => event.type === 'tool/result' && appendSurface(event) && event.data.message.source.callId === basis.callId)
      if (result === undefined) return { state: 'pending' }
      if (call === undefined) return { state: 'invalid' }
      if (call.seq >= result.seq || call.data.turn !== result.data.turn || call.data.step !== result.data.step) return { state: 'invalid' }
      const blocks = result.data.message.content
      if (blocks[0].toolCallId !== basis.callId) return { state: 'invalid' }
      const eventBasis: InvocationEventBasisV1 = { kind: 'top_level_tool', callId: basis.callId, callEvent: eventRef(header, call), resultEvent: eventRef(header, result) }
      return {
        state: 'ok',
        basis: eventBasis,
        derivedRunId: deriveRunId(runIdentityMaterial(submission.evidenceGraphId, submission.sessionId, eventBasis)),
        startRef: eventBasis.callEvent,
        resultRef: eventBasis.resultEvent,
        resultSeq: result.seq,
      }
    }
    const start = events.find((event): event is SessionEvent<'tool/code-dispatch-start'> => event.type === 'tool/code-dispatch-start' && event.data.subCallId === basis.subCallId)
    const result = events.find((event): event is SessionEvent<'tool/code-dispatch'> => event.type === 'tool/code-dispatch' && event.data.subCallId === basis.subCallId)
    if (result === undefined) return { state: 'pending' }
    if (start === undefined) return { state: 'invalid' }
    if (start.seq >= result.seq
      || start.data.rootCallId !== result.data.rootCallId
      || start.data.parentCallId !== result.data.parentCallId
      || start.data.name !== result.data.name
      || canonicalDigest(start.data.arguments as JsonValue) !== canonicalDigest(result.data.arguments as JsonValue)) return { state: 'invalid' }
    const eventBasis: InvocationEventBasisV1 = {
      kind: 'code_mode_dispatch', rootCallId: basis.rootCallId, parentCallId: basis.parentCallId, subCallId: basis.subCallId,
      startEvent: eventRef(header, start), resultEvent: eventRef(header, result),
    }
    return {
      state: 'ok',
      basis: eventBasis,
      derivedRunId: deriveRunId(runIdentityMaterial(submission.evidenceGraphId, submission.sessionId, eventBasis)),
      startRef: eventBasis.startEvent,
      resultRef: eventBasis.resultEvent,
      resultSeq: result.seq,
    }
  }

  /** Core-identity rejection with placeholder refs from the claimed basis (§6.4: event facts stay). */
  private async recordRejection(
    submission: ReceiptSubmission,
    refs: { readonly startRef: SessionEventRefV1; readonly resultRef: SessionEventRefV1 },
    reason: string,
  ): Promise<void> {
    if (this.store.acceptanceFor(submission.receiptId) !== undefined) return
    const envelope = {
      recordVersion: 'animalge.receipt-acceptance/v1' as const,
      acceptanceId: newReceiptAcceptanceId(),
      receiptId: submission.receiptId,
      submissionDigest: submission.submissionDigest,
      acceptedAt: Date.now(),
      pairedStartRef: refs.startRef,
      pairedResultRef: refs.resultRef,
      verdict: 'rejected' as const,
      rejectedReason: reason,
      componentVerdicts: this.allFailedVerdicts(submission),
      receiptAcceptance: 'rejected' as const,
    }
    const record = { ...envelope, acceptanceDigest: canonicalDigest(envelope as unknown as JsonValue) }
    await this.store.putMaterialRecord(this.store.receiptAcceptances, envelope.acceptanceId, record)
    // SPEC-05 §5.2: acceptance-record creation is a transition point (receipt state becomes queryable).
    this.store.stateNotifier?.(submission.evidenceGraphId, 'acceptance')
  }

  /** §7.2 core identity verification + §6.4 component verification; writes one immutable record. */
  private async verifyAndRecord(submission: ReceiptSubmission, paired: PairedBasis): Promise<true | undefined> {
    const existing = this.store.acceptanceFor(submission.receiptId)
    if (existing !== undefined) return existing.verdict === 'accepted' ? true : undefined

    const identityFailure = this.verifyIdentity(submission, paired)
    const componentVerdicts = identityFailure === null
      ? verifyReceiptComponents(this.store, submission)
      : this.allFailedVerdicts(submission)
    const accepted = identityFailure === null && meetsReceiptBackedMinimum(componentVerdicts)
    const envelope = {
      recordVersion: 'animalge.receipt-acceptance/v1' as const,
      acceptanceId: newReceiptAcceptanceId(),
      receiptId: submission.receiptId,
      submissionDigest: submission.submissionDigest,
      acceptedAt: Date.now(),
      pairedStartRef: paired.startRef,
      pairedResultRef: paired.resultRef,
      verdict: accepted ? 'accepted' as const : 'rejected' as const,
      rejectedReason: accepted ? null : (identityFailure ?? 'no_verified_component'),
      componentVerdicts,
      receiptAcceptance: accepted ? 'accepted' as const : 'rejected' as const,
    }
    const record: ReceiptAcceptanceRecordV1 = { ...envelope, acceptanceDigest: canonicalDigest(envelope as unknown as JsonValue) }
    await this.store.putMaterialRecord(this.store.receiptAcceptances, record.acceptanceId, record)
    // SPEC-05 §5.2: acceptance-record creation is a transition point (receipt state becomes queryable).
    this.store.stateNotifier?.(submission.evidenceGraphId, 'acceptance')
    return accepted ? true : undefined
  }

  private verifyIdentity(submission: ReceiptSubmission, paired: PairedBasis): ReceiptIdentityFailure | null {
    if (paired.derivedRunId !== submission.runId) return 'run_id_mismatch'
    const claimed = submission.invocationBasis.startEventRef
    if (claimed !== null && (claimed.seq !== paired.startRef.seq || claimed.eventDigest !== paired.startRef.eventDigest)) return 'claimed_start_ref_mismatch'
    const bootstrap = this.store.sessionGraphs.get(submission.sessionId)
    if (bootstrap === undefined || bootstrap.state !== 'ready' || bootstrap.graphId !== submission.evidenceGraphId) return 'scope_mismatch'
    if (!this.registry.providers.has(submission.providerId) || !this.registry.profiles.has(submission.captureProfileId)) return 'producer_not_registered'
    const { submissionDigest: _omit, ...rest } = submission as unknown as Record<string, unknown>
    if (canonicalDigest(rest as JsonValue) !== submission.submissionDigest) return 'submission_digest_mismatch'
    return null
  }

  private allFailedVerdicts(submission: ReceiptSubmission): Record<ComponentKey, ComponentVerdict> {
    const verdicts = {} as Record<ComponentKey, ComponentVerdict>
    for (const key of Object.keys(submission.components) as ComponentKey[]) verdicts[key] = 'failed'
    return verdicts
  }

  /**
   * Late-or-immediate recompile trigger (§7.4): every settled acceptance re-admits its result
   * boundary under reason `receipt_accepted` with a fresh fair ticket. When the compile lane
   * has not covered the boundary yet this merges with the normal admission; when it has, the
   * byte-level no-op check (store.commit) sees changed material bytes and produces a new
   * Snapshot. The deterministic watermark is never advanced by this admission.
   */
  private async requeueForMaterialization(submission: ReceiptSubmission, paired: PairedBasis): Promise<void> {
    await this.store.admitOutbox({
      graphId: submission.evidenceGraphId,
      sessionId: submission.sessionId,
      targetNextSeqExclusive: paired.resultSeq + 1,
      firstBoundarySeq: paired.resultSeq,
      lastBoundarySeq: paired.resultSeq,
      boundaryCount: 1,
      reasonCounts: { tool_result: 0, code_dispatch: 0, turn_end: 0, startup_scan: 0, retry: 0, receipt_accepted: 1 },
      firstQueuedAt: Date.now(),
      lastQueuedAt: Date.now(),
      eligibleAfter: Date.now(),
      retryNotBefore: 0,
      overflowed: false,
      latestAdmittedTarget: paired.resultSeq + 1,
    })
  }

  /**
   * Startup recovery (§3.2 step 2): cold-scan every session with pending submissions.
   * @param eligible Eligibility predicate over persisted Session headers.
   */
  async recoverPending(eligible: (header: SessionHeader) => boolean): Promise<void> {
    for (const sessionId of this.store.sessionsWithPendingReceipts()) {
      const snapshot = (await this.ctx.sessionPersistence.listSnapshots()).find(entry => entry.header.id === sessionId)
      if (snapshot === undefined || !eligible(snapshot.header)) continue
      try {
        await this.processSession(snapshot.header, true)
      } catch (error) {
        if (error instanceof EvidenceStoreError && (error.code === 'flush_unavailable' || error.code === 'read_temporary')) continue
        this.ctx.logger.warn(`evidence-core: receipt acceptance recovery '${String(sessionId)}' failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
