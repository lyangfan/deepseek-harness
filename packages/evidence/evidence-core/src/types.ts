/** Public type vocabulary for deterministic AnimalGE Evidence snapshots. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Stable identity of one Session-scoped Evidence Graph. */
export type EvidenceGraphId = Branded<'EvidenceGraphId'>
/** Stable identity of one immutable Evidence Node. */
export type EvidenceNodeId = Branded<'EvidenceNodeId'>
/** Stable identity of one immutable provenance Edge. */
export type EvidenceEdgeId = Branded<'EvidenceEdgeId'>
/** Stable identity of one deterministic execution Run. */
export type EvidenceRunId = Branded<'EvidenceRunId'>
/** Stable identity of one terminal execution Observation. */
export type ObservationId = Branded<'ObservationId'>
/** Unique identity of one compiler attempt. */
export type CompileAttemptId = Branded<'CompileAttemptId'>
/** Unique identity of one staged candidate publication. */
export type StagingId = Branded<'StagingId'>
/** Unique identity of one recorded recovery operation. */
export type RecoveryId = Branded<'RecoveryId'>
/** Stable identity of one logical research Artifact (SPEC-02). */
export type ArtifactId = Branded<'ArtifactId'>
/** Stable identity of one immutable semantic Artifact version (SPEC-02). */
export type ArtifactVersionId = Branded<'ArtifactVersionId'>
/** Unique identity of one location/availability observation (SPEC-02). */
export type LocationObservationId = Branded<'LocationObservationId'>
/** Stable identity of one software/environment/parameter ContextEntity (SPEC-02). */
export type ContextEntityId = Branded<'ContextEntityId'>
/** Unique identity of one registered SourceAnchor (SPEC-02). */
export type SourceAnchorId = Branded<'SourceAnchorId'>
/** Unique identity of one Receipt Submission (SPEC-02). */
export type ReceiptSubmissionId = Branded<'ReceiptSubmissionId'>
/** Unique identity of one Receipt AcceptanceRecord (SPEC-02). */
export type ReceiptAcceptanceId = Branded<'ReceiptAcceptanceId'>
/** Lowercase SHA-256 digest with its algorithm tag. */
export type Sha256Digest = `sha256:${string}`

/** Stable scope fields shared by every Snapshot for one Session. */
export interface EvidenceGraphScopeV1 {
  readonly kind: 'session'
  readonly graphId: EvidenceGraphId
  readonly sessionId: SessionId
  readonly sessionCreatedAt: number
  readonly workspaceId?: WorkspaceId
}

/** Immutable reference to one canonicalized authoritative Session event. */
export interface SessionEventRefV1 {
  readonly schemaVersion: 'animalge.session-event-ref/v1'
  readonly sessionId: SessionId
  readonly seq: number
  readonly eventType: string
  readonly eventTime: number
  readonly eventDigest: Sha256Digest
}

/** Compiler and selection revisions carried by derived objects. */
export interface DeterministicCompilerProvenanceV1 {
  readonly compilerRevision: string
  readonly captureContractRevision: 'animalge-capture/v1'
  readonly selectionRuleDigest: Sha256Digest
}

/** Supported authoritative event pairings for one Tool invocation. */
export type InvocationEventBasisV1 =
  | { readonly kind: 'top_level_tool'; readonly callId: CallId; readonly callEvent: SessionEventRefV1; readonly resultEvent: SessionEventRefV1 }
  | { readonly kind: 'top_level_not_started'; readonly callId: CallId; readonly assistantEvent: SessionEventRefV1; readonly toolCallBlockIndex: number; readonly resultEvent: SessionEventRefV1 }
  | { readonly kind: 'code_mode_dispatch'; readonly rootCallId: CallId; readonly parentCallId: CallId; readonly subCallId: CallId; readonly startEvent: SessionEventRefV1; readonly resultEvent: SessionEventRefV1 }

/** Conservative terminal outcome derived from persisted events. */
export type RunOutcome = 'succeeded' | 'failed' | 'not_started' | 'outcome_unknown'

/** Frozen deterministic Run payload backed by Session events. */
export interface EventBackedRunPayloadV1 {
  readonly runSchema: 'animalge.run.event-backed/v1'
  readonly runId: EvidenceRunId
  readonly runKind: 'tool'
  readonly operation: { readonly toolName: string }
  readonly primaryCallId: CallId
  readonly invocationDigest: Sha256Digest
  readonly eventBasis: InvocationEventBasisV1
  readonly captureKind: 'event'
  readonly providerId: 'dsh-session-log'
  readonly providerVersion: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
  readonly receiptDigest: null
  readonly captureContractRevision: 'animalge-capture/v1'
  readonly eventSeqRange: { readonly startInclusive: number; readonly endInclusive: number }
  readonly actorRefs: readonly []
  readonly selectionBasis: { readonly kind: 'deterministic_rule'; readonly ruleRevision: string; readonly ruleDigest: Sha256Digest } | ModelCandidateSelectionV1
  readonly startedAt: number | null
  readonly endedAt: number
  readonly outcome: RunOutcome
  readonly components: {
    readonly inputs: 'missing'
    readonly outputs: 'missing' | 'not_applicable'
    readonly softwareAndCode: 'missing'
    readonly environment: 'missing'
    readonly parameters: 'missing'
    readonly randomness: 'missing'
    readonly logs: 'missing'
  }
}

