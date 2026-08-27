/** S02-A07/A08/A09/A13: acceptance-lane pairing, two-phase timing, rejections, idempotency, requeue. */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { registerSuiteSummary } from './summary.ts'
import { materialHarness } from './helpers.ts'
import { persistReceiptSubmission, capturedComponent, missingComponent } from '../src/receipt.ts'
import { deriveRunId } from '../src/identity.ts'
import { eventRef } from '../src/capture.ts'
import { canonicalDigest } from '../src/canonical-json.ts'
import { newReceiptSubmissionId } from '../src/identity.ts'
import type { ReceiptSubmission } from '../src/schema.ts'

const CALL = CallId('call-lane-1')
const SESSION = SessionId('spec-02-lane')

function appendToolCall(session: Session, callId = CALL): number {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const call = session.events[session.events.length - 1] as SessionEvent
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'sci_run_code', arguments: '{}' })
  return session.events[session.events.length - 1]?.seq ?? call.seq
}

function appendToolResult(session: Session, callId = CALL): number {
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session.events[session.events.length - 1]?.seq ?? 0
}

async function craftSubmission(harness: Awaited<ReturnType<typeof materialHarness>>, options: {
  readonly runIdOverride?: string
  readonly graphIdOverride?: string
  readonly providerId?: string
  readonly submissionDigestOverride?: string
  readonly components?: ReceiptSubmission['components']
} = {}) {
  const bootstrap = harness.store.sessionGraphs.get(SESSION)
  const graphId = options.graphIdOverride ?? bootstrap?.graphId ?? ''
  const persisted = await harness.ctx.sessionPersistence.readFrom(SESSION, 0)
  const callEvent = persisted.events.find(event => event.type === 'tool/call' && event.data.callId === CALL)
  const runId = options.runIdOverride ?? deriveRunId({ graphId, basisKind: 'top_level_tool', sessionId: SESSION, callEventSeq: callEvent?.seq ?? 2, callId: CALL })
  if (options.providerId !== undefined || options.submissionDigestOverride !== undefined) {
    const envelope = {
      recordVersion: 'animalge.receipt-submission/v1',
      receiptId: newReceiptSubmissionId(),
      receiptSchemaRevision: 'animalge.evidence.receipt/v1',
      submissionDigest: options.submissionDigestOverride ?? canonicalDigest('placeholder'),
      submittedAt: Date.now(),
      providerId: options.providerId ?? 'animalge-declarative-runner',
      providerVersion: 'spec02-runner/v1',
      captureProfileId: 'runner:bash',
      captureProfileRevision: 'bash',
      evidenceGraphId: graphId,
      sessionId: SESSION,
      runId: runId as never,
      invocationBasis: { kind: 'direct', callId: CALL, startEventRef: callEvent === undefined ? null : eventRef(persisted.meta, callEvent) },
      expectedResultLocator: { sessionId: SESSION, callId: CALL },
      operation: { toolName: 'sci_run_code', languageProfile: 'bash' },
      invocationDigest: canonicalDigest('invocation'),
      lifecycle: { startedAt: 1, endedAt: 2 },
      outcome: 'succeeded' as const,
      components: options.components ?? {
        inputs: missingComponent('none'), outputs: missingComponent('none'), softwareAndCode: missingComponent('none'),
        environment: missingComponent('none'), parameters: missingComponent('none'),
        randomness: missingComponent('randomness_not_assessed_v0.1'), logs: missingComponent('none'),
      },
      extensions: [],
    }
    const { submissionDigest: _envelopeDigest, ...envelopeRest } = envelope as Record<string, unknown>
    const submission = { ...envelope, submissionDigest: options.submissionDigestOverride ?? canonicalDigest(
      envelopeRest as never) } as unknown as ReceiptSubmission
    await harness.store.putMaterialRecord(harness.store.receiptSubmissions, submission.receiptId, submission)
    await harness.lane.registerPending(SESSION, submission.receiptId)
    return submission
  }
  const submission = await persistReceiptSubmission(harness.store, {
    evidenceGraphId: graphId as never,
    sessionId: SESSION,
    runId: runId as never,
    invocationBasis: { kind: 'direct', callId: CALL, startEventRef: callEvent === undefined ? null : eventRef(persisted.meta, callEvent) },
    expectedResultCallId: CALL,
    toolName: 'sci_run_code',
    languageProfile: 'bash',
    invocationDigest: canonicalDigest('invocation'),
    lifecycle: { startedAt: 1, endedAt: 2 },
    outcome: 'succeeded',
    components: options.components ?? {
      inputs: missingComponent('none'), outputs: missingComponent('none'), softwareAndCode: missingComponent('none'),
      environment: missingComponent('none'), parameters: missingComponent('none'),
      randomness: missingComponent('randomness_not_assessed_v0.1'), logs: missingComponent('none'),
    },
  })
  await harness.lane.registerPending(SESSION, submission.receiptId)
  return submission
}

