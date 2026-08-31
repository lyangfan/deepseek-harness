// SPEC-05 §4 read API, behaviorally: the four-state navigation resolution, per-kind object
// technical details, receipt acceptance presentation, and the cursor codec — through the
// real service instance over a committed fixture Snapshot, plus direct unit drives of the
// pure query helpers with synthetic payloads. Wrong implementations that mis-resolve a
// navigation target, fabricate a receipt state, or accept a drifting cursor are defeated.
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { EvidenceService } from '../src/index.ts'
import { decodeCursor, encodeCursor, CANDIDATES_PAGE_SIZE, navigateWithin, detailsOf } from '../src/internal.ts'
// Cross-package relative test import (established pattern).
import { compiledFixture, storeHarness } from '../../evidence-core/tests/helpers.ts'
import { snapshotRecord } from '../../evidence-core/src/integrity.ts'
import type { EvidenceNodeV1, EvidenceSnapshotPayloadV1 } from '@deepseek-ai/dsh-evidence-core/types'
import type { ObjectDetails } from '../src/types.ts'

const SESSION = 'sess_readapi01' as never
const GRAPH = 'eg_readapi01' as never

/** Service over a store whose committed fixture carries one event-backed Run (bash). */
interface FixtureFace {
  service: EvidenceService
  store: Awaited<ReturnType<typeof storeHarness>>['store']
  digest: string
  runCallId: string
  close: () => Promise<void>
}

async function serviceWithFixture(): Promise<FixtureFace> {
  const harness = await storeHarness()
  const ctx = new Context()
  ctx.provide('evidenceStore', harness.store)
  const service = new EvidenceService(ctx, {
    preview: { fragmentMaxBytes: 1, textMaxLines: 1, tableMaxRows: 1, tableMaxColumns: 1, tableMaxCells: 1 },
  })
  // The fixture binds its own session/graph identity; align the bootstrap to it.
  const fixtureSession = 'spec-01-session' as never
  const fixtureGraph = 'eg_spec01fixture' as never
  const record = snapshotRecord(compiledFixture().payload)
  await harness.store.snapshots.put(record.snapshotDigest, record)
  await harness.store.headCommits.put('hc_readapi01' as never, {
    recordVersion: 'animalge.head-commit/v1',
    graphId: fixtureGraph,
    headRevision: 1,
    previousSnapshotDigest: null,
    snapshotDigest: record.snapshotDigest,
    kind: 'compile',
    operationId: 'op_readapi01',
    committedAt: 1,
  })
  await harness.store.heads.put(fixtureGraph, {
    recordVersion: 'animalge.current-head/v1',
    graphId: fixtureGraph,
    snapshotDigest: record.snapshotDigest,
    headRevision: 1,
    previousSnapshotDigest: null,
    previousHeadRevision: null,
  })
  await harness.store.sessionGraphs.put(fixtureSession, {
    recordVersion: 'animalge.session-graph-bootstrap/v1',
    sessionId: fixtureSession,
    sessionCreatedAt: 1,
    graphId: fixtureGraph,
    initialScope: { kind: 'session', graphId: fixtureGraph, sessionId: fixtureSession, sessionCreatedAt: 1 },
    state: 'ready',
  })
  void SESSION
  void GRAPH
  return {
    service,
    store: harness.store,
    digest: record.snapshotDigest,
    runCallId: 'call-spec-01',
    close: async () => {
      await harness.close()
      await ctx.fiber.dispose()
    },
  }
}

const agentOf = (sessionId: string): never => ({ session: { id: sessionId } }) as never

describe('cursor codec (§4.4)', () => {
  it('round-trips a cursor binding', () => {
    const cursor = encodeCursor('sha256:abc', ['conclusion', 'hypothesis'], 'cst_last')
    const decoded = decodeCursor(cursor, 'sha256:abc', ['conclusion', 'hypothesis'])
    expect('lastSeenCandidateId' in decoded).toBe(true)
    if ('lastSeenCandidateId' in decoded) expect(decoded.lastSeenCandidateId).toBe('cst_last')
  })

  it('rejects a cursor bound to a different snapshot (cursor_out_of_scope)', () => {
    const cursor = encodeCursor('sha256:abc', [], 'cst_last')
    const decoded = decodeCursor(cursor, 'sha256:def', [])
    expect('invalid' in decoded).toBe(true)
  })

  it('rejects a cursor with different filters', () => {
    const cursor = encodeCursor('sha256:abc', ['conclusion'], 'cst_last')
    const decoded = decodeCursor(cursor, 'sha256:abc', ['hypothesis'])
    expect('invalid' in decoded).toBe(true)
  })

  it('rejects a malformed cursor string and tampered JSON fields', () => {
    expect('invalid' in decodeCursor('!!!not-base64!!!', 'sha256:abc', [])).toBe(true)
    // A cursor whose kind/sort fields were tampered with must fail validation, not parse.
    const tampered = Buffer.from(JSON.stringify({ kind: 'other', sort: 'x', binding: 'sha256:abc', lastSeenCandidateId: 'cst_1' }), 'utf8').toString('base64url')
    expect('invalid' in decodeCursor(tampered, 'sha256:abc', [])).toBe(true)
  })

  it('candidates page size is frozen at 50', () => {
    expect(CANDIDATES_PAGE_SIZE).toBe(50)
  })
})