/** Frozen terminal Tool-result Observation payload. */
export interface ToolResultObservationPayloadV1 {
  readonly observationSchema: 'animalge.observation.tool-result/v1'
  readonly observationId: ObservationId
  readonly observationKind: 'run_terminal_outcome'
  readonly runId: EvidenceRunId
  readonly outcome: RunOutcome
  readonly resultContentDigest: Sha256Digest
  readonly resultBlockCount: number
  readonly errorIdentity?: { readonly name: string; readonly code: string }
}

/** Common immutable fields shared by every Evidence Node. */
export interface EvidenceNodeBaseV1 {
  readonly schemaVersion: 'animalge.evidence.node/v1'
  readonly nodeId: EvidenceNodeId
  readonly graphId: EvidenceGraphId
  readonly nodeKind: 'Run' | 'Observation' | 'ArtifactVersion' | 'ContextEntity' | 'CandidateStatement'
  readonly payloadSchema: string
  readonly projectionState: 'active' | 'diagnostic' | 'excluded'
  readonly identityRevision: 'animalge-identity/v1'
  readonly sourceEventRefs: readonly SessionEventRefV1[]
  readonly compiler: DeterministicCompilerProvenanceV1
}

/** Frozen Run or Observation Node union plus the SPEC-02 material and SPEC-04 candidate node kinds. */
export type EvidenceNodeV1 =
  | EvidenceNodeBaseV1 & { readonly nodeKind: 'Run'; readonly payloadSchema: 'animalge.run.event-backed/v1' | 'animalge.run.receipt-backed/v1'; readonly payload: EventBackedRunPayloadV1 | ReceiptBackedRunPayloadV1 }
  | EvidenceNodeBaseV1 & { readonly nodeKind: 'Observation'; readonly payloadSchema: 'animalge.observation.tool-result/v1'; readonly payload: ToolResultObservationPayloadV1 }
  | EvidenceNodeBaseV1 & { readonly nodeKind: 'ArtifactVersion'; readonly payloadSchema: 'animalge.artifact.version-node/v1'; readonly payload: ArtifactVersionNodePayloadV1 }
  | EvidenceNodeBaseV1 & { readonly nodeKind: 'ContextEntity'; readonly payloadSchema: 'animalge.context.entity-node/v1'; readonly payload: ContextEntityNodePayloadV1 }
  | EvidenceNodeBaseV1 & { readonly nodeKind: 'CandidateStatement'; readonly payloadSchema: 'animalge.candidate.statement/v1'; readonly payload: CandidateStatementPayloadV1 }

/** Edge families: deterministic provenance plus the SPEC-04 candidate families (§10.2-3). */
export type EvidenceEdgeFamilyV1 = 'deterministic_provenance' | 'scientific_argument' | 'conflict_candidate_identity'

/**
 * Frozen provenance Edge schema. Deterministic-family edges never carry a relation
 * payload; candidate-family edges always carry model generation provenance (§10.2-3).
 */
export type EvidenceEdgeV1 =
  | {
    readonly schemaVersion: 'animalge.evidence.edge/v1'
    readonly edgeId: EvidenceEdgeId
    readonly graphId: EvidenceGraphId
    readonly edgeType: 'generated_by' | 'part_of' | 'used' | 'supersedes' | 'restored_from'
    readonly family: 'deterministic_provenance'
    readonly from: EvidenceNodeId
    readonly to: EvidenceNodeId
    readonly projectionState: 'active' | 'diagnostic' | 'excluded'
    readonly sourceEventRefs: readonly SessionEventRefV1[]
    readonly compiler: DeterministicCompilerProvenanceV1
  }
  | {
    readonly schemaVersion: 'animalge.evidence.edge/v1'
    readonly edgeId: EvidenceEdgeId
    readonly graphId: EvidenceGraphId
    readonly edgeType: 'supports' | 'qualifies' | 'contradicts' | 'same_as_candidate'
    readonly family: 'scientific_argument' | 'conflict_candidate_identity'
    readonly from: EvidenceNodeId
    readonly to: EvidenceNodeId
    readonly projectionState: 'active' | 'diagnostic' | 'excluded'
    readonly sourceEventRefs: readonly SessionEventRefV1[]
    readonly compiler: DeterministicCompilerProvenanceV1
    readonly relation: CandidateGenerationProvenanceV1
  }

