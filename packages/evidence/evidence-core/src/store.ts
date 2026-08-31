/** Private single-writer owner for the `animalge_evidence` Storage Domain. */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue, SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { canonicalDigest, canonicalJson, sha256Digest } from './canonical-json.ts'
import { newCompileAttemptId, newEvidenceGraphId, newRecoveryId, newStagingId } from './identity.ts'
import {
  artifactRecordSchema,
  artifactVersionCoreSchema,
  candidateRecordSchema,
  candidateRelationRecordSchema,
  capturedInvocationSchema,
  compileAttemptSchema,
  compileOutboxSchema,
  contextEntitySchema,
  currentHeadSchema,
  environmentStateSchema,
  graphRecordSchema,
  headCommitSchema,
  inputBundleSchema,
  locationObservationSchema,
  modelCallSchema,
  modelRunSelectionSchema,
  outputFinalizationSchema,
  outputManifestSchema,
  outputPlanSchema,
  outputReservationSchema,
  preflightReportSchema,
  proposalValidationSchema,
  quarantineRecordSchema,
  queueClockSchema,
  receiptAcceptanceSchema,
  receiptLaneSchema,
  receiptSubmissionSchema,
  semanticLaneSchema,
  semanticSwitchSchema,
  sessionGraphBootstrapSchema,
  sourceAnchorSchema,
  stagingRecordSchema,
  storedSnapshotSchema,
  testedEnvironmentRevisionSchema,
  usageSchema,
  issueRecordSchema,
  issueSeenSchema,
} from './schema.ts'
import type { ArtifactRecord, ArtifactVersionCore, CapturedInvocation, CompileAttempt, CompileOutbox, ContextEntityRecord, EnvironmentStateRecord, GraphRecord, HeadCommit, LocationObservation, QuarantineRecord, QueueClock, ReceiptAcceptanceRecord, ReceiptLaneRecord, ReceiptSubmission, SessionGraphBootstrap, SourceAnchorRecord, StagingRecord, UsageRecord } from './schema.ts'
import type { CandidateRecordV1, CandidateRelationRecordV1, CandidateStatementId, CompileAttemptId, CurrentHeadV1, EnvironmentStateV1, EvidenceGraphId, EvidenceGraphScopeV1, EvidenceRunId, EvidenceSnapshotPayloadV1, InputBundleV1, IssueRecordV1, IssueSeenV1, ModelCallId, ModelCallRecordV1, ModelRunSelectionRecordV1, OutputFinalizationRecordV1, OutputManifestV1, OutputPlanV1, OutputReservationV1, PreflightReportV1, ProposalValidationRecordV1, RecoveryId, SemanticLaneV1, SemanticSwitchV1, Sha256Digest, StagingId, StoredSnapshotV1, TestedEnvironmentRevisionV1 } from './types.ts'
import { snapshotRecord, verifyStoredSnapshot } from './integrity.ts'
import { deriveIssues } from './issues.ts'

type CommitKey = `${string}:${number}`
type ArtifactKey = string
type ArtifactVersionKey = string
type LocationObservationKey = string
type ContextEntityKey = string
type SourceAnchorKey = string
type ReceiptSubmissionKey = string
type ReceiptAcceptanceKey = string
type ReceiptLaneKey = SessionId
type InputBundleKey = string
type PreflightReportKey = string
type EnvironmentRevisionKey = string
type EnvironmentStateKey = 'global'
type OutputReservationKey = string
type OutputPlanKey = string
type OutputManifestKey = string
type OutputFinalizationKey = `${string}:${number}`
type SemanticLaneKey = EvidenceGraphId
type SemanticSwitchKey = EvidenceGraphId
type ModelCallKey = ModelCallId
type CandidateKey = CandidateStatementId
type CandidateRelationKey = string
type ModelRunSelectionKey = string
type ProposalValidationKey = string
type IssueRecordKey = string
type IssueSeenKey = string

/**
 * SPEC-05 §5.2/§6.1: transition-point notifier, installed by the plugin assembly. Called
 * synchronously inside the serialized queue at head-commit, attempt terminal settle, startup
 * reconcile, semantic-switch flip, receipt acceptance and markIssuesSeen write points; the
 * callback schedules its own queued work (issue recompute + evidence/updated emission).
 */
export type EvidenceStateNotifier = (graphId: EvidenceGraphId, reason: 'commit' | 'failure' | 'reconcile' | 'switch' | 'acceptance' | 'seen') => void

/** Durable declaration shared by both JSON and SQLite Storage backends. */
export const evidenceDomainSpec = defineDomain({
  name: 'animalge_evidence',
  version: 0,
  tables: {
    graphs: domainTable<EvidenceGraphId, GraphRecord>(graphRecordSchema),
    session_graphs: domainTable<SessionId, SessionGraphBootstrap>(sessionGraphBootstrapSchema),
    captures: domainTable<string, CapturedInvocation>(capturedInvocationSchema),
    snapshots: domainTable<Sha256Digest, StoredSnapshotV1>(storedSnapshotSchema),
    heads: domainTable<EvidenceGraphId, CurrentHeadV1>(currentHeadSchema),
    head_commits: domainTable<CommitKey, HeadCommit>(headCommitSchema),
    attempts: domainTable<CompileAttemptId, CompileAttempt>(compileAttemptSchema),
    outbox: domainTable<EvidenceGraphId, CompileOutbox>(compileOutboxSchema),
    staging: domainTable<StagingId, StagingRecord>(stagingRecordSchema),
    quarantine: domainTable<RecoveryId, QuarantineRecord>(quarantineRecordSchema),
    queue_clock: domainTable<'global', QueueClock>(queueClockSchema),
    usage: domainTable<'global', UsageRecord>(usageSchema),
    // SPEC-02 material owner tables (append-only ledgers; receipt_lane is the only mutable one).
    artifacts: domainTable<ArtifactKey, ArtifactRecord>(artifactRecordSchema),
    artifact_versions: domainTable<ArtifactVersionKey, ArtifactVersionCore>(artifactVersionCoreSchema),
    location_observations: domainTable<LocationObservationKey, LocationObservation>(locationObservationSchema),
    context_entities: domainTable<ContextEntityKey, ContextEntityRecord>(contextEntitySchema),
    source_anchors: domainTable<SourceAnchorKey, SourceAnchorRecord>(sourceAnchorSchema),
    receipt_submissions: domainTable<ReceiptSubmissionKey, ReceiptSubmission>(receiptSubmissionSchema),
    receipt_acceptances: domainTable<ReceiptAcceptanceKey, ReceiptAcceptanceRecord>(receiptAcceptanceSchema),
    receipt_lane: domainTable<ReceiptLaneKey, ReceiptLaneRecord>(receiptLaneSchema),
    // SPEC-03 professional owner tables (append-only ledgers; environment_state,
    // output_reservations state, and finalization idempotency use single-record keys).
    input_bundles: domainTable<InputBundleKey, InputBundleV1>(inputBundleSchema),
    preflight_reports: domainTable<PreflightReportKey, PreflightReportV1>(preflightReportSchema),
    environment_revisions: domainTable<EnvironmentRevisionKey, TestedEnvironmentRevisionV1>(testedEnvironmentRevisionSchema),
    environment_state: domainTable<EnvironmentStateKey, EnvironmentStateV1>(environmentStateSchema),
    output_reservations: domainTable<OutputReservationKey, OutputReservationV1>(outputReservationSchema),
    output_plans: domainTable<OutputPlanKey, OutputPlanV1>(outputPlanSchema),
    output_manifests: domainTable<OutputManifestKey, OutputManifestV1>(outputManifestSchema),
    output_finalizations: domainTable<OutputFinalizationKey, OutputFinalizationRecordV1>(outputFinalizationSchema),
    // SPEC-04 candidate-semantics owner tables (append-only ledgers; semantic_lane and
    // semantic_switch are the only mutable single-record ones, §10.1).
    semantic_lane: domainTable<SemanticLaneKey, SemanticLaneV1>(semanticLaneSchema),
    semantic_switch: domainTable<SemanticSwitchKey, SemanticSwitchV1>(semanticSwitchSchema),
    model_calls: domainTable<ModelCallKey, ModelCallRecordV1>(modelCallSchema),
    candidate_records: domainTable<CandidateKey, CandidateRecordV1>(candidateRecordSchema),
    candidate_relations: domainTable<CandidateRelationKey, CandidateRelationRecordV1>(candidateRelationRecordSchema),
    model_run_selections: domainTable<ModelRunSelectionKey, ModelRunSelectionRecordV1>(modelRunSelectionSchema),
    proposal_validations: domainTable<ProposalValidationKey, ProposalValidationRecordV1>(proposalValidationSchema),
    // SPEC-05 issue-channel owner tables: derived projection + seen timestamps (§12.1); both are
    // excluded from materialStateDigest and covered by the separate issuesRevision token.
    issue_records: domainTable<IssueRecordKey, IssueRecordV1>(issueRecordSchema),
    issue_seen: domainTable<IssueSeenKey, IssueSeenV1>(issueSeenSchema),
  },
})

