/** S04-A01(unit)/A03/A05/A06/A14: ledger identity, summaries, snapshot materialization, model_candidate selection. */

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { storeHarness, header } from './helpers.ts'
import { compileSnapshot } from '../src/compiler.ts'
import { materialSnapshotFor } from '../src/materialize.ts'
import { semanticSnapshotFor, deriveCandidateIdentity, candidateNodeIdOf } from '../src/semantic/candidates.ts'
import { foldCaptures, resolveSelection } from '../src/capture.ts'
import { deriveEdgeId } from '../src/identity.ts'
import { verifySnapshot } from '../src/integrity.ts'
import type { CandidateRecordV1, CandidateRelationRecordV1, EvidenceGraphScopeV1, Sha256Digest } from '../src/types.ts'

const graphId = 'eg_spec04l' as never
const scope: EvidenceGraphScopeV1 = { kind: 'session', graphId, sessionId: header.id, sessionCreatedAt: header.createdAt }
const selection = resolveSelection('spec04-ledger/v1', ['bash'])

const TEXT = 'chr7 peak may reflect batch effect'
const LIM = 'PCA not yet checked'

const events = [
  { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
  { type: 'tool/call', seq: 2, time: 102, data: { turn: 1, step: 1, callId: 'call-ledger', name: 'bash', arguments: '{}' } },
  { type: 'tool/result', seq: 3, time: 103, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'tool', source: { callId: 'call-ledger' }, content: [{ type: 'tool-result', toolCallId: 'call-ledger', content: [{ type: 'text', text: 'ok' }] }] } } },
  { type: 'turn/end', seq: 5, time: 105, data: { turn: 1, reason: { kind: 'completed' } } },
] as SessionEvent[]

function candidateRecord(text: string, seq: number, subtype: CandidateRecordV1['subtype'], candidateId: string): CandidateRecordV1 {
  return {
    recordVersion: 'animalge.candidate/v1',
    candidateId: candidateId as never,
    graphId,
    subtype,
    text,
    sourceBinding: {
      kind: 'agent_message',
      sessionId: header.id,
      eventSeq: seq,
      spanStart: 0,
      spanEnd: text.length,
      spanTextDigest: ('sha256:' + '1'.repeat(64)) as Sha256Digest,
      actorRef: 'dsh-agent',
    },
    sourceEventRef: { schemaVersion: 'animalge.session-event-ref/v1', sessionId: header.id, seq, eventType: 'assistant/message', eventTime: 100 + seq, eventDigest: ('sha256:' + '2'.repeat(64)) as Sha256Digest },
    generationProvenance: {
      modelCallId: 'mc_l' as never,
      modelRequestEventRef: { schemaVersion: 'animalge.session-event-ref/v1', sessionId: header.id, seq: 9, eventType: 'evidence/model-request', eventTime: 109, eventDigest: ('sha256:' + '3'.repeat(64)) as Sha256Digest },
      provider: 'cli-mock', model: 'ev',
      extractorRevision: 'animalge-semantic-extractor/v1', promptRevision: 'animalge-semantic-prompt/v1',
      projectionDigest: ('sha256:' + '4'.repeat(64)) as Sha256Digest,
      attemptId: 'ca_l' as never,
    },
    acceptedAt: 1_700_000_000_500,
    acceptedAttemptId: 'ca_l' as never,
  }
}

function relationRecord(edgeType: CandidateRelationRecordV1['edgeType'], from: string, to: string): CandidateRelationRecordV1 {
  return {
    recordVersion: 'animalge.candidate-relation/v1',
    edgeId: deriveEdgeId({ graphId, edgeType, from: from as never, to: to as never }),
    graphId,
    edgeType,
    fromNodeId: from as never,
    toNodeId: to as never,
    provenance: candidateRecord(TEXT, 3, 'interpretation', 'cst_l1').generationProvenance,
    createdAt: 1_700_000_000_600,
    acceptedAttemptId: 'ca_l' as never,
  }
}

let harness: Awaited<ReturnType<typeof storeHarness>>
let folded: ReturnType<typeof foldCaptures>
let observationNodeId: string
let realRunId: string

beforeAll(async () => {
  harness = await storeHarness()
  folded = foldCaptures(scope, header, events, selection)
  for (const capture of folded.captures) await harness.store.saveCapture(capture)
  realRunId = folded.captures[0]!.runId
  const { deriveObservationId, deriveNodeId } = await import('../src/identity.ts')
  observationNodeId = deriveNodeId({ graphId, nodeKind: 'Observation', observationId: deriveObservationId({ graphId, observationKind: 'run_terminal_outcome', runId: realRunId, resultEventSeq: 3 }) })
})