/** Stable diagnostic describing a conservative projection discontinuity. */
export interface SnapshotBreakpointV1 {
  readonly schemaVersion: 'animalge.snapshot-breakpoint/v1'
  readonly code: string
  readonly stableKey: string
  readonly primarySourceRef: SessionEventRefV1
  readonly relatedObjectIds: readonly string[]
  readonly detailDigest: Sha256Digest
}

/** Snapshot schema set: core-only legacy, the SPEC-02 material pair, and the SPEC-04 candidate triple. */
export type EvidenceSchemaSetV1 =
  | readonly ['animalge.evidence.core/v1']
  | readonly ['animalge.evidence.core/v1', 'animalge.evidence.material/v1']
  | readonly ['animalge.evidence.core/v1', 'animalge.evidence.material/v1', 'animalge.evidence.candidate/v1']

/** Complete immutable deterministic Evidence projection for one watermark. */
export interface EvidenceSnapshotPayloadV1 {
  readonly format: 'animalge.evidence.snapshot/v1'
  readonly scope: EvidenceGraphScopeV1
  readonly schemaSet: EvidenceSchemaSetV1
  readonly revisions: {
    readonly canonicalization: 'animalge-c14n-json/v1'
    readonly identity: 'animalge-identity/v1'
    readonly compiler: string
    readonly captureContract: 'animalge-capture/v1'
    readonly selectionRuleDigest: Sha256Digest
    /** Present only on material snapshots (SPEC-02 §4.7-3); absent on core-only legacy. */
    readonly materialContract?: 'animalge-material/v1'
    /** Present only on candidate snapshots (SPEC-04 §10.2-3); absent on legacy schemaSets. */
    readonly candidateContract?: 'animalge-candidate/v1'
  }
  readonly baseSnapshotDigest: Sha256Digest | null
  readonly deterministicWatermark: { readonly nextSeqExclusive: number }
  readonly semanticWatermark: SemanticWatermarkV1
  readonly sourceTimeUpperBound: number | null
  readonly nodes: readonly EvidenceNodeV1[]
  readonly edges: readonly EvidenceEdgeV1[]
  readonly breakpoints: readonly SnapshotBreakpointV1[]
}

/** Digest-addressed immutable Snapshot storage envelope. */
export interface StoredSnapshotV1 {
  readonly recordVersion: 'animalge.stored-snapshot/v1'
  readonly snapshotDigest: Sha256Digest
  readonly payload: JsonValue
  readonly canonicalByteLength: number
}

/** Mutable Graph head guarded by digest and monotonic revision. */
export interface CurrentHeadV1 {
  readonly recordVersion: 'animalge.current-head/v1'
  readonly graphId: EvidenceGraphId
  readonly snapshotDigest: Sha256Digest | null
  readonly headRevision: number
  readonly previousSnapshotDigest: Sha256Digest | null
  readonly previousHeadRevision: number | null
}

/** Canonical exact-digest export envelope. */
export interface EvidenceExportV1 {
  readonly exportFormat: 'animalge.evidence.export/v1'
  readonly snapshotDigest: Sha256Digest
  readonly canonicalization: 'animalge-c14n-json/v1'
  readonly snapshot: EvidenceSnapshotPayloadV1
}

/** Runner terminal outcome vocabulary (SPEC-02 §9.4: five values, no partial). */
export type RunnerOutcome = 'succeeded' | 'failed' | 'cancelled' | 'not_started' | 'outcome_unknown'

/** Per-component capture state inside a Receipt Submission (SPEC-02 §6.3). */
export interface ReceiptComponentStateV1 {
  readonly state: 'captured' | 'missing' | 'not_applicable'
  readonly reason: string | null
  readonly ownerRefs: readonly string[]
  readonly captureBasis: 'provider_verified' | 'deterministic_rule' | null
}

/** Per-component state inside a receipt-backed Run payload (SPEC-02 §8.3 ComponentStateV1; no producer-side captureBasis). */
export interface PayloadComponentStateV1 {
  readonly state: 'captured' | 'missing' | 'not_applicable'
  readonly reason: string | null
  readonly ownerRefs: readonly string[]
}

/** The seven reproducibility components of one receipt (SPEC-02 §6.3). */
export interface ReceiptComponentsV1 {
  readonly inputs: ReceiptComponentStateV1
  readonly outputs: ReceiptComponentStateV1
  readonly softwareAndCode: ReceiptComponentStateV1
  readonly environment: ReceiptComponentStateV1
  readonly parameters: ReceiptComponentStateV1
  readonly randomness: ReceiptComponentStateV1
  readonly logs: ReceiptComponentStateV1
}

