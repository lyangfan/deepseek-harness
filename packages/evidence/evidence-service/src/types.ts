/**
 * Wire DTOs of the Evidence read service (SPEC-05 §4). Plain JSON-safe types only: the Typert
 * generator synthesizes schemas from these annotations, so no enums, generics or mapped types
 * appear here. Named errors travel as typed result unions (the wire preserves only
 * `internal` + message for thrown errors, which cannot carry the frozen named codes).
 *
 * @module @deepseek-ai/dsh-evidence-service/types
 */

// ---- shared ----

/** The three version tokens (SPEC-05 §5.3); every response embeds the current set. */
export interface VersionTokens {
  readonly materialStateDigest: string
  readonly headRevision: number
  readonly issuesRevision: string
}

/** A named service error (frozen codes: snapshot_not_found, scope_mismatch, cursor_out_of_scope, …). */
export interface ServiceError {
  readonly code: string
  readonly message: string
}

export type Subtype = 'hypothesis' | 'interpretation' | 'conclusion' | 'limitation' | 'statement'

export type NodeKind = 'Run' | 'Observation' | 'ArtifactVersion' | 'ContextEntity' | 'CandidateStatement'

/** Typed reference to one graph object (identity tuple; ids are owner-branded strings). */
export interface TypedObjectRef {
  readonly kind: NodeKind
  readonly id: string
}

// ---- status (§4.2) ----

export type PendingIncrement = 'none' | 'capture_pending' | 'compile_queued' | 'compiling' | 'retrying' | 'failed'

export type Freshness = 'current' | 'updating' | 'stale' | 'unavailable'

export type SemanticChannel = 'active' | 'disabled' | 'not_configured'

export type EvidenceStatus =
  | { readonly kind: 'no_graph' }
  | {
    readonly kind: 'graph'
    readonly graphId: string
    readonly currentSnapshotDigest: string | null
    readonly headRevision: number
    readonly freshness: Freshness
    readonly pending: PendingIncrement
    readonly semanticChannel: SemanticChannel
    readonly counts: { readonly candidates: number; readonly openIssues: number }
    readonly versions: VersionTokens
  }

export type StatusResponse = { readonly ok: true; readonly status: EvidenceStatus } | { readonly ok: false; readonly error: ServiceError }

// ---- snapshot (§4.3) ----

export interface SnapshotRequest {
  readonly requestedDigest: string | null
}

export interface SnapshotHeader {
  readonly graphId: string
  readonly snapshotDigest: string
  readonly isCurrent: boolean
  readonly committedAt: number
  readonly deterministicWatermark: number
  readonly semanticWatermark: SemanticWatermarkState
  readonly schemaSet: readonly string[]
  readonly versions: VersionTokens
}

export type SemanticWatermarkState =
  | { readonly kind: 'active'; readonly nextSeqExclusive: number }
  | { readonly kind: 'disabled'; readonly lastNextSeqExclusive: number }
  | { readonly kind: 'not_configured' }

export type SnapshotResponse = { readonly ok: true; readonly header: SnapshotHeader } | { readonly ok: false; readonly error: ServiceError }

// ---- candidates (§4.4) ----

export interface CandidatesRequest {
  readonly snapshotDigest: string
  readonly cursor: string | null
  readonly filter: { readonly subtypes: readonly Subtype[] } | null
}

export interface CandidateCard {
  readonly candidateId: string
  readonly subtype: Subtype
  readonly text: string
  readonly relationSummary: {
    readonly summary: 'no_active_evidence' | 'support_only' | 'contradiction_only' | 'mixed'
    readonly activeSupports: number
    readonly activeContradicts: number
    readonly activeQualifies: number
  }
  readonly sourceLabel: string
  readonly topBreakpoint: string | null
  readonly projectionState: 'active' | 'diagnostic'
}

export interface CandidatePage {
  readonly items: readonly CandidateCard[]
  readonly total: number
  readonly from: number
  readonly to: number
  readonly nextCursor: string | null
  readonly versions: VersionTokens
}

