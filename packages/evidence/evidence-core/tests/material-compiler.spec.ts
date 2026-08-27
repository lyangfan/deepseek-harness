/** S02-A08/A14/A15: deterministic materialization, payload upgrade idempotency, legacy dual-read, ambient defense. */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerSuiteSummary } from './summary.ts'
import { materialHarness } from './helpers.ts'
import { compiledFixture } from './helpers.ts'
import { compileSnapshot } from '../src/compiler.ts'
import { materialSnapshotFor, receiptBackedPayload } from '../src/materialize.ts'
import { capturedComponent, missingComponent, persistReceiptSubmission } from '../src/receipt.ts'
import { CallId } from '@deepseek-ai/dsh-llm'
import { canonicalDigest } from '../src/canonical-json.ts'
import { verifySnapshot } from '../src/integrity.ts'

async function acceptedReceiptFixture(harness: Awaited<ReturnType<typeof materialHarness>>, runId?: string) {
  const session = await harness.createSession('spec-02-material')
  const inputPath = join(harness.root, 'material-input.txt')
  await writeFile(inputPath, 'material-input-bytes', 'utf8')
  const captured = await harness.artifacts.captureFile({ role: 'input', locator: inputPath }, { createdBy: 'runner_input' })
  const { ContextEntityOwner } = await import('../src/context-entity.ts')
  const entities = new ContextEntityOwner(harness.store)
  const environment = await entities.register({ contextKind: 'environment', name: 'runner-local', version: null, payload: { os: 'darwin' } })
  const bootstrap = harness.store.sessionGraphs.get(session.id)
  const graphId = bootstrap?.graphId as never
  const submission = await persistReceiptSubmission(harness.store, {
    evidenceGraphId: graphId,
    sessionId: session.id,
    runId: (runId ?? 'er_placeholder') as never,
    invocationBasis: { kind: 'direct', callId: CallId('call-material'), startEventRef: null },
    expectedResultCallId: CallId('call-material'),
    toolName: 'sci_run_code',
    languageProfile: 'bash',
    invocationDigest: canonicalDigest('material-invocation'),
    lifecycle: { startedAt: 1, endedAt: 2 },
    outcome: 'succeeded',
    components: {
      inputs: capturedComponent([captured.artifactVersionId]),
      outputs: capturedComponent([]),
      softwareAndCode: missingComponent('none'),
      environment: capturedComponent([environment.contextEntityId]),
      parameters: missingComponent('none'),
      randomness: missingComponent('randomness_not_assessed_v0.1'),
      logs: missingComponent('none'),
    },
  })
  return { session, submission, captured, graphId }
}