/** Producer-claimed invocation basis carried by a Submission (SPEC-02 §6.2). */
export type RunnerInvocationBasisV1 =
  | { readonly kind: 'direct'; readonly callId: CallId; readonly startEventRef: SessionEventRefV1 | null }
  | { readonly kind: 'code_dispatch'; readonly rootCallId: CallId; readonly parentCallId: CallId; readonly subCallId: CallId; readonly startEventRef: SessionEventRefV1 | null }

/** Immutable producer-side receipt delivery persisted before the tool result settles (SPEC-02 §6.2). */
export interface EvidenceRunReceiptSubmissionV1 {
  readonly recordVersion: 'animalge.receipt-submission/v1'
  readonly receiptId: ReceiptSubmissionId
  readonly receiptSchemaRevision: 'animalge.evidence.receipt/v1'
  readonly submissionDigest: Sha256Digest
  readonly submittedAt: number
  readonly providerId: string
  readonly providerVersion: string
  readonly captureProfileId: string
  readonly captureProfileRevision: string
  readonly evidenceGraphId: EvidenceGraphId
  readonly sessionId: SessionId
  readonly runId: EvidenceRunId
  readonly invocationBasis: RunnerInvocationBasisV1
  readonly expectedResultLocator: { readonly sessionId: SessionId; readonly callId: CallId }
  /** SPEC-03 §11.4-2 additive diff: languageProfile optional, operationProfile added. */
  readonly operation: { readonly toolName: string; readonly languageProfile?: string; readonly operationProfile?: string }
  readonly invocationDigest: Sha256Digest
  readonly lifecycle: { readonly startedAt: number | null; readonly endedAt: number }
  readonly outcome: RunnerOutcome
  readonly components: ReceiptComponentsV1
  readonly extensions: readonly {
    readonly namespace: string
    readonly schemaId: string
    readonly revision: string
    readonly payload: JsonValue
  }[]
}

/** Immutable acceptance verdict written by the deterministic lane after the real event pair (SPEC-02 §7.3). */
export interface ReceiptAcceptanceRecordV1 {
  readonly recordVersion: 'animalge.receipt-acceptance/v1'
  readonly acceptanceId: ReceiptAcceptanceId
  readonly receiptId: ReceiptSubmissionId
  readonly submissionDigest: Sha256Digest
  readonly acceptedAt: number
  readonly pairedStartRef: SessionEventRefV1
  readonly pairedResultRef: SessionEventRefV1
  readonly acceptanceDigest: Sha256Digest
  readonly verdict: 'accepted' | 'rejected'
  readonly rejectedReason: string | null
  readonly componentVerdicts: Readonly<Record<'inputs' | 'outputs' | 'softwareAndCode' | 'environment' | 'parameters' | 'randomness' | 'logs', 'verified' | 'failed' | 'not_applicable'>>
  readonly receiptAcceptance: 'accepted' | 'rejected'
}

/** Per-session acceptance-lane watermark and pending list (SPEC-02 §7.1; the lane's only mutable record). */
export interface ReceiptLaneV1 {
  readonly recordVersion: 'animalge.receipt-lane/v1'
  readonly sessionId: SessionId
  readonly nextSeqExclusive: number
  readonly pendingSubmissions: readonly ReceiptSubmissionId[]
  readonly updatedAt: number
}

/** Immutable logical-Artifact ledger row (SPEC-02 §4.1; current version derives from the version chain). */
export interface ArtifactRecordV1 {
  readonly recordVersion: 'animalge.artifact/v1'
  readonly artifactId: ArtifactId
  readonly createdAt: number
  readonly createdBy: 'runner_output' | 'runner_input' | 'runner_log' | 'runner_code' | 'explicit_registration'
}

/** Immutable version core — layer one of the four-layer state (SPEC-02 §4.2). */
export interface ArtifactVersionCoreV1 {
  readonly recordVersion: 'animalge.artifact-version/v1'
  readonly artifactId: ArtifactId
  readonly artifactVersionId: ArtifactVersionId
  readonly contentDigest: Sha256Digest
  readonly byteLength: number
  readonly mediaType: string
  readonly retention: 'reference'
  readonly parentVersionId: ArtifactVersionId | null
  readonly supersedesReason: 'content_change' | 'explicit_commit' | 'restore_as_new' | null
  readonly createdAt: number
  readonly createdBy: 'runner_output' | 'runner_input' | 'runner_log' | 'runner_code' | 'explicit_registration'
}

/** Immutable location/availability observation — layer two of the four-layer state (SPEC-02 §4.3). */
export interface LocationAvailabilityObservationV1 {
  readonly recordVersion: 'animalge.location-observation/v1'
  readonly locationObservationId: LocationObservationId
  readonly artifactVersionId: ArtifactVersionId
  readonly locator: string
  readonly availability: 'available' | 'missing'
  readonly integrity: 'matched' | 'content_mismatch' | 'not_checked' | 'integrity_unknown'
  readonly observedAt: number
  readonly freshnessToken: string | null
  readonly continuityBasis: 'provider_verified' | 'explicit_registration' | null
  readonly observationBasis: 'full_sha256' | 'freshness_reuse' | 'no_read'
}

