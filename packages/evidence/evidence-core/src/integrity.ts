/** Complete Snapshot schema, digest, identity, reference and graph validation. */

import { Buffer } from 'node:buffer'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import { canonicalDigest, canonicalJson } from './canonical-json.ts'
import { deriveArtifactNodeId, deriveCandidateNodeId, deriveContextNodeId, deriveEdgeId, deriveNodeId } from './identity.ts'
import { evidenceSnapshotPayloadSchema } from './schema.ts'
import type { EvidenceNodeV1, EvidenceSnapshotPayloadV1, StoredSnapshotV1 } from './types.ts'

export class EvidenceIntegrityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'EvidenceIntegrityError'
  }
}

function assertSortedUnique(values: readonly string[], code: string): void {
  for (let index = 1; index < values.length; index++) {
    if ((values[index - 1] as string).localeCompare(values[index] as string) >= 0) {
      throw new EvidenceIntegrityError(code, 'values must be strictly sorted and unique')
    }
  }
}

function validateRefs(node: EvidenceNodeV1, watermark: number): void {
  const keys = node.sourceEventRefs.map(ref => `${String(ref.seq).padStart(16, '0')}:${ref.eventType}:${ref.eventDigest}`)
  assertSortedUnique(keys, 'source_ref_order')
  for (const ref of node.sourceEventRefs) {
    if (ref.seq >= watermark) throw new EvidenceIntegrityError('source_ref_watermark', `event ref ${ref.seq} is not below watermark ${watermark}`)
  }
}

/**
 * Validate one complete Snapshot payload and return its detached strict value.
 * @param input Snapshot value received from a public or durable boundary.
 * @returns Strict Snapshot payload with recomputable identities and references.
 */