describe('S02-A08 material projection', () => {
  it('upgrades the same runId to the receipt-backed payload with ArtifactVersion/ContextEntity nodes and used edges', async () => {
    const harness = await materialHarness()
    const session = await harness.createSession('spec-02-material')
    const bootstrap = harness.store.sessionGraphs.get(session.id)
    const graphId = bootstrap?.graphId as never
    const { foldCaptures, resolveSelection } = await import('../src/capture.ts')
    const { topLevelEvents } = await import('./helpers.ts')
    const selection = resolveSelection('selection/v1', ['sci_run_code'])
    const scope = { kind: 'session' as const, graphId, sessionId: session.id, sessionCreatedAt: session.header.createdAt }
    const folded = foldCaptures(scope, session.header, topLevelEvents('sci_run_code'), selection)
    const capture = folded.captures[0]
    if (capture === undefined) throw new Error('fixture produced no capture')
    const inputPath = join(harness.root, 'material-input.txt')
    await writeFile(inputPath, 'material-input-bytes', 'utf8')
    const input = await harness.artifacts.captureFile({ role: 'input', locator: inputPath }, { createdBy: 'runner_input' })
    const { ContextEntityOwner } = await import('../src/context-entity.ts')
    const entities = new ContextEntityOwner(harness.store)
    const environment = await entities.register({ contextKind: 'environment', name: 'runner-local', version: null, payload: { os: 'darwin' } })
    const submission = await persistReceiptSubmission(harness.store, {
      evidenceGraphId: graphId,
      sessionId: session.id,
      runId: capture.runId,
      invocationBasis: { kind: 'direct', callId: capture.basis.kind === 'top_level_tool' ? capture.basis.callId : CallId('call-spec-01'), startEventRef: null },
      expectedResultCallId: 'call-spec-01' as never,
      toolName: 'sci_run_code',
      languageProfile: 'bash',
      invocationDigest: canonicalDigest('material-invocation'),
      lifecycle: { startedAt: 1, endedAt: 2 },
      outcome: 'succeeded',
      components: {
        inputs: capturedComponent([input.artifactVersionId]),
        outputs: missingComponent('output_absent'),
        softwareAndCode: missingComponent('none'),
        environment: capturedComponent([environment.contextEntityId]),
        parameters: missingComponent('none'),
        randomness: missingComponent('randomness_not_assessed_v0.1'),
        logs: missingComponent('none'),
      },
    })
    const acceptance = {
      recordVersion: 'animalge.receipt-acceptance/v1' as const,
      acceptanceId: 'ra_test0001' as never,
      receiptId: submission.receiptId,
      submissionDigest: submission.submissionDigest,
      acceptedAt: 1,
      pairedStartRef: capture.basis.kind === 'top_level_tool' ? capture.basis.callEvent : capture.basis.kind === 'code_mode_dispatch' ? capture.basis.startEvent : capture.basis.assistantEvent,
      pairedResultRef: capture.basis.resultEvent,
      acceptanceDigest: canonicalDigest('acceptance'),
      verdict: 'accepted' as const,
      rejectedReason: null,
      componentVerdicts: { inputs: 'verified' as const, outputs: 'not_applicable' as const, softwareAndCode: 'not_applicable' as const, environment: 'verified' as const, parameters: 'not_applicable' as const, randomness: 'not_applicable' as const, logs: 'not_applicable' as const },
      receiptAcceptance: 'accepted' as const,
    }
    await harness.store.putMaterialRecord(harness.store.receiptAcceptances, acceptance.acceptanceId, acceptance)
    const material = materialSnapshotFor(harness.store, graphId)
    const payload = compileSnapshot({
      scope,
      captures: folded.captures,
      baseSnapshotDigest: null,
      targetNextSeqExclusive: 6,
      sourceTimeUpperBound: 105,
      selectionRevision: selection.revision,
      selectionRuleDigest: selection.digest,
      material,
    })
    const runNode = payload.nodes.find(node => node.nodeKind === 'Run')
    expect(runNode?.payloadSchema).toBe('animalge.run.receipt-backed/v1')
    expect(runNode?.payload).toMatchObject({ captureBasis: 'receipt', receiptId: submission.receiptId, selectionBasis: { kind: 'receipt_auto' } })
    expect(payload.nodes.some(node => node.nodeKind === 'ArtifactVersion')).toBe(true)
    expect(payload.nodes.some(node => node.nodeKind === 'ContextEntity')).toBe(true)
    expect(payload.edges.some(edge => edge.edgeType === 'used')).toBe(true)
    expect(payload.schemaSet).toEqual(['animalge.evidence.core/v1', 'animalge.evidence.material/v1'])
    await harness.close()
  })
})

describe('S02-A14 determinism and legacy dual-read', () => {
  it('recompiles byte-identically for the same frozen material state', async () => {
    const fixture = compiledFixture()
    const payload = compileSnapshot({
      scope: fixture.scope,
      captures: fixture.folded.captures,
      baseSnapshotDigest: null,
      targetNextSeqExclusive: 6,
      sourceTimeUpperBound: 105,
      selectionRevision: fixture.selection.revision,
      selectionRuleDigest: fixture.selection.digest,
    })
    const again = compileSnapshot({
      scope: fixture.scope,
      captures: fixture.folded.captures,
      baseSnapshotDigest: null,
      targetNextSeqExclusive: 6,
      sourceTimeUpperBound: 105,
      selectionRevision: fixture.selection.revision,
      selectionRuleDigest: fixture.selection.digest,
    })
    expect(again).toEqual(payload)
  })

  it('keeps legacy core-only snapshots readable while new material snapshots carry the material revision', () => {
    const fixture = compiledFixture()
    const coreOnly = compileSnapshot({
      scope: fixture.scope,
      captures: fixture.folded.captures,
      baseSnapshotDigest: null,
      targetNextSeqExclusive: 6,
      sourceTimeUpperBound: 105,
      selectionRevision: fixture.selection.revision,
      selectionRuleDigest: fixture.selection.digest,
    })
    expect(coreOnly.schemaSet).toEqual(['animalge.evidence.core/v1'])
    expect(verifySnapshot(JSON.parse(JSON.stringify(coreOnly)))).toEqual(coreOnly)
  })
})

