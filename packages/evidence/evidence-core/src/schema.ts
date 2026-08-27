/** Strict runtime schemas for public Evidence values and durable control records. */

import { z } from 'zod'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ArtifactId, ArtifactVersionId, CompileAttemptId, ContextEntityId, EvidenceEdgeId, EvidenceGraphId, EvidenceNodeId, EvidenceRunId, LocationObservationId, ObservationId, ReceiptAcceptanceId, ReceiptSubmissionId, RecoveryId, SourceAnchorId, StagingId } from './identity.ts'
import type { ArtifactRecordV1, ArtifactVersionCoreV1, CompileAttemptId as CompileAttemptIdType, ContextEntityRecordV1, CurrentHeadV1, EvidenceEdgeV1, EvidenceGraphId as EvidenceGraphIdType, EvidenceNodeV1, EvidenceRunReceiptSubmissionV1, EvidenceSnapshotPayloadV1, LocationAvailabilityObservationV1, ReceiptAcceptanceRecordV1, ReceiptLaneV1, RecoveryId as RecoveryIdType, Sha256Digest, SourceAnchorRecordV1, StagingId as StagingIdType, StoredSnapshotV1 } from './types.ts'

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Strict tagged SHA-256 digest schema. */
export const sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u).transform(value => value as Sha256Digest)
export const evidenceGraphIdSchema = z.string().transform(EvidenceGraphId)
export const evidenceNodeIdSchema = z.string().transform(EvidenceNodeId)
export const evidenceEdgeIdSchema = z.string().transform(EvidenceEdgeId)
export const evidenceRunIdSchema = z.string().transform(EvidenceRunId)
export const observationIdSchema = z.string().transform(ObservationId)
export const compileAttemptIdSchema = z.string().transform(CompileAttemptId)
export const stagingIdSchema = z.string().transform(StagingId)
export const recoveryIdSchema = z.string().transform(RecoveryId)
export const artifactIdSchema = z.string().transform(ArtifactId)
export const artifactVersionIdSchema = z.string().transform(ArtifactVersionId)
export const locationObservationIdSchema = z.string().transform(LocationObservationId)
export const contextEntityIdSchema = z.string().transform(ContextEntityId)
export const sourceAnchorIdSchema = z.string().transform(SourceAnchorId)
export const receiptSubmissionIdSchema = z.string().transform(ReceiptSubmissionId)
export const receiptAcceptanceIdSchema = z.string().transform(ReceiptAcceptanceId)
const sessionIdSchema = z.string().min(1).transform(value => value as SessionId)
const callIdSchema = z.string().min(1).transform(value => value as CallId)
const workspaceIdSchema = z.string().min(1).transform(value => value as WorkspaceId)

/** Strict Session-scoped Evidence Graph identity schema. */
export const evidenceGraphScopeSchema = z.object({
  kind: z.literal('session'),
  graphId: evidenceGraphIdSchema,
  sessionId: sessionIdSchema,
  sessionCreatedAt: safeInteger,
  workspaceId: workspaceIdSchema.optional(),
}).strict()

/** Strict immutable reference to one authoritative Session event. */
export const sessionEventRefSchema = z.object({
  schemaVersion: z.literal('animalge.session-event-ref/v1'),
  sessionId: sessionIdSchema,
  seq: safeInteger,
  eventType: z.string().min(1),
  eventTime: safeInteger,
  eventDigest: sha256DigestSchema,
}).strict()

const compilerProvenanceSchema = z.object({
  compilerRevision: z.string().min(1),
  captureContractRevision: z.literal('animalge-capture/v1'),
  selectionRuleDigest: sha256DigestSchema,
}).strict()

const invocationBasisSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('top_level_tool'), callId: callIdSchema, callEvent: sessionEventRefSchema, resultEvent: sessionEventRefSchema }).strict(),
  z.object({ kind: z.literal('top_level_not_started'), callId: callIdSchema, assistantEvent: sessionEventRefSchema, toolCallBlockIndex: safeInteger, resultEvent: sessionEventRefSchema }).strict(),
  z.object({ kind: z.literal('code_mode_dispatch'), rootCallId: callIdSchema, parentCallId: callIdSchema, subCallId: callIdSchema, startEvent: sessionEventRefSchema, resultEvent: sessionEventRefSchema }).strict(),
])