afterAll(async () => {
  await harness.close()
})

function compileWith(options: {
  readonly candidates?: ReadonlyMap<string, CandidateRecordV1>
  readonly relations?: ReadonlyMap<string, CandidateRelationRecordV1>
  readonly runSelections?: ReadonlyMap<string, never>
  readonly watermark?: { kind: 'active'; nextSeqExclusive: number } | { kind: 'disabled'; lastNextSeqExclusive: number }
  readonly captures?: typeof folded.captures
  readonly semantic?: boolean
}) {
  return compileSnapshot({
    scope,
    captures: options.captures ?? folded.captures,
    baseSnapshotDigest: null,
    targetNextSeqExclusive: 6,
    sourceTimeUpperBound: 105,
    selectionRevision: selection.revision,
    selectionRuleDigest: selection.digest,
    material: materialSnapshotFor(harness.store, graphId),
    ...(options.semantic === false ? {} : {
      semantic: {
        ledger: {
          candidates: options.candidates ?? new Map<string, CandidateRecordV1>(),
          relations: options.relations ?? new Map<string, CandidateRelationRecordV1>(),
          runSelections: options.runSelections ?? new Map<string, never>(),
        },
        watermark: options.watermark ?? { kind: 'active' as const, nextSeqExclusive: 6 },
      },
    }),
  })
}

describe('S04-A03 candidate identity (D-124)', () => {
  it('identity derives from source binding + generation position, never from text alone', () => {
    const binding = { kind: 'agent_message' as const, sessionId: header.id, eventSeq: 3, spanStart: 0, spanEnd: TEXT.length, spanTextDigest: ('sha256:' + '0'.repeat(64)) as Sha256Digest, actorRef: 'dsh-agent' }
    const a = deriveCandidateIdentity(graphId, { subtype: 'interpretation', text: TEXT, sourceBinding: binding })
    expect(a).toBe(deriveCandidateIdentity(graphId, { subtype: 'interpretation', text: TEXT, sourceBinding: binding }))
    expect(a).not.toBe(deriveCandidateIdentity(graphId, { subtype: 'interpretation', text: TEXT, sourceBinding: { ...binding, eventSeq: 4 } }))
    expect(a).not.toBe(deriveCandidateIdentity(graphId, { subtype: 'limitation', text: TEXT, sourceBinding: binding }))
  })

  it('re-delivering an identical record is idempotent; divergent bytes collide loudly', async () => {
    const record = candidateRecord(TEXT, 3, 'interpretation', 'cst_l1')
    await harness.store.putMaterialRecord(harness.store.candidateRecords, record.candidateId, record)
    await harness.store.putMaterialRecord(harness.store.candidateRecords, record.candidateId, record)
    expect(harness.store.candidateRecords.size).toBe(1)
    await expect(harness.store.putMaterialRecord(harness.store.candidateRecords, record.candidateId, { ...record, text: 'rewritten' })).rejects.toMatchObject({ code: 'immutable_key_collision' })
  })
})