/** Immutable software/environment/parameter_set owner record (SPEC-02 §4.6). */
export interface ContextEntityRecordV1 {
  readonly recordVersion: 'animalge.context-entity/v1'
  readonly contextEntityId: ContextEntityId
  readonly contextKind: 'software' | 'environment' | 'parameter_set'
  readonly identity: { readonly name: string; readonly version: string | null }
  readonly canonicalDigest: Sha256Digest | null
  readonly payload: JsonValue
}

/** Immutable SourceAnchor owner record with its latest verification result (SPEC-02 §5). */
export interface SourceAnchorRecordV1 {
  readonly recordVersion: 'animalge.source-anchor/v1'
  readonly anchorId: SourceAnchorId
  readonly sourceVersionRef: ArtifactVersionId
  readonly sourceKind: 'text' | 'csv_table' | 'pdf' | 'html' | 'code' | 'dataset'
  readonly selector: JsonValue
  readonly verifierRevision: string
  readonly selectedDigest: Sha256Digest | null
  readonly lastVerification: { readonly code: string; readonly verifiedAt: number } | null
}

/** Graph-projection payload of one ArtifactVersion node (SPEC-02 §4.6). */
export interface ArtifactVersionNodePayloadV1 {
  readonly nodeSchema: 'animalge.artifact.version-node/v1'
  readonly artifactId: ArtifactId
  readonly artifactVersionId: ArtifactVersionId
  readonly contentDigest: Sha256Digest
  readonly byteLength: number
  readonly mediaType: string
  readonly retention: 'reference'
  readonly frozenLocationObservationId: LocationObservationId
}

/** Graph-projection payload of one ContextEntity node (SPEC-02 §4.6). */
export interface ContextEntityNodePayloadV1 {
  readonly nodeSchema: 'animalge.context.entity-node/v1'
  readonly contextEntityId: ContextEntityId
  readonly contextKind: 'software' | 'environment' | 'parameter_set'
  readonly identity: { readonly name: string; readonly version: string | null }
  readonly canonicalDigest: Sha256Digest | null
  readonly payload: JsonValue
}

/** Frozen receipt-backed Run payload — same runId, stronger capture basis (SPEC-02 §8.3). */
export interface ReceiptBackedRunPayloadV1 {
  readonly runSchema: 'animalge.run.receipt-backed/v1'
  readonly runId: EvidenceRunId
  readonly runKind: 'tool'
  readonly operation: { readonly toolName: string; readonly languageProfile?: string; readonly operationProfile?: string }
  readonly primaryCallId: CallId
  readonly invocationDigest: Sha256Digest
  readonly eventBasis: InvocationEventBasisV1
  readonly captureBasis: 'receipt'
  readonly receiptDigest: Sha256Digest
  readonly receiptId: ReceiptSubmissionId
  readonly captureContractRevision: 'animalge-capture/v1'
  readonly materialContractRevision: 'animalge-material/v1'
  readonly eventSeqRange: { readonly startInclusive: number; endInclusive: number }
  readonly actorRefs: readonly []
  readonly selectionBasis: { readonly kind: 'receipt_auto'; readonly receiptId: ReceiptSubmissionId; readonly acceptanceDigest: Sha256Digest }
  readonly startedAt: number | null
  readonly endedAt: number
  readonly outcome: RunnerOutcome
  readonly components: {
    readonly inputs: PayloadComponentStateV1
    readonly outputs: PayloadComponentStateV1
    readonly softwareAndCode: PayloadComponentStateV1
    readonly environment: PayloadComponentStateV1
    readonly parameters: PayloadComponentStateV1
    readonly randomness: PayloadComponentStateV1
    readonly logs: PayloadComponentStateV1
  }
}

/** --- SPEC-03 professional-layer identities and objects --- */

/** Unique identity of one normalized input bundle (SPEC-03 §6.1). */
export type InputBundleId = Branded<'InputBundleId'>
/** Unique identity of one persisted preflight report (SPEC-03 §6.2). */
export type PreflightReportId = Branded<'PreflightReportId'>
/** Unique identity of one frozen TestedEnvironmentRevision (SPEC-03 §7.1). */
export type TestedEnvironmentRevisionId = Branded<'TestedEnvironmentRevisionId'>
/** Unique identity of one output boundary reservation (SPEC-03 §8.1). */
export type OutputReservationId = Branded<'OutputReservationId'>
/** Unique identity of one persisted output plan (SPEC-03 §8.2). */
export type OutputPlanId = Branded<'OutputPlanId'>
/** Unique identity of one formal/diagnostic output manifest (SPEC-03 §8.3). */
export type OutputManifestId = Branded<'OutputManifestId'>
/** Unique identity of one output finalization record (SPEC-03 §8.4). */
export type OutputFinalizationId = Branded<'OutputFinalizationId'>

