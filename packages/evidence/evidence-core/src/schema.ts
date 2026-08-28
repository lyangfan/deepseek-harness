/** Strict runtime schemas for public Evidence values and durable control records. */

import { z } from 'zod'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { ArtifactId, ArtifactVersionId, CandidateStatementId, CompileAttemptId, ContextEntityId, EvidenceEdgeId, EvidenceGraphId, EvidenceNodeId, EvidenceRunId, InputBundleId, LocationObservationId, ModelCallId, ObservationId, OutputFinalizationId, OutputManifestId, OutputPlanId, OutputReservationId, PreflightReportId, ReceiptAcceptanceId, ReceiptSubmissionId, RecoveryId, SourceAnchorId, StagingId, TestedEnvironmentRevisionId } from './identity.ts'
import type { ArtifactRecordV1, ArtifactVersionCoreV1, CandidateRecordV1, CandidateRelationRecordV1, CompileAttemptId as CompileAttemptIdType, ContextEntityRecordV1, CurrentHeadV1, EnvironmentStateV1, EvidenceEdgeV1, EvidenceGraphId as EvidenceGraphIdType, EvidenceNodeV1, EvidenceRunReceiptSubmissionV1, EvidenceSnapshotPayloadV1, InputBundleV1, LocationAvailabilityObservationV1, ModelCallRecordV1, ModelRunSelectionRecordV1, OutputFinalizationRecordV1, OutputManifestV1, OutputPlanV1, OutputReservationV1, PreflightReportV1, ProposalValidationRecordV1, ReceiptAcceptanceRecordV1, ReceiptLaneV1, RecoveryId as RecoveryIdType, SemanticLaneV1, SemanticSwitchV1, Sha256Digest, SourceAnchorRecordV1, StagingId as StagingIdType, StoredSnapshotV1, TestedEnvironmentRevisionV1 } from './types.ts'

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
export const inputBundleIdSchema = z.string().transform(InputBundleId)
export const preflightReportIdSchema = z.string().transform(PreflightReportId)
export const testedEnvironmentRevisionIdSchema = z.string().transform(TestedEnvironmentRevisionId)
export const outputReservationIdSchema = z.string().transform(OutputReservationId)
export const outputPlanIdSchema = z.string().transform(OutputPlanId)
export const outputManifestIdSchema = z.string().transform(OutputManifestId)
export const outputFinalizationIdSchema = z.string().transform(OutputFinalizationId)
export const candidateStatementIdSchema = z.string().transform(CandidateStatementId)
export const modelCallIdSchema = z.string().transform(ModelCallId)
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
  operation: z.object({
    toolName: z.string().min(1),
    languageProfile: z.string().min(1).optional(),
    operationProfile: z.string().min(1).optional(),
  }).strict(),
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
  selectionBasis: z.union([
    z.object({ kind: z.literal('deterministic_rule'), ruleRevision: z.string().min(1), ruleDigest: sha256DigestSchema }).strict(),
    z.object({ kind: z.literal('model_candidate'), modelCallId: modelCallIdSchema, attemptId: compileAttemptIdSchema, modelRequestEventRef: sessionEventRefSchema }).strict(),
  ]),
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

/** Source binding of one candidate to its Agent-message span (SPEC-04 §8.3). */
export const agentMessageSourceBindingSchema = z.object({
  kind: z.literal('agent_message'),
  sessionId: sessionIdSchema,
  eventSeq: safeInteger,
  spanStart: safeInteger,
  spanEnd: safeInteger,
  spanTextDigest: sha256DigestSchema,
  actorRef: z.string().min(1),
}).strict()

/** Model generation provenance shared by candidate nodes and relation edges (SPEC-04 §8.3). */
export const candidateGenerationProvenanceSchema = z.object({
  modelCallId: modelCallIdSchema,
  modelRequestEventRef: sessionEventRefSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  extractorRevision: z.string().min(1),
  promptRevision: z.string().min(1),
  projectionDigest: sha256DigestSchema,
  attemptId: compileAttemptIdSchema,
}).strict()

/** Strict CandidateStatement node payload schema (SPEC-04 §8.3). */
export const candidateStatementNodePayloadSchema = z.object({
  candidateSchema: z.literal('animalge.candidate.statement/v1'),
  candidateId: candidateStatementIdSchema,
  subtype: z.enum(['hypothesis', 'interpretation', 'conclusion', 'limitation', 'statement']),
  text: z.string().min(1),
  sourceBinding: agentMessageSourceBindingSchema,
  generationProvenance: candidateGenerationProvenanceSchema,
  relationSummary: z.object({
    summary: z.enum(['no_active_evidence', 'support_only', 'contradiction_only', 'mixed']),
    activeSupports: safeInteger,
    activeContradicts: safeInteger,
    activeQualifies: safeInteger,
  }).strict(),
}).strict()

