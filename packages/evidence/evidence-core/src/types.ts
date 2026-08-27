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
  readonly selectionBasis: { readonly kind: 'deterministic_rule'; readonly ruleRevision: string; readonly ruleDigest: Sha256Digest }
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
  readonly nodeKind: 'Run' | 'Observation'
  readonly payloadSchema: string
  readonly projectionState: 'active' | 'diagnostic' | 'excluded'
  readonly identityRevision: 'animalge-identity/v1'
  readonly sourceEventRefs: readonly SessionEventRefV1[]
  readonly compiler: DeterministicCompilerProvenanceV1
}

/** Frozen Run or Observation Node union. */
export type EvidenceNodeV1 =
  | EvidenceNodeBaseV1 & { readonly nodeKind: 'Run'; readonly payloadSchema: 'animalge.run.event-backed/v1'; readonly payload: EventBackedRunPayloadV1 }
  | EvidenceNodeBaseV1 & { readonly nodeKind: 'Observation'; readonly payloadSchema: 'animalge.observation.tool-result/v1'; readonly payload: ToolResultObservationPayloadV1 }

/** Frozen deterministic provenance Edge. */
export interface EvidenceEdgeV1 {
  readonly schemaVersion: 'animalge.evidence.edge/v1'
  readonly edgeId: EvidenceEdgeId
  readonly graphId: EvidenceGraphId
  readonly edgeType: 'generated_by' | 'part_of'
  readonly family: 'deterministic_provenance'
  readonly from: EvidenceNodeId
  readonly to: EvidenceNodeId
  readonly projectionState: 'active' | 'diagnostic' | 'excluded'
  readonly sourceEventRefs: readonly SessionEventRefV1[]
  readonly compiler: DeterministicCompilerProvenanceV1
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

/** Complete immutable deterministic Evidence projection for one watermark. */
export interface EvidenceSnapshotPayloadV1 {
  readonly format: 'animalge.evidence.snapshot/v1'
  readonly scope: EvidenceGraphScopeV1
  readonly schemaSet: readonly ['animalge.evidence.core/v1']
  readonly revisions: {
    readonly canonicalization: 'animalge-c14n-json/v1'
    readonly identity: 'animalge-identity/v1'
    readonly compiler: string
    readonly captureContract: 'animalge-capture/v1'
    readonly selectionRuleDigest: Sha256Digest
  }
  readonly baseSnapshotDigest: Sha256Digest | null
  readonly deterministicWatermark: { readonly nextSeqExclusive: number }
  readonly semanticWatermark: { readonly nextSeqExclusive: number }
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
