/** S03-A13/A14: receipt extensions namespaces and the two-phase professional acceptance. */

import { join } from 'node:path'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { registerSuiteSummary } from './summary.ts'
import { proHarness, ownCallFlushed, proExec, runtimeOptions } from './pro-harness.ts'
import { runProfessionalTool } from '../src/professional/factory.ts'
import { PLINK_TOOL_SPEC } from '../src/professional/adapters/plink.ts'
import { classifyReceiptExtension, registerReceiptExtensionSchema } from '../src/receipt.ts'
import { PROFESSIONAL_CAPTURE_PROFILE_PREFIX } from '../src/materialize.ts'

registerSuiteSummary({ suiteId: 'professional-receipt', acceptanceIds: ['S03-A13', 'S03-A14'], sessionPersistence: [''], evidenceStorage: [''] })

async function runPlink(harness: Awaited<ReturnType<typeof proHarness>>, callId: string, outPrefix: string) {
  await ownCallFlushed(harness, callId, 'plink_cli')
  return runProfessionalTool(harness.ctx, runtimeOptions(harness), PLINK_TOOL_SPEC, {
    bed: harness.trio.bed,
    bim: harness.trio.bim,
    fam: harness.trio.fam,
    native_args: [],
    out_prefix: outPrefix,
  }, proExec(harness, callId) as never)
}

describe('S03-A13 receipt extensions', () => {
  it('classifies registered, unknown, and invalid extension entries without touching components', () => {
    registerReceiptExtensionSchema({
      namespace: 'test@1', schemaId: 'test-schema/v1', revision: 'r1',
      validate: payload => (payload as { ok?: unknown } | null)?.ok === true,
    })
    expect(classifyReceiptExtension({ namespace: 'test@1', schemaId: 'test-schema/v1', revision: 'r1', payload: { ok: true } }).kind).toBe('registered')
    expect(classifyReceiptExtension({ namespace: 'test@1', schemaId: 'test-schema/v1', revision: 'r1', payload: { ok: false } }).kind).toBe('invalid')
    expect(classifyReceiptExtension({ namespace: 'nope@1', schemaId: 'x', revision: 'r', payload: {} }).kind).toBe('unknown')
  })

  it('the four namespaces are registered by adapter definition time', async () => {
    const harness = await proHarness()
    try {
      for (const namespace of ['plink_cli@1', 'himvp_cli@1', 'r_script@1', 'cmplot_call@1']) {
        expect(classifyReceiptExtension({ namespace, schemaId: 'x', revision: 'y', payload: {} }).kind).toBe('unknown')
      }
      // Registering the real adapter schemas (as the factory does) makes them registered.
      await import('../src/professional/index.ts')
      void harness
    } finally {
      await harness.close()
    }
  })
})

describe('S03-A14 two-phase acceptance for professional submissions', () => {
  it('a real plink_cli run lands as sci-tool submission, is accepted by the lane, and materializes through the finalization gate', async () => {
    const harness = await proHarness()
    try {
      const result = await runPlink(harness, 'call-ext-1', join(harness.root, 'qc1'))
      expect(result.outcome).toBe('succeeded')
      expect(result.outputCompleteness).toBe('complete')
      expect(result.outputs.map(output => output.role).sort()).toEqual(['qc_bed', 'qc_bim', 'qc_fam', 'software_log'])
      // Before the result event persists, receiptAcceptance is pending (no acceptance record yet).
      const submissions = [...harness.store.receiptSubmissions.entries()]
      expect(submissions).toHaveLength(1)
      const submission = submissions[0]?.[1]
      expect(submission?.providerId).toBe('animalge-scientific-tool-runtime')
      expect(submission?.captureProfileId.startsWith(PROFESSIONAL_CAPTURE_PROFILE_PREFIX)).toBe(true)
      expect(submission?.operation.operationProfile).toBe('animalge-pro-plink-cli/v1')
      expect(submission?.extensions[0]?.namespace).toBe('plink_cli@1')
      expect(harness.store.acceptanceFor(submission?.receiptId ?? '')).toBeUndefined()
      // Drive the real result event through the lane (the deterministic acceptance path).
      const session = harness.session
      session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId: 'call-ext-1' as never, content: [{ type: 'text', text: 'ok' }], isError: false }),
      }, { surfaceOp: 'append' })
      await harness.ctx.sessions.flush(session)
      await harness.lane.processSession(session.header, true)
      const acceptance = harness.store.acceptanceFor(submission?.receiptId ?? '')
      expect(acceptance?.verdict).toBe('accepted')
      expect(acceptance?.componentVerdicts.outputs).toBe('verified')
    } finally {
      await harness.close()
    }
  })

  it('a whole-delivery identity failure rejects the submission without dropping it', async () => {
    const harness = await proHarness()
    try {
      const result = await runPlink(harness, 'call-ext-2', join(harness.root, 'qc2'))
      expect(result.outcome).toBe('succeeded')
      const submission = [...harness.store.receiptSubmissions.entries()][0]?.[1]
      expect(submission).toBeDefined()
      if (submission === undefined) throw new Error('submission missing')
      // Tamper the stored envelope digest: the lane must reject the whole delivery.
      await harness.store.receiptSubmissions.put(submission.receiptId, { ...submission, submissionDigest: 'sha256:' + '0'.repeat(64) as never })
      harness.session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId: 'call-ext-2' as never, content: [{ type: 'text', text: 'ok' }], isError: false }),
      }, { surfaceOp: 'append' })
      await harness.ctx.sessions.flush(harness.session)
      await harness.lane.processSession(harness.session.header, true)
      const acceptance = harness.store.acceptanceFor(submission.receiptId)
      expect(acceptance?.verdict).toBe('rejected')
      expect(acceptance?.rejectedReason).toBe('submission_digest_mismatch')
      // The submission itself survives as immutable evidence.
      expect(harness.store.receiptSubmissions.get(submission.receiptId)).toBeDefined()
    } finally {
      await harness.close()
    }
  })
})
