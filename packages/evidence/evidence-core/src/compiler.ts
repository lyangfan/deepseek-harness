/** Deterministic no-LLM fold from terminal captures to one immutable Snapshot payload. */

import { deriveEdgeId, deriveNodeId, deriveObservationId } from './identity.ts'
import { MATERIAL_CONTRACT_REVISION, materialProjection, receiptBackedPayload } from './materialize.ts'
import type { MaterialSnapshot } from './materialize.ts'
import { CANDIDATE_CONTRACT_REVISION, candidateProjection } from './semantic/candidates.ts'
import type { SemanticSnapshot } from './semantic/candidates.ts'
import type { CapturedInvocation } from './schema.ts'
import type { DeterministicCompilerProvenanceV1, EvidenceEdgeV1, EvidenceGraphScopeV1, EvidenceNodeV1, EvidenceSnapshotPayloadV1, EventBackedRunPayloadV1, ModelCandidateSelectionV1, Sha256Digest, ToolResultObservationPayloadV1 } from './types.ts'
import { verifySnapshot } from './integrity.ts'

export const COMPILER_REVISION = 'animalge-deterministic-compiler/v1'

function refs(capture: CapturedInvocation) {
  const values = capture.basis.kind === 'top_level_tool'
    ? [capture.basis.callEvent, capture.basis.resultEvent]
    : capture.basis.kind === 'top_level_not_started'
      ? [capture.basis.assistantEvent, capture.basis.resultEvent]
      : [capture.basis.startEvent, capture.basis.resultEvent]
  return values.toSorted((left, right) => left.seq - right.seq
    || left.eventType.localeCompare(right.eventType)
    || left.eventDigest.localeCompare(right.eventDigest))
}

function runPayload(capture: CapturedInvocation, revision: string, ruleDigest: Sha256Digest,
  modelSelection: ModelCandidateSelectionV1 | undefined): EventBackedRunPayloadV1 {
  const start = capture.basis.kind === 'top_level_tool' ? capture.basis.callEvent.seq : capture.basis.kind === 'top_level_not_started' ? capture.basis.assistantEvent.seq : capture.basis.startEvent.seq
  const end = capture.basis.resultEvent.seq
  const primaryCallId = capture.basis.kind === 'code_mode_dispatch' ? capture.basis.subCallId : capture.basis.callId
  return {
    runSchema: 'animalge.run.event-backed/v1', runId: capture.runId, runKind: 'tool', operation: { toolName: capture.toolName }, primaryCallId,
    invocationDigest: capture.invocationDigest, eventBasis: capture.basis, captureKind: 'event', providerId: 'dsh-session-log',
    providerVersion: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e', receiptDigest: null, captureContractRevision: 'animalge-capture/v1',
    eventSeqRange: { startInclusive: start, endInclusive: end }, actorRefs: [],
    // SPEC-04 §8.4: receipt_auto > deterministic_rule > model_candidate; a model proposal only
    // selects an otherwise unselected capture and never rewrites its capture facts.
    selectionBasis: modelSelection ?? { kind: 'deterministic_rule', ruleRevision: revision, ruleDigest }, startedAt: capture.startedAt, endedAt: capture.endedAt,
    outcome: capture.outcome,
    components: { inputs: 'missing', outputs: capture.outcome === 'not_started' ? 'not_applicable' : 'missing', softwareAndCode: 'missing', environment: 'missing', parameters: 'missing', randomness: 'missing', logs: 'missing' },
  }
}