export class EvidenceStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'EvidenceStoreError'
  }
}

function sameBytes(left: unknown, right: unknown): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue)
}

function headAt(graphId: EvidenceGraphId, revision = 0): CurrentHeadV1 {
  return {
    recordVersion: 'animalge.current-head/v1',
    graphId,
    snapshotDigest: null,
    headRevision: revision,
    previousSnapshotDigest: null,
    previousHeadRevision: null,
  }
}

/** Private owner; no Context service or public registry is installed. */
export class EvidenceStore {
  private tail: Promise<void> = Promise.resolve()
  private accepting = true

  private constructor(private readonly domain: Domain<typeof evidenceDomainSpec>) {}

  static async open(ctx: Context): Promise<EvidenceStore> {
    const domain = await ctx.storageDomain.open(evidenceDomainSpec)
    const owner = new EvidenceStore(domain)
    await owner.initializeControlRows()
    return owner
  }


  get graphs(): KvTable<EvidenceGraphId, GraphRecord> { return this.domain.table('graphs') }
  get sessionGraphs(): KvTable<SessionId, SessionGraphBootstrap> { return this.domain.table('session_graphs') }
  get captures(): KvTable<string, CapturedInvocation> { return this.domain.table('captures') }
  get snapshots(): KvTable<Sha256Digest, StoredSnapshotV1> { return this.domain.table('snapshots') }
  get heads(): KvTable<EvidenceGraphId, CurrentHeadV1> { return this.domain.table('heads') }
  get headCommits(): KvTable<CommitKey, HeadCommit> { return this.domain.table('head_commits') }
  get attempts(): KvTable<CompileAttemptId, CompileAttempt> { return this.domain.table('attempts') }
  get outbox(): KvTable<EvidenceGraphId, CompileOutbox> { return this.domain.table('outbox') }
  get staging(): KvTable<StagingId, StagingRecord> { return this.domain.table('staging') }
  get quarantine(): KvTable<RecoveryId, QuarantineRecord> { return this.domain.table('quarantine') }
  get queueClock(): KvTable<'global', QueueClock> { return this.domain.table('queue_clock') }
  get usage(): KvTable<'global', UsageRecord> { return this.domain.table('usage') }
  get artifacts(): KvTable<ArtifactKey, ArtifactRecord> { return this.domain.table('artifacts') }
  get artifactVersions(): KvTable<ArtifactVersionKey, ArtifactVersionCore> { return this.domain.table('artifact_versions') }
  get locationObservations(): KvTable<LocationObservationKey, LocationObservation> { return this.domain.table('location_observations') }
  get contextEntities(): KvTable<ContextEntityKey, ContextEntityRecord> { return this.domain.table('context_entities') }
  get sourceAnchors(): KvTable<SourceAnchorKey, SourceAnchorRecord> { return this.domain.table('source_anchors') }
  get receiptSubmissions(): KvTable<ReceiptSubmissionKey, ReceiptSubmission> { return this.domain.table('receipt_submissions') }
  get receiptAcceptances(): KvTable<ReceiptAcceptanceKey, ReceiptAcceptanceRecord> { return this.domain.table('receipt_acceptances') }
  get receiptLane(): KvTable<ReceiptLaneKey, ReceiptLaneRecord> { return this.domain.table('receipt_lane') }
  get inputBundles(): KvTable<InputBundleKey, InputBundleV1> { return this.domain.table('input_bundles') }
  get preflightReports(): KvTable<PreflightReportKey, PreflightReportV1> { return this.domain.table('preflight_reports') }
  get environmentRevisions(): KvTable<EnvironmentRevisionKey, TestedEnvironmentRevisionV1> { return this.domain.table('environment_revisions') }
  get environmentState(): KvTable<EnvironmentStateKey, EnvironmentStateV1> { return this.domain.table('environment_state') }
  get outputReservations(): KvTable<OutputReservationKey, OutputReservationV1> { return this.domain.table('output_reservations') }
  get outputPlans(): KvTable<OutputPlanKey, OutputPlanV1> { return this.domain.table('output_plans') }
  get outputManifests(): KvTable<OutputManifestKey, OutputManifestV1> { return this.domain.table('output_manifests') }
  get outputFinalizations(): KvTable<OutputFinalizationKey, OutputFinalizationRecordV1> { return this.domain.table('output_finalizations') }
  get semanticLane(): KvTable<SemanticLaneKey, SemanticLaneV1> { return this.domain.table('semantic_lane') }
  get semanticSwitch(): KvTable<SemanticSwitchKey, SemanticSwitchV1> { return this.domain.table('semantic_switch') }
  get modelCalls(): KvTable<ModelCallKey, ModelCallRecordV1> { return this.domain.table('model_calls') }
  get candidateRecords(): KvTable<CandidateKey, CandidateRecordV1> { return this.domain.table('candidate_records') }
  get candidateRelations(): KvTable<CandidateRelationKey, CandidateRelationRecordV1> { return this.domain.table('candidate_relations') }
  get modelRunSelections(): KvTable<ModelRunSelectionKey, ModelRunSelectionRecordV1> { return this.domain.table('model_run_selections') }
  get proposalValidations(): KvTable<ProposalValidationKey, ProposalValidationRecordV1> { return this.domain.table('proposal_validations') }
  get issueRecords(): KvTable<IssueRecordKey, IssueRecordV1> { return this.domain.table('issue_records') }
  get issueSeen(): KvTable<IssueSeenKey, IssueSeenV1> { return this.domain.table('issue_seen') }

  /** SPEC-05 §5.2/§6.1: installed by the assembly; undefined in bare-store tests. */
  stateNotifier: EvidenceStateNotifier | undefined

  /** SPEC-05 §11.4-2: installed by the assembly; wakes the compile loop after the backlog
   * verb lowers a row's eligibility to now (undefined in bare-store tests). */
  compileWakeNotifier: (() => void) | undefined

  /** The semantic lane's only mutable record: single-record atomic update (SPEC-04 §10.1). */
  async updateSemanticLane(
    graphId: EvidenceGraphId,
    update: (current: SemanticLaneV1 | undefined) => SemanticLaneV1,
  ): Promise<SemanticLaneV1> {
    return this.enqueue(async () => {
      const next = update(this.semanticLane.get(graphId))
      await this.semanticLane.put(graphId, next)
      await this.recountNow()
      return next
    })
  }

  /** The session-level switch's only mutable record: single-record atomic update (SPEC-04 §4.3). */
  async updateSemanticSwitch(
    graphId: EvidenceGraphId,
    update: (current: SemanticSwitchV1 | undefined) => SemanticSwitchV1,
  ): Promise<SemanticSwitchV1> {
    return this.enqueue(async () => {
      const next = update(this.semanticSwitch.get(graphId))
      await this.semanticSwitch.put(graphId, next)
      await this.recountNow()
      this.stateNotifier?.(graphId, 'switch')
      return next
    })
  }

  semanticLaneFor(graphId: EvidenceGraphId): SemanticLaneV1 | undefined {
    return this.semanticLane.get(graphId)
  }

  semanticSwitchFor(graphId: EvidenceGraphId): SemanticSwitchV1 | undefined {
    return this.semanticSwitch.get(graphId)
  }