const outcomeSchema = z.enum(['succeeded', 'failed', 'not_started', 'outcome_unknown'])
const runnerOutcomeSchema = z.enum(['succeeded', 'failed', 'cancelled', 'not_started', 'outcome_unknown'])

const receiptComponentStateSchema = z.object({
  state: z.enum(['captured', 'missing', 'not_applicable']),
  reason: z.string().min(1).nullable(),
  ownerRefs: z.array(z.string()),
  captureBasis: z.enum(['provider_verified', 'deterministic_rule']).nullable(),
}).strict()

const receiptComponentsSchema = z.object({
  inputs: receiptComponentStateSchema,
  outputs: receiptComponentStateSchema,
  softwareAndCode: receiptComponentStateSchema,
  environment: receiptComponentStateSchema,
  parameters: receiptComponentStateSchema,
  randomness: receiptComponentStateSchema,
  logs: receiptComponentStateSchema,
}).strict()

/** Strict §8.3 ComponentStateV1: three fields only, no producer-side captureBasis. */
const payloadComponentStateSchema = z.object({
  state: z.enum(['captured', 'missing', 'not_applicable']),
  reason: z.string().min(1).nullable(),
  ownerRefs: z.array(z.string()),
}).strict()

const payloadComponentsSchema = z.object({
  inputs: payloadComponentStateSchema,
  outputs: payloadComponentStateSchema,
  softwareAndCode: payloadComponentStateSchema,
  environment: payloadComponentStateSchema,
  parameters: payloadComponentStateSchema,
  randomness: payloadComponentStateSchema,
  logs: payloadComponentStateSchema,
}).strict()

const runnerInvocationBasisSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), callId: callIdSchema, startEventRef: sessionEventRefSchema.nullable() }).strict(),
  z.object({ kind: z.literal('code_dispatch'), rootCallId: callIdSchema, parentCallId: callIdSchema, subCallId: callIdSchema, startEventRef: sessionEventRefSchema.nullable() }).strict(),
])

/** Strict receipt-backed Run payload (SPEC-02 §8.3). */
export const receiptBackedRunPayloadSchema = z.object({
  runSchema: z.literal('animalge.run.receipt-backed/v1'),
  runId: evidenceRunIdSchema,
  runKind: z.literal('tool'),
  operation: z.object({ toolName: z.string().min(1), languageProfile: z.string().min(1).optional() }).strict(),
  primaryCallId: callIdSchema,
  invocationDigest: sha256DigestSchema,
  eventBasis: invocationBasisSchema,
  captureBasis: z.literal('receipt'),
  receiptDigest: sha256DigestSchema,
  receiptId: receiptSubmissionIdSchema,
  captureContractRevision: z.literal('animalge-capture/v1'),
  materialContractRevision: z.literal('animalge-material/v1'),
  eventSeqRange: z.object({ startInclusive: safeInteger, endInclusive: safeInteger }).strict(),
  actorRefs: z.tuple([]),
  selectionBasis: z.object({ kind: z.literal('receipt_auto'), receiptId: receiptSubmissionIdSchema, acceptanceDigest: sha256DigestSchema }).strict(),
  startedAt: safeInteger.nullable(),
  endedAt: safeInteger,
  outcome: runnerOutcomeSchema,
  components: payloadComponentsSchema,
}).strict()

/** Strict deterministic Run payload derived only from Session events. */
export const eventBackedRunPayloadSchema = z.object({
  runSchema: z.literal('animalge.run.event-backed/v1'),
  runId: evidenceRunIdSchema,
  runKind: z.literal('tool'),
  operation: z.object({ toolName: z.string().min(1) }).strict(),
  primaryCallId: callIdSchema,
  invocationDigest: sha256DigestSchema,
  eventBasis: invocationBasisSchema,
  captureKind: z.literal('event'),
  providerId: z.literal('dsh-session-log'),
  providerVersion: z.literal('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'),
  receiptDigest: z.null(),
  captureContractRevision: z.literal('animalge-capture/v1'),
  eventSeqRange: z.object({ startInclusive: safeInteger, endInclusive: safeInteger }).strict(),
  actorRefs: z.tuple([]),
  selectionBasis: z.object({ kind: z.literal('deterministic_rule'), ruleRevision: z.string().min(1), ruleDigest: sha256DigestSchema }).strict(),
  startedAt: safeInteger.nullable(),
  endedAt: safeInteger,
  outcome: outcomeSchema,
  components: z.object({
    inputs: z.literal('missing'),
    outputs: z.enum(['missing', 'not_applicable']),
    softwareAndCode: z.literal('missing'),
    environment: z.literal('missing'),
    parameters: z.literal('missing'),
    randomness: z.literal('missing'),
    logs: z.literal('missing'),
  }).strict(),
}).strict()