/** Immutable normalized input bundle value object (SPEC-03 §6.1; not a DAG node or copy). */
export interface InputBundleV1 {
  readonly recordVersion: 'animalge.input-bundle/v1'
  readonly bundleId: InputBundleId
  readonly bundleKind: string
  readonly schemaRevision: string
  readonly components: readonly {
    readonly role: string
    readonly locator: string
    readonly artifactVersionId: ArtifactVersionId
    readonly observationId: LocationObservationId
    readonly captureBasis: 'full_sha256' | 'freshness_reuse'
  }[]
  readonly bundleDigest: Sha256Digest
  readonly createdAt: number
}

/** Immutable persisted preflight report: one of exactly four states (SPEC-03 §6.2). */
export interface PreflightReportV1 {
  readonly recordVersion: 'animalge.preflight-report/v1'
  readonly reportId: PreflightReportId
  readonly profileIdentity: { readonly contractId: string; readonly revision: string }
  readonly softwareVersion: string | null
  readonly inputBundleRef: InputBundleId
  readonly coverage: 'operation_profile' | 'baseline_only'
  readonly status: 'incompatible' | 'needs_clarification' | 'ready_with_warnings' | 'ready'
  readonly checks: readonly {
    readonly checkId: string
    readonly severity: 'incompatible' | 'needs_clarification' | 'warning'
    readonly result: 'pass' | 'fail' | 'clarify'
    readonly observed: JsonValue | null
  }[]
  readonly coverageGaps: readonly string[]
  readonly warnings: readonly { readonly code: string; readonly detail: string }[]
  readonly clarification: { readonly question: string; readonly candidates: JsonValue } | null
  readonly computedAt: number
  readonly reportDigest: Sha256Digest
}

/** Deterministic observation of one environment component (SPEC-03 §7.1). */
export interface ProbeObservationV1 {
  readonly component: string
  readonly resolvedPath: string
  readonly executableDigest: Sha256Digest
  readonly versionOutput: string
  readonly parsedVersion: string | null
  readonly observedAt: number
}

/** Immutable TestedEnvironmentRevision frozen only from real probe results (SPEC-03 §7.1). */
export interface TestedEnvironmentRevisionV1 {
  readonly recordVersion: 'animalge.tested-environment/v1'
  readonly revisionId: TestedEnvironmentRevisionId
  readonly environmentSpecRevision: string
  readonly platform: { readonly os: string; readonly arch: string }
  readonly components: readonly {
    readonly name: string
    readonly kind: 'executable' | 'r_package' | 'conda_package'
    readonly identity: { readonly version: string; readonly digest: Sha256Digest; readonly sourceRef: string | null }
    readonly resolvedPath: string
  }[]
  readonly inputSchemaRevisions: readonly string[]
  readonly frozenAt: number
  readonly frozenFromProbe: readonly ProbeObservationV1[]
}

/** Single mutable pointer record naming the current environment revision (SPEC-03 §7.1). */
export interface EnvironmentStateV1 {
  readonly recordVersion: 'animalge.environment-state/v1'
  readonly currentRevisionId: TestedEnvironmentRevisionId | null
  readonly updatedAt: number
}

/** Persisted, normalized, mutually exclusive output boundary reservation (SPEC-03 §8.1). */
export interface OutputReservationV1 {
  readonly recordVersion: 'animalge.output-reservation/v1'
  readonly reservationId: OutputReservationId
  readonly runId: EvidenceRunId
  readonly attempt: number
  readonly kind: 'run_exclusive_dir' | 'user_specified'
  readonly boundary: { readonly rootDir: string; readonly entries: readonly string[]; readonly prefixes: readonly string[] }
  readonly state: 'active' | 'released' | 'abandoned'
  readonly createdAt: number
  readonly releasedAt: number | null
  readonly releaseBasis: 'completed' | 'failed' | 'cancelled_confirmed' | null
}

/** Pre-execution declaration of expected formal outputs (SPEC-03 §8.2). */
export interface OutputPlanV1 {
  readonly recordVersion: 'animalge.output-plan/v1'
  readonly planId: OutputPlanId
  readonly runId: EvidenceRunId
  readonly planRevision: string
  readonly generatedByHook: string
  readonly roles: readonly {
    readonly role: string
    readonly pathRule: { readonly kind: 'exact' | 'prefix'; readonly value: string }
    readonly required: boolean
    readonly cardinality: 'one' | 'many'
    readonly bundle: string | null
    readonly validator: string
  }[]
  readonly bundles: readonly { readonly bundleName: string; readonly requiredRoles: readonly string[] }[]
  readonly createdAt: number
}