  /**
   * SPEC-05 §6.4: the single notification-state write. Idempotent overwrite of `seenAt` for the
   * given keys, restricted to keys that currently hold an unresolved record in the Session's
   * Graph; unknown or resolved keys are ignored and reflected in `applied`. Advances
   * issuesRevision (both issue tables are its input) and fires the transition notifier.
   */
  async markIssuesSeenRows(sessionId: SessionId, issueKeys: readonly string[]): Promise<{ applied: readonly string[]; seenAt: number }> {
    return this.enqueue(async () => {
      const seenAt = Date.now()
      const applied: string[] = []
      const bootstrap = this.sessionGraphs.get(sessionId)
      if (bootstrap !== undefined) {
        for (const key of issueKeys) {
          const record = this.issueRecords.get(key)
          if (record === undefined || record.graphId !== bootstrap.graphId || record.resolvedAt !== null) continue
          await this.issueSeen.put(key, { recordVersion: 'animalge.issue-seen/v1', issueKey: key, seenAt })
          applied.push(key)
        }
      }
      await this.recountNow()
      if (bootstrap !== undefined) this.stateNotifier?.(bootstrap.graphId, 'seen')
      return { applied, seenAt }
    })
  }

  /**
   * SPEC-05 §6.1/§6.3: owner-side deterministic issue recompute, serialized with every other
   * mutation. Active-and-unresolved rows refresh `lastSeenAt`; a condition re-appearing after
   * resolution starts a new occurrence; a vanished condition resolves its row; records are kept.
   */
  async recomputeIssuesFor(graphId: EvidenceGraphId): Promise<void> {
    await this.enqueue(async () => {
      const now = Date.now()
      const derived = deriveIssues(this, graphId, now)
      const activeKeys = new Set(derived.map(issue => issue.issueKey))
      for (const issue of derived) {
        const existing = this.issueRecords.get(issue.issueKey)
        if (existing === undefined) {
          await this.issueRecords.put(issue.issueKey, {
            recordVersion: 'animalge.issue-record/v1', issueKey: issue.issueKey, graphId,
            severity: issue.severity, conditionCode: issue.conditionCode,
            targetKind: issue.targetKind, targetId: issue.targetId,
            applicableSnapshotDigest: issue.applicableSnapshotDigest,
            applicableWatermark: issue.applicableWatermark,
            firstSeenAt: now, lastSeenAt: now, occurrenceCount: 1, resolvedAt: null,
          })
        } else if (existing.resolvedAt !== null) {
          await this.issueRecords.put(issue.issueKey, {
            ...existing, lastSeenAt: now, occurrenceCount: existing.occurrenceCount + 1, resolvedAt: null,
          })
        } else {
          await this.issueRecords.put(issue.issueKey, { ...existing, lastSeenAt: now })
        }
      }
      for (const [key, record] of this.issueRecords.entries()) {
        if (record.graphId !== graphId || record.resolvedAt !== null || activeKeys.has(key)) continue
        await this.issueRecords.put(key, { ...record, resolvedAt: now })
      }
      await this.recountNow()
    })
  }

  /**
   * Owner-serialized immutable put for one SPEC-02 material record (§10.1).
   * The accountedBytes hard limit pauses new material writes (§10.3); an
   * in-flight settlement whose submission is already being assembled is the
   * caller's responsibility to bound, not this gate's.
   */
  async putMaterialRecord<K extends string, V>(table: KvTable<K, V>, key: K, value: V): Promise<void> {
    await this.enqueue(async () => {
      const usage = this.usage.get('global')
      if (usage !== undefined && this.hardLimitBytes > 0 && usage.accountedBytes >= this.hardLimitBytes) {
        throw new EvidenceStoreError('storage_hard_limit', `material write paused: accountedBytes ${String(usage.accountedBytes)} ≥ hard limit ${String(this.hardLimitBytes)}`)
      }
      await this.putImmutable(table, key, value)
      await this.recountNow()
    })
  }

  /** Hard-limit threshold for material writes; 0 disables the gate (test harness). */
  hardLimitBytes = 0

  /** The lane's only mutable record: single-record atomic update (§7.1). */
  async updateReceiptLane(
    sessionId: SessionId,
    update: (current: ReceiptLaneRecord | undefined) => ReceiptLaneRecord,
  ): Promise<ReceiptLaneRecord> {
    return this.enqueue(async () => {
      const next = update(this.receiptLane.get(sessionId))
      await this.receiptLane.put(sessionId, next)
      await this.recountNow()
      return next
    })
  }

  /** The environment owner's only mutable record: single-record atomic update (SPEC-03 §7.1). */
  async updateEnvironmentState(
    update: (current: EnvironmentStateRecord | undefined) => EnvironmentStateV1,
  ): Promise<EnvironmentStateV1> {
    return this.enqueue(async () => {
      const next = update(this.environmentState.get('global'))
      await this.environmentState.put('global', next)
      await this.recountNow()
      return next
    })
  }

  environmentStateNow(): EnvironmentStateV1 | undefined {
    return this.environmentState.get('global')
  }

  /** Reservation state migration: the reservation record's only mutable field (SPEC-03 §8.1). */
  async updateOutputReservation(
    reservationId: string,
    update: (current: OutputReservationV1) => OutputReservationV1,
  ): Promise<OutputReservationV1> {
    return this.enqueue(async () => {
      const current = this.outputReservations.get(reservationId)
      if (current === undefined) throw new EvidenceStoreError('reservation_missing', `reservation '${reservationId}' is missing`)
      await this.outputReservations.put(reservationId, update(current))
      await this.recountNow()
      return current
    })
  }

  /** Latest finalization per runId (compiler materialization gate lookup, SPEC-03 §8.4). */
  finalizationForRun(runId: EvidenceGraphId | EvidenceRunId): OutputFinalizationRecordV1 | undefined {
    let latest: OutputFinalizationRecordV1 | undefined
    for (const [, row] of this.outputFinalizations.entries()) {
      if (row.runId !== runId) continue
      if (latest === undefined || row.finalizedAt > latest.finalizedAt
        || (row.finalizedAt === latest.finalizedAt && row.finalizationId > latest.finalizationId)) latest = row
    }
    return latest
  }

  /** Startup recovery scan (SPEC-03 §8.1): conservatively abandon every active reservation. */
  async abandonActiveReservations(): Promise<number> {
    return this.enqueue(async () => {
      let abandoned = 0
      for (const [id, row] of this.outputReservations.entries()) {
        if (row.state !== 'active') continue
        await this.outputReservations.put(id, { ...row, state: 'abandoned' })
        abandoned++
      }
      await this.recountNow()
      return abandoned
    })
  }

  receiptLaneFor(sessionId: SessionId): ReceiptLaneRecord | undefined {
    return this.receiptLane.get(sessionId)
  }

  /** Latest persisted observation for one ArtifactVersion (append-only ledger scan). */
  latestObservation(artifactVersionId: string): LocationObservation | undefined {
    let latest: LocationObservation | undefined
    for (const [, row] of this.locationObservations.entries()) {
      if (row.artifactVersionId !== artifactVersionId) continue
      const newer = latest === undefined
        || row.observedAt > latest.observedAt
        || (row.observedAt === latest.observedAt && row.locationObservationId > latest.locationObservationId)
      if (newer) latest = row
    }
    return latest
  }

  /** Latest observation whose target matches, regardless of version (locator reuse lookup). */
  latestObservationForTarget(locator: string): LocationObservation | undefined {
    let latest: LocationObservation | undefined
    for (const [, row] of this.locationObservations.entries()) {
      if (row.locator !== locator) continue
      if (latest === undefined || row.observedAt > latest.observedAt || (
        row.observedAt === latest.observedAt && row.locationObservationId > latest.locationObservationId)) latest = row
    }
    return latest
  }

  /** Derive the current version of one Artifact from its immutable chain head (single writer ⇒ unique head). (§4.1) */
  currentArtifactVersion(artifactId: string): ArtifactVersionCore | undefined {
    const versions: ArtifactVersionCore[] = []
    for (const [, row] of this.artifactVersions.entries()) if (row.artifactId === artifactId) versions.push(row)
    if (versions.length === 0) return undefined
    const parents = new Set(versions.map(row => row.parentVersionId).filter((id): id is NonNullable<typeof id> => id !== null))
    const heads = versions.filter(row => !parents.has(row.artifactVersionId))
    if (heads.length !== 1) throw new EvidenceStoreError('material_identity_conflict', `Artifact '${artifactId}' has ${heads.length} chain heads`)
    return heads[0]
  }