type AcceptanceRow = { receiptId: string; verdict: 'accepted' | 'rejected'; rejectedReason: string | null; pairedResultRef: { seq: number } }
function acceptancesOf(harness: Awaited<ReturnType<typeof materialHarness>>): AcceptanceRow[] {
  return [...harness.store.receiptAcceptances.entries()].map(([, row]) => row as unknown as AcceptanceRow)
}

describe('S02-A07 two-phase timing', () => {
  it('keeps the delivery pending while only the submission exists (no result event)', async () => {
    const harness = await materialHarness()
    const session = await harness.createSession(SESSION)
    appendToolCall(session)
    await harness.ctx.sessions.flush(session)
    await craftSubmission(harness)
    await harness.lane.processSession(session.header, false)
    expect(acceptancesOf(harness)).toHaveLength(0)
    expect(harness.store.receiptLaneFor(SESSION)?.pendingSubmissions).toHaveLength(1)
    await harness.close()
  })

  it('creates the AcceptanceRecord only after the real persisted result event pair verifies', async () => {
    const harness = await materialHarness()
    const session = await harness.createSession(SESSION)
    appendToolCall(session)
    await harness.ctx.sessions.flush(session)
    const submission = await craftSubmission(harness)
    appendToolResult(session)
    await harness.ctx.sessions.flush(session)
    await harness.lane.processSession(session.header, false)
    const records = acceptancesOf(harness)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ receiptId: submission.receiptId, verdict: 'rejected' })
    // All-missing components: rejected for the empty-receipt reason, never receipt-backed.
    expect(records[0]?.rejectedReason).toBe('no_verified_component')
    await harness.close()
  })
})

describe('S02-A08 accepted closure', () => {
  it('accepts a verified component delivery, advances the lane watermark, and requeues receipt_accepted', async () => {
    const harness = await materialHarness()
    const session = await harness.createSession(SESSION)
    appendToolCall(session)
    await harness.ctx.sessions.flush(session)
    const inputPath = join(harness.root, 'lane-input.txt')
    await writeFile(inputPath, 'lane-bytes', 'utf8')
    const captured = await harness.artifacts.captureFile({ role: 'input', locator: inputPath }, { createdBy: 'runner_input' })
    const submission = await craftSubmission(harness, {
      components: {
        inputs: capturedComponent([captured.artifactVersionId]),
        outputs: missingComponent('output_absent'), softwareAndCode: missingComponent('none'),
        environment: missingComponent('none'), parameters: missingComponent('none'),
        randomness: missingComponent('randomness_not_assessed_v0.1'), logs: missingComponent('none'),
      },
    })
    const resultSeq = appendToolResult(session)
    await harness.ctx.sessions.flush(session)
    await harness.lane.processSession(session.header, false)
    const record = acceptancesOf(harness)[0]
    expect(record).toMatchObject({ receiptId: submission.receiptId, verdict: 'accepted' })
    expect(record?.pairedResultRef.seq).toBe(resultSeq - 2) // the tool/result event seq
    expect(harness.store.receiptLaneFor(SESSION)).toMatchObject({ nextSeqExclusive: resultSeq - 1, pendingSubmissions: [] })
    const outboxRow = harness.store.outbox.get((harness.store.sessionGraphs.get(SESSION)?.graphId) as never)
    expect(outboxRow?.reasonCounts).toMatchObject({ receipt_accepted: 1 })
    await harness.close()
  })
})

