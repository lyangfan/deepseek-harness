/** Strict runtime schemas for public Evidence values and durable control records. */

import { z } from 'zod'
import type { CallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import { CompileAttemptId, EvidenceEdgeId, EvidenceGraphId, EvidenceNodeId, EvidenceRunId, ObservationId, RecoveryId, StagingId } from './identity.ts'
import type { CompileAttemptId as CompileAttemptIdType, CurrentHeadV1, EvidenceEdgeV1, EvidenceGraphId as EvidenceGraphIdType, EvidenceNodeV1, EvidenceSnapshotPayloadV1, RecoveryId as RecoveryIdType, Sha256Digest, StagingId as StagingIdType, StoredSnapshotV1 } from './types.ts'

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

/** Strict Run-or-Observation Evidence Node schema. */
export const evidenceNodeSchema = z.discriminatedUnion('nodeKind', [
  z.object({ ...nodeBase, nodeKind: z.literal('Run'), payloadSchema: z.literal('animalge.run.event-backed/v1'), payload: eventBackedRunPayloadSchema }).strict(),
  z.object({ ...nodeBase, nodeKind: z.literal('Observation'), payloadSchema: z.literal('animalge.observation.tool-result/v1'), payload: toolResultObservationPayloadSchema }).strict(),
]) as unknown as z.ZodType<EvidenceNodeV1>

/** Strict deterministic provenance Edge schema. */
export const evidenceEdgeSchema = z.object({
  schemaVersion: z.literal('animalge.evidence.edge/v1'),
  edgeId: evidenceEdgeIdSchema,
  graphId: evidenceGraphIdSchema,
  edgeType: z.enum(['generated_by', 'part_of']),
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

export const snapshotRevisionsSchema = z.object({
  canonicalization: z.literal('animalge-c14n-json/v1'),
  identity: z.literal('animalge-identity/v1'),
  compiler: z.string().min(1),
  captureContract: z.literal('animalge-capture/v1'),
  selectionRuleDigest: sha256DigestSchema,
}).strict()

/** Strict immutable Evidence Snapshot payload schema. */
export const evidenceSnapshotPayloadSchema = z.object({
  format: z.literal('animalge.evidence.snapshot/v1'),
  scope: evidenceGraphScopeSchema,
  schemaSet: z.tuple([z.literal('animalge.evidence.core/v1')]),
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

export type ControlIds = EvidenceGraphIdType | CompileAttemptIdType | StagingIdType | RecoveryIdType