/** Strict terminal Tool-result Observation payload. */
export const toolResultObservationPayloadSchema = z.object({
  observationSchema: z.literal('animalge.observation.tool-result/v1'),
  observationId: observationIdSchema,
  observationKind: z.literal('run_terminal_outcome'),
  runId: evidenceRunIdSchema,
  outcome: outcomeSchema,
  resultContentDigest: sha256DigestSchema,
  resultBlockCount: safeInteger,
  errorIdentity: z.object({ name: z.string().min(1), code: z.string().min(1) }).strict().optional(),
}).strict()

const nodeBase = {
  schemaVersion: z.literal('animalge.evidence.node/v1'),
  nodeId: evidenceNodeIdSchema,
  graphId: evidenceGraphIdSchema,
  projectionState: z.enum(['active', 'diagnostic', 'excluded']),
  identityRevision: z.literal('animalge-identity/v1'),
  sourceEventRefs: z.array(sessionEventRefSchema),
  compiler: compilerProvenanceSchema,
}

/** Strict ArtifactVersion or ContextEntity node payload schemas (SPEC-02 §4.6). */
export const artifactVersionNodePayloadSchema = z.object({
  nodeSchema: z.literal('animalge.artifact.version-node/v1'),
  artifactId: artifactIdSchema,
  artifactVersionId: artifactVersionIdSchema,
  contentDigest: sha256DigestSchema,
  byteLength: safeInteger,
  mediaType: z.string().min(1),
  retention: z.literal('reference'),
  frozenLocationObservationId: locationObservationIdSchema,
}).strict()

/** Strict ContextEntity node payload schema (SPEC-02 §4.6). */
export const contextEntityNodePayloadSchema = z.object({
  nodeSchema: z.literal('animalge.context.entity-node/v1'),
  contextEntityId: contextEntityIdSchema,
  contextKind: z.enum(['software', 'environment', 'parameter_set']),
  identity: z.object({ name: z.string().min(1), version: z.string().min(1).nullable() }).strict(),
  canonicalDigest: sha256DigestSchema.nullable(),
  payload: z.json(),
}).strict()

/** Strict Evidence Node schema, discriminated on payloadSchema (unique per kind and per Run capture basis). */
export const evidenceNodeSchema = z.discriminatedUnion('payloadSchema', [
  z.object({ ...nodeBase, nodeKind: z.literal('Run'), payloadSchema: z.literal('animalge.run.event-backed/v1'), payload: eventBackedRunPayloadSchema }).strict(),
  z.object({ ...nodeBase, nodeKind: z.literal('Run'), payloadSchema: z.literal('animalge.run.receipt-backed/v1'), payload: receiptBackedRunPayloadSchema }).strict(),
  z.object({ ...nodeBase, nodeKind: z.literal('Observation'), payloadSchema: z.literal('animalge.observation.tool-result/v1'), payload: toolResultObservationPayloadSchema }).strict(),
  z.object({ ...nodeBase, nodeKind: z.literal('ArtifactVersion'), payloadSchema: z.literal('animalge.artifact.version-node/v1'), payload: artifactVersionNodePayloadSchema }).strict(),
  z.object({ ...nodeBase, nodeKind: z.literal('ContextEntity'), payloadSchema: z.literal('animalge.context.entity-node/v1'), payload: contextEntityNodePayloadSchema }).strict(),
]) as unknown as z.ZodType<EvidenceNodeV1>

/** Strict deterministic provenance Edge schema (SPEC-02 extends the closed edge-type union). */
export const evidenceEdgeSchema = z.object({
  schemaVersion: z.literal('animalge.evidence.edge/v1'),
  edgeId: evidenceEdgeIdSchema,
  graphId: evidenceGraphIdSchema,
  edgeType: z.enum(['generated_by', 'part_of', 'used', 'supersedes', 'restored_from']),
  family: z.literal('deterministic_provenance'),
  from: evidenceNodeIdSchema,
  to: evidenceNodeIdSchema,
  projectionState: z.enum(['active', 'diagnostic', 'excluded']),
  sourceEventRefs: z.array(sessionEventRefSchema),
  compiler: compilerProvenanceSchema,
}).strict() as unknown as z.ZodType<EvidenceEdgeV1>