/** Strict Evidence Node schema, discriminated on payloadSchema (unique per kind and per Run capture basis). */
export const evidenceNodeSchema = z.discriminatedUnion('payloadSchema', [
  z.object({ ...nodeBase, nodeKind: z.literal('Run'), payloadSchema: z.literal('animalge.run.event-backed/v1'), payload: eventBackedRunPayloadSchema }).strict(),
  z.object({ ...nodeBase, nodeKind: z.literal('Run'), payloadSchema: z.literal('animalge.run.receipt-backed/v1'), payload: receiptBackedRunPayloadSchema }).strict(),
  z.object({ ...nodeBase, nodeKind: z.literal('Observation'), payloadSchema: z.literal('animalge.observation.tool-result/v1'), payload: toolResultObservationPayloadSchema }).strict(),
  z.object({ ...nodeBase, nodeKind: z.literal('ArtifactVersion'), payloadSchema: z.literal('animalge.artifact.version-node/v1'), payload: artifactVersionNodePayloadSchema }).strict(),
  z.object({ ...nodeBase, nodeKind: z.literal('ContextEntity'), payloadSchema: z.literal('animalge.context.entity-node/v1'), payload: contextEntityNodePayloadSchema }).strict(),
  z.object({ ...nodeBase, nodeKind: z.literal('CandidateStatement'), payloadSchema: z.literal('animalge.candidate.statement/v1'), payload: candidateStatementNodePayloadSchema }).strict(),
]) as unknown as z.ZodType<EvidenceNodeV1>

/** Deterministic-family edge base: provenance edges never carry model provenance (SPEC-04 §10.2-3). */
const deterministicEdgeBase = {
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
}

/** Candidate-family edges always carry model generation provenance (SPEC-04 §10.2-3). */
const candidateEdgeSchema = z.object({
  schemaVersion: z.literal('animalge.evidence.edge/v1'),
  edgeId: evidenceEdgeIdSchema,
  graphId: evidenceGraphIdSchema,
  edgeType: z.enum(['supports', 'qualifies', 'contradicts', 'same_as_candidate']),
  family: z.enum(['scientific_argument', 'conflict_candidate_identity']),
  from: evidenceNodeIdSchema,
  to: evidenceNodeIdSchema,
  projectionState: z.enum(['active', 'diagnostic', 'excluded']),
  sourceEventRefs: z.array(sessionEventRefSchema),
  compiler: compilerProvenanceSchema,
  relation: candidateGenerationProvenanceSchema,
}).strict()

/** Strict Edge schema: closed union of the deterministic and candidate families. */
export const evidenceEdgeSchema = z.union([
  z.object(deterministicEdgeBase).strict(),
  candidateEdgeSchema,
]) as unknown as z.ZodType<EvidenceEdgeV1>

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
  z.object({
    canonicalization: z.literal('animalge-c14n-json/v1'),
    identity: z.literal('animalge-identity/v1'),
    compiler: z.string().min(1),
    captureContract: z.literal('animalge-capture/v1'),
    selectionRuleDigest: sha256DigestSchema,
    materialContract: z.literal('animalge-material/v1'),
    candidateContract: z.literal('animalge-candidate/v1'),
  }).strict(),
])

/** Snapshot schema set: core-only legacy (SPEC-01), the material pair (SPEC-02), the candidate triple (SPEC-04 §10.2-3). */
export const evidenceSchemaSetSchema = z.union([
  z.tuple([z.literal('animalge.evidence.core/v1')]),
  z.tuple([z.literal('animalge.evidence.core/v1'), z.literal('animalge.evidence.material/v1')]),
  z.tuple([z.literal('animalge.evidence.core/v1'), z.literal('animalge.evidence.material/v1'), z.literal('animalge.evidence.candidate/v1')]),
])

/**
 * Semantic watermark: the tri-state tagged union plus the untagged SPEC-01/02 legacy form
 * (SPEC-04 §9.6/§10.2-4). Integrity enforces: legacy form only on non-candidate schemaSets
 * and only at zero; candidate schemaSets require a tagged form.
 */