describe('S02-A09 core-identity rejections', () => {
  it('rejects the whole delivery on a runId derivation mismatch while keeping the submission', async () => {
    const harness = await materialHarness()
    const session = await harness.createSession(SESSION)
    appendToolCall(session)
    appendToolResult(session)
    await harness.ctx.sessions.flush(session)
    await craftSubmission(harness, { runIdOverride: 'er_wrongbutwellformed000000000000000000000000000' })
    await harness.lane.processSession(session.header, false)
    const record = acceptancesOf(harness)[0]
    expect(record?.verdict).toBe('rejected')
    expect(record?.rejectedReason).toBe('run_id_mismatch')
    expect(harness.store.receiptSubmissions.size).toBe(1)
    await harness.close()
  })

  it('rejects on scope mismatch when the claimed Graph differs from the bootstrap mapping', async () => {
    const harness = await materialHarness()
    const session = await harness.createSession(SESSION)
    appendToolCall(session)
    appendToolResult(session)
    await harness.ctx.sessions.flush(session)
    await craftSubmission(harness, { graphIdOverride: 'eg_othergraph0000' })
    await harness.lane.processSession(session.header, false)
    expect(acceptancesOf(harness)[0]?.rejectedReason).toBe('scope_mismatch')
    await harness.close()
  })

  it('rejects on an unregistered producer identity', async () => {
    const harness = await materialHarness()
    const session = await harness.createSession(SESSION)
    appendToolCall(session)
    appendToolResult(session)
    await harness.ctx.sessions.flush(session)
    await craftSubmission(harness, { providerId: 'rogue-producer' })
    await harness.lane.processSession(session.header, false)
    expect(acceptancesOf(harness)[0]?.rejectedReason).toBe('producer_not_registered')
    await harness.close()
  })

  it('rejects on a submission digest mismatch', async () => {
    const harness = await materialHarness()
    const session = await harness.createSession(SESSION)
    appendToolCall(session)
    appendToolResult(session)
    await harness.ctx.sessions.flush(session)
    await craftSubmission(harness, { submissionDigestOverride: 'sha256:' + 'f'.repeat(64) })
    await harness.lane.processSession(session.header, false)
    expect(acceptancesOf(harness)[0]?.rejectedReason).toBe('submission_digest_mismatch')
    await harness.close()
  })
})

describe('S02-A13 idempotency and recovery', () => {
  it('is idempotent across repeated lane passes and restart-style recovery scans', async () => {
    const harness = await materialHarness()
    const session = await harness.createSession(SESSION)
    appendToolCall(session)
    await harness.ctx.sessions.flush(session)
    const inputPath = join(harness.root, 'lane-input2.txt')
    await writeFile(inputPath, 'stable', 'utf8')
    const captured = await harness.artifacts.captureFile({ role: 'input', locator: inputPath }, { createdBy: 'runner_input' })
    await craftSubmission(harness, {
      components: {
        inputs: capturedComponent([captured.artifactVersionId]),
        outputs: missingComponent('output_absent'), softwareAndCode: missingComponent('none'),
        environment: missingComponent('none'), parameters: missingComponent('none'),
        randomness: missingComponent('randomness_not_assessed_v0.1'), logs: missingComponent('none'),
      },
    })
    appendToolResult(session)
    await harness.ctx.sessions.flush(session)
    await harness.lane.processSession(session.header, false)
    await harness.lane.processSession(session.header, false)
    await harness.lane.recoverPending(() => true)
    expect(harness.store.receiptAcceptances.size).toBe(1)
    await harness.close()
  })

})

registerSuiteSummary({ suiteId: 'acceptance-lane', acceptanceIds: ['S02-A07', 'S02-A08', 'S02-A09', 'S02-A13'], sessionPersistence: ['jsonl'], evidenceStorage: ['memory'] })