  /** Accepted acceptance records by receiptId (idempotent lookup for the lane and materializer). */
  acceptanceFor(receiptId: string): ReceiptAcceptanceRecord | undefined {
    for (const [, row] of this.receiptAcceptances.entries()) if (row.receiptId === receiptId) return row
    return undefined
  }

  /** Deterministic digest over the material ledger state (late-acceptance idempotency key input, §7.4). */
  materialStateDigest(): Sha256Digest {
    const material: Record<string, unknown> = {}
    const tables: Array<[string, KvTable<string, unknown>]> = [
      ['artifacts', this.artifacts], ['artifact_versions', this.artifactVersions],
      ['location_observations', this.locationObservations], ['context_entities', this.contextEntities],
      ['source_anchors', this.sourceAnchors], ['receipt_submissions', this.receiptSubmissions],
      ['receipt_acceptances', this.receiptAcceptances],
      ['output_finalizations', this.outputFinalizations], ['output_manifests', this.outputManifests],
      // SPEC-04 §10.2-8: the graph-affecting candidate ledgers join the idempotency key;
      // model_calls/proposal_validations are excluded (failures and rejections never
      // change graph state and must not force a new Snapshot).
      ['candidate_records', this.candidateRecords], ['candidate_relations', this.candidateRelations],
      ['model_run_selections', this.modelRunSelections],
    ]
    for (const [name, table] of tables) {
      const rows: Array<[string, unknown]> = [...table.entries()].map(([key, value]) => [key, value])
      rows.sort((left, right) => left[0].localeCompare(right[0]))
      material[name] = rows
    }
    return canonicalDigest(material as JsonValue)
  }

  /** Sessions with pending submissions (lane wake set). */
  sessionsWithPendingReceipts(): SessionId[] {
    return [...this.receiptLane.entries()].filter(([, row]) => row.pendingSubmissions.length > 0).map(([sessionId]) => sessionId)
  }

  async close(): Promise<void> {
    this.accepting = false
    await this.tail
    await this.domain.close()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new EvidenceStoreError('closed', 'Evidence Store is closed'))
    const result = this.tail.then(operation)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private async initializeControlRows(): Promise<void> {
    await this.enqueue(async () => {
      if (this.queueClock.get('global') === undefined) {
        if (this.outbox.size > 0 || this.attempts.size > 0) throw new EvidenceStoreError('queue_clock_corrupt', 'queue clock missing with durable queue state')
        await this.queueClock.put('global', { recordVersion: 'animalge.queue-clock/v1', nextTicket: 1 })
      }
      const clock = this.queueClock.get('global') as QueueClock
      const maximum = Math.max(0, ...[...this.outbox.entries()].map(([, row]) => row.fairTicket))
      if (clock.nextTicket <= maximum) throw new EvidenceStoreError('queue_clock_corrupt', 'queue clock does not exceed durable tickets')
      if (this.usage.get('global') === undefined) {
        await this.usage.put('global', { recordVersion: 'animalge.usage/v1', accountedBytes: 0, recordCount: 0, recountedAt: Date.now() })
      }
      await this.recountNow()
    })
  }

  private async putImmutable<K extends string, V>(table: KvTable<K, V>, key: K, value: V): Promise<void> {
    const current = table.get(key)
    if (current === undefined) {
      await table.put(key, value)
      return
    }
    if (!sameBytes(current, value)) throw new EvidenceStoreError('immutable_key_collision', `immutable key '${key}' has different bytes`)
  }

  async bootstrap(header: SessionHeader, workspaceId?: WorkspaceId): Promise<EvidenceGraphScopeV1> {
    return this.enqueue(async () => {
      const existing = this.sessionGraphs.get(header.id)
      let intent: SessionGraphBootstrap
      if (existing === undefined) {
        const graphId = newEvidenceGraphId()
        const initialScope: EvidenceGraphScopeV1 = {
          kind: 'session', graphId, sessionId: header.id, sessionCreatedAt: header.createdAt,
          ...(workspaceId === undefined ? {} : { workspaceId }),
        }
        intent = {
          recordVersion: 'animalge.session-graph-bootstrap/v1',
          sessionId: header.id,
          sessionCreatedAt: header.createdAt,
          graphId,
          initialScope,
          state: 'initializing',
        }
        await this.sessionGraphs.put(header.id, intent)
      } else {
        intent = existing
        if (intent.sessionCreatedAt !== header.createdAt || intent.sessionId !== header.id) {
          throw new EvidenceStoreError('session_lifecycle_conflict', `session '${header.id}' lifecycle conflicts with its Graph mapping`)
        }
        if (intent.state === 'ready') {
          // §7.2: a ready mapping must already own matching companions; a missing or
          // mismatched one is bootstrap corruption, never something to self-heal.
          const readyGraph = this.graphs.get(intent.graphId)
          const readyHead = this.heads.get(intent.graphId)
          if (readyGraph === undefined || readyHead === undefined || readyHead.graphId !== intent.graphId) {
            throw new EvidenceStoreError('bootstrap_corrupt', `Graph '${intent.graphId}' lacks matching companions`)
          }
        }
      }
      const graph: GraphRecord = { recordVersion: 'animalge.evidence-graph/v1', scope: intent.initialScope, status: 'ready' }
      if (this.graphs.get(intent.graphId) === undefined) await this.putImmutable(this.graphs, intent.graphId, graph)
      // SPEC-05 §12.2 contract-diff extension (user ruling 2026-08-29 Option A): guard the
      // head seed the same way as the graph seed — after the first compile advances the head
      // (rev ≥ 1, digest ≠ null), a subsequent bootstrap must NOT try to overwrite it with the
      // initial seed (rev=0, digest=null); the unguarded putImmutable rejected with
      // "different bytes" and silently killed every later-turn captureHeader call.
      if (this.heads.get(intent.graphId) === undefined) await this.putImmutable(this.heads, intent.graphId, headAt(intent.graphId))
      if (intent.state === 'initializing') {
        intent = await this.sessionGraphs.update(header.id, (current) => {
          if (!sameBytes(current, intent)) throw new EvidenceStoreError('bootstrap_mapping_conflict', `session '${header.id}' bootstrap intent changed`)
          return { ...current, state: 'ready' }
        })
      }
      let companionGraph = this.graphs.get(intent.graphId)
      const companionHead = this.heads.get(intent.graphId)
      if (companionGraph === undefined || companionHead === undefined || companionHead.graphId !== intent.graphId) {
        throw new EvidenceStoreError('bootstrap_corrupt', `Graph '${intent.graphId}' lacks matching companions`)
      }
      if (workspaceId !== undefined) {
        if (companionGraph.scope.workspaceId !== undefined && companionGraph.scope.workspaceId !== workspaceId) {
          throw new EvidenceStoreError('scope_workspace_conflict', `Graph '${intent.graphId}' is already bound to another Workspace`)
        }
        if (companionGraph.scope.workspaceId === undefined) {
          companionGraph = await this.graphs.update(intent.graphId, current => ({ ...current, scope: { ...current.scope, workspaceId } }))
        }
      }
      await this.recountNow()
      return companionGraph.scope
    })
  }

  async recoverBootstraps(): Promise<void> {
    const rows = [...this.sessionGraphs.entries()]
    for (const [, row] of rows) {
      if (row.state === 'initializing') {
        await this.bootstrap({ version: 0, id: row.sessionId, createdAt: row.sessionCreatedAt })
      } else if (this.graphs.get(row.graphId) === undefined || this.heads.get(row.graphId) === undefined) {
        await this.enqueue(async () => {
          const graph = this.graphs.get(row.graphId)
          if (graph !== undefined) await this.graphs.put(row.graphId, { ...graph, status: 'bootstrap_corrupt' })
          await this.quarantineNow(row.graphId, 'session_graphs', row.sessionId, 'bootstrap_corrupt', 'startup', [])
        })
      }
    }
  }

