/** Bounded model-visible projection and the canonical requestPayload (SPEC-04 §5, D-098/D-164). */

import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { canonicalDigest, canonicalJson } from '../canonical-json.ts'
import { eventRef } from '../capture.ts'
import { deriveObservationId, taggedSha256Digest } from '../identity.ts'
import type { CapturedInvocation } from '../schema.ts'
import type { CandidateRecordV1, SessionEventRefV1, Sha256Digest } from '../types.ts'
import type { EvidenceModelRouteV1, SemanticProjectionConfig } from './model-route.ts'

/** One bounded entry inside the model-visible projection. */
export interface ProjectionItem {
  readonly kind: 'user_message' | 'assistant_message' | 'tool_result_summary' | 'run_summary' | 'existing_object'
  readonly sourceSeq: number
  readonly text: string
  readonly truncated: boolean
  readonly meta?: JsonValue
}

/** The frozen projection result; the canonical requestPayload is the only model-input copy basis. */
export interface SemanticProjection {
  readonly requestPayload: JsonValue
  readonly projectionDigest: Sha256Digest
  readonly sourceRefs: readonly SessionEventRefV1[]
  readonly items: readonly ProjectionItem[]
  readonly targetNextSeqExclusive: number
}

function isTextBlockShape(block: unknown): boolean {
  // Only visible text enters the projection: reasoning/CoT blocks, images, tool-call blocks
  // and any plugin-merged unknown block kinds are hard-excluded (SPEC-04 §5.1, D-105).
  return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
}

function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (isTextBlockShape(block)) {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** head+tail declarative truncation with a recorded method (SPEC-04 §5.2 head_tail_v1). */
export function truncateHeadTail(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false }
  const half = Math.floor(limit / 2)
  return { text: `${text.slice(0, half)}\n…[truncated ${String(text.length - limit)} chars, method head_tail_v1]…\n${text.slice(text.length - half)}`, truncated: true }
}

/**
 * Build the bounded projection over one frozen prefix (SPEC-04 §5.1—5.3). Input domain:
 * public user/assistant text (text blocks only), tool call/result compact summaries, pending
 * event-backed run summaries, and minimal existing-object summaries. The result is normalized
 * to the versioned canonical requestPayload carrying the explicit route and generation params;
 * the projection digest is derived from those exact bytes.
 */