const breakpointSchema = z.object({
  schemaVersion: z.literal('animalge.snapshot-breakpoint/v1'),
  code: z.string().min(1),
  stableKey: z.string().min(1),
  primarySourceRef: sessionEventRefSchema,
  relatedObjectIds: z.array(z.string()),
  detailDigest: sha256DigestSchema,
}).strict()

export const snapshotRevisionsSchema = z.union([
  z.object({
    canonicalization: z.literal('animalge-c14n-json/v1'),
    identity: z.literal('animalge-identity/v1'),
    compiler: z.string().min(1),
    captureContract: z.literal('animalge-capture/v1'),
    selectionRuleDigest: sha256DigestSchema,
  }).strict(),
  z.object({
    canonicalization: z.literal('animalge-c14n-json/v1'),
    identity: z.literal('animalge-identity/v1'),
    compiler: z.string().min(1),
    captureContract: z.literal('animalge-capture/v1'),
    selectionRuleDigest: sha256DigestSchema,
    materialContract: z.literal('animalge-material/v1'),
  }).strict(),
])

/** Snapshot schema set: core-only legacy (SPEC-01) plus the material pair (SPEC-02 §4.7-3/7). */
export const evidenceSchemaSetSchema = z.union([
  z.tuple([z.literal('animalge.evidence.core/v1')]),
  z.tuple([z.literal('animalge.evidence.core/v1'), z.literal('animalge.evidence.material/v1')]),
])

/** Strict immutable Evidence Snapshot payload schema. */
export const evidenceSnapshotPayloadSchema = z.object({
  format: z.literal('animalge.evidence.snapshot/v1'),
  scope: evidenceGraphScopeSchema,
  schemaSet: evidenceSchemaSetSchema,
  revisions: snapshotRevisionsSchema,
  baseSnapshotDigest: sha256DigestSchema.nullable(),
  deterministicWatermark: z.object({ nextSeqExclusive: safeInteger }).strict(),
  semanticWatermark: z.object({ nextSeqExclusive: safeInteger }).strict(),
  sourceTimeUpperBound: safeInteger.nullable(),
  nodes: z.array(evidenceNodeSchema),
  edges: z.array(evidenceEdgeSchema),
  breakpoints: z.array(breakpointSchema),
}).strict() as unknown as z.ZodType<EvidenceSnapshotPayloadV1>

/** Strict immutable stored Snapshot envelope schema. */
export const storedSnapshotSchema = z.object({
  recordVersion: z.literal('animalge.stored-snapshot/v1'),
  snapshotDigest: sha256DigestSchema,
  payload: z.json(),
  canonicalByteLength: safeInteger,
}).strict() as unknown as z.ZodType<StoredSnapshotV1>

export const currentHeadSchema = z.object({
  recordVersion: z.literal('animalge.current-head/v1'),
  graphId: evidenceGraphIdSchema,
  snapshotDigest: sha256DigestSchema.nullable(),
  headRevision: safeInteger,
  previousSnapshotDigest: sha256DigestSchema.nullable(),
  previousHeadRevision: safeInteger.nullable(),
}).strict() as unknown as z.ZodType<CurrentHeadV1>

export const graphRecordSchema = z.object({
  recordVersion: z.literal('animalge.evidence-graph/v1'),
  scope: evidenceGraphScopeSchema,
  status: z.enum(['ready', 'bootstrap_corrupt', 'unavailable']),
}).strict() as unknown as z.ZodType<GraphRecord>

export const sessionGraphBootstrapSchema = z.object({
  recordVersion: z.literal('animalge.session-graph-bootstrap/v1'),
  sessionId: sessionIdSchema,
  sessionCreatedAt: safeInteger,
  graphId: evidenceGraphIdSchema,
  initialScope: evidenceGraphScopeSchema,
  state: z.enum(['initializing', 'ready']),
}).strict() as unknown as z.ZodType<SessionGraphBootstrap>