  async saveCapture(capture: CapturedInvocation): Promise<void> {
    await this.enqueue(async () => {
      const current = this.captures.get(capture.runId)
      if (current !== undefined) {
        const { selection: _currentSelection, selectionRuleDigest: _currentRule, ...currentExecution } = current
        const { selection: _nextSelection, selectionRuleDigest: _nextRule, ...nextExecution } = capture
        if (!sameBytes(currentExecution, nextExecution)) {
          throw new EvidenceStoreError('capture_identity_conflict', `capture '${capture.runId}' changed immutable execution bytes`)
        }
        if (!sameBytes(current, capture)) await this.captures.put(capture.runId, capture)
      }
      if (current === undefined) await this.captures.put(capture.runId, capture)
      await this.recountNow()
    })
  }

  capturesFor(graphId: EvidenceGraphId): CapturedInvocation[] {
    return [...this.captures.entries()].map(([, row]) => row).filter(row => row.graphId === graphId)
  }

  async admitOutbox(row: Omit<CompileOutbox, 'fairTicket' | 'recordVersion' | 'inFlightAttemptId'>): Promise<CompileOutbox> {
    return this.enqueue(async () => {
      const existing = this.outbox.get(row.graphId)
      if (existing !== undefined) {
        if (existing.sessionId !== row.sessionId) throw new EvidenceStoreError('queue_link_corrupt', 'outbox Session identity changed')
        const merged: CompileOutbox = {
          ...existing,
          targetNextSeqExclusive: Math.max(existing.targetNextSeqExclusive, row.targetNextSeqExclusive),
          lastBoundarySeq: Math.max(existing.lastBoundarySeq, row.lastBoundarySeq),
          boundaryCount: existing.boundaryCount + row.boundaryCount,
          reasonCounts: Object.fromEntries(Object.keys({ ...existing.reasonCounts, ...row.reasonCounts }).map(key => [key, (existing.reasonCounts[key as keyof typeof existing.reasonCounts] ?? 0) + (row.reasonCounts[key as keyof typeof row.reasonCounts] ?? 0)])) as CompileOutbox['reasonCounts'],
          lastQueuedAt: row.lastQueuedAt,
          eligibleAfter: row.eligibleAfter,
          latestAdmittedTarget: Math.max(existing.latestAdmittedTarget ?? 0, row.latestAdmittedTarget ?? row.targetNextSeqExclusive),
          // §8.1: once a row has overflowed (or this admission overflows it), the marker and the
          // first rejected target survive every merge so the row stays paused at its watermark.
          overflowed: existing.overflowed || row.overflowed,
          ...(existing.firstRejectedTarget === undefined && row.firstRejectedTarget === undefined
            ? {}
            : { firstRejectedTarget: existing.firstRejectedTarget ?? row.firstRejectedTarget }),
        }
        await this.outbox.put(row.graphId, merged)
        await this.recountNow()
        return merged
      }
      const fairTicket = await this.nextTicketNow()
      const created: CompileOutbox = { ...row, recordVersion: 'animalge.compile-outbox/v1', fairTicket, inFlightAttemptId: null }
      await this.outbox.put(row.graphId, created)
      await this.recountNow()
      return created
    })
  }

  private async nextTicketNow(): Promise<number> {
    const clock = await this.queueClock.update('global', (current) => {
      if (current.nextTicket >= Number.MAX_SAFE_INTEGER) throw new EvidenceStoreError('queue_ticket_exhausted', 'queue ticket exhausted')
      return { ...current, nextTicket: current.nextTicket + 1 }
    })
    return clock.nextTicket - 1
  }

  runnableOutbox(now: number): CompileOutbox | undefined {
    return [...this.outbox.entries()].map(([, row]) => row)
      .filter((row) => {
        if (row.eligibleAfter > now || row.retryNotBefore > now || row.overflowed) return false
        if (row.inFlightAttemptId === null) return true
        return this.attempts.get(row.inFlightAttemptId)?.state === 'queued'
      })
      .sort((left, right) => left.fairTicket - right.fairTicket || left.graphId.localeCompare(right.graphId))[0]
  }

  nextRunnableAt(): number | undefined {
    const values = [...this.outbox.entries()].map(([, row]) => row)
      .filter(row => !row.overflowed && (row.inFlightAttemptId === null || this.attempts.get(row.inFlightAttemptId)?.state === 'queued'))
      .map(row => Math.max(row.eligibleAfter, row.retryNotBefore))
      .filter(value => value < Number.MAX_SAFE_INTEGER)
    return values.length === 0 ? undefined : Math.min(...values)
  }

  /**
   * SPEC-05 §11.4-2 owner-side row mutation for the backlog verb: raise the persisted
   * backlog's priority to runnable-now — the idle-merge window and any retry backoff
   * collapse to the caller's now, and a terminal failure re-arms from its persisted
   * compile boundary. A capture-overflow pause (§8.1) is integrity-held and never
   * user-resumable; a running attempt reports `busy` (the UI's disabled condition).
   * The write never touches material state (outbox rows are outside materialStateDigest),
   * never creates captures or attempts, and never runs research tools.
   */
  async processBacklogRow(graphId: EvidenceGraphId, now: number): Promise<'triggered' | 'idle' | 'busy' | 'paused'> {
    return this.enqueue(async () => {
      const row = this.outbox.get(graphId)
      if (row === undefined) return 'idle'
      if (row.overflowed) return 'paused'
      if (row.inFlightAttemptId !== null && this.attempts.get(row.inFlightAttemptId)?.state === 'running') return 'busy'
      const updated: CompileOutbox = {
        ...row,
        eligibleAfter: Math.min(row.eligibleAfter, now),
        retryNotBefore: 0,
        lastQueuedAt: Math.max(row.lastQueuedAt, now),
      }
      await this.outbox.put(graphId, updated)
      await this.recountNow()
      return 'triggered'
    })
  }

  async dequeue(row: CompileOutbox, head: CurrentHeadV1, revisions: EvidenceSnapshotPayloadV1['revisions']): Promise<CompileAttempt> {
    return this.enqueue(async () => {
      if (row.inFlightAttemptId !== null) {
        const queued = this.attempts.get(row.inFlightAttemptId)
        if (queued === undefined || queued.state !== 'queued' || queued.graphId !== row.graphId
          || queued.sessionId !== row.sessionId
          || queued.targetNextSeqExclusive !== row.targetNextSeqExclusive
          || queued.baseSnapshotDigest !== head.snapshotDigest
          || queued.baseHeadRevision !== head.headRevision
          || !sameBytes(queued.revisions, revisions)) {
          throw new EvidenceStoreError('queue_link_corrupt', 'queued attempt does not match its durable outbox')
        }
        return queued
      }
      const attemptId = newCompileAttemptId()
      const now = Date.now()
      const retryOf = [...this.attempts.entries()].map(([, candidate]) => candidate)
        .filter(candidate => candidate.graphId === row.graphId && candidate.targetNextSeqExclusive === row.targetNextSeqExclusive
          && ['failed', 'interrupted', 'cancelled'].includes(candidate.state))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.attemptId ?? null
      const attempt: CompileAttempt = {
        recordVersion: 'animalge.compile-attempt/v1', attemptId, graphId: row.graphId, sessionId: row.sessionId,
        fromNextSeqExclusive: this.snapshotWatermark(head.snapshotDigest), targetNextSeqExclusive: row.targetNextSeqExclusive,
        baseSnapshotDigest: head.snapshotDigest, baseHeadRevision: head.headRevision, state: 'queued', stage: 'capture', revisions,
        retryOf, startedAt: null, updatedAt: now, terminalError: null, stagingId: null, resultSnapshotDigest: null,
      }
      await this.putImmutable(this.attempts, attemptId, attempt)
      await this.outbox.update(row.graphId, (current) => {
        if (current.fairTicket !== row.fairTicket
          || current.targetNextSeqExclusive !== row.targetNextSeqExclusive
          || current.inFlightAttemptId !== null) {
          throw new EvidenceStoreError('queue_link_corrupt', 'outbox changed before dequeue linearization')
        }
        return { ...current, inFlightAttemptId: attemptId }
      })
      return attempt
    })
  }

