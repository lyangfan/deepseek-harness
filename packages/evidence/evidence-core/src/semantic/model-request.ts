/** Append-then-verify persistence of evidence model requests: fail closed before dispatch (SPEC-04 §6.2). */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { eventRef } from '../capture.ts'
import { newModelCallId } from '../identity.ts'
import type { CompileAttemptId, EvidenceGraphId, SessionEventRefV1, Sha256Digest } from '../types.ts'
import type { EvidenceModelRequestEventData } from './events.ts'
import { EXTRACTOR_REVISION, PROMPT_REVISION, PROJECTION_POLICY_REVISION } from './candidates.ts'
import { COMPILER_REVISION } from '../compiler.ts'

export class ModelRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ModelRequestError'
  }
}

/** Verified request identity: the durable event plus the modelCallId it belongs to. */
export interface VerifiedModelRequest {
  readonly modelCallId: string
  readonly requestEventRef: SessionEventRefV1
  readonly data: EvidenceModelRequestEventData
}

/**
 * Persist one evidence model request strictly before dispatch (SPEC-04 §6.2, D-153):
 * append the log-only event, outer-await flush, then readFrom-verify the event is inside
 * the durable prefix. Any failure throws and the caller must not dispatch (fail closed —
 * no model call, no watermark advance; the deterministic channel continues, D-116).
 */
export async function persistModelRequest(options: {
  readonly ctx: Context
  readonly session: Session
  readonly header: SessionHeader
  readonly graphId: EvidenceGraphId
  readonly attemptId: CompileAttemptId
  readonly requestPayload: JsonValue
  readonly projectionDigest: Sha256Digest
  readonly sourceRefs: readonly SessionEventRefV1[]
  readonly targetNextSeqExclusive: number
  readonly signal?: AbortSignal
}): Promise<VerifiedModelRequest> {
  const modelCallId = newModelCallId()
  const data: EvidenceModelRequestEventData = {
    schemaVersion: 'animalge.evidence.model-request/v1',
    modelCallId,
    graphId: options.graphId,
    attemptId: options.attemptId,
    purpose: 'candidate-semantics',
    requestPayload: options.requestPayload,
    projectionDigest: options.projectionDigest,
    projectionPolicyRevision: PROJECTION_POLICY_REVISION,
    extractorRevision: EXTRACTOR_REVISION,
    promptRevision: PROMPT_REVISION,
    compilerRevision: COMPILER_REVISION,
    schemaRevision: 'animalge.semantic-extraction/v1',
    sourceRefs: options.sourceRefs,
    targetNextSeqExclusive: options.targetNextSeqExclusive,
  }
  const event = options.session.append('evidence/model-request', data)
  if (!(await options.ctx.sessions.flush(options.session))) {
    throw new ModelRequestError('flush_unavailable', `no durability listener participated for Session '${String(options.header.id)}'`)
  }
  const read = await options.ctx.sessionPersistence.readFrom(options.header.id, event.seq, options.signal)
  const persisted = read.events.find(candidate => candidate.seq === event.seq && candidate.type === 'evidence/model-request')
  if (persisted === undefined) {
    throw new ModelRequestError('request_event_not_durable', `model request event ${String(event.seq)} did not reach the durable prefix`)
  }
  return { modelCallId, requestEventRef: eventRef(options.header, event), data }
}
