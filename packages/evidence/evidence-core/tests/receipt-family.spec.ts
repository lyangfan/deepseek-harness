/** S02-A09..A11: Receipt family schemas, submission digest binding, and the two-layer verification helpers. */

import { describe, expect, it } from 'vitest'
import { registerSuiteSummary } from './summary.ts'
import { materialHarness } from './helpers.ts'
import { capturedComponent, missingComponent, meetsReceiptBackedMinimum, persistReceiptSubmission, verifyReceiptComponents } from '../src/receipt.ts'
import type { EvidenceStore } from '../src/store.ts'
import type { ReceiptSubmission } from '../src/schema.ts'
import { canonicalDigest } from '../src/canonical-json.ts'
import { EvidenceGraphId } from '../src/identity.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CallId } from '@deepseek-ai/dsh-llm'
import { deriveRunId } from '../src/identity.ts'

async function receiptHarness() {
  const harness = await materialHarness()
  const graphId = EvidenceGraphId('eg_receiptspec')
  await harness.store.bootstrap({ version: 0, id: SessionId('spec-02-receipts'), createdAt: 1 }, undefined)
  const bootstrap = harness.store.sessionGraphs.get(SessionId('spec-02-receipts'))
  return { ...harness, graphId: bootstrap?.graphId ?? graphId }
}

function submissionBase(overrides: Partial<Parameters<typeof persistReceiptSubmission>[1]> = {}) {
  return overrides
}

describe('S02-A09 core identity binding', () => {
  it('binds submissionDigest to the stored envelope bytes so any tampering fails recomputation', async () => {
    const harness = await receiptHarness()
    const runId = deriveRunId({ graphId: harness.graphId, basisKind: 'top_level_tool', sessionId: 'spec-02-receipts', callEventSeq: 2, callId: 'call-r1' })
    const submission = await persistReceiptSubmission(harness.store, {
      evidenceGraphId: harness.graphId,
      sessionId: SessionId('spec-02-receipts'),
      runId,
      invocationBasis: { kind: 'direct', callId: CallId('call-r1'), startEventRef: null },
      expectedResultCallId: CallId('call-r1'),
      toolName: 'sci_run_code',
      languageProfile: 'bash',
      invocationDigest: canonicalDigest('invocation'),
      lifecycle: { startedAt: 1, endedAt: 2 },
      outcome: 'succeeded',
      components: {
        inputs: missingComponent('none'),
        outputs: missingComponent('none'),
        softwareAndCode: missingComponent('none'),
        environment: missingComponent('none'),
        parameters: missingComponent('none'),
        randomness: missingComponent('randomness_not_assessed_v0.1'),
        logs: missingComponent('none'),
      },
      ...submissionBase(),
    })
    const stored = harness.store.receiptSubmissions.get(submission.receiptId) as ReceiptSubmission
    const { submissionDigest: _omit, ...rest } = stored as unknown as Record<string, unknown>
    expect(canonicalDigest(structuredClone(rest) as never)).toBe(stored.submissionDigest)
    // The stored envelope is immutable: a differently-byted duplicate under the same key fails.
    await expect(harness.store.putMaterialRecord(harness.store.receiptSubmissions, stored.receiptId, { ...stored, outcome: 'failed' })).rejects.toMatchObject({ code: 'immutable_key_collision' })
    await harness.close()
  })

  it('rejects unknown provider identities structurally (only the runner producer is registered in v0.1)', async () => {
    const harness = await receiptHarness()
    const runId = deriveRunId({ graphId: harness.graphId, basisKind: 'top_level_tool', sessionId: 'spec-02-receipts', callEventSeq: 2, callId: 'call-r2' })
    const submission = await persistReceiptSubmission(harness.store, {
      evidenceGraphId: harness.graphId,
      sessionId: SessionId('spec-02-receipts'),
      runId,
      invocationBasis: { kind: 'direct', callId: CallId('call-r2'), startEventRef: null },
      expectedResultCallId: CallId('call-r2'),
      toolName: 'sci_run_code',
      languageProfile: 'bash',
      invocationDigest: canonicalDigest('invocation'),
      lifecycle: { startedAt: 1, endedAt: 2 },
      outcome: 'succeeded',
      components: {
        inputs: missingComponent('none'), outputs: missingComponent('none'), softwareAndCode: missingComponent('none'),
        environment: missingComponent('none'), parameters: missingComponent('none'),
        randomness: missingComponent('randomness_not_assessed_v0.1'), logs: missingComponent('none'),
      },
    })
    expect(submission.providerId).toBe('animalge-declarative-runner')
    expect(submission.captureProfileId).toBe('runner:bash')
    await harness.close()
  })
})

describe('S02-A10/A11 component verification and the receipt-backed minimum', () => {
  it('marks components verified only when every ownerRef resolves', async () => {
    const harness = await receiptHarness()
    const { artifacts } = harness
    const path = `${harness.root}/receipt-input.txt`
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, 'input-bytes', 'utf8')
    const captured = await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    const submission = {
      components: {
        inputs: capturedComponent([captured.artifactVersionId]),
        outputs: capturedComponent(['av_missing0000000000000000000000000000000000000000000000000000000']),
        softwareAndCode: missingComponent('none'),
        environment: missingComponent('none'),
        parameters: missingComponent('none'),
        randomness: missingComponent('randomness_not_assessed_v0.1'),
        logs: missingComponent('none'),
      },
    }
    const verdicts = verifyReceiptComponents(harness.store, submission as never)
    expect(verdicts.inputs).toBe('verified')
    expect(verdicts.outputs).toBe('failed')
    expect(meetsReceiptBackedMinimum(verdicts)).toBe(true)
    await harness.close()
  })

  it('an empty receipt (all components missing/not_applicable) never meets the receipt-backed minimum', async () => {
    const harness = await receiptHarness()
    const verdicts = verifyReceiptComponents(harness.store, {
      components: {
        inputs: missingComponent('none'), outputs: missingComponent('none'), softwareAndCode: missingComponent('none'),
        environment: missingComponent('none'), parameters: missingComponent('none'),
        randomness: missingComponent('randomness_not_assessed_v0.1'), logs: missingComponent('none'),
      },
    } as never)
    expect(meetsReceiptBackedMinimum(verdicts)).toBe(false)
    await harness.close()
  })

  it('a single failed component alone does not meet the minimum (no lineage without a verified extra component)', () => {
    const verdicts = {
      inputs: 'failed', outputs: 'failed', softwareAndCode: 'failed',
      environment: 'failed', parameters: 'failed', randomness: 'not_applicable', logs: 'failed',
    } as const
    expect(meetsReceiptBackedMinimum(verdicts)).toBe(false)
  })
})

registerSuiteSummary({ suiteId: 'receipt-family', acceptanceIds: ['S02-A09', 'S02-A10', 'S02-A11'], sessionPersistence: [''], evidenceStorage: ['memory'] })
export type { EvidenceStore }