describe('S04-A01/A05/A06 snapshot materialization', () => {
  it('candidates, summaries, and candidate edges project into the candidate-triple snapshot', () => {
    const c1 = candidateNodeIdOf(graphId, 'cst_l1' as never)
    const c2 = candidateNodeIdOf(graphId, 'cst_l2' as never)
    const payload = compileWith({
      candidates: new Map([
        ['cst_l1', candidateRecord(TEXT, 3, 'interpretation', 'cst_l1')],
        ['cst_l2', candidateRecord(LIM, 4, 'limitation', 'cst_l2')],
      ]),
      relations: new Map([
        ['e1', relationRecord('qualifies', c2, c1)],
        ['e2', relationRecord('supports', observationNodeId, c1)],
      ]),
    })
    expect(payload.schemaSet).toEqual(['animalge.evidence.core/v1', 'animalge.evidence.material/v1', 'animalge.evidence.candidate/v1'])
    const candidates = payload.nodes.filter(node => node.nodeKind === 'CandidateStatement')
    expect(candidates).toHaveLength(2)
    expect((candidates.find(node => node.nodeId === c1)?.payload as CandidateRecordV1 extends never ? never : { relationSummary: { summary: string; activeSupports: number; activeQualifies: number } }).relationSummary).toMatchObject({ summary: 'support_only', activeSupports: 1, activeQualifies: 1 })
    expect((candidates.find(node => node.nodeId === c2)?.payload as { relationSummary: { summary: string } }).relationSummary).toMatchObject({ summary: 'no_active_evidence' })
    expect(payload.semanticWatermark).toEqual({ kind: 'active', nextSeqExclusive: 6 })
  })

  it('contradicts flips the summary to mixed; the disabled watermark expression round-trips', () => {
    const c1 = candidateNodeIdOf(graphId, 'cst_l1' as never)
    const c2 = candidateNodeIdOf(graphId, 'cst_l2' as never)
    const payload = compileWith({
      candidates: new Map([
        ['cst_l1', candidateRecord(TEXT, 3, 'interpretation', 'cst_l1')],
        ['cst_l2', candidateRecord(LIM, 4, 'limitation', 'cst_l2')],
      ]),
      relations: new Map([
        ['e1', relationRecord('supports', c2, c1)],
        ['e2', relationRecord('contradicts', c2, c1)],
      ]),
      watermark: { kind: 'disabled', lastNextSeqExclusive: 4 },
    })
    expect((payload.nodes.find(node => node.nodeId === c1)?.payload as { relationSummary: { summary: string; activeSupports: number; activeContradicts: number } }).relationSummary).toMatchObject({ summary: 'mixed', activeSupports: 1, activeContradicts: 1 })
    expect(payload.semanticWatermark).toEqual({ kind: 'disabled', lastNextSeqExclusive: 4 })
  })

  it('S04-A14 model_candidate selectionBasis selects an unselected run and never upgrades capture facts', () => {
    const unselected = folded.captures.map(capture => ({ ...capture, selection: 'not_selected' as const }))
    const payload = compileWith({
      captures: unselected,
      runSelections: new Map([[realRunId, {
        recordVersion: 'animalge.model-run-selection/v1',
        runId: realRunId,
        graphId,
        modelCallId: 'mc_l' as never,
        attemptId: 'ca_l' as never,
        modelRequestEventRef: candidateRecord(TEXT, 3, 'interpretation', 'cst_l1').generationProvenance.modelRequestEventRef,
        reason: 'fixture',
        createdAt: 1_700_000_000_700,
      } as never]]),
    })
    const runs = payload.nodes.filter(node => node.nodeKind === 'Run')
    expect(runs).toHaveLength(1)
    expect((runs[0]?.payload as { selectionBasis: { kind: string } }).selectionBasis.kind).toBe('model_candidate')
    // Capture facts stay event-owned: the payload still carries the event basis verbatim.
    expect((runs[0]?.payload as { captureKind: string }).captureKind).toBe('event')
  })

  it('unconfigured semantics keep legacy snapshot bytes and still verify', () => {
    const payload = compileWith({ semantic: false })
    expect(payload.schemaSet).toEqual(['animalge.evidence.core/v1', 'animalge.evidence.material/v1'])
    expect(payload.semanticWatermark).toEqual({ nextSeqExclusive: 0 })
    expect(verifySnapshot(payload)).toBeDefined()
  })

  it('C1-01/C2-01 regression: proposal→ledger→snapshot round-trip keeps Observation endpoints graph-resident', async () => {
    // Route through the REAL proposal validator (resolveEndpoint), never hand-built
    // records: the model proposes a relation from a selected run's Observation handle,
    // and the accepted edge must carry the derived en_ node id that verifySnapshot
    // recomputes. A pending run's handle must be rejected outright (endpoint_invalid).
    const { deriveObservationId } = await import('../src/identity.ts')
    const { validateAndRecordProposals } = await import('../src/semantic/proposals.ts')
    const selected = folded.captures[0] as NonNullable<typeof folded.captures[0]>
    const pending = { ...selected, runId: ('er_pending' + Math.random().toString(36).slice(2, 8)) as never, selection: 'not_selected' as const } as NonNullable<typeof folded.captures[0]>
    const selectedObservation = String(deriveObservationId({ graphId, observationKind: 'run_terminal_outcome', runId: selected.runId, resultEventSeq: selected.basis.resultEvent.seq }))
    const pendingObservation = String(deriveObservationId({ graphId, observationKind: 'run_terminal_outcome', runId: pending.runId, resultEventSeq: pending.basis.resultEvent.seq }))
    const result = await validateAndRecordProposals({
      store: harness.store,
      graphId,
      attemptId: 'ca_c2reg' as never,
      fromNextSeqExclusive: 0,
      targetNextSeqExclusive: 6,
      prefixEvents: [{ type: 'assistant/message', seq: 3, time: 103, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: TEXT }] } } } as never],
      captures: [selected, pending],
      provenance: {
        modelCallId: 'mc_c2',
        modelRequestEventRef: candidateRecord(TEXT, 3, 'interpretation', 'cst_l1').generationProvenance.modelRequestEventRef,
        provider: 'cli-mock', model: 'ev',
        extractorRevision: 'animalge-semantic-extractor/v1', promptRevision: 'animalge-semantic-prompt/v1',
        projectionDigest: ('sha256:' + '9'.repeat(64)) as never,
        attemptId: 'ca_c2reg' as never,
      },
      output: {
        schemaVersion: 'animalge.semantic-extraction/v1',
        candidates: [{ localId: 'c1', sourceEventSeq: 3, spanStart: 0, spanEnd: TEXT.length, subtype: 'conclusion', text: TEXT }],
        relations: [
          { type: 'supports', fromRef: { kind: 'Observation', id: selectedObservation }, toRef: { kind: 'BatchCandidate', localId: 'c1' }, sourceEventSeqs: [3] },
          { type: 'supports', fromRef: { kind: 'Observation', id: pendingObservation }, toRef: { kind: 'BatchCandidate', localId: 'c1' }, sourceEventSeqs: [3] },
        ],
        sameAsProposals: [],
        runSelections: [],
      },
    })
    const accepted = result.relations.filter(relation => relation.edgeType === 'supports')
    expect(accepted).toHaveLength(1)
    expect(String(accepted[0]?.fromNodeId)).toMatch(/^en_/)
    expect(String(accepted[0]?.fromNodeId)).not.toMatch(/^eo_/)
    expect(result.verdicts.filter(verdict => verdict.rejectCode === 'endpoint_invalid')).toHaveLength(1)
    // The ledger edge survives a full snapshot compile (verifySnapshot inside) — both
    // endpoints must be graph-resident in the SAME projection.
    const ledgerCandidates = new Map(result.candidates.map(record => [String(record.candidateId), record]))
    const payload = compileWith({ candidates: ledgerCandidates, relations: new Map([['e1', accepted[0] as never]]) })
    expect(payload.edges.length).toBeGreaterThanOrEqual(1)
  })

  it('R2-01 regression: receipt-accepted and model-selected runs are graph-resident endpoints', async () => {
    // Route through the REAL validator: an accepted receipt makes a run's Observation a
    // legal relation endpoint (three-way predicate), and a model-selection proposal for
    // that same run is rejected with run_selection_target_invalid (§8.1/§8.2).
    const { deriveObservationId } = await import('../src/identity.ts')
    const { validateAndRecordProposals } = await import('../src/semantic/proposals.ts')
    const selected = folded.captures[0] as NonNullable<typeof folded.captures[0]>
    const receiptRun = { ...selected, runId: ('er_receipt' + Math.random().toString(36).slice(2, 6)) as never, selection: 'not_selected' as const } as NonNullable<typeof folded.captures[0]>
    const receiptObservation = String(deriveObservationId({ graphId, observationKind: 'run_terminal_outcome', runId: receiptRun.runId, resultEventSeq: receiptRun.basis.resultEvent.seq }))
    // Register an accepted receipt for the receipt-run (material path).
    const receiptKey = 'rs_r2' + Math.random().toString(36).slice(2, 8)
    await harness.store.putMaterialRecord(harness.store.receiptSubmissions, receiptKey, {
      recordVersion: 'animalge.receipt-submission/v1',
      receiptId: receiptKey as never,
      receiptSchemaRevision: 'animalge.evidence.receipt/v1',
      submissionDigest: ('sha256:' + '1'.repeat(64)) as never,
      submittedAt: 1, providerId: 'animalge-declarative-runner', providerVersion: 'v0', captureProfileId: 'sci-code:bash', captureProfileRevision: 'v1',
      evidenceGraphId: graphId, sessionId: header.id, runId: receiptRun.runId,
      invocationBasis: { kind: 'direct', callId: 'call-r2' as never, startEventRef: null },
      expectedResultLocator: { sessionId: header.id, callId: 'call-r2' as never },
      operation: { toolName: 'bash' },
      invocationDigest: ('sha256:' + '2'.repeat(64)) as never,
      lifecycle: { startedAt: 1, endedAt: 2 },
      outcome: 'succeeded',
      components: {
        inputs: { state: 'missing', reason: null, ownerRefs: [], captureBasis: null },
        outputs: { state: 'missing', reason: null, ownerRefs: [], captureBasis: null },
        softwareAndCode: { state: 'missing', reason: null, ownerRefs: [], captureBasis: null },
        environment: { state: 'missing', reason: null, ownerRefs: [], captureBasis: null },
        parameters: { state: 'missing', reason: null, ownerRefs: [], captureBasis: null },
        randomness: { state: 'missing', reason: null, ownerRefs: [], captureBasis: null },
        logs: { state: 'missing', reason: null, ownerRefs: [], captureBasis: null },
      },
      extensions: [],
    } as never)
    const submissionKey = [...harness.store.receiptSubmissions.entries()].filter(([, row]) => row.runId === receiptRun.runId)[0]
    const submission = submissionKey?.[1]
    if (submission !== undefined) {
      const acceptanceKey = 'ra_r2' + Math.random().toString(36).slice(2, 8)
      await harness.store.putMaterialRecord(
        harness.store.receiptAcceptances,
        acceptanceKey,
        {
          recordVersion: 'animalge.receipt-acceptance/v1',
          acceptanceId: acceptanceKey as never,
          receiptId: submission.receiptId,
          submissionDigest: submission.submissionDigest,
          acceptedAt: 1,
          pairedStartRef: candidateRecord(TEXT, 3, 'interpretation', 'cst_l1').sourceEventRef,
          pairedResultRef: candidateRecord(TEXT, 3, 'interpretation', 'cst_l1').sourceEventRef,
          acceptanceDigest: ('sha256:' + '3'.repeat(64)) as never,
          verdict: 'accepted',
          rejectedReason: null,
          componentVerdicts: {
            inputs: 'not_applicable', outputs: 'not_applicable', softwareAndCode: 'not_applicable',
            environment: 'not_applicable', parameters: 'not_applicable', randomness: 'not_applicable', logs: 'not_applicable',
          },
          receiptAcceptance: 'accepted',
        } as never,
      )
    }
    const result = await validateAndRecordProposals({
      store: harness.store,
      graphId,
      attemptId: 'ca_r2reg' as never,
      fromNextSeqExclusive: 0,
      targetNextSeqExclusive: 6,
      prefixEvents: [{ type: 'assistant/message', seq: 3, time: 103, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: TEXT }] } } } as never],
      captures: [selected, receiptRun],
      provenance: {
        modelCallId: 'mc_r2',
        modelRequestEventRef: candidateRecord(TEXT, 3, 'interpretation', 'cst_l1').generationProvenance.modelRequestEventRef,
        provider: 'cli-mock', model: 'ev',
        extractorRevision: 'animalge-semantic-extractor/v1', promptRevision: 'animalge-semantic-prompt/v1',
        projectionDigest: ('sha256:' + '9'.repeat(64)) as never,
        attemptId: 'ca_r2reg' as never,
      },
      output: {
        schemaVersion: 'animalge.semantic-extraction/v1',
        candidates: [{ localId: 'c1', sourceEventSeq: 3, spanStart: 0, spanEnd: TEXT.length, subtype: 'limitation', text: TEXT }],
        relations: [
          { type: 'supports', fromRef: { kind: 'Observation', id: receiptObservation }, toRef: { kind: 'BatchCandidate', localId: 'c1' }, sourceEventSeqs: [3] },
        ],
        sameAsProposals: [],
        runSelections: [{ runId: receiptRun.runId, reason: 'x', sourceEventSeqs: [3] }],
      },
    })
    // The receipt-accepted run's Observation is a legal endpoint (accepted, en_ identity).
    expect(result.relations).toHaveLength(1)
    expect(String(result.relations[0]?.fromNodeId)).toMatch(/^en_/)
    // But proposing a model selection for that same run is rejected (§8.1).
    expect(result.verdicts.filter(verdict => verdict.rejectCode === 'run_selection_target_invalid')).toHaveLength(1)
    expect(result.runSelections).toHaveLength(0)
  })

  it('S04-A03 replay: the same ledger state recomputes identical snapshot bytes', () => {
    const build = () => compileWith({
      candidates: new Map([['cst_l1', candidateRecord(TEXT, 3, 'interpretation', 'cst_l1')]]),
    })
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()))
    expect(semanticSnapshotFor(harness.store, graphId).candidates.size).toBeGreaterThanOrEqual(1)
  })
})