export type CandidatesResponse = { readonly ok: true; readonly page: CandidatePage } | { readonly ok: false; readonly error: ServiceError }

// ---- path (§4.5) ----

export interface PathRequest {
  readonly snapshotDigest: string
  readonly center: TypedObjectRef
}

export interface ObjectSummary {
  readonly ref: TypedObjectRef
  readonly label: string
  readonly projectionState: 'active' | 'diagnostic' | 'excluded'
}

export interface PathGroup {
  readonly direction: 'in' | 'out'
  readonly edgeType: string
  readonly items: readonly ObjectSummary[]
  readonly total: number
}

export interface PathView {
  readonly center: ObjectSummary
  readonly groups: readonly PathGroup[]
  readonly versions: VersionTokens
}

export type PathResponse = { readonly ok: true; readonly view: PathView } | { readonly ok: false; readonly error: ServiceError }

// ---- objectDetails (§4.6) ----

export interface ObjectDetailsRequest {
  readonly snapshotDigest: string
  readonly ref: TypedObjectRef
}

export interface RunDetails {
  readonly kind: 'Run'
  readonly callId: string
  readonly toolName: string
  readonly argumentsDigest: string
  readonly captureBasis: 'event' | 'receipt'
  readonly selectionBasis: string
  readonly outcome: string
  readonly eventSeqRange: { readonly startInclusive: number; readonly endInclusive: number }
  readonly receiptSubmissionRef: string | null
  readonly outputManifestRef: string | null
  readonly outputs: readonly { readonly role: string; readonly artifactVersionRef: string }[]
}

export interface ArtifactVersionDetails {
  readonly kind: 'ArtifactVersion'
  readonly artifactId: string
  readonly artifactVersionId: string
  readonly contentDigest: string
  readonly byteLength: number
  readonly mediaType: string
  readonly frozenLocator: string | null
  readonly frozenAvailability: string | null
  /** Anchor reachability for the §7 preview entry: this version's registered anchors. */
  readonly anchors: readonly { readonly sourceAnchorId: string; readonly sourceKind: string }[]
}

export interface ObservationDetails {
  readonly kind: 'Observation'
  readonly observationKind: string
  readonly runId: string | null
  readonly outcome: string | null
  readonly resultBlockCount: number | null
}

export interface CandidateDetails {
  readonly kind: 'CandidateStatement'
  readonly candidateId: string
  readonly subtype: Subtype
  readonly text: string
  readonly sourceBinding: string
  readonly generationProvenance: string
  readonly relationSummary: CandidateCard['relationSummary']
}

export interface ContextEntityDetails {
  readonly kind: 'ContextEntity'
  readonly contextKind: string
  readonly name: string
  readonly version: string | null
}

export type ObjectDetails = RunDetails | ArtifactVersionDetails | ObservationDetails | CandidateDetails | ContextEntityDetails

export type ObjectDetailsResponse =
  | { readonly ok: true; readonly details: ObjectDetails }
  | { readonly ok: false; readonly error: ServiceError }

// ---- receipt (§4.7) ----

export interface ReceiptRequest {
  readonly submissionRef: string
}

export interface ReceiptStatus {
  readonly state: 'pending' | 'accepted' | 'rejected'
  readonly acceptedAt: number | null
  readonly rejectedReason: string | null
}

export type ReceiptResponse = { readonly ok: true; readonly receipt: ReceiptStatus } | { readonly ok: false; readonly error: ServiceError }

// ---- issues (§6.4) ----

export interface IssuesRequest {
  readonly includeResolved: boolean
}

export interface IssueView {
  readonly issueKey: string
  readonly severity: 'attention' | 'action_required'
  readonly conditionCode: string
  readonly targetKind: string
  readonly targetId: string
  readonly applicableSnapshotDigest: string | null
  readonly applicableWatermark: number
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly occurrenceCount: number
  readonly resolvedAt: number | null
  readonly seenAt: number | null
}

export interface IssuesView {
  readonly items: readonly IssueView[]
  readonly unread: number
  readonly versions: VersionTokens
}