/** Unclassified file observed inside a reserved boundary (SPEC-03 §8.3). */
export interface BoundaryObservationV1 {
  readonly locator: string
  readonly fileType: string | null
  readonly byteLength: number
  readonly observedAt: number
  readonly observationBasis: 'boundary_scan'
}

/** One validated formal output row inside a formal manifest (SPEC-03 §8.3). */
export interface FormalOutputV1 {
  readonly role: string
  readonly locator: string
  readonly artifactVersionId: ArtifactVersionId
  readonly contentDigest: Sha256Digest
  readonly byteLength: number
  readonly captureBasis: 'provider_verified'
  readonly validatorResult: { readonly validator: string; readonly passed: boolean }
  readonly bundle: string | null
  readonly disposition: 'finalized' | 'residual_integrity_unknown' | null
}

/** Closed formal/diagnostic union bound to runId/attempt (SPEC-03 §8.3). */
export interface OutputManifestV1 {
  readonly recordVersion: 'animalge.output-manifest/v1'
  readonly manifestId: OutputManifestId
  readonly kind: 'formal' | 'diagnostic'
  readonly reason: 'output_plan_absent' | null
  readonly runId: EvidenceRunId
  readonly attempt: number
  readonly reservationId: OutputReservationId
  readonly outputPlanId: OutputPlanId | null
  readonly formalOutputs: readonly FormalOutputV1[]
  readonly unclassifiedBoundaryObservations: readonly BoundaryObservationV1[]
  readonly generatedAt: number
  readonly manifestDigest: Sha256Digest
}

/** The only publication commit marker for formal outputs (SPEC-03 §8.4; runId/attempt idempotent). */
export interface OutputFinalizationRecordV1 {
  readonly recordVersion: 'animalge.output-finalization/v1'
  readonly finalizationId: OutputFinalizationId
  readonly runId: EvidenceRunId
  readonly attempt: number
  readonly manifestId: OutputManifestId
  readonly manifestDigest: Sha256Digest
  readonly finalizedRoles: readonly string[]
  readonly finalizedAt: number
  readonly finalizationDigest: Sha256Digest
}

/** Minimal referencing canonical Tool result shared by all professional tools (SPEC-03 §9.4). */
export interface ProfessionalToolResultV1 {
  readonly runId: string
  readonly outcome: RunnerOutcome
  readonly outputCompleteness: 'complete' | 'incomplete' | 'unknown'
  readonly outputCompletenessReason: string | null
  readonly outputManifestRef: string | null
  readonly outputs: readonly { readonly role: string; readonly artifactVersionRef: string }[]
  readonly receiptSubmissionRef: string
  readonly error?: { readonly code: string; readonly message: string }
}

/** --- SPEC-04 candidate-semantics layer identities and objects --- */

/** Stable identity of one CandidateStatement (SPEC-04 §8.2; prefix cst_). */
export type CandidateStatementId = Branded<'CandidateStatementId'>
/** Unique identity of one evidence model call (SPEC-04 §6.3; prefix mc_). */
export type ModelCallId = Branded<'ModelCallId'>

/**
 * Tri-state semantic watermark (SPEC-04 §9.6/§10.2-4). The untagged legacy form is only
 * legal on non-candidate schemaSets where it must equal zero; readers interpret it as
 * `not_configured` without rewriting stored bytes.
 */
export type SemanticWatermarkV1 =
  | { readonly kind: 'active'; readonly nextSeqExclusive: number }
  | { readonly kind: 'disabled'; readonly lastNextSeqExclusive: number }
  | { readonly kind: 'not_configured' }
  | { readonly nextSeqExclusive: number }

/** Verifiable binding of one candidate to its direct Agent-message source (SPEC-04 §8.3). */
export interface AgentMessageSourceBindingV1 {
  readonly kind: 'agent_message'
  readonly sessionId: SessionId
  readonly eventSeq: number
  readonly spanStart: number
  readonly spanEnd: number
  readonly spanTextDigest: Sha256Digest
  readonly actorRef: string
}

/** Generation provenance shared by candidate nodes and candidate relation edges (SPEC-04 §8.3). */
export interface CandidateGenerationProvenanceV1 {
  readonly modelCallId: ModelCallId
  readonly modelRequestEventRef: SessionEventRefV1
  readonly provider: string
  readonly model: string
  readonly extractorRevision: string
  readonly promptRevision: string
  readonly projectionDigest: Sha256Digest
  readonly attemptId: CompileAttemptId
}

/** Deterministic relation summary derived from active candidate edges (SPEC-04 §8.3, D-092). */
export interface CandidateRelationSummaryV1 {
  readonly summary: 'no_active_evidence' | 'support_only' | 'contradiction_only' | 'mixed'
  readonly activeSupports: number
  readonly activeContradicts: number
  readonly activeQualifies: number
}

