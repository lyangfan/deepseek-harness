/** Deterministic per-proposal validation and owner-ledger writes (SPEC-04 §7/§8.1—8.2). */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { canonicalJson } from '../canonical-json.ts'
import { deriveEdgeId, deriveNodeId, deriveObservationId, taggedSha256Digest } from '../identity.ts'
import type { CapturedInvocation } from '../schema.ts'
import type { CandidateRecordV1, CandidateRelationRecordV1, CompileAttemptId, EvidenceGraphId, EvidenceNodeId, ModelCallId, ModelRunSelectionRecordV1, SessionEventRefV1, Sha256Digest } from '../types.ts'
import { EvidenceStore } from '../store.ts'
import { candidateNodeIdOf, deriveCandidateIdentity, textDigest } from './candidates.ts'
import type { ProposalEndpointRef, SemanticExtractionOutput } from './output-schema.ts'

/** Named rejection codes — the closed §8.1 table; each rejected proposal is recorded, never batch-fatal. */
export type ProposalRejectCode =
  | 'source_binding_mismatch'
  | 'empty_candidate_text'
  | 'endpoint_invalid'
  | 'source_out_of_scope'
  | 'self_loop'
  | 'epistemic_cycle'
  | 'same_as_endpoint_invalid'
  | 'duplicate_edge'
  | 'run_selection_target_invalid'

/** One recorded verdict row (audit + replay dedup input). */
export interface ProposalVerdict {
  readonly fingerprint: string
  readonly verdict: 'accepted' | 'rejected'
  readonly rejectCode: ProposalRejectCode | null
  readonly summary: JsonValue
}

/** The batch result handed back to the lane: accepted ledger rows and per-proposal verdicts. */
export interface ProposalValidationResult {
  readonly candidates: readonly CandidateRecordV1[]
  readonly relations: readonly CandidateRelationRecordV1[]
  readonly runSelections: readonly ModelRunSelectionRecordV1[]
  readonly verdicts: readonly ProposalVerdict[]
}

/** Generation provenance shared by every accepted row of one call (§8.3 shape). */
export interface BatchProvenance {
  readonly modelCallId: string
  readonly modelRequestEventRef: SessionEventRefV1
  readonly provider: string
  readonly model: string
  readonly extractorRevision: string
  readonly promptRevision: string
  readonly projectionDigest: Sha256Digest
  readonly attemptId: CompileAttemptId
}

function fingerprintOf(kind: string, identity: unknown): string {
  return `pv:${taggedSha256Digest('animalge:proposal-fingerprint:v1', { kind, identity } as unknown as JsonValue).slice('sha256:'.length).slice(0, 32)}`
}

function joinedTextOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    const text = textBlockOf(block)
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}

function textBlockOf(block: unknown): string | undefined {
  if (typeof block !== 'object' || block === null) return undefined
  const shape = block as { type?: unknown; text?: unknown }
  return shape.type === 'text' && typeof shape.text === 'string' ? shape.text : undefined
}

/**
 * Validate one structured output against the frozen prefix and existing ledgers, then write
 * accepted rows to the owner ledgers (SPEC-04 §8.1—8.2). Candidates validate and materialize
 * first; relations resolve batch endpoints against accepted candidates only; every verdict —
 * accepted or rejected with a named code — is recorded. Invalid proposals never block the
 * valid subset, and no model field can reach the graph outside these ledgers (§7.4).
 */