export type IssuesResponse = { readonly ok: true; readonly view: IssuesView } | { readonly ok: false; readonly error: ServiceError }

export interface MarkSeenRequest {
  readonly issueKeys: readonly string[]
}

export interface MarkSeenResult {
  readonly applied: readonly string[]
  readonly seenAt: number
}

export type MarkSeenResponse = { readonly ok: true; readonly result: MarkSeenResult } | { readonly ok: false; readonly error: ServiceError }

// ---- processBacklog (§11.4-2) ----

/** §11.4-2 outcome union: `triggered` (backlog now runnable), `idle` (nothing queued),
 * `busy` (a same-target attempt is active — the UI disabled condition), `paused`
 * (capture-overflow integrity hold, §8.1). */
export type ProcessBacklogOutcome = 'triggered' | 'idle' | 'busy' | 'paused'

export type ProcessBacklogResponse =
  | { readonly ok: true; readonly outcome: ProcessBacklogOutcome }
  | { readonly ok: false; readonly error: ServiceError }

// ---- navigate (§4.8) ----

export interface NavigateRequest {
  readonly snapshotDigest: string
  readonly source: NavigationSource
}

export type NavigationSource =
  | { readonly kind: 'tool_call'; readonly callId: string }
  | { readonly kind: 'artifact_version'; readonly artifactVersionId: string }
  | { readonly kind: 'session_event'; readonly eventSeq: number }

export type NavigationResolution =
  | { readonly result: 'found'; readonly target: TypedObjectRef }
  | { readonly result: 'multiple'; readonly alternatives: readonly TypedObjectRef[] }
  | { readonly result: 'not_in_snapshot' }
  | { readonly result: 'unavailable'; readonly reason: string }

export type NavigateResponse =
  | { readonly ok: true; readonly resolution: NavigationResolution }
  | { readonly ok: false; readonly error: ServiceError }

// ---- preview / openTarget (§7) ----

export interface PreviewRequest {
  readonly snapshotDigest: string
  readonly sourceAssertionId: string | null
  readonly artifactVersionId: string
  readonly sourceAnchorId: string
}

export interface VerificationPair {
  readonly snapshotFrozen: { readonly availability: string; readonly observedAt: number } | null
  readonly currentCheck: { readonly availability: string; readonly integrity: string; readonly checkedAt: number } | null
}

export type PreviewFragment =
  | { readonly kind: 'text'; readonly lines: readonly { readonly lineNo: number; readonly text: string }[]; readonly startLine: number; readonly endLine: number; readonly truncated: boolean }
  | { readonly kind: 'table'; readonly columns: readonly string[]; readonly rows: readonly (readonly string[])[]; readonly totalRows: number; readonly truncated: boolean }
  | { readonly kind: 'document_excerpt'; readonly note: string }
  | { readonly kind: 'web_excerpt'; readonly note: string }
  | { readonly kind: 'metadata'; readonly mediaType: string; readonly byteLength: number }
  | { readonly kind: 'unavailable'; readonly reason: string }

export interface PreviewResult {
  readonly fragment: PreviewFragment
  readonly checkedAt: number
  readonly verification: VerificationPair
}

export type PreviewResponse = { readonly ok: true; readonly preview: PreviewResult } | { readonly ok: false; readonly error: ServiceError }

export interface OpenTargetRequest {
  readonly snapshotDigest: string
  readonly artifactVersionId: string
}

export type OpenTargetResult =
  | { readonly ok: true; readonly path: string; readonly checkedAt: number }
  | { readonly ok: false; readonly reason: string }

export type OpenTargetResponse = { readonly result: OpenTargetResult } | { readonly ok: false; readonly error: ServiceError }

// ---- export (§8) ----

export interface ExportRequest {
  readonly snapshotDigest: string
}

export interface ExportResult {
  readonly filename: string
  readonly canonicalJson: string
}

export type ExportResponse = { readonly ok: true; readonly export: ExportResult } | { readonly ok: false; readonly error: ServiceError }