export const semanticWatermarkSchema = z.union([
  z.object({ kind: z.literal('active'), nextSeqExclusive: safeInteger }).strict(),
  z.object({ kind: z.literal('disabled'), lastNextSeqExclusive: safeInteger }).strict(),
  z.object({ kind: z.literal('not_configured') }).strict(),
  z.object({ nextSeqExclusive: safeInteger }).strict(),
])

/** Strict immutable Evidence Snapshot payload schema. */
export const evidenceSnapshotPayloadSchema = z.object({
  format: z.literal('animalge.evidence.snapshot/v1'),
  scope: evidenceGraphScopeSchema,
  schemaSet: evidenceSchemaSetSchema,
  revisions: snapshotRevisionsSchema,
  baseSnapshotDigest: sha256DigestSchema.nullable(),
  deterministicWatermark: z.object({ nextSeqExclusive: safeInteger }).strict(),
  semanticWatermark: semanticWatermarkSchema,
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
    semantic_ready: safeInteger.optional(),
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
  /** SPEC-04 §10.2-5 additive diff: compile channel; absent means 'deterministic' (legacy rows unchanged). */
  channel: z.enum(['deterministic', 'semantic']).optional(),
  /** Semantic-attempt provenance block (SPEC-04 §9.2); present only on channel='semantic' attempts. */
  semantic: z.object({
    modelCallId: modelCallIdSchema.nullable(),
    modelRequestEventRef: sessionEventRefSchema.nullable(),
    projectionDigest: sha256DigestSchema.nullable(),
    extractorRevision: z.string().min(1),
    promptRevision: z.string().min(1),
    outputDigest: sha256DigestSchema.nullable(),
  }).strict().optional(),
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
  operation: z.object({
    toolName: z.string().min(1),
    languageProfile: z.string().min(1).optional(),
    operationProfile: z.string().min(1).optional(),
  }).strict(),
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

/** --- SPEC-03 professional-layer owner records --- */

export const inputBundleSchema = z.object({
  recordVersion: z.literal('animalge.input-bundle/v1'),
  bundleId: inputBundleIdSchema,
  bundleKind: z.string().min(1),
  schemaRevision: z.string().min(1),
  components: z.array(z.object({
    role: z.string().min(1),
    locator: z.string().min(1),
    artifactVersionId: artifactVersionIdSchema,
    observationId: locationObservationIdSchema,
    captureBasis: z.enum(['full_sha256', 'freshness_reuse']),
  }).strict()),
  bundleDigest: sha256DigestSchema,
  createdAt: safeInteger,
}).strict() as unknown as z.ZodType<InputBundleV1>

export const preflightReportSchema = z.object({
  recordVersion: z.literal('animalge.preflight-report/v1'),
  reportId: preflightReportIdSchema,
  profileIdentity: z.object({ contractId: z.string().min(1), revision: z.string().min(1) }).strict(),
  softwareVersion: z.string().min(1).nullable(),
  inputBundleRef: inputBundleIdSchema,
  coverage: z.enum(['operation_profile', 'baseline_only']),
  status: z.enum(['incompatible', 'needs_clarification', 'ready_with_warnings', 'ready']),
  checks: z.array(z.object({
    checkId: z.string().min(1),
    severity: z.enum(['incompatible', 'needs_clarification', 'warning']),
    result: z.enum(['pass', 'fail', 'clarify']),
    observed: z.json().nullable(),
  }).strict()),
  coverageGaps: z.array(z.string().min(1)),
  warnings: z.array(z.object({ code: z.string().min(1), detail: z.string().min(1) }).strict()),
  clarification: z.object({ question: z.string().min(1), candidates: z.json() }).strict().nullable(),
  computedAt: safeInteger,
  reportDigest: sha256DigestSchema,
}).strict() as unknown as z.ZodType<PreflightReportV1>

const probeObservationSchema = z.object({
  component: z.string().min(1),
  resolvedPath: z.string().min(1),
  executableDigest: sha256DigestSchema,
  versionOutput: z.string(),
  parsedVersion: z.string().min(1).nullable(),
  observedAt: safeInteger,
}).strict()

export const testedEnvironmentRevisionSchema = z.object({
  recordVersion: z.literal('animalge.tested-environment/v1'),
  revisionId: testedEnvironmentRevisionIdSchema,
  environmentSpecRevision: z.string().min(1),
  platform: z.object({ os: z.string().min(1), arch: z.string().min(1) }).strict(),
  components: z.array(z.object({
    name: z.string().min(1),
    kind: z.enum(['executable', 'r_package', 'conda_package']),
    identity: z.object({
      version: z.string().min(1),
      digest: sha256DigestSchema,
      sourceRef: z.string().min(1).nullable(),
    }).strict(),
    resolvedPath: z.string().min(1),
  }).strict()),
  inputSchemaRevisions: z.array(z.string().min(1)),
  frozenAt: safeInteger,
  frozenFromProbe: z.array(probeObservationSchema),
}).strict() as unknown as z.ZodType<TestedEnvironmentRevisionV1>

export const environmentStateSchema = z.object({
  recordVersion: z.literal('animalge.environment-state/v1'),
  currentRevisionId: testedEnvironmentRevisionIdSchema.nullable(),
  updatedAt: safeInteger,
}).strict() as unknown as z.ZodType<EnvironmentStateV1>

export const outputReservationSchema = z.object({
  recordVersion: z.literal('animalge.output-reservation/v1'),
  reservationId: outputReservationIdSchema,
  runId: evidenceRunIdSchema,
  attempt: safeInteger.min(1),
  kind: z.enum(['run_exclusive_dir', 'user_specified']),
  boundary: z.object({
    rootDir: z.string().min(1),
    entries: z.array(z.string().min(1)),
    prefixes: z.array(z.string().min(1)),
  }).strict(),
  state: z.enum(['active', 'released', 'abandoned']),
  createdAt: safeInteger,
  releasedAt: safeInteger.nullable(),
  releaseBasis: z.enum(['completed', 'failed', 'cancelled_confirmed']).nullable(),
}).strict() as unknown as z.ZodType<OutputReservationV1>

export const outputPlanSchema = z.object({
  recordVersion: z.literal('animalge.output-plan/v1'),
  planId: outputPlanIdSchema,
  runId: evidenceRunIdSchema,
  planRevision: z.string().min(1),
  generatedByHook: z.string().min(1),
  roles: z.array(z.object({
    role: z.string().min(1),
    pathRule: z.object({ kind: z.enum(['exact', 'prefix']), value: z.string().min(1) }).strict(),
    required: z.boolean(),
    cardinality: z.enum(['one', 'many']),
    bundle: z.string().min(1).nullable(),
    validator: z.string().min(1),
  }).strict()),
  bundles: z.array(z.object({
    bundleName: z.string().min(1),
    requiredRoles: z.array(z.string().min(1)),
  }).strict()),
  createdAt: safeInteger,
}).strict() as unknown as z.ZodType<OutputPlanV1>

const boundaryObservationSchema = z.object({
  locator: z.string().min(1),
  fileType: z.string().min(1).nullable(),
  byteLength: safeInteger,
  observedAt: safeInteger,
  observationBasis: z.literal('boundary_scan'),
}).strict()

const formalOutputSchema = z.object({
  role: z.string().min(1),
  locator: z.string().min(1),
  artifactVersionId: artifactVersionIdSchema,
  contentDigest: sha256DigestSchema,
  byteLength: safeInteger,
  captureBasis: z.literal('provider_verified'),
  validatorResult: z.object({ validator: z.string().min(1), passed: z.boolean() }).strict(),
  bundle: z.string().min(1).nullable(),
  disposition: z.enum(['finalized', 'residual_integrity_unknown']).nullable(),
}).strict()

export const outputManifestSchema = z.object({
  recordVersion: z.literal('animalge.output-manifest/v1'),
  manifestId: outputManifestIdSchema,
  kind: z.enum(['formal', 'diagnostic']),
  reason: z.literal('output_plan_absent').nullable(),
  runId: evidenceRunIdSchema,
  attempt: safeInteger.min(1),
  reservationId: outputReservationIdSchema,
  outputPlanId: outputPlanIdSchema.nullable(),
  formalOutputs: z.array(formalOutputSchema),
  unclassifiedBoundaryObservations: z.array(boundaryObservationSchema),
  generatedAt: safeInteger,
  manifestDigest: sha256DigestSchema,
}).strict() as unknown as z.ZodType<OutputManifestV1>

export const outputFinalizationSchema = z.object({
  recordVersion: z.literal('animalge.output-finalization/v1'),
  finalizationId: outputFinalizationIdSchema,
  runId: evidenceRunIdSchema,
  attempt: safeInteger.min(1),
  manifestId: outputManifestIdSchema,
  manifestDigest: sha256DigestSchema,
  finalizedRoles: z.array(z.string().min(1)),
  finalizedAt: safeInteger,
  finalizationDigest: sha256DigestSchema,
}).strict() as unknown as z.ZodType<OutputFinalizationRecordV1>

/** --- SPEC-04 candidate-semantics owner records --- */

export const semanticLaneSchema = z.object({
  recordVersion: z.literal('animalge.semantic-lane/v1'),
  graphId: evidenceGraphIdSchema,
  nextSeqExclusive: safeInteger,
  updatedAt: safeInteger,
}).strict() as unknown as z.ZodType<SemanticLaneV1>

export const semanticSwitchSchema = z.object({
  recordVersion: z.literal('animalge.semantic-switch/v1'),
  graphId: evidenceGraphIdSchema,
  enabled: z.boolean(),
  updatedAt: safeInteger,
}).strict() as unknown as z.ZodType<SemanticSwitchV1>

export const modelCallSchema = z.object({
  recordVersion: z.literal('animalge.model-call/v1'),
  modelCallId: modelCallIdSchema,
  graphId: evidenceGraphIdSchema,
  attemptId: compileAttemptIdSchema,
  purpose: z.literal('candidate-semantics'),
  provider: z.string().min(1),
  model: z.string().min(1),
  generationConfig: z.json(),
  requestEventRef: sessionEventRefSchema.nullable(),
  startedAt: safeInteger,
  endedAt: safeInteger,
  outcome: z.enum(['succeeded', 'aborted', 'timed_out', 'failed']),
  errorDigest: z.string().min(1).nullable(),
  usage: z.json().nullable(),
  acceptedOutputDigest: sha256DigestSchema.nullable(),
}).strict() as unknown as z.ZodType<ModelCallRecordV1>

export const candidateRecordSchema = z.object({
  recordVersion: z.literal('animalge.candidate/v1'),
  candidateId: candidateStatementIdSchema,
  graphId: evidenceGraphIdSchema,
  subtype: z.enum(['hypothesis', 'interpretation', 'conclusion', 'limitation', 'statement']),
  text: z.string().min(1),
  sourceBinding: agentMessageSourceBindingSchema,
  sourceEventRef: sessionEventRefSchema,
  generationProvenance: candidateGenerationProvenanceSchema,
  acceptedAt: safeInteger,
  acceptedAttemptId: compileAttemptIdSchema,
}).strict() as unknown as z.ZodType<CandidateRecordV1>

export const candidateRelationRecordSchema = z.object({
  recordVersion: z.literal('animalge.candidate-relation/v1'),
  edgeId: evidenceEdgeIdSchema,
  graphId: evidenceGraphIdSchema,
  edgeType: z.enum(['supports', 'qualifies', 'contradicts', 'same_as_candidate']),
  fromNodeId: evidenceNodeIdSchema,
  toNodeId: evidenceNodeIdSchema,
  provenance: candidateGenerationProvenanceSchema,
  createdAt: safeInteger,
  acceptedAttemptId: compileAttemptIdSchema,
}).strict() as unknown as z.ZodType<CandidateRelationRecordV1>

export const modelRunSelectionSchema = z.object({
  recordVersion: z.literal('animalge.model-run-selection/v1'),
  runId: evidenceRunIdSchema,
  graphId: evidenceGraphIdSchema,
  modelCallId: modelCallIdSchema,
  attemptId: compileAttemptIdSchema,
  modelRequestEventRef: sessionEventRefSchema,
  reason: z.string(),
  createdAt: safeInteger,
}).strict() as unknown as z.ZodType<ModelRunSelectionRecordV1>

export const proposalValidationSchema = z.object({
  recordVersion: z.literal('animalge.proposal-validation/v1'),
  fingerprint: z.string().min(1),
  graphId: evidenceGraphIdSchema,
  attemptId: compileAttemptIdSchema,
  verdict: z.enum(['accepted', 'rejected']),
  rejectCode: z.string().min(1).nullable(),
  summary: z.json(),
  recordedAt: safeInteger,
}).strict() as unknown as z.ZodType<ProposalValidationRecordV1>

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
export type PreflightReportRecord = z.infer<typeof preflightReportSchema>
export type EnvironmentStateRecord = z.infer<typeof environmentStateSchema>
export type SemanticLaneRecord = z.infer<typeof semanticLaneSchema>
export type SemanticSwitchRecord = z.infer<typeof semanticSwitchSchema>
export type ModelCallRecord = z.infer<typeof modelCallSchema>
export type CandidateRecord = z.infer<typeof candidateRecordSchema>
export type CandidateRelationRecord = z.infer<typeof candidateRelationRecordSchema>
export type ModelRunSelectionRecord = z.infer<typeof modelRunSelectionSchema>
export type ProposalValidationRecord = z.infer<typeof proposalValidationSchema>

export type ControlIds = EvidenceGraphIdType | CompileAttemptIdType | StagingIdType | RecoveryIdType