export async function validateAndRecordProposals(options: {
  readonly store: EvidenceStore
  readonly graphId: EvidenceGraphId
  readonly attemptId: CompileAttemptId
  readonly fromNextSeqExclusive: number
  readonly targetNextSeqExclusive: number
  readonly prefixEvents: readonly SessionEvent[]
  readonly captures: readonly CapturedInvocation[]
  readonly provenance: BatchProvenance
  readonly output: SemanticExtractionOutput
}): Promise<ProposalValidationResult> {
  const verdicts: ProposalVerdict[] = []
  const acceptedCandidates: CandidateRecordV1[] = []
  const acceptedRelations: CandidateRelationRecordV1[] = []
  const acceptedSelections: ModelRunSelectionRecordV1[] = []
  const now = Date.now()

  // --- 1. candidates: source binding verified against the frozen prefix events (§8.1) ---
  const assistantMessages = new Map<number, { text: string; ref: SessionEventRefV1; actorRef: string }>()
  for (const event of options.prefixEvents) {
    if (event.type !== 'assistant/message') continue
    const data = event.data as { message?: { content?: unknown; source?: unknown } }
    const text = joinedTextOfBlocks(data.message?.content)
    const source = data.message?.source as { agent?: string; agentName?: string } | undefined
    assistantMessages.set(event.seq, {
      text,
      ref: {
        schemaVersion: 'animalge.session-event-ref/v1',
        sessionId: options.provenance.modelRequestEventRef.sessionId,
        seq: event.seq,
        eventType: 'assistant/message',
        eventTime: event.time,
        eventDigest: taggedEventDigest(event),
      },
      actorRef: typeof source?.agent === 'string' ? source.agent : typeof source?.agentName === 'string' ? source.agentName : 'dsh-agent',
    })
  }
  const acceptedByLocalId = new Map<string, CandidateRecordV1>()
  for (const proposal of options.output.candidates) {
    const identity = {
      localId: proposal.localId,
      sourceEventSeq: proposal.sourceEventSeq,
      span: [proposal.spanStart, proposal.spanEnd] as const,
      subtype: proposal.subtype,
      textDigest: textDigest(proposal.text),
    }
    const reject = (code: ProposalRejectCode, summary: JsonValue): void => {
      verdicts.push({ fingerprint: fingerprintOf('candidate', identity), verdict: 'rejected', rejectCode: code, summary })
    }
    if (proposal.text.trim() === '') {
      reject('empty_candidate_text', { localId: proposal.localId })
      continue
    }
    const message = assistantMessages.get(proposal.sourceEventSeq)
    if (message === undefined
      || proposal.sourceEventSeq < options.fromNextSeqExclusive
      || proposal.sourceEventSeq >= options.targetNextSeqExclusive
      || proposal.spanStart >= proposal.spanEnd
      || proposal.spanEnd > message.text.length) {
      reject('source_binding_mismatch', { localId: proposal.localId, sourceEventSeq: proposal.sourceEventSeq })
      continue
    }
    const spanText = message.text.slice(proposal.spanStart, proposal.spanEnd)
    if (taggedSha256Digest('animalge:candidate-text:v1', spanText) !== taggedSha256Digest('animalge:candidate-text:v1', proposal.text)) {
      reject('source_binding_mismatch', { localId: proposal.localId, reason: 'span_digest_mismatch' })
      continue
    }
    const record: CandidateRecordV1 = {
      recordVersion: 'animalge.candidate/v1',
      candidateId: deriveCandidateIdentity(options.graphId, { subtype: proposal.subtype, text: proposal.text, sourceBinding: { kind: 'agent_message', sessionId: options.provenance.modelRequestEventRef.sessionId, eventSeq: proposal.sourceEventSeq, spanStart: proposal.spanStart, spanEnd: proposal.spanEnd, spanTextDigest: textDigest(spanText), actorRef: message.actorRef } }),
      graphId: options.graphId,
      subtype: proposal.subtype,
      text: proposal.text,
      sourceBinding: {
        kind: 'agent_message' as const,
        sessionId: options.provenance.modelRequestEventRef.sessionId,
        eventSeq: proposal.sourceEventSeq,
        spanStart: proposal.spanStart,
        spanEnd: proposal.spanEnd,
        spanTextDigest: textDigest(spanText),
        actorRef: message.actorRef,
      },
      sourceEventRef: message.ref,
      generationProvenance: provenanceOf(options.provenance),
      acceptedAt: now,
      acceptedAttemptId: options.attemptId,
    }
    const existingRecord = options.store.candidateRecords.get(record.candidateId)
    const settled = existingRecord ?? record
    acceptedByLocalId.set(proposal.localId, settled)
    acceptedCandidates.push(settled)
    verdicts.push({ fingerprint: fingerprintOf('candidate', identity), verdict: 'accepted', rejectCode: null, summary: { localId: proposal.localId, candidateId: settled.candidateId, replay: existingRecord !== undefined } })
  }

  // --- 2. endpoint index: existing ledger candidates + this batch + prefix observations ---
  const candidateIdToNodeId = new Map<string, EvidenceNodeId>()
  const observationIds = new Set<string>()
  for (const record of options.store.candidateRecords.entries()) {
    if (record[1].graphId !== options.graphId) continue
    candidateIdToNodeId.set(record[1].candidateId, candidateNodeIdOf(options.graphId, record[1].candidateId))
  }
  for (const record of acceptedCandidates) candidateIdToNodeId.set(record.candidateId, candidateNodeIdOf(options.graphId,
    record.candidateId))
  // R2-01: the endpoint domain must mirror compileSnapshot's graph-residency predicate
  // exactly — a Run enters the graph when the deterministic rule selected it, an accepted
  // receipt covers it, or a prior model selection claimed it (§8.2). Anything narrower
  // rejects legal in-graph references; anything wider re-opens the C2-01 poisoning chain.
  const acceptedReceiptRunIds = new Set<string>()
  for (const [, row] of options.store.receiptAcceptances.entries()) {
    if (row.verdict !== 'accepted') continue
    const submission = options.store.receiptSubmissions.get(row.receiptId)
    if (submission !== undefined && submission.evidenceGraphId === options.graphId) acceptedReceiptRunIds.add(submission.runId)
  }
  const graphResident = (capture: CapturedInvocation): boolean =>
    capture.selection === 'selected'
    || acceptedReceiptRunIds.has(capture.runId)
    || options.store.modelRunSelections.get(capture.runId) !== undefined
  for (const capture of options.captures) {
    if (capture.graphId !== options.graphId) continue
    if (!graphResident(capture)) continue
    observationIds.add(String(deriveObservationId({ graphId: options.graphId, observationKind: 'run_terminal_outcome', runId: capture.runId, resultEventSeq: capture.basis.resultEvent.seq })))
  }

  const resolveEndpoint = (ref: ProposalEndpointRef): { nodeId: EvidenceNodeId; kind: 'Observation' | 'CandidateStatement' } | undefined => {
    if (ref.kind === 'BatchCandidate') return acceptedByLocalId.get(ref.localId) === undefined ? undefined : { nodeId: candidateIdToNodeId.get((acceptedByLocalId.get(ref.localId) as CandidateRecordV1).candidateId) as EvidenceNodeId, kind: 'CandidateStatement' }
    if (ref.kind === 'CandidateStatement') {
      const nodeId = candidateIdToNodeId.get(ref.id)
      return nodeId === undefined ? undefined : { nodeId, kind: 'CandidateStatement' }
    }
    // Observation refs carry the eo_ ObservationId from the projection's endpoint handle;
    // the ledger stores the derived en_ Node identity (SPEC-01 §4.4), never the raw id.
    if (!observationIds.has(ref.id)) return undefined
    return { nodeId: deriveNodeId({ graphId: options.graphId, nodeKind: 'Observation', observationId: ref.id as never }), kind: 'Observation' }
  }

  // --- 3. relations in deterministic {type, from, to} order; epistemic cycle guarded (§8.1) ---
  const relationProposals = [...options.output.relations].sort((left, right) => left.type.localeCompare(right.type)
    || canonicalJson(left.fromRef).localeCompare(canonicalJson(right.fromRef))
    || canonicalJson(left.toRef).localeCompare(canonicalJson(right.toRef)))
  const epistemic = new Map<string, string[]>()
  for (const record of options.store.candidateRelations.entries()) {
    if (record[1].graphId !== options.graphId) continue
    if (record[1].edgeType !== 'supports' && record[1].edgeType !== 'qualifies') continue
    const targets = epistemic.get(record[1].fromNodeId) ?? []
    targets.push(record[1].toNodeId)
    epistemic.set(record[1].fromNodeId, targets)
  }
  const existingEdges = [...options.store.candidateRelations.entries()]
    .filter(([, row]) => row.graphId === options.graphId)
    .map(([, row]) => row.edgeId)
  const seenEdges = new Set<string>(existingEdges)
  for (const proposal of relationProposals) {
    const identity = { type: proposal.type, fromRef: proposal.fromRef, toRef: proposal.toRef }
    const reject = (code: ProposalRejectCode, summary: JsonValue): void => {
      verdicts.push({ fingerprint: fingerprintOf('relation', identity), verdict: 'rejected', rejectCode: code, summary })
    }
    if (proposal.sourceEventSeqs.some(seq => seq < options.fromNextSeqExclusive || seq >= options.targetNextSeqExclusive)) {
      reject('source_out_of_scope', { type: proposal.type })
      continue
    }
    const from = resolveEndpoint(proposal.fromRef)
    const to = resolveEndpoint(proposal.toRef)
    if (from === undefined || to === undefined || to.kind !== 'CandidateStatement') {
      reject('endpoint_invalid', { type: proposal.type, reason: to !== undefined && to.kind !== 'CandidateStatement' ? 'target_not_candidate' : 'unresolved' })
      continue
    }
    if (from.nodeId === to.nodeId) {
      reject('self_loop', { type: proposal.type })
      continue
    }
    const edgeId = deriveEdgeId({ graphId: options.graphId, edgeType: proposal.type, from: from.nodeId, to: to.nodeId })
    if (seenEdges.has(edgeId)) {
      reject('duplicate_edge', { type: proposal.type })
      continue
    }
    if (proposal.type === 'supports' || proposal.type === 'qualifies') {
      const targets = epistemic.get(from.nodeId) ?? []
      targets.push(to.nodeId)
      epistemic.set(from.nodeId, targets)
      if (wouldCycle(epistemic, from.nodeId)) {
        const list = epistemic.get(from.nodeId) ?? []
        list.pop()
        epistemic.set(from.nodeId, list)
        reject('epistemic_cycle', { type: proposal.type })
        continue
      }
    }
    seenEdges.add(edgeId)
    const record: CandidateRelationRecordV1 = {
      recordVersion: 'animalge.candidate-relation/v1',
      edgeId,
      graphId: options.graphId,
      edgeType: proposal.type,
      fromNodeId: from.nodeId,
      toNodeId: to.nodeId,
      provenance: provenanceOf(options.provenance),
      createdAt: now,
      acceptedAttemptId: options.attemptId,
    }
    acceptedRelations.push(record)
    verdicts.push({ fingerprint: fingerprintOf('relation', identity), verdict: 'accepted', rejectCode: null, summary: { edgeId, type: proposal.type } })
  }

  // --- 4. same_as_candidate: two distinct existing candidates, normalized endpoints (§8.1/§3.41) ---
  for (const proposal of options.output.sameAsProposals) {
    const identity = { aRef: proposal.aRef, bRef: proposal.bRef }
    const reject = (code: ProposalRejectCode): void => {
      verdicts.push({ fingerprint: fingerprintOf('same_as', identity), verdict: 'rejected', rejectCode: code, summary: identity })
    }
    if (proposal.aRef.kind === 'BatchCandidate' || proposal.bRef.kind === 'BatchCandidate') {
      // C1-01 accepted limitation: the schema union admits batch refs, but same_as targets
      // existing candidates only — the proposal lands in the named rejection.
      reject('same_as_endpoint_invalid')
      continue
    }
    const a = candidateIdToNodeId.get(proposal.aRef.id)
    const b = candidateIdToNodeId.get(proposal.bRef.id)
    if (a === undefined || b === undefined || a === b) {
      reject('same_as_endpoint_invalid')
      continue
    }
    const [from, to] = a.localeCompare(b) < 0 ? [a, b] : [b, a]
    const edgeId = deriveEdgeId({ graphId: options.graphId, edgeType: 'same_as_candidate', from, to })
    if (seenEdges.has(edgeId)) {
      reject('duplicate_edge')
      continue
    }
    seenEdges.add(edgeId)
    const record: CandidateRelationRecordV1 = {
      recordVersion: 'animalge.candidate-relation/v1',
      edgeId,
      graphId: options.graphId,
      edgeType: 'same_as_candidate',
      fromNodeId: from,
      toNodeId: to,
      provenance: provenanceOf(options.provenance),
      createdAt: now,
      acceptedAttemptId: options.attemptId,
    }
    acceptedRelations.push(record)
    verdicts.push({ fingerprint: fingerprintOf('same_as', identity), verdict: 'accepted', rejectCode: null, summary: { edgeId } })
  }

  // --- 5. run selections: unselected captures of this graph only (§8.1/§8.4) ---
  const captureByRunId = new Map<string, CapturedInvocation>()
  for (const capture of options.captures) if (capture.graphId === options.graphId) captureByRunId.set(capture.runId, capture)
  for (const proposal of options.output.runSelections) {
    const identity = { runId: proposal.runId, reasonDigest: textDigest(proposal.reason) }
    const reject = (code: ProposalRejectCode): void => {
      verdicts.push({ fingerprint: fingerprintOf('run_selection', identity), verdict: 'rejected', rejectCode: code, summary: { runId: proposal.runId } })
    }
    if (proposal.sourceEventSeqs.some(seq => seq < options.fromNextSeqExclusive || seq >= options.targetNextSeqExclusive)) {
      reject('source_out_of_scope')
      continue
    }
    const capture = captureByRunId.get(proposal.runId)
    const existing = options.store.modelRunSelections.get(proposal.runId)
    if (capture === undefined || capture.selection === 'selected' || existing !== undefined
      // R2-01(b): a run already graph-resident via an accepted receipt cannot be model-
      // selected either (§8.1: run_selection_target_invalid; receipt_auto wins §8.2).
      || acceptedReceiptRunIds.has(proposal.runId)) {
      reject('run_selection_target_invalid')
      continue
    }
    const record: ModelRunSelectionRecordV1 = {
      recordVersion: 'animalge.model-run-selection/v1',
      runId: capture.runId,
      graphId: options.graphId,
      modelCallId: options.provenance.modelCallId as ModelCallId,
      attemptId: options.attemptId,
      modelRequestEventRef: options.provenance.modelRequestEventRef,
      reason: proposal.reason,
      createdAt: now,
    }
    acceptedSelections.push(record)
    verdicts.push({ fingerprint: fingerprintOf('run_selection', identity), verdict: 'accepted', rejectCode: null, summary: { runId: proposal.runId } })
  }

  // --- 6. ledger writes: immutable idempotent puts; rejections recorded for audit (§8.2) ---
  // Replays keep the first materialization; a later delivery of the same identity is a
  // no-op (§8.2 idempotency — only the audit row below grows per attempt).
  const putCandidateOnce = async (key: CandidateRecordV1['candidateId'], value: CandidateRecordV1): Promise<void> => {
    const table = options.store.candidateRecords
    if (table.get(key) === undefined) await options.store.putMaterialRecord(table, key, value)
  }
  const putRelationOnce = async (key: CandidateRelationRecordV1['edgeId'], value: CandidateRelationRecordV1): Promise<void> => {
    const table = options.store.candidateRelations
    if (table.get(key) === undefined) await options.store.putMaterialRecord(table, key, value)
  }
  const putSelectionOnce = async (key: ModelRunSelectionRecordV1['runId'], value: ModelRunSelectionRecordV1): Promise<void> => {
    const table = options.store.modelRunSelections
    if (table.get(key) === undefined) await options.store.putMaterialRecord(table, key, value)
  }
  for (const record of acceptedCandidates) await putCandidateOnce(record.candidateId, record)
  for (const record of acceptedRelations) await putRelationOnce(record.edgeId, record)
  for (const record of acceptedSelections) await putSelectionOnce(record.runId, record)
  for (const verdict of verdicts) {
    await options.store.putMaterialRecord(options.store.proposalValidations, `${options.attemptId}:${verdict.fingerprint}`, {
      recordVersion: 'animalge.proposal-validation/v1',
      fingerprint: `${options.attemptId}:${verdict.fingerprint}`,
      graphId: options.graphId,
      attemptId: options.attemptId,
      verdict: verdict.verdict,
      rejectCode: verdict.rejectCode,
      summary: verdict.summary,
      recordedAt: now,
    })
  }
  return { candidates: acceptedCandidates, relations: acceptedRelations, runSelections: acceptedSelections, verdicts }
}

function provenanceOf(provenance: BatchProvenance): CandidateRecordV1['generationProvenance'] {
  return {
    modelCallId: provenance.modelCallId as ModelCallId,
    modelRequestEventRef: provenance.modelRequestEventRef,
    provider: provenance.provider,
    model: provenance.model,
    extractorRevision: provenance.extractorRevision,
    promptRevision: provenance.promptRevision,
    projectionDigest: provenance.projectionDigest,
    attemptId: provenance.attemptId,
  }
}

function wouldCycle(adjacency: Map<string, string[]>, start: string): boolean {
  const visiting = new Set<string>()
  const seen = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (seen.has(id)) return false
    visiting.add(id)
    for (const target of adjacency.get(id) ?? []) if (visit(target)) return true
    visiting.delete(id)
    seen.add(id)
    return false
  }
  return visit(start)
}

function taggedEventDigest(event: SessionEvent): Sha256Digest {
  return taggedSha256Digest('animalge:proposal-fingerprint:v1', event as unknown as JsonValue)
}