describe('S02-A15 ambient defense', () => {
  it('materializes nothing for runs without accepted receipts (event path unchanged)', () => {
    const fixture = compiledFixture()
    const payload = compileSnapshot({
      scope: fixture.scope,
      captures: fixture.folded.captures,
      baseSnapshotDigest: null,
      targetNextSeqExclusive: 6,
      sourceTimeUpperBound: 105,
      selectionRevision: fixture.selection.revision,
      selectionRuleDigest: fixture.selection.digest,
      material: { accepted: new Map(), versions: new Map(), entities: new Map(), observations: new Map() },
    })
    expect(payload.nodes.filter(node => node.nodeKind === 'Run').every(node => node.payloadSchema === 'animalge.run.event-backed/v1')).toBe(true)
    expect(payload.nodes.some(node => node.nodeKind === 'ArtifactVersion')).toBe(false)
  })

  it('builds the receipt-backed payload without any LLM access (pure functions over store facts)', async () => {
    const harness = await materialHarness()
    const { submission } = await acceptedReceiptFixture(harness)
    const fixture = compiledFixture()
    const capture = fixture.folded.captures[0]
    if (capture === undefined) throw new Error('fixture produced no capture')
    const payload = receiptBackedPayload({ capture, submission, acceptance: { acceptanceDigest: canonicalDigest('acc') } as never })
    expect(payload).toMatchObject({ captureBasis: 'receipt', selectionBasis: { kind: 'receipt_auto' } })
    await harness.close()
  })
})