export function buildSemanticProjection(options: {
  readonly header: SessionHeader
  readonly graphId: string
  readonly events: readonly SessionEvent[]
  readonly fromNextSeqExclusive: number
  readonly targetNextSeqExclusive: number
  readonly captures: readonly CapturedInvocation[]
  readonly selectedRunIds: ReadonlySet<string>
  readonly existingCandidates: readonly CandidateRecordV1[]
  readonly route: EvidenceModelRouteV1
  readonly config: SemanticProjectionConfig
}): SemanticProjection {
  const items: ProjectionItem[] = []
  const sourceRefs: SessionEventRefV1[] = []
  const selectedSeqs = new Set<number>()
  for (const event of options.events) {
    if (event.seq < options.fromNextSeqExclusive || event.seq >= options.targetNextSeqExclusive) continue
    if (event.type === 'evidence/model-request') continue
    selectedSeqs.add(event.seq)
    if (event.type === 'user/message') {
      const text = textOfBlocks((event.data as { content?: unknown }).content)
      if (text === '') continue
      const bounded = truncateHeadTail(text, options.config.perItemTruncationChars)
      items.push({ kind: 'user_message', sourceSeq: event.seq, text: bounded.text, truncated: bounded.truncated })
      sourceRefs.push(eventRef(options.header, event))
    } else if (event.type === 'assistant/message') {
      const message = event.data as { message?: { content?: unknown } }
      const text = textOfBlocks(message.message?.content)
      if (text === '') continue
      const bounded = truncateHeadTail(text, options.config.perItemTruncationChars)
      items.push({ kind: 'assistant_message', sourceSeq: event.seq, text: bounded.text, truncated: bounded.truncated })
      sourceRefs.push(eventRef(options.header, event))
    } else if (event.type === 'tool/result') {
      const data = event.data as { message?: { content?: unknown } }
      const text = textOfBlocks(data.message?.content)
      if (text === '') continue
      const bounded = truncateHeadTail(text, options.config.toolResultSummaryChars)
      items.push({
        kind: 'tool_result_summary',
        sourceSeq: event.seq,
        text: bounded.text,
        truncated: bounded.truncated,
        meta: { isError: Boolean((event.data as { error?: unknown }).error) },
      })
      sourceRefs.push(eventRef(options.header, event))
    }
  }
  // Pending event-backed runs that no stronger basis selected yet (relevance selection input).
  for (const capture of options.captures) {
    if (capture.selection === 'selected' || options.selectedRunIds.has(capture.runId)) continue
    if (capture.basis.resultEvent.seq >= options.targetNextSeqExclusive) continue
    const summary = `runId=${capture.runId} tool=${capture.toolName} outcome=${capture.outcome}`
    items.push({
      kind: 'run_summary',
      sourceSeq: capture.basis.resultEvent.seq,
      text: truncateHeadTail(summary, options.config.runSummaryChars).text,
      truncated: false,
      meta: {
        runId: capture.runId,
        toolName: capture.toolName,
        outcome: capture.outcome,
        observationId: deriveObservationId({ graphId: capture.graphId, observationKind: 'run_terminal_outcome', runId: capture.runId, resultEventSeq: capture.basis.resultEvent.seq }),
      },
    })
  }
  // Minimal existing-object summaries so relation proposals can target real endpoints:
  // prior candidates AND the tool-result Observations of already-selected runs (§5.1-5).
  for (const candidate of options.existingCandidates) {
    items.push({
      kind: 'existing_object',
      sourceSeq: candidate.sourceBinding.eventSeq,
      text: `${candidate.candidateId} [${candidate.subtype}] ${candidate.text.slice(0, 160)}`,
      truncated: candidate.text.length > 160,
      meta: { candidateId: candidate.candidateId, subtype: candidate.subtype },
    })
  }
  for (const capture of options.captures) {
    if (capture.graphId !== options.graphId) continue
    // Only graph-resident observations are offered as relation endpoints; pending
    // handles must not tempt the model into unresolvable references (C2-01). The
    // caller passes the full three-way residency set (R2-01).
    if (capture.selection !== 'selected' && !options.selectedRunIds.has(capture.runId)) continue
    const observationId = deriveObservationId({
      graphId: capture.graphId,
      observationKind: 'run_terminal_outcome',
      runId: capture.runId,
      resultEventSeq: capture.basis.resultEvent.seq,
    })
    items.push({
      kind: 'existing_object',
      sourceSeq: capture.basis.resultEvent.seq,
      text: `${String(observationId)} [Observation] ${capture.toolName} → ${capture.outcome}`,
      truncated: false,
      meta: { observationId: String(observationId), nodeKind: 'Observation' },
    })
  }
  items.sort((left, right) => left.sourceSeq - right.sourceSeq || left.kind.localeCompare(right.kind))
  sourceRefs.sort((left, right) => left.seq - right.seq || left.eventDigest.localeCompare(right.eventDigest))
  const generationParams: Record<string, unknown> = {}
  if (options.route.reasoningEffort !== undefined) generationParams.reasoningEffort = options.route.reasoningEffort
  if (options.route.temperature !== undefined) generationParams.temperature = options.route.temperature
  if (options.route.maxTokens !== undefined) generationParams.maxTokens = options.route.maxTokens
  if (options.route.stop !== undefined) generationParams.stop = options.route.stop
  const requestPayload = {
    schemaVersion: 'animalge.semantic-request/v1',
    provider: options.route.provider,
    model: options.route.model,
    system: SEMANTIC_SYSTEM_PROMPT,
    messages: items.map(item => ({
      role: item.kind === 'user_message' ? 'user' : item.kind === 'assistant_message' ? 'assistant' : 'system',
      content: item.text,
      meta: { kind: item.kind, sourceSeq: item.sourceSeq, truncated: item.truncated,
        ...(item.meta === undefined ? {} : { detail: item.meta }) },
    })),
    generationParams,
  } as unknown as JsonValue
  const projectionDigest = taggedSha256Digest('animalge:semantic-projection:v1', requestPayload)
  return {
    requestPayload,
    projectionDigest,
    sourceRefs,
    items,
    targetNextSeqExclusive: options.targetNextSeqExclusive,
  }
}

/** Recompute the canonical bytes and digest for an already-built payload (dispatch-reuse check). */
export function projectionDigestOf(requestPayload: JsonValue): { bytes: string; digest: Sha256Digest } {
  return { bytes: canonicalJson(requestPayload), digest: taggedSha256Digest('animalge:semantic-projection:v1', requestPayload) }
}

/** Determinism anchor: the same canonical request payload digest recomputes the same bytes. */
export function canonicalRequestDigest(value: unknown): Sha256Digest {
  return canonicalDigest(value as JsonValue)
}

/** Versioned system prompt for the v0.1 extraction task (promptRevision carries changes). */
export const SEMANTIC_SYSTEM_PROMPT = [
  'You are the AnimalGE evidence candidate-semantics extractor.',
  'Extract only arguable, task-relevant scientific hypotheses, interpretations, conclusions, and limitations from the assistant messages shown.',
  'Do not extract plans, tool usage notes, navigation, small talk, or mechanical restatements of tool results.',
  'Reference existing graph objects only by their exact ids; reference same-batch candidates only by their localId.',
  'Return only the structured JSON object requested by the caller; never invent runs, receipts, artifacts, numbers, anchors, or outcomes.',
].join('\n')
