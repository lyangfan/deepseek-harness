/** Pure Session-suffix validation and DSH-aware invocation capture fold. */

import type { CallId, ToolCallBlock, ToolResultBlock } from '@deepseek-ai/dsh-llm'
import { TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { JsonValue, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-tools'
import { canonicalDigest } from './canonical-json.ts'
import { deriveRunId, taggedSha256Digest } from './identity.ts'
import type { CapturedInvocation } from './schema.ts'
import type { EvidenceGraphScopeV1, InvocationEventBasisV1, RunOutcome, SessionEventRefV1, Sha256Digest } from './types.ts'

export interface CaptureSelection {
  readonly revision: string
  readonly exactToolNames: readonly string[]
  readonly digest: Sha256Digest
}

export interface CaptureBoundary {
  readonly seq: number
  readonly reason: 'tool_result' | 'code_dispatch' | 'turn_end'
}

export interface CaptureFoldResult {
  readonly captures: CapturedInvocation[]
  readonly boundaries: CaptureBoundary[]
  readonly observedNextSeqExclusive: number
}

export class CaptureError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CaptureError'
  }
}

/** Normalize an exact-name selection policy and bind it to canonical bytes. */
export function resolveSelection(revision: string, names: readonly string[]): CaptureSelection {
  if (revision.trim() === '') throw new TypeError('selection revision must be non-empty')
  const normalized = [...names]
  if (normalized.some(name => name.trim() === '')) throw new TypeError('selection tool names must be non-empty')
  normalized.sort()
  if (normalized.some((name, index) => index > 0 && name === normalized[index - 1])) throw new TypeError('selection tool names must be unique')
  return { revision, exactToolNames: Object.freeze(normalized), digest: canonicalDigest({ revision, exactToolNames: normalized }) }
}

/** Recompute one stable reference to the complete persisted event envelope. */
export function eventRef(header: SessionHeader, event: SessionEvent): SessionEventRefV1 {
  return {
    schemaVersion: 'animalge.session-event-ref/v1',
    sessionId: header.id,
    seq: event.seq,
    eventType: event.type,
    eventTime: event.time,
    eventDigest: canonicalDigest(event as unknown as JsonValue),
  }
}

/** Reject a suffix that does not start at the requested watermark or contain contiguous sequence numbers. */
export function validateSuffix(header: SessionHeader, expected: SessionHeader, from: number, events: readonly SessionEvent[]): void {
  if (header.id !== expected.id || header.createdAt !== expected.createdAt) throw new CaptureError('header_mismatch', 'persisted Session lifecycle changed')
  for (let index = 0; index < events.length; index++) {
    if ((events[index] as SessionEvent).seq !== from + index) throw new CaptureError(index === 0 ? 'sequence_start_mismatch' : 'sequence_gap', 'persisted suffix is not contiguous')
  }
}

function appendSurface(event: SessionEvent): boolean {
  return 'surfaceOp' in event && event.surfaceOp === 'append'
}

/** Whether an event may durably admit a deterministic compile target. */
export function completionBoundary(event: SessionEvent): CaptureBoundary | undefined {
  if (event.type === 'tool/result' && appendSurface(event)) return { seq: event.seq, reason: 'tool_result' }
  if (event.type === 'tool/code-dispatch') return { seq: event.seq, reason: 'code_dispatch' }
  if (event.type === 'turn/end') return { seq: event.seq, reason: 'turn_end' }
  return undefined
}

function terminalBlock(event: SessionEvent<'tool/result'>): ToolResultBlock {
  const blocks = event.data.message.content
  if (blocks[0].toolCallId !== event.data.message.source.callId) {
    throw new CaptureError('corrupt_pair', 'tool result must contain one matching result block')
  }
  return blocks[0]
}

function resultDigest(block: ToolResultBlock): Sha256Digest {
  return canonicalDigest(block.content as unknown as JsonValue)
}

function outcomeOf(error: { name: string; code: string } | undefined, isError: boolean): RunOutcome {
  if (error?.name === 'ToolNotStartedError' && error.code === TOOL_NOT_STARTED) return 'not_started'
  if (error?.name === 'ToolOutcomeUnknownError' && error.code === TOOL_OUTCOME_UNKNOWN) return 'outcome_unknown'
  return isError ? 'failed' : 'succeeded'
}

