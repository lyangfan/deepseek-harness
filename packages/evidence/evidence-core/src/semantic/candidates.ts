/** Candidate owner ledger: deterministic identity, frozen snapshots, and graph projection (SPEC-04 §8.2—8.3). */

import { canonicalJson } from '../canonical-json.ts'
import { deriveCandidateNodeId, deriveCandidateStatementId, taggedSha256Digest } from '../identity.ts'
import type { CandidateRecord, CandidateRelationRecord, ModelRunSelectionRecord } from '../schema.ts'
import type { EvidenceStore } from '../store.ts'
import type {
  CandidateGenerationProvenanceV1,
  Sha256Digest,
  CandidateRecordV1,
  CandidateRelationRecordV1,
  CandidateRelationSummaryV1,
  CandidateStatementPayloadV1,
  DeterministicCompilerProvenanceV1,
  EvidenceEdgeV1,
  EvidenceGraphId,
  EvidenceGraphScopeV1,
  EvidenceNodeV1,
} from '../types.ts'

export const CANDIDATE_CONTRACT_REVISION = 'animalge-candidate/v1'
/** v0.1 closed single purpose (SPEC-04 §7.1); correction-match is a SPEC-06 versioned increment. */
export type SemanticPurpose = 'candidate-semantics'
export const SEMANTIC_PURPOSE: SemanticPurpose = 'candidate-semantics'
export const EXTRACTOR_REVISION = 'animalge-semantic-extractor/v1'
export const PROMPT_REVISION = 'animalge-semantic-prompt/v1'
export const PROJECTION_POLICY_REVISION = 'animalge-semantic-projection/v1'

/** Attempt-frozen view of the candidate owner ledger (SPEC-04 §8.4; mirrors MaterialSnapshot). */
export interface SemanticSnapshot {
  readonly candidates: ReadonlyMap<string, CandidateRecordV1>
  readonly relations: ReadonlyMap<string, CandidateRelationRecordV1>
  readonly runSelections: ReadonlyMap<string, ModelRunSelectionRecord>
}

/** Freeze the store's candidate ledger state for one Graph at attempt start (§8.4 discipline). */
export function semanticSnapshotFor(store: EvidenceStore, graphId: EvidenceGraphId): SemanticSnapshot {
  const candidates = new Map<string, CandidateRecordV1>()
  for (const [key, row] of store.candidateRecords.entries()) if (row.graphId === graphId) candidates.set(key, row)
  const relations = new Map<string, CandidateRelationRecordV1>()
  for (const [key, row] of store.candidateRelations.entries()) if (row.graphId === graphId) relations.set(key, row)
  const runSelections = new Map<string, ModelRunSelectionRecord>()
  for (const [key, row] of store.modelRunSelections.entries()) if (row.graphId === graphId) runSelections.set(key, row)
  return { candidates, relations, runSelections }
}

/** Stable source-binding key: canonical {kind, sessionId, eventSeq, spanStart, spanEnd} (SPEC-04 §8.2). */
export function sourceBindingKey(binding: CandidateRecordV1['sourceBinding']): string {
  return canonicalJson({ kind: binding.kind, sessionId: binding.sessionId, eventSeq: binding.eventSeq, spanStart: binding.spanStart,
    spanEnd: binding.spanEnd })
}

/** Ordinal key: canonical {subtype, textDigest} — replay of identical extraction reuses identity (SPEC-04 §8.2). */
export function ordinalKey(record: Pick<CandidateRecordV1, 'subtype' | 'text'>): string {
  return canonicalJson({ subtype: record.subtype, textDigest: textDigest(record.text) })
}

/** Digest of the candidate text alone; never merges identities (D-124: no text-based merging). */
export function textDigest(text: string): Sha256Digest {
  return taggedSha256Digest('animalge:candidate-text:v1', text)
}

/**
 * Derive the CandidateStatement identity for one accepted proposal (SPEC-04 §8.2).
 * Identity material: graph scope + stable source binding + task type + ordinal key.
 */