describe('navigate (§4.8, through the service over the committed fixture)', () => {
  it('resolves a known tool_call to its Run (found) and binds the snapshot digest', async () => {
    const face = await serviceWithFixture()
    try {
      const response = face.service.navigate(agentOf('spec-01-session'), {
        snapshotDigest: face.digest,
        source: { kind: 'tool_call', callId: face.runCallId },
      })
      expect(response.ok).toBe(true)
      if (!response.ok) return
      expect(response.resolution.result).toBe('found')
      if (response.resolution.result === 'found') {
        expect(response.resolution.target.kind).toBe('Run')
      }
    } finally { await face.close() }
  })

  it('resolves an unknown tool_call and session_event sources to not_in_snapshot', async () => {
    const face = await serviceWithFixture()
    try {
      const unknownTool = face.service.navigate(agentOf('spec-01-session'), { snapshotDigest: face.digest, source: { kind: 'tool_call', callId: 'call-missing' } })
      expect(unknownTool.ok && unknownTool.resolution.result === 'not_in_snapshot').toBe(true)
      const event = face.service.navigate(agentOf('spec-01-session'), { snapshotDigest: face.digest, source: { kind: 'session_event', eventSeq: 3 } })
      // §4.8: SourceAssertion nodes fail closed in v0.1 — the honest resolution is not_in_snapshot.
      expect(event.ok && event.resolution.result === 'not_in_snapshot').toBe(true)
    } finally { await face.close() }
  })
})

describe('navigateWithin four states (§4.8, synthetic payloads)', () => {
  const runNode = (id: string, callId: string): EvidenceNodeV1 => ({
    nodeKind: 'Run',
    nodeId: `en_${id}` as never,
    projectionState: 'active',
    payloadSchema: 'animalge.run.event-backed/v1',
    payload: { primaryCallId: callId },
  } as never)
  const payloadWith = (...nodes: EvidenceNodeV1[]): EvidenceSnapshotPayloadV1 => ({ nodes, edges: [] } as never)

  it('single match → found; no match → not_in_snapshot; session_event → fail-closed not_in_snapshot', () => {
    const payload = payloadWith(runNode('a', 'call_1'))
    const found = navigateWithin(payload, { snapshotDigest: 'sha256:s', source: { kind: 'tool_call', callId: 'call_1' } })
    expect(found).toMatchObject({ result: 'found' })
    const missing = navigateWithin(payload, { snapshotDigest: 'sha256:s', source: { kind: 'tool_call', callId: 'call_x' } })
    expect(missing).toEqual({ result: 'not_in_snapshot' })
    const event = navigateWithin(payload, { snapshotDigest: 'sha256:s', source: { kind: 'session_event', eventSeq: 5 } })
    expect(event).toEqual({ result: 'not_in_snapshot' })
  })

  it('two matches → multiple with alternatives (the user chooses, §10)', () => {
    const payload = payloadWith(runNode('a', 'call_1'), runNode('b', 'call_1'))
    const multiple = navigateWithin(payload, { snapshotDigest: 'sha256:s', source: { kind: 'tool_call', callId: 'call_1' } })
    expect(multiple.result).toBe('multiple')
    if (multiple.result === 'multiple') expect(multiple.alternatives).toHaveLength(2)
  })

  it('artifact_version resolves only exact ArtifactVersion identities; excluded nodes never match', () => {
    const artifactNode: EvidenceNodeV1 = {
      nodeKind: 'ArtifactVersion',
      nodeId: 'en_av' as never,
      projectionState: 'active',
      payloadSchema: 'animalge.artifact.version-node/v1',
      payload: { artifactVersionId: 'av_1' },
    } as never
    const excluded: EvidenceNodeV1 = { ...runNode('x', 'call_9'), projectionState: 'excluded' } as never
    const payload = payloadWith(artifactNode, excluded)
    const found = navigateWithin(payload, { snapshotDigest: 'sha256:s', source: { kind: 'artifact_version', artifactVersionId: 'av_1' } })
    expect(found).toMatchObject({ result: 'found' })
    const missing = navigateWithin(payload, { snapshotDigest: 'sha256:s', source: { kind: 'artifact_version', artifactVersionId: 'av_2' } })
    expect(missing).toEqual({ result: 'not_in_snapshot' })
    const excludedNever = navigateWithin(payload, { snapshotDigest: 'sha256:s', source: { kind: 'tool_call', callId: 'call_9' } })
    expect(excludedNever).toEqual({ result: 'not_in_snapshot' })
  })
})