export const capturedInvocationSchema = z.object({
  recordVersion: z.literal('animalge.captured-invocation/v1'),
  graphId: evidenceGraphIdSchema,
  sessionId: sessionIdSchema,
  runId: evidenceRunIdSchema,
  basis: invocationBasisSchema,
  toolName: z.string().min(1),
  argumentsDigest: sha256DigestSchema,
  resultContentDigest: sha256DigestSchema,
  resultBlockCount: safeInteger,
  isError: z.boolean(),
  errorIdentity: z.object({ name: z.string().min(1), code: z.string().min(1) }).strict().optional(),
  outcome: outcomeSchema,
  startedAt: safeInteger.nullable(),
  endedAt: safeInteger,
  invocationDigest: sha256DigestSchema,
  selection: z.enum(['selected', 'not_selected']),
  selectionRuleDigest: sha256DigestSchema,
  captureContractRevision: z.literal('animalge-capture/v1'),
}).strict()

export const compileOutboxSchema = z.object({
  recordVersion: z.literal('animalge.compile-outbox/v1'),
  graphId: evidenceGraphIdSchema,
  sessionId: sessionIdSchema,
  targetNextSeqExclusive: safeInteger,
  firstBoundarySeq: safeInteger,
  lastBoundarySeq: safeInteger,
  boundaryCount: safeInteger.min(1),
  reasonCounts: z.object({
    tool_result: safeInteger,
    code_dispatch: safeInteger,
    turn_end: safeInteger,
    startup_scan: safeInteger,
    retry: safeInteger,
    receipt_accepted: safeInteger.optional(),
  }).strict(),
  fairTicket: safeInteger.min(1),
  firstQueuedAt: safeInteger,
  lastQueuedAt: safeInteger,
  eligibleAfter: safeInteger,
  retryNotBefore: safeInteger,
  inFlightAttemptId: compileAttemptIdSchema.nullable(),
  overflowed: z.boolean(),
  firstRejectedTarget: safeInteger.optional(),
  latestAdmittedTarget: safeInteger.optional(),
}).strict()

export const compileAttemptSchema = z.object({
  recordVersion: z.literal('animalge.compile-attempt/v1'),
  attemptId: compileAttemptIdSchema,
  graphId: evidenceGraphIdSchema,
  sessionId: sessionIdSchema,
  fromNextSeqExclusive: safeInteger,
  targetNextSeqExclusive: safeInteger,
  baseSnapshotDigest: sha256DigestSchema.nullable(),
  baseHeadRevision: safeInteger,
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled']),
  stage: z.enum(['capture', 'fold', 'validate', 'stage', 'commit', 'finalize']),
  revisions: snapshotRevisionsSchema,
  retryOf: compileAttemptIdSchema.nullable(),
  startedAt: safeInteger.nullable(),
  updatedAt: safeInteger,
  terminalError: z.object({
    code: z.string().min(1),
    stage: z.string().min(1),
    retryable: z.boolean(),
    messageDigest: sha256DigestSchema,
  }).strict().nullable(),
  stagingId: stagingIdSchema.nullable(),
  resultSnapshotDigest: sha256DigestSchema.nullable(),
}).strict()

export const stagingRecordSchema = z.object({
  recordVersion: z.literal('animalge.staging/v1'),
  stagingId: stagingIdSchema,
  attemptId: compileAttemptIdSchema,
  graphId: evidenceGraphIdSchema,
  expectedSnapshotDigest: sha256DigestSchema.nullable(),
  expectedHeadRevision: safeInteger,
  candidateSnapshotDigest: sha256DigestSchema,
  createdAt: safeInteger,
  state: z.enum(['draft', 'validated', 'committed', 'orphan']),
}).strict()

export const headCommitSchema = z.object({
  recordVersion: z.literal('animalge.head-commit/v1'),
  graphId: evidenceGraphIdSchema,
  headRevision: safeInteger,
  previousSnapshotDigest: sha256DigestSchema.nullable(),
  snapshotDigest: sha256DigestSchema.nullable(),
  kind: z.enum(['compile', 'recovery']),
  operationId: z.string().min(1),
  committedAt: safeInteger,
}).strict()

export const quarantineRecordSchema = z.object({
  recordVersion: z.literal('animalge.quarantine/v1'),
  recoveryId: recoveryIdSchema,
  graphId: evidenceGraphIdSchema.optional(),
  objectTable: z.string().min(1),
  objectKey: z.string().min(1),
  code: z.string().min(1),
  stage: z.string().min(1),
  headRevision: safeInteger.optional(),
  detectedAt: safeInteger,
  detailDigest: sha256DigestSchema,
  retainKeys: z.array(z.string()),
}).strict()