/** Compile selected captures through a frozen target into a validated canonical Snapshot. */
export function compileSnapshot(options: {
  readonly scope: EvidenceGraphScopeV1
  readonly captures: readonly CapturedInvocation[]
  readonly baseSnapshotDigest: Sha256Digest | null
  readonly targetNextSeqExclusive: number
  readonly sourceTimeUpperBound: number | null
  readonly selectionRevision: string
  readonly selectionRuleDigest: Sha256Digest
  /** SPEC-02 §8: frozen store material state; absent input compiles the legacy core-only Snapshot. */
  readonly material?: MaterialSnapshot
  /**
   * SPEC-04 §8.4: frozen candidate ledger state plus the tagged semantic watermark. Present
   * whenever the semantic layer is configured — including disabled and empty ledgers — which
   * upgrades the schemaSet to the candidate triple; absent input keeps legacy bytes unchanged.
   */
  readonly semantic?: {
    readonly ledger: SemanticSnapshot
    readonly watermark: { readonly kind: 'active'; readonly nextSeqExclusive: number } | { readonly kind: 'disabled'; readonly lastNextSeqExclusive: number } | { readonly kind: 'not_configured' }
  }
}): EvidenceSnapshotPayloadV1 {
  const compiler: DeterministicCompilerProvenanceV1 = { compilerRevision: COMPILER_REVISION, captureContractRevision: 'animalge-capture/v1', selectionRuleDigest: options.selectionRuleDigest }
  const material = options.material
  const semantic = options.semantic
  // The candidate schemaSet triple and its revisions variant require the material contract
  // alongside the candidate contract (§10.2-3); the runtime always freezes both together.
  if (semantic !== undefined && material === undefined) throw new TypeError('compileSnapshot: the candidate layer requires the frozen material snapshot')
  const nodes: EvidenceNodeV1[] = []
  const edges: EvidenceEdgeV1[] = []
  // §8.2: receipt_auto selection takes precedence over the deterministic rule; runs without an
  // accepted receipt keep their SPEC-01 event path unchanged. SPEC-04 §8.4 adds model_candidate
  // as the weakest source: it only selects captures no stronger basis already claimed.
  const selected = options.captures.filter(capture => (capture.selection === 'selected'
    || (material !== undefined && material.accepted.has(capture.runId))
    || (semantic !== undefined && semantic.ledger.runSelections.has(capture.runId)))
    && capture.basis.resultEvent.seq < options.targetNextSeqExclusive)
  const runNodes = new Map<string, EvidenceNodeV1 & { nodeKind: 'Run' }>()
  const captureByPrimary = new Map<string, CapturedInvocation>()
  for (const capture of selected) {
    const materialEntry = material === undefined ? undefined : material.accepted.get(capture.runId)
    const selectionRecord = semantic === undefined ? undefined : semantic.ledger.runSelections.get(capture.runId)
    const payload = materialEntry === undefined
      ? runPayload(capture, options.selectionRevision, options.selectionRuleDigest, selectionRecord === undefined ? undefined : {
        kind: 'model_candidate',
        modelCallId: selectionRecord.modelCallId,
        attemptId: selectionRecord.attemptId,
        modelRequestEventRef: selectionRecord.modelRequestEventRef,
      })
      : receiptBackedPayload({ capture, submission: materialEntry.submission, acceptance: materialEntry.acceptance })
    const payloadSchema = materialEntry === undefined ? 'animalge.run.event-backed/v1' as const : 'animalge.run.receipt-backed/v1' as const
    const nodeId = deriveNodeId({ graphId: options.scope.graphId, nodeKind: 'Run', runId: capture.runId })
    const run: EvidenceNodeV1 & { nodeKind: 'Run' } = { schemaVersion: 'animalge.evidence.node/v1', nodeId, graphId: options.scope.graphId, nodeKind: 'Run', payloadSchema, projectionState: 'active', identityRevision: 'animalge-identity/v1', sourceEventRefs: refs(capture), compiler, payload }
    nodes.push(run)
    runNodes.set(capture.runId, run)
    captureByPrimary.set(String(payload.primaryCallId), capture)
    const observationId = deriveObservationId({ graphId: options.scope.graphId, observationKind: 'run_terminal_outcome', runId: capture.runId, resultEventSeq: capture.basis.resultEvent.seq })
    const observationPayload: ToolResultObservationPayloadV1 = {
      observationSchema: 'animalge.observation.tool-result/v1', observationId, observationKind: 'run_terminal_outcome', runId: capture.runId,
      outcome: capture.outcome, resultContentDigest: capture.resultContentDigest, resultBlockCount: capture.resultBlockCount,
      ...(capture.errorIdentity === undefined ? {} : { errorIdentity: capture.errorIdentity }),
    }
    const observationNodeId = deriveNodeId({ graphId: options.scope.graphId, nodeKind: 'Observation', observationId })
    const observation: EvidenceNodeV1 = { schemaVersion: 'animalge.evidence.node/v1', nodeId: observationNodeId, graphId: options.scope.graphId, nodeKind: 'Observation', payloadSchema: 'animalge.observation.tool-result/v1', projectionState: 'active', identityRevision: 'animalge-identity/v1', sourceEventRefs: refs(capture), compiler, payload: observationPayload }
    nodes.push(observation)
    edges.push({ schemaVersion: 'animalge.evidence.edge/v1', edgeId: deriveEdgeId({ graphId: options.scope.graphId, edgeType: 'generated_by', from: observationNodeId, to: nodeId }), graphId: options.scope.graphId, edgeType: 'generated_by', family: 'deterministic_provenance', from: observationNodeId, to: nodeId, projectionState: 'active', sourceEventRefs: refs(capture), compiler })
    if (materialEntry !== undefined && material !== undefined) {
      const projection = materialProjection({ graphId: options.scope.graphId, runNodeId: nodeId, refs: refs(capture), compiler,
        submission: materialEntry.submission, material })
      nodes.push(...projection.nodes)
      edges.push(...projection.edges)
    }
  }
  for (const capture of selected) {
    if (capture.basis.kind !== 'code_mode_dispatch') continue
    const parentCapture = captureByPrimary.get(String(capture.basis.parentCallId))
    const childNode = runNodes.get(capture.runId)
    const parentNode = parentCapture === undefined ? undefined : runNodes.get(parentCapture.runId)
    if (childNode === undefined || parentNode === undefined) continue
    edges.push({ schemaVersion: 'animalge.evidence.edge/v1', edgeId: deriveEdgeId({ graphId: options.scope.graphId, edgeType: 'part_of', from: childNode.nodeId, to: parentNode.nodeId }), graphId: options.scope.graphId, edgeType: 'part_of', family: 'deterministic_provenance', from: childNode.nodeId, to: parentNode.nodeId, projectionState: 'active', sourceEventRefs: refs(capture), compiler })
  }
  if (semantic !== undefined) {
    // SPEC-04 §8.3: the frozen candidate ledger projects into nodes/edges with derived
    // relation summaries; the snapshot write path consumes ledgers only (§11.2 constraint).
    const projection = candidateProjection({ scope: options.scope, ledger: semantic.ledger, compiler })
    nodes.push(...projection.nodes)
    edges.push(...projection.edges)
  }
  nodes.sort((left, right) => left.nodeId.localeCompare(right.nodeId))
  edges.sort((left, right) => left.edgeId.localeCompare(right.edgeId))
  const payload: EvidenceSnapshotPayloadV1 = {
    format: 'animalge.evidence.snapshot/v1', scope: options.scope,
    schemaSet: semantic !== undefined
      ? ['animalge.evidence.core/v1', 'animalge.evidence.material/v1', 'animalge.evidence.candidate/v1']
      : material === undefined
        ? ['animalge.evidence.core/v1']
        : ['animalge.evidence.core/v1', 'animalge.evidence.material/v1'],
    revisions: semantic !== undefined
      ? { canonicalization: 'animalge-c14n-json/v1', identity: 'animalge-identity/v1', compiler: COMPILER_REVISION, captureContract: 'animalge-capture/v1', selectionRuleDigest: options.selectionRuleDigest, materialContract: MATERIAL_CONTRACT_REVISION, candidateContract: CANDIDATE_CONTRACT_REVISION }
      : material === undefined
        ? { canonicalization: 'animalge-c14n-json/v1', identity: 'animalge-identity/v1', compiler: COMPILER_REVISION, captureContract: 'animalge-capture/v1', selectionRuleDigest: options.selectionRuleDigest }
        : { canonicalization: 'animalge-c14n-json/v1', identity: 'animalge-identity/v1', compiler: COMPILER_REVISION, captureContract: 'animalge-capture/v1', selectionRuleDigest: options.selectionRuleDigest, materialContract: MATERIAL_CONTRACT_REVISION },
    baseSnapshotDigest: options.baseSnapshotDigest,
    deterministicWatermark: { nextSeqExclusive: options.targetNextSeqExclusive },
    semanticWatermark: semantic === undefined ? { nextSeqExclusive: 0 } : semantic.watermark,
    sourceTimeUpperBound: options.sourceTimeUpperBound, nodes, edges, breakpoints: [],
  }
  return verifySnapshot(payload)
}