describe('objectDetails (§4.6, per-kind technical projection)', () => {
  const store = { finalizationForRun: () => undefined } as never

  it('Run details carry tool/call/outcome/seq-range with event capture basis', () => {
    const node: EvidenceNodeV1 = {
      nodeKind: 'Run',
      nodeId: 'en_r' as never,
      projectionState: 'active',
      payloadSchema: 'animalge.run.event-backed/v1',
      payload: {
        runId: 'run_1',
        primaryCallId: 'call_1',
        operation: { toolName: 'bash' },
        invocationDigest: 'sha256:i',
        outcome: 'succeeded',
        eventSeqRange: { startInclusive: 2, endInclusive: 3 },
        selectionBasis: { kind: 'deterministic_rule' },
      },
    } as never
    const details: ObjectDetails = detailsOf(store, node)
    expect(details.kind).toBe('Run')
    if (details.kind === 'Run') {
      expect(details.toolName).toBe('bash')
      expect(details.callId).toBe('call_1')
      expect(details.captureBasis).toBe('event')
      expect(details.outcome).toBe('succeeded')
      expect(details.eventSeqRange).toEqual({ startInclusive: 2, endInclusive: 3 })
    }
  })

  it('ArtifactVersion details expose the frozen locator observation and anchors', () => {
    const anchors = new Map([['sa_1', { anchorId: 'sa_1', sourceVersionRef: 'av_1', sourceKind: 'text' }]])
    const anchorStore = { locationObservations: { get: () => ({ locator: '/tmp/f.csv', availability: 'available' }) }, sourceAnchors: { entries: () => anchors.entries() } } as never
    const node: EvidenceNodeV1 = {
      nodeKind: 'ArtifactVersion',
      nodeId: 'en_av' as never,
      projectionState: 'active',
      payloadSchema: 'animalge.artifact.version-node/v1',
      payload: { artifactId: 'a_1', artifactVersionId: 'av_1', contentDigest: 'sha256:c', byteLength: 12, mediaType: 'text/csv', frozenLocationObservationId: 'lo_1' },
    } as never
    const details: ObjectDetails = detailsOf(anchorStore, node)
    expect(details.kind).toBe('ArtifactVersion')
    if (details.kind === 'ArtifactVersion') {
      expect(details.frozenLocator).toBe('/tmp/f.csv')
      expect(details.anchors).toEqual([{ sourceAnchorId: 'sa_1', sourceKind: 'text' }])
    }
  })

  it('Observation/CandidateStatement/ContextEntity project their frozen fields', () => {
    const observation: ObjectDetails = detailsOf(store, {
      nodeKind: 'Observation', nodeId: 'en_o' as never, projectionState: 'active',
      payloadSchema: 'animalge.observation.tool-result/v1',
      payload: { observationKind: 'run_terminal_outcome', runId: 'run_1', outcome: 'failed', resultBlockCount: 2 },
    } as never)
    expect(observation).toMatchObject({ kind: 'Observation', outcome: 'failed', resultBlockCount: 2 })
    const candidate: ObjectDetails = detailsOf(store, {
      nodeKind: 'CandidateStatement', nodeId: 'en_c' as never, projectionState: 'active',
      payloadSchema: 'animalge.candidate.statement/v1',
      payload: { candidateId: 'cst_1', subtype: 'conclusion', text: 'stmt', sourceBinding: { kind: 'agent_message' }, generationProvenance: { provider: 'p' }, relationSummary: { summary: 'support_only' } },
    } as never)
    expect(candidate).toMatchObject({ kind: 'CandidateStatement', subtype: 'conclusion' })
    const entity: ObjectDetails = detailsOf(store, {
      nodeKind: 'ContextEntity', nodeId: 'en_e' as never, projectionState: 'active',
      payloadSchema: 'animalge.context.entity-node/v1',
      payload: { contextKind: 'software', identity: { name: 'plink', version: '1.9' } },
    } as never)
    expect(entity).toEqual({ kind: 'ContextEntity', contextKind: 'software', name: 'plink', version: '1.9' })
  })
})