export function deriveCandidateIdentity(graphId: EvidenceGraphId, record: Pick<CandidateRecordV1, 'subtype' | 'text' | 'sourceBinding'>): ReturnType<typeof deriveCandidateStatementId> {
  return deriveCandidateStatementId({
    graphId,
    nodeKind: 'CandidateStatement',
    sourceBindingKey: sourceBindingKey(record.sourceBinding),
    taskType: SEMANTIC_PURPOSE,
    ordinalKey: ordinalKey(record),
  })
}

/** Node identity for one candidate: {graphId, nodeKind, candidateId} (SPEC-04 §8.2, SPEC-01 §4.4 pattern). */
export function candidateNodeIdOf(graphId: EvidenceGraphId, candidateId: CandidateRecordV1['candidateId']): EvidenceNodeV1['nodeId'] {
  return deriveCandidateNodeId({ graphId, nodeKind: 'CandidateStatement', candidateId })
}

/** Derive the relation summary for one candidate from active ledger relations (SPEC-04 §8.3, D-092). */
export function relationSummaryOf(nodeId: EvidenceNodeV1['nodeId'], relations: readonly CandidateRelationRecordV1[]): CandidateRelationSummaryV1 {
  let activeSupports = 0
  let activeContradicts = 0
  let activeQualifies = 0
  for (const relation of relations) {
    if (relation.toNodeId !== nodeId || relation.edgeType === 'same_as_candidate') continue
    if (relation.edgeType === 'supports') activeSupports++
    else if (relation.edgeType === 'contradicts') activeContradicts++
    else activeQualifies++
  }
  const summary = activeSupports > 0 && activeContradicts > 0 ? 'mixed'
    : activeSupports > 0 ? 'support_only'
      : activeContradicts > 0 ? 'contradiction_only'
        : 'no_active_evidence'
  return { summary, activeSupports, activeContradicts, activeQualifies }
}

/** Project the frozen candidate ledger into graph nodes and edges (SPEC-04 §8.3). */
export function candidateProjection(options: {
  readonly scope: EvidenceGraphScopeV1
  readonly ledger: SemanticSnapshot
  readonly compiler: DeterministicCompilerProvenanceV1
}): { readonly nodes: EvidenceNodeV1[]; readonly edges: EvidenceEdgeV1[] } {
  const { scope, ledger, compiler } = options
  const nodes: EvidenceNodeV1[] = []
  const edges: EvidenceEdgeV1[] = []
  const relations = [...ledger.relations.values()].toSorted((left, right) => left.edgeId.localeCompare(right.edgeId))
  for (const record of ledger.candidates.values()) {
    const nodeId = candidateNodeIdOf(scope.graphId, record.candidateId)
    const payload: CandidateStatementPayloadV1 = {
      candidateSchema: 'animalge.candidate.statement/v1',
      candidateId: record.candidateId,
      subtype: record.subtype,
      text: record.text,
      sourceBinding: record.sourceBinding,
      generationProvenance: record.generationProvenance,
      relationSummary: relationSummaryOf(nodeId, relations),
    }
    nodes.push({
      schemaVersion: 'animalge.evidence.node/v1',
      nodeId,
      graphId: scope.graphId,
      nodeKind: 'CandidateStatement',
      payloadSchema: 'animalge.candidate.statement/v1',
      projectionState: 'active',
      identityRevision: 'animalge-identity/v1',
      sourceEventRefs: [record.sourceEventRef],
      compiler,
      payload,
    })
  }
  for (const relation of relations) {
    edges.push({
      schemaVersion: 'animalge.evidence.edge/v1',
      edgeId: relation.edgeId,
      graphId: scope.graphId,
      edgeType: relation.edgeType,
      family: relation.edgeType === 'supports' || relation.edgeType === 'qualifies' ? 'scientific_argument' : 'conflict_candidate_identity',
      from: relation.fromNodeId,
      to: relation.toNodeId,
      projectionState: 'active',
      sourceEventRefs: [relation.provenance.modelRequestEventRef],
      compiler,
      relation: relation.provenance,
    })
  }
  return { nodes, edges }
}

/** Generation provenance shared by candidate nodes and relation records (SPEC-04 §8.3 shape). */
export type GenerationProvenance = CandidateGenerationProvenanceV1

/** Ledger record shapes re-exported for the lane and proposal validator. */
export type { CandidateRecord, CandidateRelationRecord, ModelRunSelectionRecord }