/** Graph-projection payload of one CandidateStatement node (SPEC-04 §8.3). */
export interface CandidateStatementPayloadV1 {
  readonly candidateSchema: 'animalge.candidate.statement/v1'
  readonly candidateId: CandidateStatementId
  readonly subtype: 'hypothesis' | 'interpretation' | 'conclusion' | 'limitation' | 'statement'
  readonly text: string
  readonly sourceBinding: AgentMessageSourceBindingV1
  readonly generationProvenance: CandidateGenerationProvenanceV1
  readonly relationSummary: CandidateRelationSummaryV1
}

/** Model-proposed selection basis for event-backed Runs (SPEC-04 §8.4; SPEC-02 §8.2 reservation). */
export interface ModelCandidateSelectionV1 {
  readonly kind: 'model_candidate'
  readonly modelCallId: ModelCallId
  readonly attemptId: CompileAttemptId
  readonly modelRequestEventRef: SessionEventRefV1
}

/** Immutable candidate owner record (SPEC-04 §8.2 ledger; append-only). */
export interface CandidateRecordV1 {
  readonly recordVersion: 'animalge.candidate/v1'
  readonly candidateId: CandidateStatementId
  readonly graphId: EvidenceGraphId
  readonly subtype: CandidateStatementPayloadV1['subtype']
  readonly text: string
  readonly sourceBinding: AgentMessageSourceBindingV1
  /** Verified assistant/message event reference from the attempt's frozen prefix. */
  readonly sourceEventRef: SessionEventRefV1
  readonly generationProvenance: CandidateGenerationProvenanceV1
  readonly acceptedAt: number
  readonly acceptedAttemptId: CompileAttemptId
}

/** Immutable candidate-relation owner record (SPEC-04 §8.2 ledger; append-only). */
export interface CandidateRelationRecordV1 {
  readonly recordVersion: 'animalge.candidate-relation/v1'
  readonly edgeId: EvidenceEdgeId
  readonly graphId: EvidenceGraphId
  readonly edgeType: 'supports' | 'qualifies' | 'contradicts' | 'same_as_candidate'
  readonly fromNodeId: EvidenceNodeId
  readonly toNodeId: EvidenceNodeId
  readonly provenance: CandidateGenerationProvenanceV1
  readonly createdAt: number
  readonly acceptedAttemptId: CompileAttemptId
}

/** Immutable model-proposed run selection owner record (SPEC-04 §8.2; first write per runId wins). */
export interface ModelRunSelectionRecordV1 {
  readonly recordVersion: 'animalge.model-run-selection/v1'
  readonly runId: EvidenceRunId
  readonly graphId: EvidenceGraphId
  readonly modelCallId: ModelCallId
  readonly attemptId: CompileAttemptId
  readonly modelRequestEventRef: SessionEventRefV1
  readonly reason: string
  readonly createdAt: number
}

/** Result-side provenance of one evidence model call (SPEC-04 §6.3; request bytes live in the Session log). */
export interface ModelCallRecordV1 {
  readonly recordVersion: 'animalge.model-call/v1'
  readonly modelCallId: ModelCallId
  readonly graphId: EvidenceGraphId
  readonly attemptId: CompileAttemptId
  readonly purpose: 'candidate-semantics'
  readonly provider: string
  readonly model: string
  readonly generationConfig: JsonValue
  readonly requestEventRef: SessionEventRefV1 | null
  readonly startedAt: number
  readonly endedAt: number
  readonly outcome: 'succeeded' | 'aborted' | 'timed_out' | 'failed'
  /** Short fnv1a error identity — full messages never enter durable records (§6.3). */
  readonly errorDigest: string | null
  readonly usage: JsonValue | null
  readonly acceptedOutputDigest: Sha256Digest | null
}

/** Per-Graph semantic lane watermark — the crash-recovery authority (SPEC-04 §9.2). */
export interface SemanticLaneV1 {
  readonly recordVersion: 'animalge.semantic-lane/v1'
  readonly graphId: EvidenceGraphId
  readonly nextSeqExclusive: number
  readonly updatedAt: number
}

/** Per-Graph session-level "AI candidate extraction" switch state (SPEC-04 §4.3, D-155). */
export interface SemanticSwitchV1 {
  readonly recordVersion: 'animalge.semantic-switch/v1'
  readonly graphId: EvidenceGraphId
  readonly enabled: boolean
  readonly updatedAt: number
}

/** Immutable per-proposal validation verdict, accepted or rejected with a named code (SPEC-04 §8.1). */
export interface ProposalValidationRecordV1 {
  readonly recordVersion: 'animalge.proposal-validation/v1'
  readonly fingerprint: string
  readonly graphId: EvidenceGraphId
  readonly attemptId: CompileAttemptId
  readonly verdict: 'accepted' | 'rejected'
  readonly rejectCode: string | null
  readonly summary: JsonValue
  readonly recordedAt: number
}