describe('receipt (§4.7, acceptance presentation states)', () => {
  it('pending / accepted / rejected / unknown through the service over seeded owner rows', async () => {
    const face = await serviceWithFixture()
    try {
      const ref = (id: string): string => id
      await seedReceipt(face.store, ref('rs_pending'), undefined)
      await seedReceipt(face.store, ref('rs_ok'), { verdict: 'accepted', acceptedAt: 42, receiptId: 'rs_ok' })
      await seedReceipt(face.store, ref('rs_no'), { verdict: 'rejected', reason: 'component_missing', receiptId: 'rs_no' })
      const pending = face.service.receipt(agentOf('spec-01-session'), { submissionRef: ref('rs_pending') })
      expect(pending.ok && pending.receipt.state === 'pending' && pending.receipt.acceptedAt === null).toBe(true)
      const accepted = face.service.receipt(agentOf('spec-01-session'), { submissionRef: ref('rs_ok') })
      expect(accepted.ok && accepted.receipt.state === 'accepted' && accepted.receipt.acceptedAt === 42).toBe(true)
      const rejected = face.service.receipt(agentOf('spec-01-session'), { submissionRef: ref('rs_no') })
      expect(rejected.ok && rejected.receipt.state === 'rejected' && rejected.receipt.rejectedReason === 'component_missing').toBe(true)
      const unknown = face.service.receipt(agentOf('spec-01-session'), { submissionRef: ref('rs_missing') })
      expect(unknown.ok).toBe(false)
      if (!unknown.ok) expect(unknown.error.code).toBe('not_in_snapshot')
    } finally { await face.close() }
  })
})

/** Seed one receipt submission (+ optional acceptance) with schema-valid full rows. */
async function seedReceipt(store: Awaited<ReturnType<typeof storeHarness>>['store'], receiptId: string, acceptance: { verdict: 'accepted' | 'rejected'; acceptedAt?: number; reason?: string; receiptId: string } | undefined): Promise<void> {
  const dig = (tag: string): string => `sha256:${tag.padEnd(64, '0').slice(0, 64)}`
  const eventRef = {
    schemaVersion: 'animalge.session-event-ref/v1', sessionId: 'spec-01-session',
    seq: 2, eventType: 'tool/call', eventTime: 1, eventDigest: dig('e'),
  }
  interface ComponentState { state: string; reason: string | null; ownerRefs: string[] }
  const component = (state: string): ComponentState => ({ state, reason: null, ownerRefs: [] })
  await store.receiptSubmissions.put(receiptId, ({
    recordVersion: 'animalge.receipt-submission/v1',
    receiptId,
    receiptSchemaRevision: 'animalge.evidence.receipt/v1',
    submissionDigest: dig('s'),
    submittedAt: 1,
    providerId: 'provider-x',
    providerVersion: '1.0.0',
    captureProfileId: 'profile-x',
    captureProfileRevision: 'r1',
    evidenceGraphId: 'eg_spec01fixture',
    sessionId: 'spec-01-session',
    runId: 'run_x',
    invocationBasis: { kind: 'direct', callId: 'call-spec-01', startEventRef: eventRef },
    expectedResultLocator: { sessionId: 'spec-01-session', callId: 'call-spec-01' },
    operation: { toolName: 'bash' },
    invocationDigest: dig('i'),
    lifecycle: { startedAt: 1, endedAt: 2 },
    outcome: 'succeeded',
    components: {
      inputs: component('captured'), outputs: component('captured'), softwareAndCode: component('captured'),
      environment: component('captured'), parameters: component('captured'), randomness: component('not_applicable'), logs: component('captured'),
    },
    extensions: [],
  }) as never)
  if (acceptance !== undefined) {
    await store.receiptAcceptances.put(`ra_${receiptId}`, ({
      recordVersion: 'animalge.receipt-acceptance/v1',
      acceptanceId: `ra_${receiptId}`,
      receiptId,
      submissionDigest: dig('s'),
      acceptedAt: acceptance.acceptedAt ?? 1,
      pairedStartRef: eventRef,
      pairedResultRef: { ...eventRef, seq: 3, eventType: 'tool/result' },
      acceptanceDigest: dig('a'),
      verdict: acceptance.verdict,
      rejectedReason: acceptance.verdict === 'rejected' ? acceptance.reason ?? 'reason' : null,
    }) as never)
  }
}