function selected(selection: CaptureSelection, toolName: string): 'selected' | 'not_selected' {
  return selection.exactToolNames.includes(toolName) ? 'selected' : 'not_selected'
}

/** Identity material for one invocation basis under one Graph (shared by capture and the SPEC-02 acceptance lane). */
export function runIdentityMaterial(graphId: string, sessionId: string, basis: InvocationEventBasisV1): JsonValue {
  return basis.kind === 'top_level_tool'
    ? { graphId, basisKind: 'top_level_tool', sessionId, callEventSeq: basis.callEvent.seq, callId: basis.callId }
    : basis.kind === 'top_level_not_started'
      ? { graphId, basisKind: 'top_level_not_started', sessionId, assistantEventSeq: basis.assistantEvent.seq, toolCallBlockIndex: basis.toolCallBlockIndex, callId: basis.callId }
      : { graphId, basisKind: 'code_mode_dispatch', sessionId, startEventSeq: basis.startEvent.seq, rootCallId: basis.rootCallId, parentCallId: basis.parentCallId, subCallId: basis.subCallId }
}

function capture(
  scope: EvidenceGraphScopeV1,
  basis: InvocationEventBasisV1,
  toolName: string,
  argumentsMaterial: { readonly kind: string; readonly toolName: string; readonly argumentsRaw?: string; readonly arguments?: JsonValue },
  block: ToolResultBlock,
  error: { name: string; code: string } | undefined,
  selection: CaptureSelection,
  startedAt: number | null,
  endedAt: number,
): CapturedInvocation {
  const runId = deriveRunId(runIdentityMaterial(scope.graphId, scope.sessionId, basis))
  const outcome = outcomeOf(error, block.isError === true)
  const invocationMaterial = argumentsMaterial as unknown as JsonValue
  return {
    recordVersion: 'animalge.captured-invocation/v1', graphId: scope.graphId, sessionId: scope.sessionId, runId, basis, toolName,
    argumentsDigest: taggedSha256Digest('animalge:arguments:v1', invocationMaterial),
    resultContentDigest: resultDigest(block), resultBlockCount: block.content.length, isError: block.isError === true,
    ...(error === undefined ? {} : { errorIdentity: error }), outcome, startedAt, endedAt,
    invocationDigest: taggedSha256Digest('animalge:invocation:v1', invocationMaterial),
    selection: selected(selection, toolName), selectionRuleDigest: selection.digest,
    captureContractRevision: 'animalge-capture/v1',
  }
}

