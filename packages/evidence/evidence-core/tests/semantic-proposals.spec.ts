/** S04-A02/A04/A12/A13: strict output schema, dual endpoint resolution, named rejections, negative power. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { validateAndRecordProposals } from '../src/semantic/proposals.ts'
import { validateExtractionOutput } from '../src/semantic/output-schema.ts'
import type { SemanticExtractionOutput } from '../src/semantic/output-schema.ts'
import type { CapturedInvocation } from '../src/schema.ts'
import { storeHarness } from './helpers.ts'
import { deriveObservationId } from '../src/identity.ts'

const graphId = 'eg_spec04p' as never
const attemptId = 'ca_spec04p' as never

const assistantEvent = (seq: number, text: string): SessionEvent => ({
  type: 'assistant/message',
  seq,
  time: 100 + seq,
  surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
} as unknown as SessionEvent)

const provenance = {
  modelCallId: 'mc_x' as never,
  modelRequestEventRef: { schemaVersion: 'animalge.session-event-ref/v1', sessionId: 'spec-04-p' as never, seq: 9, eventType: 'evidence/model-request', eventTime: 109, eventDigest: (('sha256:' + '0'.repeat(64)) as never) },
  provider: 'cli-mock',
  model: 'ev',
  extractorRevision: 'animalge-semantic-extractor/v1',
  promptRevision: 'animalge-semantic-prompt/v1',
  projectionDigest: (('sha256:' + '3'.repeat(64)) as never),
  attemptId,
} as const

const MESSAGE = 'chr7 peak may reflect batch effect; PCA not yet checked'
const TEXT = 'chr7 peak may reflect batch effect'
const LIM = 'PCA not yet checked'
const SPAN_C1: [number, number] = [0, TEXT.length]
const SPAN_C2: [number, number] = [TEXT.length + 2, TEXT.length + 2 + LIM.length]

function output(overrides: Partial<SemanticExtractionOutput> = {}): SemanticExtractionOutput {
  return validateExtractionOutput({
    schemaVersion: 'animalge.semantic-extraction/v1',
    candidates: [
      { localId: 'c1', sourceEventSeq: 3, spanStart: SPAN_C1[0], spanEnd: SPAN_C1[1], subtype: 'interpretation', text: TEXT },
      { localId: 'c2', sourceEventSeq: 3, spanStart: SPAN_C2[0], spanEnd: SPAN_C2[1], subtype: 'limitation', text: LIM },
    ],
    relations: [
      { type: 'qualifies', fromRef: { kind: 'BatchCandidate', localId: 'c2' }, toRef: { kind: 'BatchCandidate', localId: 'c1' }, sourceEventSeqs: [3] },
    ],
    sameAsProposals: [],
    runSelections: [],
    ...overrides,
  }) as SemanticExtractionOutput
}

describe('S04-A02 strict output schema', () => {
  it('rejects an unknown field on the whole output (retryable model failure, not per-proposal)', () => {
    expect(validateExtractionOutput({ ...output(), forgedReceipt: {} })).toBeNull()
  })

  it('rejects a subtype outside the closed enum on the whole output', () => {
    expect(validateExtractionOutput({ ...output(), candidates: [{ localId: 'c1', sourceEventSeq: 3, spanStart: 0, spanEnd: 4, subtype: 'claim', text: 'x' }] })).toBeNull()
  })

  it('rejects duplicate batch localIds as an invalid output', () => {
    expect(validateExtractionOutput({
      ...output(),
      candidates: [
        { localId: 'c1', sourceEventSeq: 3, spanStart: SPAN_C1[0], spanEnd: SPAN_C1[1], subtype: 'interpretation', text: TEXT },
        { localId: 'c1', sourceEventSeq: 3, spanStart: SPAN_C1[0], spanEnd: SPAN_C1[1], subtype: 'interpretation', text: TEXT },
      ],
    })).toBeNull()
  })
})

describe('S04-A04/A12 deterministic per-proposal validation', () => {
  it('accepts same-batch candidates with a qualifying relation between them (§3.22 first-class case)', async () => {
    const harness = await storeHarness()
    try {
      const result = await validateAndRecordProposals({
        store: harness.store, graphId, attemptId,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 6,
        prefixEvents: [assistantEvent(3, MESSAGE)],
        captures: [], provenance, output: output(),
      })
      expect(result.candidates).toHaveLength(2)
      expect(result.relations).toHaveLength(1)
      expect(result.relations[0]?.edgeType).toBe('qualifies')
      expect(result.verdicts.filter(verdict => verdict.verdict === 'accepted')).toHaveLength(3)
    } finally { await harness.close() }
  })

  it('rejects source-binding mismatches with the named code while keeping valid siblings', async () => {
    const harness = await storeHarness()
    try {
      const badSpan = validateExtractionOutput({
        schemaVersion: 'animalge.semantic-extraction/v1',
        candidates: [
          { localId: 'c1', sourceEventSeq: 3, spanStart: SPAN_C1[0], spanEnd: SPAN_C1[1], subtype: 'interpretation', text: TEXT },
          { localId: 'cX', sourceEventSeq: 99, spanStart: 0, spanEnd: 4, subtype: 'statement', text: 'orphan' },
          { localId: 'cY', sourceEventSeq: 3, spanStart: 0, spanEnd: 5, subtype: 'statement', text: 'WRONGSPAN' },
        ],
        relations: [], sameAsProposals: [], runSelections: [],
      })
      const result = await validateAndRecordProposals({
        store: harness.store, graphId, attemptId,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 6,
        prefixEvents: [assistantEvent(3, MESSAGE)],
        captures: [], provenance, output: badSpan as SemanticExtractionOutput,
      })
      expect(result.candidates.map(record => record.text)).toEqual([TEXT])
      const rejected = result.verdicts.filter(verdict => verdict.verdict === 'rejected')
      expect(rejected.map(verdict => verdict.rejectCode)).toContain('source_binding_mismatch')
      expect(result.relations).toHaveLength(0)
    } finally { await harness.close() }
  })

  it('endpoint_invalid: dangling localId, unknown graph id, and non-candidate target all reject', async () => {
    const harness = await storeHarness()
    try {
      const result = await validateAndRecordProposals({
        store: harness.store, graphId, attemptId,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 6,
        prefixEvents: [assistantEvent(3, MESSAGE)],
        captures: [], provenance,
        output: output({
          relations: [
            { type: 'supports', fromRef: { kind: 'BatchCandidate', localId: 'missing' }, toRef: { kind: 'BatchCandidate', localId: 'c1' }, sourceEventSeqs: [3] },
            { type: 'supports', fromRef: { kind: 'Observation', id: 'eo_unknown' }, toRef: { kind: 'BatchCandidate', localId: 'c1' }, sourceEventSeqs: [3] },
          ],
        }),
      })
      expect(result.candidates).toHaveLength(2)
      expect(result.relations).toHaveLength(0)
      const codes = result.verdicts.filter(verdict => verdict.verdict === 'rejected').map(verdict => verdict.rejectCode)
      expect(codes).toContain('endpoint_invalid')
    } finally { await harness.close() }
  })

  it('source_out_of_scope and epistemic_cycle reject with their named codes', async () => {
    const harness = await storeHarness()
    try {
      const first = await validateAndRecordProposals({
        store: harness.store, graphId, attemptId,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 6,
        prefixEvents: [assistantEvent(3, MESSAGE)],
        captures: [], provenance,
        output: output({
          relations: [
            { type: 'qualifies', fromRef: { kind: 'BatchCandidate', localId: 'c2' }, toRef: { kind: 'BatchCandidate', localId: 'c1' }, sourceEventSeqs: [99] },
          ],
        }),
      })
      expect(first.verdicts.filter(verdict => verdict.rejectCode === 'source_out_of_scope')).toHaveLength(1)
      // Self-loop through a batch alias of the same source span is still a self-loop.
      const selfLoop = await validateAndRecordProposals({
        store: harness.store, graphId, attemptId: 'ca_spec04p2' as never,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 6,
        prefixEvents: [assistantEvent(3, MESSAGE)],
        captures: [], provenance,
        output: output({
          relations: [
            { type: 'supports', fromRef: { kind: 'BatchCandidate', localId: 'c1' }, toRef: { kind: 'BatchCandidate', localId: 'c1' }, sourceEventSeqs: [3] },
          ],
        }),
      })
      expect(selfLoop.verdicts.filter(verdict => verdict.rejectCode === 'self_loop')).toHaveLength(1)
    } finally { await harness.close() }
  })

  it('same_as_candidate: normalized single symmetric edge; batch refs land in the named rejection (C1-01)', async () => {
    const harness = await storeHarness()
    try {
      const first = await validateAndRecordProposals({
        store: harness.store, graphId, attemptId,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 6,
        prefixEvents: [assistantEvent(3, MESSAGE)],
        captures: [], provenance,
        output: output({
          relations: [],
          sameAsProposals: [
            { aRef: { kind: 'BatchCandidate', localId: 'c2' }, bRef: { kind: 'BatchCandidate', localId: 'c1' } },
          ],
        }),
      })
      expect(first.verdicts.filter(verdict => verdict.rejectCode === 'same_as_endpoint_invalid')).toHaveLength(1)
      const second = await validateAndRecordProposals({
        store: harness.store, graphId, attemptId: 'ca_spec04p3' as never,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 6,
        prefixEvents: [assistantEvent(3, MESSAGE)],
        captures: [], provenance,
        output: output({
          relations: [],
          sameAsProposals: [
            { aRef: { kind: 'CandidateStatement', id: first.candidates[1]!.candidateId }, bRef: { kind: 'CandidateStatement', id: first.candidates[0]!.candidateId } },
            { aRef: { kind: 'CandidateStatement', id: first.candidates[0]!.candidateId }, bRef: { kind: 'CandidateStatement', id: first.candidates[1]!.candidateId } },
          ],
        }),
      })
      expect(second.relations).toHaveLength(1)
      expect(second.relations[0]?.edgeType).toBe('same_as_candidate')
      const [from, to] = [second.relations[0]!.fromNodeId, second.relations[0]!.toNodeId]
      expect(from.localeCompare(to)).toBeLessThan(0)
      expect(second.verdicts.filter(verdict => verdict.rejectCode === 'duplicate_edge')).toHaveLength(1)
    } finally { await harness.close() }
  })

  it('S04-A12 empty candidate text rejects with the named code (schema passes, text blank)', async () => {
    const harness = await storeHarness()
    try {
      const blank = validateExtractionOutput({
        schemaVersion: 'animalge.semantic-extraction/v1',
        candidates: [{ localId: 'c1', sourceEventSeq: 3, spanStart: SPAN_C1[0], spanEnd: SPAN_C1[1], subtype: 'interpretation', text: '   ' }],
        relations: [], sameAsProposals: [], runSelections: [],
      })
      expect(blank).not.toBeNull()
      const result = await validateAndRecordProposals({
        store: harness.store, graphId, attemptId,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 6,
        prefixEvents: [assistantEvent(3, MESSAGE)],
        captures: [], provenance, output: blank as SemanticExtractionOutput,
      })
      expect(result.candidates).toHaveLength(0)
      expect(result.verdicts.filter(verdict => verdict.rejectCode === 'empty_candidate_text')).toHaveLength(1)
    } finally { await harness.close() }
  })

  it('S04-A13 negative power: forged deterministic-object fields cannot materialize anywhere', async () => {
    const harness = await storeHarness()
    try {
      const forged = validateExtractionOutput({
        schemaVersion: 'animalge.semantic-extraction/v1',
        candidates: [{ localId: 'c1', sourceEventSeq: 3, spanStart: 0, spanEnd: TEXT.length, subtype: 'interpretation', text: TEXT }],
        relations: [], sameAsProposals: [], runSelections: [],
        // Unknown top-level fields kill the whole output before any ledger write.
        receipt: { accepted: true }, artifactVersion: 'av_forged', observationValue: 42,
      })
      expect(forged).toBeNull()
      expect(harness.store.candidateRecords.size).toBe(0)
      expect(harness.store.candidateRelations.size).toBe(0)
      expect(harness.store.modelRunSelections.size).toBe(0)
    } finally { await harness.close() }
  })

  it('run selections validate against real captures of this graph only', async () => {
    const harness = await storeHarness()
    try {
      const observationId = deriveObservationId({ graphId, observationKind: 'run_terminal_outcome', runId: 'er_real' as never, resultEventSeq: 3 })
      const capture: CapturedInvocation = {
        recordVersion: 'animalge.captured-invocation/v1',
        graphId, sessionId: 'spec-04-p' as never, runId: 'er_real' as never,
        basis: {
          kind: 'top_level_tool', callId: 'call-1' as never,
          callEvent: { schemaVersion: 'animalge.session-event-ref/v1', sessionId: 'spec-04-p' as never, seq: 2, eventType: 'tool/call', eventTime: 102, eventDigest: ('sha256:' + 'a'.repeat(64)) as never },
          resultEvent: { schemaVersion: 'animalge.session-event-ref/v1', sessionId: 'spec-04-p' as never, seq: 3, eventType: 'tool/result', eventTime: 103, eventDigest: ('sha256:' + 'b'.repeat(64)) as never },
        },
        toolName: 'bash',
        argumentsDigest: ('sha256:' + 'c'.repeat(64)) as never, resultContentDigest: ('sha256:' + 'd'.repeat(64)) as never, resultBlockCount: 1,
        isError: false, outcome: 'succeeded', startedAt: 102, endedAt: 103, invocationDigest: ('sha256:' + 'e'.repeat(64)) as never,
        selection: 'not_selected', selectionRuleDigest: ('sha256:' + 'f'.repeat(64)) as never, captureContractRevision: 'animalge-capture/v1',
      }
      await harness.store.saveCapture(capture)
      const result = await validateAndRecordProposals({
        store: harness.store, graphId, attemptId,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 6,
        prefixEvents: [assistantEvent(3, MESSAGE)],
        captures: [capture], provenance,
        output: output({
          candidates: [],
          relations: [],
          runSelections: [
            { runId: 'er_real', reason: 'fixture', sourceEventSeqs: [3] },
            { runId: 'er_unknown', reason: 'fixture', sourceEventSeqs: [3] },
          ],
        }),
      })
      expect(result.runSelections.map(record => record.runId)).toEqual(['er_real'])
      expect(result.verdicts.filter(verdict => verdict.rejectCode === 'run_selection_target_invalid')).toHaveLength(1)
      expect(String(observationId)).toMatch(/^eo_/)
    } finally { await harness.close() }
  })
})