export const queueClockSchema = z.object({ recordVersion: z.literal('animalge.queue-clock/v1'), nextTicket: safeInteger.min(1) }).strict()
export const usageSchema = z.object({ recordVersion: z.literal('animalge.usage/v1'), accountedBytes: safeInteger, recordCount: safeInteger, recountedAt: safeInteger }).strict()

/** --- SPEC-02 material owner records --- */

export const artifactRecordSchema = z.object({
  recordVersion: z.literal('animalge.artifact/v1'),
  artifactId: artifactIdSchema,
  createdAt: safeInteger,
  createdBy: z.enum(['runner_output', 'runner_input', 'runner_log', 'runner_code', 'explicit_registration']),
}).strict() as unknown as z.ZodType<ArtifactRecordV1>

export const artifactVersionCoreSchema = z.object({
  recordVersion: z.literal('animalge.artifact-version/v1'),
  artifactId: artifactIdSchema,
  artifactVersionId: artifactVersionIdSchema,
  contentDigest: sha256DigestSchema,
  byteLength: safeInteger,
  mediaType: z.string().min(1),
  retention: z.literal('reference'),
  parentVersionId: artifactVersionIdSchema.nullable(),
  supersedesReason: z.enum(['content_change', 'explicit_commit', 'restore_as_new']).nullable(),
  createdAt: safeInteger,
  createdBy: z.enum(['runner_output', 'runner_input', 'runner_log', 'runner_code', 'explicit_registration']),
}).strict() as unknown as z.ZodType<ArtifactVersionCoreV1>

export const locationObservationSchema = z.object({
  recordVersion: z.literal('animalge.location-observation/v1'),
  locationObservationId: locationObservationIdSchema,
  artifactVersionId: artifactVersionIdSchema,
  locator: z.string().min(1),
  availability: z.enum(['available', 'missing']),
  integrity: z.enum(['matched', 'content_mismatch', 'not_checked', 'integrity_unknown']),
  observedAt: safeInteger,
  freshnessToken: z.string().nullable(),
  continuityBasis: z.enum(['provider_verified', 'explicit_registration']).nullable(),
  observationBasis: z.enum(['full_sha256', 'freshness_reuse', 'no_read']),
}).strict() as unknown as z.ZodType<LocationAvailabilityObservationV1>

export const contextEntitySchema = z.object({
  recordVersion: z.literal('animalge.context-entity/v1'),
  contextEntityId: contextEntityIdSchema,
  contextKind: z.enum(['software', 'environment', 'parameter_set']),
  identity: z.object({ name: z.string().min(1), version: z.string().min(1).nullable() }).strict(),
  canonicalDigest: sha256DigestSchema.nullable(),
  payload: z.json(),
}).strict() as unknown as z.ZodType<ContextEntityRecordV1>

export const sourceAnchorSchema = z.object({
  recordVersion: z.literal('animalge.source-anchor/v1'),
  anchorId: sourceAnchorIdSchema,
  sourceVersionRef: artifactVersionIdSchema,
  sourceKind: z.enum(['text', 'csv_table', 'pdf', 'html', 'code', 'dataset']),
  selector: z.json(),
  verifierRevision: z.string().min(1),
  selectedDigest: sha256DigestSchema.nullable(),
  lastVerification: z.object({ code: z.string().min(1), verifiedAt: safeInteger }).strict().nullable(),
}).strict() as unknown as z.ZodType<SourceAnchorRecordV1>