/** Fold one complete verified prefix into terminal captures; unmatched starts remain private and emit no capture. */
export function foldCaptures(
  scope: EvidenceGraphScopeV1,
  header: SessionHeader,
  events: readonly SessionEvent[],
  selection: CaptureSelection,
): CaptureFoldResult {
  const calls = new Map<CallId, SessionEvent<'tool/call'>>()
  const assistants = new Map<CallId, Array<{ event: SessionEvent<'assistant/message'>; index: number; block: ToolCallBlock }>>()
  const codeStarts = new Map<CallId, SessionEvent<'tool/code-dispatch-start'>>()
  const terminalIds = new Set<string>()
  const captures: CapturedInvocation[] = []
  const boundaries: CaptureBoundary[] = []
  for (const event of events) {
    const boundary = completionBoundary(event)
    if (boundary !== undefined) boundaries.push(boundary)
    if (event.type === 'assistant/message' && appendSurface(event)) {
      event.data.message.content.forEach((block, index) => {
        if (block.type !== 'tool-call') return
        const list = assistants.get(block.id) ?? []
        list.push({ event, index, block })
        assistants.set(block.id, list)
      })
      continue
    }
    if (event.type === 'tool/call') {
      if (calls.has(event.data.callId)) throw new CaptureError('duplicate_start', `duplicate tool/call '${event.data.callId}'`)
      calls.set(event.data.callId, event)
      continue
    }
    if (event.type === 'tool/code-dispatch-start') {
      if (codeStarts.has(event.data.subCallId)) throw new CaptureError('duplicate_start', `duplicate code dispatch '${event.data.subCallId}'`)
      codeStarts.set(event.data.subCallId, event)
      continue
    }
    if (event.type === 'tool/result') {
      if (!appendSurface(event)) continue
      const block = terminalBlock(event)
      const callId = event.data.message.source.callId
      if (terminalIds.has(`top:${callId}`)) throw new CaptureError('duplicate_terminal', `duplicate tool result '${callId}'`)
      terminalIds.add(`top:${callId}`)
      const call = calls.get(callId)
      if (event.data.error?.code === TOOL_NOT_STARTED) {
        if (call !== undefined || event.sourceEventSeqs !== undefined) throw new CaptureError('capture_identity_conflict', 'not-started repair cannot cite a started call')
        const candidates = assistants.get(callId) ?? []
        if (candidates.length !== 1) throw new CaptureError('capture_identity_conflict', 'not-started repair requires one assistant tool-call block')
        const candidate = candidates[0] as typeof candidates[number]
        if (candidate.block.name === '' || candidate.event.data.turn !== event.data.turn || candidate.event.data.step !== event.data.step) throw new CaptureError('corrupt_pair', 'not-started assistant/result fields differ')
        const basis: InvocationEventBasisV1 = { kind: 'top_level_not_started', callId, assistantEvent: eventRef(header, candidate.event), toolCallBlockIndex: candidate.index, resultEvent: eventRef(header, event) }
        captures.push(capture(scope, basis, candidate.block.name, { kind: 'top_level_not_started', toolName: candidate.block.name, argumentsRaw: candidate.block.arguments }, block, event.data.error, selection, null, event.time))
        continue
      }
      if (call === undefined || call.seq >= event.seq || call.data.turn !== event.data.turn || call.data.step !== event.data.step || block.toolCallId !== callId) throw new CaptureError('corrupt_pair', `tool result '${callId}' has no unique valid start`)
      if (event.data.error?.code === TOOL_OUTCOME_UNKNOWN && (event.data.error.name !== 'ToolOutcomeUnknownError' || event.sourceEventSeqs?.length !== 1 || event.sourceEventSeqs[0] !== call.seq)) {
        throw new CaptureError('capture_identity_conflict', 'outcome-unknown repair must cite its exact call event')
      }
      const basis: InvocationEventBasisV1 = { kind: 'top_level_tool', callId, callEvent: eventRef(header, call), resultEvent: eventRef(header, event) }
      captures.push(capture(scope, basis, call.data.name, { kind: 'top_level_tool', toolName: call.data.name, argumentsRaw: call.data.arguments }, block, event.data.error, selection, call.time, event.time))
      continue
    }
    if (event.type === 'tool/code-dispatch') {
      if (terminalIds.has(`code:${event.data.subCallId}`)) throw new CaptureError('duplicate_terminal', `duplicate code dispatch result '${event.data.subCallId}'`)
      terminalIds.add(`code:${event.data.subCallId}`)
      const start = codeStarts.get(event.data.subCallId)
      if (start === undefined || start.seq >= event.seq
        || start.data.rootCallId !== event.data.rootCallId || start.data.parentCallId !== event.data.parentCallId
        || start.data.name !== event.data.name
        || canonicalDigest(start.data.arguments as JsonValue) !== canonicalDigest(event.data.arguments as JsonValue)) {
        throw new CaptureError('corrupt_pair', `code dispatch '${event.data.subCallId}' has no exact start`)
      }
      const block: ToolResultBlock = { type: 'tool-result', toolCallId: event.data.subCallId, isError: event.data.isError, content: event.data.content }
      const basis: InvocationEventBasisV1 = {
        kind: 'code_mode_dispatch', rootCallId: event.data.rootCallId, parentCallId: event.data.parentCallId, subCallId: event.data.subCallId,
        startEvent: eventRef(header, start), resultEvent: eventRef(header, event),
      }
      captures.push(capture(scope, basis, event.data.name, { kind: 'code_mode_dispatch', toolName: event.data.name, arguments: event.data.arguments as JsonValue }, block, undefined, selection, start.time, event.time))
    }
  }
  return { captures, boundaries, observedNextSeqExclusive: events.at(-1)?.seq === undefined ? 0 : (events.at(-1) as SessionEvent).seq + 1 }
}