export function verifySnapshot(input: unknown): EvidenceSnapshotPayloadV1 {
  let payload: EvidenceSnapshotPayloadV1
  try {
    payload = evidenceSnapshotPayloadSchema.parse(input)
  } catch (error) {
    // §4.3: reserved node kinds (e.g. SourceAssertion, Annotation) belong to later owner specs
    // and must be rejected under their own named code rather than a generic schema error.
    if (error instanceof z.ZodError && error.issues.some(issue => issue.path.includes('nodeKind') || issue.path.includes('payloadSchema'))) {
      // The node union discriminates on payloadSchema; an unknown kind surfaces as an
      // unrecognized discriminator, a reserved kind as a nodeKind literal mismatch.
      throw new EvidenceIntegrityError('unsupported_node_kind', 'node kind is reserved for a later owner spec and is not supported')
    }
    // SPEC-02 §4.6: agent/model ContextEntity kinds stay fail closed under their own named code.
    if (error instanceof z.ZodError && error.issues.some(issue => issue.path.includes('contextKind'))) {
      throw new EvidenceIntegrityError('unsupported_context_kind', 'ContextEntity kind is reserved for a later owner spec')
    }
    throw error
  }
  const { graphId, sessionId } = payload.scope
  const candidateSchema = (payload.schemaSet as readonly string[]).includes('animalge.evidence.candidate/v1')
  // SPEC-04 §9.6/§10.2-4: the untagged legacy form stays legal only at zero and only on
  // non-candidate schemaSets (readers interpret it as not_configured without rewriting bytes);
  // candidate schemaSets require a tagged form. An active semantic watermark never exceeds the
  // deterministic one (§8.4: the semantic channel only covers prefixes the head already covers).
  if (!('kind' in payload.semanticWatermark)) {
    if (payload.semanticWatermark.nextSeqExclusive !== 0 || candidateSchema) {
      throw new EvidenceIntegrityError('semantic_watermark_active', 'untagged semantic watermark is only legal at zero on non-candidate schemaSets')
    }
  } else if (candidateSchema) {
    if (payload.semanticWatermark.kind === 'active' && payload.semanticWatermark.nextSeqExclusive > payload.deterministicWatermark.nextSeqExclusive) {
      throw new EvidenceIntegrityError('semantic_watermark_exceeds_deterministic', 'active semantic watermark exceeds the deterministic watermark')
    }
  } else {
    throw new EvidenceIntegrityError('semantic_watermark_tagged_without_candidate_schema', 'tagged semantic watermark requires the candidate schemaSet')
  }
  assertSortedUnique(payload.nodes.map(node => node.nodeId), 'node_order')
  assertSortedUnique(payload.edges.map(edge => edge.edgeId), 'edge_order')
  assertSortedUnique(payload.breakpoints.map(point => `${point.code}:${String(point.primarySourceRef.seq).padStart(16, '0')}:${point.stableKey}`), 'breakpoint_order')
  const nodes = new Map(payload.nodes.map(node => [node.nodeId, node]))
  for (const node of payload.nodes) {
    if (node.graphId !== graphId) throw new EvidenceIntegrityError('graph_mismatch', `node '${node.nodeId}' belongs to another Graph`)
    if (node.sourceEventRefs.some(ref => ref.sessionId !== sessionId)) throw new EvidenceIntegrityError('session_ref_mismatch', `node '${node.nodeId}' cites another Session`)
    validateRefs(node, payload.deterministicWatermark.nextSeqExclusive)
    const expected = node.nodeKind === 'Run'
      ? deriveNodeId({ graphId, nodeKind: 'Run', runId: node.payload.runId })
      : node.nodeKind === 'Observation'
        ? deriveNodeId({ graphId, nodeKind: 'Observation', observationId: node.payload.observationId })
        : node.nodeKind === 'ArtifactVersion'
          ? deriveArtifactNodeId({ graphId, nodeKind: 'ArtifactVersion', artifactVersionId: node.payload.artifactVersionId })
          : node.nodeKind === 'ContextEntity'
            ? deriveContextNodeId({ graphId, nodeKind: 'ContextEntity', contextEntityId: node.payload.contextEntityId })
            : deriveCandidateNodeId({ graphId, nodeKind: 'CandidateStatement', candidateId: node.payload.candidateId })
    if (expected !== node.nodeId) throw new EvidenceIntegrityError('identity_mismatch', `node '${node.nodeId}' identity does not recompute`)
    // SPEC-04 §10.2-7: a candidate's source binding must resolve to its own cited event.
    if (node.nodeKind === 'CandidateStatement') {
      const binding = node.payload.sourceBinding
      if (!node.sourceEventRefs.some(ref => ref.seq === binding.eventSeq && ref.sessionId === binding.sessionId)) {
        throw new EvidenceIntegrityError('source_binding_unresolved', `candidate '${node.nodeId}' does not cite its binding event`)
      }
    }
  }
  const adjacency = new Map<string, string[]>()
  const epistemic = new Map<string, string[]>()
  const supports = new Map<string, { supports: number; contradicts: number; qualifies: number }>()
  const candidateNodeIds = new Set<string>()
  for (const node of payload.nodes) if (node.nodeKind === 'CandidateStatement') candidateNodeIds.add(node.nodeId)
  for (const edge of payload.edges) {
    if (edge.graphId !== graphId) throw new EvidenceIntegrityError('graph_mismatch', `edge '${edge.edgeId}' belongs to another Graph`)
    if (edge.from === edge.to) throw new EvidenceIntegrityError('self_loop', `edge '${edge.edgeId}' is a self-loop`)
    const from = nodes.get(edge.from)
    const to = nodes.get(edge.to)
    if (from === undefined || to === undefined) throw new EvidenceIntegrityError('missing_endpoint', `edge '${edge.edgeId}' has a missing endpoint`)
    if (edge.family === 'deterministic_provenance') {
      if (edge.edgeType === 'generated_by' && !((from.nodeKind === 'Observation' || from.nodeKind === 'ArtifactVersion') && to.nodeKind === 'Run')) {
        throw new EvidenceIntegrityError('invalid_endpoint', 'generated_by must point Observation or ArtifactVersion to Run')
      }
      if (edge.edgeType === 'part_of' && (from.nodeKind !== 'Run' || to.nodeKind !== 'Run')) {
        throw new EvidenceIntegrityError('invalid_endpoint', 'part_of must point Run to Run')
      }
      if (edge.edgeType === 'used' && (from.nodeKind !== 'Run' || (to.nodeKind !== 'ArtifactVersion' && to.nodeKind !== 'ContextEntity'))) {
        throw new EvidenceIntegrityError('invalid_endpoint', 'used must point Run to ArtifactVersion or ContextEntity')
      }
      if ((edge.edgeType === 'supersedes' || edge.edgeType === 'restored_from') && (from.nodeKind !== 'ArtifactVersion' || to.nodeKind !== 'ArtifactVersion')) {
        throw new EvidenceIntegrityError('invalid_endpoint', `${edge.edgeType} must point ArtifactVersion to ArtifactVersion`)
      }
    } else {
      // SPEC-04 §10.2-7/§8.3: supports/qualifies → scientific_argument; contradicts and
      // same_as_candidate → conflict_candidate_identity (overlay, never in a cycle check).
      if (!candidateSchema) throw new EvidenceIntegrityError('candidate_edge_without_candidate_schema', `edge '${edge.edgeId}' requires the candidate schemaSet`)
      const argumentFamily = edge.edgeType === 'supports' || edge.edgeType === 'qualifies'
      if (argumentFamily && edge.family !== 'scientific_argument') throw new EvidenceIntegrityError('invalid_family', `${edge.edgeType} belongs to the scientific-argument family`)
      if (!argumentFamily && edge.family !== 'conflict_candidate_identity') throw new EvidenceIntegrityError('invalid_family', `${edge.edgeType} belongs to the conflict family`)
      if (edge.edgeType === 'same_as_candidate') {
        if (!candidateNodeIds.has(edge.from) || !candidateNodeIds.has(edge.to)) throw new EvidenceIntegrityError('invalid_endpoint', 'same_as_candidate must point CandidateStatement to CandidateStatement')
        // Normalized symmetric edge: exactly one stored direction per unordered pair (§8.1).
        if (edge.from.localeCompare(edge.to) >= 0) throw new EvidenceIntegrityError('same_as_endpoint_unnormalized', `same_as_candidate edge '${edge.edgeId}' is not stored on normalized endpoints`)
      } else {
        const fromOk = from.nodeKind === 'Observation' || from.nodeKind === 'CandidateStatement'
        if (!fromOk || to.nodeKind !== 'CandidateStatement') throw new EvidenceIntegrityError('invalid_endpoint', `${edge.edgeType} must point Observation or CandidateStatement to CandidateStatement`)
        if (candidateNodeIds.has(edge.to)) {
          const counts = supports.get(edge.to) ?? { supports: 0, contradicts: 0, qualifies: 0 }
          if (edge.edgeType === 'supports') counts.supports++
          else if (edge.edgeType === 'contradicts') counts.contradicts++
          else counts.qualifies++
          supports.set(edge.to, counts)
        }
        if (argumentFamily) {
          const targets = epistemic.get(edge.from) ?? []
          targets.push(edge.to)
          epistemic.set(edge.from, targets)
        }
      }
    }
    const expected = deriveEdgeId({ graphId, edgeType: edge.edgeType, from: edge.from, to: edge.to })
    if (expected !== edge.edgeId) throw new EvidenceIntegrityError('identity_mismatch', `edge '${edge.edgeId}' identity does not recompute`)
    if (edge.family === 'deterministic_provenance') {
      const targets = adjacency.get(edge.from) ?? []
      targets.push(edge.to)
      adjacency.set(edge.from, targets)
    }
  }
  // SPEC-04 §8.3/§10.2-7: relation summaries must match the active candidate edges exactly.
  for (const node of payload.nodes) {
    if (node.nodeKind !== 'CandidateStatement') continue
    const counts = supports.get(node.nodeId) ?? { supports: 0, contradicts: 0, qualifies: 0 }
    const summary = counts.supports > 0 && counts.contradicts > 0 ? 'mixed'
      : counts.supports > 0 ? 'support_only'
        : counts.contradicts > 0 ? 'contradiction_only'
          : 'no_active_evidence'
    const actual = node.payload.relationSummary
    if (actual.summary !== summary || actual.activeSupports !== counts.supports
      || actual.activeContradicts !== counts.contradicts || actual.activeQualifies !== counts.qualifies) {
      throw new EvidenceIntegrityError('relation_summary_mismatch', `candidate '${node.nodeId}' relation summary does not match active edges`)
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (adjacencyFor: Map<string, string[]>, id: string, code: string): void => {
    if (visiting.has(id)) throw new EvidenceIntegrityError(code, `graph contains a cycle at '${id}'`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const target of adjacencyFor.get(id) ?? []) visit(adjacencyFor, target, code)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of nodes.keys()) visit(adjacency, id, 'cycle')
  // §5.3/D-091: only supports+qualifies participate in epistemic acyclicity; contradicts and
  // same_as_candidate are overlays and never join either cycle check.
  visiting.clear()
  visited.clear()
  for (const id of nodes.keys()) visit(epistemic, id, 'epistemic_cycle')
  return payload
}

/** Build the immutable StoredSnapshot envelope after complete validation. */
export function snapshotRecord(input: EvidenceSnapshotPayloadV1): StoredSnapshotV1 {
  const payload = verifySnapshot(input)
  const bytes = canonicalJson(payload as unknown as JsonValue)
  return {
    recordVersion: 'animalge.stored-snapshot/v1',
    snapshotDigest: canonicalDigest(payload as unknown as JsonValue),
    payload: payload as unknown as JsonValue,
    canonicalByteLength: Buffer.byteLength(bytes, 'utf8'),
  }
}

/**
 * Re-parse and recompute a stored record before read, commit, export or GC.
 * @param record Immutable StoredSnapshot envelope.
 * @returns Verified strict Snapshot payload.
 */
export function verifyStoredSnapshot(record: StoredSnapshotV1): EvidenceSnapshotPayloadV1 {
  const payload = verifySnapshot(record.payload)
  const bytes = canonicalJson(payload as unknown as JsonValue)
  if (Buffer.byteLength(bytes, 'utf8') !== record.canonicalByteLength) throw new EvidenceIntegrityError('snapshot_byte_length_mismatch', 'stored Snapshot byte length does not match')
  if (canonicalDigest(payload as unknown as JsonValue) !== record.snapshotDigest) throw new EvidenceIntegrityError('snapshot_digest_mismatch', 'stored Snapshot digest does not match payload')
  return payload
}