export const receiptSubmissionSchema = z.object({
  recordVersion: z.literal('animalge.receipt-submission/v1'),
  receiptId: receiptSubmissionIdSchema,
  receiptSchemaRevision: z.literal('animalge.evidence.receipt/v1'),
  submissionDigest: sha256DigestSchema,
  submittedAt: safeInteger,
  providerId: z.string().min(1),
  providerVersion: z.string().min(1),
  captureProfileId: z.string().min(1),
  captureProfileRevision: z.string().min(1),
  evidenceGraphId: evidenceGraphIdSchema,
  sessionId: sessionIdSchema,
  runId: evidenceRunIdSchema,
  invocationBasis: runnerInvocationBasisSchema,
  expectedResultLocator: z.object({ sessionId: sessionIdSchema, callId: callIdSchema }).strict(),
  operation: z.object({ toolName: z.string().min(1), languageProfile: z.string().min(1) }).strict(),
  invocationDigest: sha256DigestSchema,
  lifecycle: z.object({ startedAt: safeInteger.nullable(), endedAt: safeInteger }).strict(),
  outcome: runnerOutcomeSchema,
  components: receiptComponentsSchema,
  extensions: z.array(z.object({
    namespace: z.string().min(1),
    schemaId: z.string().min(1),
    revision: z.string().min(1),
    payload: z.json(),
  }).strict()),
}).strict() as unknown as z.ZodType<EvidenceRunReceiptSubmissionV1>

export const receiptAcceptanceSchema = z.object({
  recordVersion: z.literal('animalge.receipt-acceptance/v1'),
  acceptanceId: receiptAcceptanceIdSchema,
  receiptId: receiptSubmissionIdSchema,
  submissionDigest: sha256DigestSchema,
  acceptedAt: safeInteger,
  pairedStartRef: sessionEventRefSchema,
  pairedResultRef: sessionEventRefSchema,
  acceptanceDigest: sha256DigestSchema,
  verdict: z.enum(['accepted', 'rejected']),
  rejectedReason: z.string().min(1).nullable(),
  componentVerdicts: z.object({
    inputs: z.enum(['verified', 'failed', 'not_applicable']),
    outputs: z.enum(['verified', 'failed', 'not_applicable']),
    softwareAndCode: z.enum(['verified', 'failed', 'not_applicable']),
    environment: z.enum(['verified', 'failed', 'not_applicable']),
    parameters: z.enum(['verified', 'failed', 'not_applicable']),
    randomness: z.enum(['verified', 'failed', 'not_applicable']),
    logs: z.enum(['verified', 'failed', 'not_applicable']),
  }).strict(),
  receiptAcceptance: z.enum(['accepted', 'rejected']),
}).strict() as unknown as z.ZodType<ReceiptAcceptanceRecordV1>

export const receiptLaneSchema = z.object({
  recordVersion: z.literal('animalge.receipt-lane/v1'),
  sessionId: sessionIdSchema,
  nextSeqExclusive: safeInteger,
  pendingSubmissions: z.array(receiptSubmissionIdSchema),
  updatedAt: safeInteger,
}).strict() as unknown as z.ZodType<ReceiptLaneV1>

export interface SessionGraphBootstrap {
  readonly recordVersion: 'animalge.session-graph-bootstrap/v1'
  readonly sessionId: SessionId
  readonly sessionCreatedAt: number
  readonly graphId: EvidenceGraphIdType
  readonly initialScope: import('./types.ts').EvidenceGraphScopeV1
  readonly state: 'initializing' | 'ready'
}
export interface GraphRecord {
  readonly recordVersion: 'animalge.evidence-graph/v1'
  readonly scope: import('./types.ts').EvidenceGraphScopeV1
  readonly status: 'ready' | 'bootstrap_corrupt' | 'unavailable'
}
export type CapturedInvocation = z.infer<typeof capturedInvocationSchema>
export type CompileOutbox = z.infer<typeof compileOutboxSchema>
export type CompileAttempt = z.infer<typeof compileAttemptSchema>
export type StagingRecord = z.infer<typeof stagingRecordSchema>
export type HeadCommit = z.infer<typeof headCommitSchema>
export type QuarantineRecord = z.infer<typeof quarantineRecordSchema>
export type QueueClock = z.infer<typeof queueClockSchema>
export type UsageRecord = z.infer<typeof usageSchema>
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>
export type ArtifactVersionCore = z.infer<typeof artifactVersionCoreSchema>
export type LocationObservation = z.infer<typeof locationObservationSchema>
export type ContextEntityRecord = z.infer<typeof contextEntitySchema>
export type SourceAnchorRecord = z.infer<typeof sourceAnchorSchema>
export type ReceiptSubmission = z.infer<typeof receiptSubmissionSchema>
export type ReceiptAcceptanceRecord = z.infer<typeof receiptAcceptanceSchema>
export type ReceiptLaneRecord = z.infer<typeof receiptLaneSchema>

export type ControlIds = EvidenceGraphIdType | CompileAttemptIdType | StagingIdType | RecoveryIdType