  async startAttempt(attemptId: CompileAttemptId): Promise<CompileAttempt> {
    return this.enqueue(() => this.attempts.update(attemptId, current => ({ ...current, state: 'running', startedAt: Date.now(), updatedAt: Date.now() })))
  }

  /**
   * Create and start one semantic attempt outside the per-graph outbox (SPEC-04 §9.2).
   * Semantic attempts never share the outbox row: a parked semantic retry must not
   * block deterministic compilation for the same Graph (D-116 shared-fate rule).
   */
  async startSemanticAttempt(options: {
    readonly graphId: EvidenceGraphId
    readonly sessionId: SessionId
    readonly head: CurrentHeadV1
    readonly targetNextSeqExclusive: number
    readonly revisions: CompileAttempt['revisions']
    readonly semantic: NonNullable<CompileAttempt['semantic']>
  }): Promise<CompileAttempt> {
    return this.enqueue(async () => {
      const attemptId = newCompileAttemptId()
      const retryOf = [...this.attempts.entries()].map(([, candidate]) => candidate)
        .filter(candidate => candidate.graphId === options.graphId && candidate.channel === 'semantic'
          && candidate.targetNextSeqExclusive === options.targetNextSeqExclusive
          && ['failed', 'interrupted', 'cancelled'].includes(candidate.state))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]?.attemptId ?? null
      const attempt: CompileAttempt = {
        recordVersion: 'animalge.compile-attempt/v1', attemptId, graphId: options.graphId, sessionId: options.sessionId,
        fromNextSeqExclusive: this.snapshotWatermark(options.head.snapshotDigest), targetNextSeqExclusive: options.targetNextSeqExclusive,
        baseSnapshotDigest: options.head.snapshotDigest, baseHeadRevision: options.head.headRevision, state: 'running', stage: 'capture', revisions: options.revisions,
        retryOf, startedAt: Date.now(), updatedAt: Date.now(), terminalError: null, stagingId: null, resultSnapshotDigest: null,
        channel: 'semantic', semantic: options.semantic,
      }
      await this.putImmutable(this.attempts, attemptId, attempt)
      return attempt
    })
  }

  async commit(attempt: CompileAttempt, payload: EvidenceSnapshotPayloadV1, kind: 'compile' | 'recovery' = 'compile'): Promise<CurrentHeadV1> {
    return this.enqueue(async () => {
      const currentHeadRow = this.heads.get(attempt.graphId)
      if (currentHeadRow !== undefined && currentHeadRow.snapshotDigest !== null) {
        let coveredPayload: ReturnType<typeof verifyStoredSnapshot> | undefined
        try {
          coveredPayload = verifyStoredSnapshot(this.committedSnapshot(currentHeadRow.snapshotDigest))
        } catch { coveredPayload = undefined }
        if (coveredPayload !== undefined
          && coveredPayload.deterministicWatermark.nextSeqExclusive >= payload.deterministicWatermark.nextSeqExclusive
          && sameBytes(coveredPayload.revisions, payload.revisions)
          && sameBytes(coveredPayload, payload)) {
          // §8.4 covered-target no-op (SPEC-02 §7.4 extends the idempotency key with the
          // material ledger state): identical revisions AND identical canonical bytes — a
          // late receipt acceptance changes the payload bytes and must produce a new Snapshot.
          await this.attempts.put(attempt.attemptId, {
            ...attempt, state: 'succeeded', stage: 'finalize', updatedAt: Date.now(),
            resultSnapshotDigest: currentHeadRow.snapshotDigest,
          })
          await this.settleCoveredOutbox(attempt)
          await this.recountNow()
          this.stateNotifier?.(attempt.graphId, 'commit')
          return currentHeadRow
        }
      }
      const record = snapshotRecord(payload)
      const stagingId = newStagingId()
      const stage: StagingRecord = {
        recordVersion: 'animalge.staging/v1', stagingId, attemptId: attempt.attemptId, graphId: attempt.graphId,
        expectedSnapshotDigest: attempt.baseSnapshotDigest, expectedHeadRevision: attempt.baseHeadRevision,
        candidateSnapshotDigest: record.snapshotDigest, createdAt: Date.now(), state: 'validated',
      }
      await this.putImmutable(this.staging, stagingId, stage)
      try {
        await this.putImmutable(this.snapshots, record.snapshotDigest, record)
      } catch (error) {
        if (error instanceof EvidenceStoreError && error.code === 'immutable_key_collision') {
          await this.quarantineNow(attempt.graphId, 'snapshots', record.snapshotDigest, 'immutable_key_collision', 'commit', [])
        }
        throw error
      }
      await this.attempts.put(attempt.attemptId, {
        ...attempt, stage: 'commit', updatedAt: Date.now(), stagingId, resultSnapshotDigest: record.snapshotDigest,
      })
      const head = await this.heads.update(attempt.graphId, (current) => {
        if (current.snapshotDigest !== attempt.baseSnapshotDigest || current.headRevision !== attempt.baseHeadRevision) {
          throw new EvidenceStoreError('head_cas_conflict', `expected head ${String(attempt.baseSnapshotDigest)}@${attempt.baseHeadRevision}, got ${String(current.snapshotDigest)}@${current.headRevision}`)
        }
        return {
          recordVersion: 'animalge.current-head/v1', graphId: attempt.graphId,
          snapshotDigest: record.snapshotDigest, headRevision: current.headRevision + 1,
          previousSnapshotDigest: current.snapshotDigest, previousHeadRevision: current.headRevision,
        }
      })
      try {
        await this.finalizeCommit(attempt, head, record, stagingId, stage, kind)
      } catch {
        // §7.4(6): the durable head update above is the commit point, so the Snapshot is
        // already committed; repair the history and settle as succeeded instead of failing.
        try {
          await this.repairMissingHeadCommit(attempt.graphId, head)
          await this.settleCoveredOutbox(attempt)
        } catch {
          const pending = this.attempts.get(attempt.attemptId) ?? attempt
          await this.attempts.put(attempt.attemptId, {
            ...pending, state: 'succeeded', stage: 'finalize', updatedAt: Date.now(),
            resultSnapshotDigest: record.snapshotDigest,
          }).catch(() => {})
          throw new EvidenceStoreError('post_commit_repair_pending', `head '${String(head.snapshotDigest)}'@${head.headRevision} is committed but its history repair is pending`)
        }
        this.stateNotifier?.(attempt.graphId, 'commit')
        return head
      }
      await this.recountNow()
      this.stateNotifier?.(attempt.graphId, 'commit')
      return head
    })
  }

  private async finalizeCommit(
    attempt: CompileAttempt,
    head: CurrentHeadV1,
    record: StoredSnapshotV1,
    stagingId: StagingId,
    stage: StagingRecord,
    kind: 'compile' | 'recovery',
  ): Promise<void> {
    const commit: HeadCommit = {
      recordVersion: 'animalge.head-commit/v1', graphId: attempt.graphId, headRevision: head.headRevision,
      previousSnapshotDigest: head.previousSnapshotDigest, snapshotDigest: head.snapshotDigest,
      kind, operationId: attempt.attemptId, committedAt: Date.now(),
    }
    await this.putImmutable(this.headCommits, `${attempt.graphId}:${head.headRevision}`, commit)
    await this.staging.put(stagingId, { ...stage, state: 'committed' })
    await this.attempts.put(attempt.attemptId, { ...attempt, state: 'succeeded', stage: 'finalize', updatedAt: Date.now(), stagingId, resultSnapshotDigest: record.snapshotDigest })
    await this.settleCoveredOutbox(attempt)
  }

  private async settleCoveredOutbox(attempt: CompileAttempt): Promise<void> {
    const outbox = this.outbox.get(attempt.graphId)
    if (outbox !== undefined && outbox.inFlightAttemptId === attempt.attemptId) {
      if (outbox.targetNextSeqExclusive <= attempt.targetNextSeqExclusive) await this.outbox.delete(attempt.graphId)
      else await this.outbox.put(attempt.graphId, { ...outbox, inFlightAttemptId: null, fairTicket: await this.nextTicketNow() })
    }
  }

  attemptOrdinal(attempt: CompileAttempt): number {
    let ordinal = 1
    let previous = attempt.retryOf
    const seen = new Set<CompileAttemptId>()
    while (previous !== null) {
      if (seen.has(previous)) throw new EvidenceStoreError('attempt_chain_corrupt', 'retryOf chain contains a cycle')
      seen.add(previous)
      const record = this.attempts.get(previous)
      if (record === undefined) throw new EvidenceStoreError('attempt_chain_corrupt', `retry predecessor '${previous}' is missing`)
      ordinal++
      previous = record.retryOf
    }
    return ordinal
  }

  async failAttempt(attempt: CompileAttempt, code: string, retryable: boolean, retryDelayMs?: number): Promise<void> {
    await this.enqueue(async () => {
      const current = this.attempts.get(attempt.attemptId) ?? attempt
      await this.attempts.put(attempt.attemptId, {
        ...current, state: 'failed', updatedAt: Date.now(),
        terminalError: { code, stage: current.stage, retryable, messageDigest: sha256Digest(code) },
      })
      const row = this.outbox.get(attempt.graphId)
      if (row?.inFlightAttemptId === attempt.attemptId) {
        const willRetry = retryable && retryDelayMs !== undefined
        await this.outbox.put(attempt.graphId, {
          ...row,
          inFlightAttemptId: null,
          fairTicket: await this.nextTicketNow(),
          retryNotBefore: willRetry ? Date.now() + retryDelayMs : Number.MAX_SAFE_INTEGER,
          reasonCounts: { ...row.reasonCounts, retry: row.reasonCounts.retry + (willRetry ? 1 : 0) },
        })
      }
      await this.recountNow()
      this.stateNotifier?.(attempt.graphId, 'failure')
    })
  }

  async cancelAttempt(attempt: CompileAttempt): Promise<void> {
    await this.enqueue(async () => {
      const current = this.attempts.get(attempt.attemptId) ?? attempt
      if (current.state === 'succeeded') return
      await this.attempts.put(attempt.attemptId, {
        ...current, state: 'cancelled', updatedAt: Date.now(),
        terminalError: { code: 'cancelled', stage: current.stage, retryable: false, messageDigest: sha256Digest('cancelled') },
      })
      const row = this.outbox.get(attempt.graphId)
      if (row?.inFlightAttemptId === attempt.attemptId) await this.outbox.put(attempt.graphId, { ...row, inFlightAttemptId: null })
      await this.recountNow()
    })
  }

  async recoverHead(
    graphId: EvidenceGraphId,
    expected: CurrentHeadV1,
    restoredDigest: Sha256Digest | null,
    quarantinedDigest: Sha256Digest | null,
  ): Promise<CurrentHeadV1> {
    return this.enqueue(async () => {
      if (restoredDigest !== null) verifyStoredSnapshot(this.snapshots.get(restoredDigest) ?? (() => { throw new EvidenceStoreError('snapshot_missing', `recovery Snapshot '${restoredDigest}' is missing`) })())
      const recoveryId = newRecoveryId()
      const next = await this.heads.update(graphId, (current) => {
        if (current.snapshotDigest !== expected.snapshotDigest || current.headRevision !== expected.headRevision) throw new EvidenceStoreError('head_cas_conflict', 'head changed during recovery')
        return {
          recordVersion: 'animalge.current-head/v1', graphId, snapshotDigest: restoredDigest,
          headRevision: current.headRevision + 1,
          previousSnapshotDigest: current.snapshotDigest,
          previousHeadRevision: current.headRevision,
        }
      })
      await this.putImmutable(this.headCommits, `${graphId}:${next.headRevision}`, {
        recordVersion: 'animalge.head-commit/v1', graphId, headRevision: next.headRevision,
        previousSnapshotDigest: quarantinedDigest, snapshotDigest: restoredDigest, kind: 'recovery', operationId: recoveryId, committedAt: Date.now(),
      })
      const graph = this.graphs.get(graphId)
      if (graph !== undefined && restoredDigest === null) await this.graphs.put(graphId, { ...graph, status: 'unavailable' })
      await this.recountNow()
      return next
    })
  }

  async repairMissingHeadCommit(graphId: EvidenceGraphId, head: CurrentHeadV1): Promise<void> {
    await this.enqueue(async () => {
      const key = `${graphId}:${head.headRevision}` as CommitKey
      if (this.headCommits.get(key) !== undefined || head.snapshotDigest === null) return
      const matching = [...this.staging.entries()].map(([, row]) => row).filter(row => row.graphId === graphId
        && row.candidateSnapshotDigest === head.snapshotDigest && row.expectedSnapshotDigest === head.previousSnapshotDigest
        && row.expectedHeadRevision + 1 === head.headRevision)
      const stage = matching.length === 1 ? matching[0] : undefined
      const operationId = stage?.attemptId ?? newRecoveryId()
      await this.putImmutable(this.headCommits, key, {
        recordVersion: 'animalge.head-commit/v1', graphId, headRevision: head.headRevision,
        previousSnapshotDigest: head.previousSnapshotDigest, snapshotDigest: head.snapshotDigest,
        kind: stage === undefined ? 'recovery' : 'compile', operationId, committedAt: Date.now(),
      })
      if (stage !== undefined) {
        await this.staging.put(stage.stagingId, { ...stage, state: 'committed' })
        const attempt = this.attempts.get(stage.attemptId)
        if (attempt !== undefined) {
          await this.attempts.put(stage.attemptId, {
            ...attempt,
            state: 'succeeded',
            stage: 'finalize',
            updatedAt: Date.now(),
            stagingId: stage.stagingId,
            resultSnapshotDigest: head.snapshotDigest,
          })
        }
      }
      await this.recountNow()
    })
  }

  async reconcileAttempts(): Promise<void> {
    const touched = new Set<EvidenceGraphId>()
    await this.enqueue(async () => {
      for (const [graphId, row] of this.outbox.entries()) {
        if (row.inFlightAttemptId === null) continue
        const attempt = this.attempts.get(row.inFlightAttemptId)
        if (attempt === undefined || attempt.graphId !== graphId || attempt.sessionId !== row.sessionId
          || attempt.targetNextSeqExclusive !== row.targetNextSeqExclusive) {
          await this.quarantineNow(graphId, 'outbox', graphId, 'queue_link_corrupt', 'startup', [row.inFlightAttemptId])
          await this.outbox.put(graphId, { ...row, overflowed: true })
          continue
        }
        if (attempt.state === 'running') {
          const stage = attempt.stagingId === null ? undefined : this.staging.get(attempt.stagingId)
          const head = this.heads.get(attempt.graphId)
          const committed = attempt.resultSnapshotDigest !== null && head?.snapshotDigest === attempt.resultSnapshotDigest
            && (this.headCommits.get(`${attempt.graphId}:${head.headRevision}`) !== undefined || stage?.candidateSnapshotDigest === head.snapshotDigest)
          if (committed) {
            await this.attempts.put(attempt.attemptId, { ...attempt, state: 'succeeded', stage: 'finalize', updatedAt: Date.now() })
            if (stage !== undefined) await this.staging.put(stage.stagingId, { ...stage, state: 'committed' })
            if (row.targetNextSeqExclusive <= attempt.targetNextSeqExclusive) await this.outbox.delete(graphId)
            else await this.outbox.put(graphId, { ...row, inFlightAttemptId: null, fairTicket: await this.nextTicketNow() })
          } else {
            await this.attempts.put(attempt.attemptId, { ...attempt, state: 'interrupted', updatedAt: Date.now() })
            await this.outbox.put(graphId, {
              ...row,
              inFlightAttemptId: null,
              fairTicket: await this.nextTicketNow(),
              retryNotBefore: Date.now(),
            })
          }
          touched.add(graphId)
        } else if (['succeeded', 'failed', 'interrupted', 'cancelled'].includes(attempt.state)) {
          if (attempt.state === 'succeeded' && row.targetNextSeqExclusive <= attempt.targetNextSeqExclusive) await this.outbox.delete(graphId)
          else await this.outbox.put(graphId, { ...row, inFlightAttemptId: null, fairTicket: await this.nextTicketNow() })
        }
      }
      for (const [id, attempt] of this.attempts.entries()) {
        if (attempt.state === 'queued' && ![...this.outbox.entries()].some(([, row]) => row.inFlightAttemptId === id)) {
          await this.attempts.put(id, { ...attempt, state: 'cancelled', updatedAt: Date.now(), terminalError: { code: 'dequeue_not_linearized', stage: attempt.stage, retryable: false, messageDigest: sha256Digest('dequeue_not_linearized') } })
        }
        // SPEC-04 §9.3: semantic attempts carry no outbox linkage; a running one found at
        // startup is a crash window — committed evidence settles it succeeded, otherwise
        // interrupted, and the semantic lane re-admits idempotently from its watermark.
        if (attempt.state === 'running' && attempt.channel === 'semantic') {
          const stage = attempt.stagingId === null ? undefined : this.staging.get(attempt.stagingId)
          const head = this.heads.get(attempt.graphId)
          const committed = attempt.resultSnapshotDigest !== null && head?.snapshotDigest === attempt.resultSnapshotDigest
            && (this.headCommits.get(`${attempt.graphId}:${head.headRevision}`) !== undefined || stage?.candidateSnapshotDigest === head.snapshotDigest)
          if (committed) {
            await this.attempts.put(id, { ...attempt, state: 'succeeded', stage: 'finalize', updatedAt: Date.now() })
            if (stage !== undefined) await this.staging.put(stage.stagingId, { ...stage, state: 'committed' })
          } else {
            await this.attempts.put(id, { ...attempt, state: 'interrupted', updatedAt: Date.now(), terminalError: { code: 'semantic_interrupted', stage: attempt.stage, retryable: true, messageDigest: sha256Digest('semantic_interrupted') } })
          }
          touched.add(attempt.graphId)
        }
      }
      await this.recountNow()
      for (const graphId of touched) this.stateNotifier?.(graphId, 'reconcile')
    })
  }

  currentHead(graphId: EvidenceGraphId): CurrentHeadV1 {
    const head = this.heads.get(graphId)
    if (head === undefined) throw new EvidenceStoreError('head_missing', `Graph '${graphId}' has no head`)
    return head
  }

  committedSnapshot(digest: Sha256Digest): StoredSnapshotV1 {
    const committed = [...this.headCommits.entries()].some(([, row]) => row.snapshotDigest === digest)
      || [...this.heads.entries()].some(([, row]) => row.snapshotDigest === digest || row.previousSnapshotDigest === digest)
    if (!committed) throw new EvidenceStoreError('snapshot_not_committed', `Snapshot '${digest}' is not committed history`)
    const record = this.snapshots.get(digest)
    if (record === undefined) throw new EvidenceStoreError('snapshot_missing', `Snapshot '${digest}' is missing`)
    verifyStoredSnapshot(record)
    return record
  }

  snapshotWatermark(digest: Sha256Digest | null): number {
    if (digest === null) return 0
    return verifyStoredSnapshot(this.committedSnapshot(digest)).deterministicWatermark.nextSeqExclusive
  }

  async quarantineObject(
    graphId: EvidenceGraphId | undefined,
    table: string,
    key: string,
    code: string,
    stage: string,
    retainKeys: string[] = [],
  ): Promise<RecoveryId> {
    return this.enqueue(() => this.quarantineNow(graphId, table, key, code, stage, retainKeys))
  }

  private async quarantineNow(
    graphId: EvidenceGraphId | undefined,
    table: string,
    key: string,
    code: string,
    stage: string,
    retainKeys: string[],
  ): Promise<RecoveryId> {
    const recoveryId = newRecoveryId()
    const record: QuarantineRecord = {
      recordVersion: 'animalge.quarantine/v1', recoveryId, ...(graphId === undefined ? {} : { graphId }),
      objectTable: table, objectKey: key, code, stage, detectedAt: Date.now(), detailDigest: sha256Digest(`${table}:${key}:${code}:${stage}`), retainKeys,
    }
    await this.putImmutable(this.quarantine, recoveryId, record)
    return recoveryId
  }

  async recount(): Promise<UsageRecord> { return this.enqueue(() => this.recountNow()) }

  async deleteGarbage(
    expectedHeads: ReadonlyMap<EvidenceGraphId, string>,
    stagingIds: readonly StagingId[],
    snapshotDigests: readonly Sha256Digest[],
  ): Promise<{ deletedStaging: number; deletedOrphans: number; aborted: boolean }> {
    return this.enqueue(async () => {
      const changed = [...this.heads.entries()].some(([id, head]) => expectedHeads.get(id) !== `${String(head.snapshotDigest)}@${head.headRevision}`)
        || this.heads.size !== expectedHeads.size
      if (changed) return { deletedStaging: 0, deletedOrphans: 0, aborted: true }
      let deletedStaging = 0
      for (const id of stagingIds) if (await this.staging.delete(id)) deletedStaging++
      let deletedOrphans = 0
      for (const digest of snapshotDigests) if (await this.snapshots.delete(digest)) deletedOrphans++
      await this.recountNow()
      return { deletedStaging, deletedOrphans, aborted: false }
    })
  }

  private async recountNow(): Promise<UsageRecord> {
    const tables: Array<[string, KvTable<string, unknown>]> = [
      ['graphs', this.graphs], ['session_graphs', this.sessionGraphs],
      ['captures', this.captures], ['snapshots', this.snapshots],
      ['heads', this.heads], ['head_commits', this.headCommits],
      ['attempts', this.attempts], ['outbox', this.outbox],
      ['staging', this.staging], ['quarantine', this.quarantine],
      ['queue_clock', this.queueClock],
      ['artifacts', this.artifacts], ['artifact_versions', this.artifactVersions],
      ['location_observations', this.locationObservations], ['context_entities', this.contextEntities],
      ['source_anchors', this.sourceAnchors], ['receipt_submissions', this.receiptSubmissions],
      ['receipt_acceptances', this.receiptAcceptances], ['receipt_lane', this.receiptLane],
      ['input_bundles', this.inputBundles], ['preflight_reports', this.preflightReports],
      ['environment_revisions', this.environmentRevisions], ['environment_state', this.environmentState],
      ['output_reservations', this.outputReservations], ['output_plans', this.outputPlans],
      ['output_manifests', this.outputManifests], ['output_finalizations', this.outputFinalizations],
      ['semantic_lane', this.semanticLane], ['semantic_switch', this.semanticSwitch],
      ['model_calls', this.modelCalls], ['candidate_records', this.candidateRecords],
      ['candidate_relations', this.candidateRelations], ['model_run_selections', this.modelRunSelections],
      ['proposal_validations', this.proposalValidations],
      ['issue_records', this.issueRecords], ['issue_seen', this.issueSeen],
    ]
    let accountedBytes = 0
    let recordCount = 0
    for (const [name, table] of tables) {
      for (const [key, value] of table.entries()) {
        accountedBytes += Buffer.byteLength(name) + Buffer.byteLength(key) + Buffer.byteLength(canonicalJson(value as JsonValue))
        recordCount++
      }
    }
    let record: UsageRecord = { recordVersion: 'animalge.usage/v1', accountedBytes, recordCount: recordCount + 1, recountedAt: Date.now() }
    for (;;) {
      const total = accountedBytes + Buffer.byteLength('usage') + Buffer.byteLength('global') + Buffer.byteLength(canonicalJson(record))
      if (total === record.accountedBytes) break
      record = { ...record, accountedBytes: total }
    }
    await this.usage.put('global', record)
    return record
  }
}

/** Outcome of the SPEC-05 §11.4-2 backlog verb, mirrored by the read service DTO. */
export type BacklogOutcome = 'triggered' | 'idle' | 'busy' | 'paused'

/**
 * SPEC-05 §11.4-2 owner function: "立即处理/重试 Evidence 更新" acts only on the existing
 * persistent backlog — it raises the row's priority to runnable-now / re-arms from the
 * persisted compile boundary and wakes the compile loop. It is the second (and last)
 * non-query owner path beside `markIssuesSeen`; it never executes research tools and is
 * idempotent (a second call on an already-runnable row is a byte-stable no-op rewrite).
 */
export async function processBacklog(store: EvidenceStore, graphId: EvidenceGraphId): Promise<BacklogOutcome> {
  const outcome = await store.processBacklogRow(graphId, Date.now())
  if (outcome === 'triggered') store.compileWakeNotifier?.()
  return outcome
}