describe('S02-A01 supersedes/restored_from edge projection', () => {
  it('materializes supersedes edges between projected versions of the same Artifact chain', async () => {
    const harness = await materialHarness()
    await acceptedReceiptFixture(harness)
    // Create two versions of the same logical artifact via explicit commit
    const path = join(harness.root, 'chain.txt')
    const { writeFile: wf } = await import('node:fs/promises')
    await wf(path, 'v1', 'utf8')
    const first = await harness.artifacts.registerExplicit(path, { createdBy: 'explicit_registration', reason: 'explicit_commit' })
    await wf(path, 'v2-bytes', 'utf8')
    const second = await harness.artifacts.registerExplicit(path, { createdBy: 'explicit_registration', reason: 'explicit_commit' })
    const secondCore = harness.store.artifactVersions.get(second.artifactVersionId)
    expect(secondCore?.parentVersionId).toBe(first.artifactVersionId)
    // C1-03: assert the supersedes edge materialization through a compiled Snapshot
    const { compileSnapshot } = await import('../src/compiler.ts')
    const { foldCaptures, resolveSelection } = await import('../src/capture.ts')
    const { topLevelEvents } = await import('./helpers.ts')
    const { capturedComponent, missingComponent, persistReceiptSubmission } = await import('../src/receipt.ts')
    const { canonicalDigest } = await import('../src/canonical-json.ts')
    const { ContextEntityOwner } = await import('../src/context-entity.ts')
    const entities = new ContextEntityOwner(harness.store)
    const environment = await entities.register({ contextKind: 'environment', name: 'env', version: null, payload: { os: 'darwin' } })
    const session = harness.ctx.sessions.create(
      (await import('@deepseek-ai/dsh-session')).SessionId('spec-02-supersedes'),
      { meta: { agentPreset: 'animalge-open-test' } },
    )
    await harness.store.bootstrap(session.header)
    const graphId = (harness.store.sessionGraphs.get(session.id)?.graphId) as never
    const selection = resolveSelection('selection/v1', ['sci_run_code'])
    const scope = { kind: 'session' as const, graphId, sessionId: session.id, sessionCreatedAt: session.header.createdAt }
    const folded = foldCaptures(scope, session.header, topLevelEvents('sci_run_code'), selection)
    const capture = folded.captures[0]
    if (capture === undefined) throw new Error('no capture')
    const submission = await persistReceiptSubmission(harness.store, {
      evidenceGraphId: graphId,
      sessionId: session.id,
      runId: capture.runId,
      invocationBasis: { kind: 'direct', callId: 'call-spec-01' as never, startEventRef: null },
      expectedResultCallId: 'call-spec-01' as never,
      toolName: 'sci_run_code',
      languageProfile: 'bash',
      invocationDigest: canonicalDigest('chain-inv'),
      lifecycle: { startedAt: 1, endedAt: 2 },
      outcome: 'succeeded',
      components: {
        inputs: capturedComponent([first.artifactVersionId, second.artifactVersionId]),
        outputs: missingComponent('none'),
        softwareAndCode: missingComponent('none'),
        environment: capturedComponent([environment.contextEntityId]),
        parameters: missingComponent('none'),
        randomness: missingComponent('randomness_not_assessed_v0.1'),
        logs: missingComponent('none'),
      },
    })
    const acceptance = {
      recordVersion: 'animalge.receipt-acceptance/v1' as const,
      acceptanceId: 'ra_chain001' as never,
      receiptId: submission.receiptId,
      submissionDigest: submission.submissionDigest,
      acceptedAt: 1,
      pairedStartRef: capture.basis.kind === 'top_level_tool' ? capture.basis.callEvent : capture.basis.kind === 'top_level_not_started' ? capture.basis.assistantEvent : capture.basis.startEvent,
      pairedResultRef: capture.basis.resultEvent,
      acceptanceDigest: canonicalDigest('chain-acc'),
      verdict: 'accepted' as const,
      rejectedReason: null,
      componentVerdicts: { inputs: 'verified' as const, outputs: 'not_applicable' as const, softwareAndCode: 'not_applicable' as const, environment: 'verified' as const, parameters: 'not_applicable' as const, randomness: 'not_applicable' as const, logs: 'not_applicable' as const },
      receiptAcceptance: 'accepted' as const,
    }
    await harness.store.putMaterialRecord(harness.store.receiptAcceptances, acceptance.acceptanceId, acceptance)
    const { materialSnapshotFor } = await import('../src/materialize.ts')
    const payload = compileSnapshot({
      scope,
      captures: folded.captures,
      baseSnapshotDigest: null,
      targetNextSeqExclusive: 6,
      sourceTimeUpperBound: 105,
      selectionRevision: selection.revision,
      selectionRuleDigest: selection.digest,
      material: materialSnapshotFor(harness.store, graphId),
    })
    const supersedesEdges = payload.edges.filter(edge => edge.edgeType === 'supersedes')
    expect(supersedesEdges.length).toBeGreaterThanOrEqual(1)
    const nodeIds = new Map(payload.nodes.map(node => [node.nodeId, node]))
    for (const edge of supersedesEdges) {
      const fromNode = nodeIds.get(edge.from)
      const toNode = nodeIds.get(edge.to)
      expect(fromNode?.nodeKind).toBe('ArtifactVersion')
      expect(toNode?.nodeKind).toBe('ArtifactVersion')
      const fromPayload = fromNode?.payload as { artifactVersionId: string }
      const toPayload = toNode?.payload as { artifactVersionId: string }
      expect(fromPayload.artifactVersionId).toBe(second.artifactVersionId)
      expect(toPayload.artifactVersionId).toBe(first.artifactVersionId)
    }
    await harness.close()
  })
})

registerSuiteSummary({ suiteId: 'material-compiler', acceptanceIds: ['S02-A08', 'S02-A14', 'S02-A15'], sessionPersistence: [''], evidenceStorage: ['memory'] })
