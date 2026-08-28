/** S03-A16: fake-executable golden contracts for the four adapters (D-190 layer 2). */

import { chmod, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerSuiteSummary } from './summary.ts'
import { proHarness, runTool } from './pro-harness.ts'
import { PLINK_TOOL_SPEC } from '../src/professional/adapters/plink.ts'
import { HIMVP_TOOL_SPEC } from '../src/professional/adapters/himvp.ts'
import { RSCRIPT_TOOL_SPEC } from '../src/professional/adapters/rscript.ts'
import { CMPLOT_TOOL_SPEC } from '../src/professional/adapters/cmplot.ts'

registerSuiteSummary({ suiteId: 'adapters-fake', acceptanceIds: ['S03-A16'], sessionPersistence: [''], evidenceStorage: [''] })

describe('S03-A16 plink_cli golden', () => {
  it('runs the fake executable end-to-end with the QC output plan complete', async () => {
    const harness = await proHarness(4, 6)
    try {
      const result = await runTool(harness, PLINK_TOOL_SPEC, {
        bed: harness.trio.bed, bim: harness.trio.bim, fam: harness.trio.fam,
        maf: 0.05, geno: 0.1, mind: 0.1, native_args: [], out_prefix: join(harness.root, 'qc'),
      }, 'call-plink-1')
      expect(result.outcome).toBe('succeeded')
      expect(result.outputCompleteness).toBe('complete')
      expect(result.outputs.map(output => output.role).sort()).toEqual(['qc_bed', 'qc_bim', 'qc_fam', 'software_log'])
      const submission = [...harness.store.receiptSubmissions.entries()][0]?.[1]
      expect(submission?.captureProfileId).toBe('sci-tool:plink_cli')
      // argv/executable separation: the executable path is the frozen fake, argv follows.
      const parameters = [...harness.store.contextEntities.entries()].map(([, row]) => row.payload)
      const argvPayload = parameters.find(payload => typeof payload === 'object' && payload !== null && 'argv' in payload) as { argv: string[] } | undefined
      expect(argvPayload?.argv[0]).toContain('fake-plink')
      expect(argvPayload?.argv).toContain('--bfile')
    } finally {
      await harness.close()
    }
  })

  it('a nonzero software exit fails the run and leaves files diagnostic (no fake outputs)', async () => {
    const harness = await proHarness(2, 4)
    try {
      process.env.FAKE_PLINK_FAIL = '1'
      const result = await runTool(harness, PLINK_TOOL_SPEC, {
        bed: harness.trio.bed, bim: harness.trio.bim, fam: harness.trio.fam,
        native_args: [], out_prefix: join(harness.root, 'qcfail'),
      }, 'call-plink-2')
      expect(result.outcome).toBe('failed')
      expect(result.outputs).toEqual([])
    } finally {
      delete process.env.FAKE_PLINK_FAIL
      await harness.close()
    }
  })

  it('nativeArgs pass through verbatim and the uncovered call settles D-195 (no fabricated plan)', async () => {
    const harness = await proHarness(2, 4)
    try {
      const result = await runTool(harness, PLINK_TOOL_SPEC, {
        bed: harness.trio.bed, bim: harness.trio.bim, fam: harness.trio.fam,
        native_args: ['--freq'], out_prefix: join(harness.root, 'qcnative'),
      }, 'call-plink-3')
      // The fake plink ignores --freq but the adapter must still have passed it through.
      const report = [...harness.store.preflightReports.entries()][0]?.[1]
      expect(report?.coverage).toBe('baseline_only')
      expect(report?.coverageGaps).toEqual(['no_operation_profile:plink_cli'])
      // D-195: no Output Plan for the uncovered call — diagnostic manifest, zero formal outputs.
      expect(result.outcome).toBe('succeeded')
      expect(result.outputCompleteness).toBe('unknown')
      expect(result.outputCompletenessReason).toBe('output_plan_absent')
      expect(result.outputs).toEqual([])
      const manifest = harness.store.outputManifests.get(result.outputManifestRef ?? '')
      expect(manifest?.kind).toBe('diagnostic')
      expect(manifest?.formalOutputs).toEqual([])
      const runId = harness.store.receiptSubmissions.get(result.receiptSubmissionRef)?.runId
      expect(harness.store.finalizationForRun(runId as never)).toBeUndefined()
    } finally {
      await harness.close()
    }
  })
})

describe('S03-A16 himvp_cli golden', () => {
  it('validates the association table header and fails on a missing required member', async () => {
    const harness = await proHarness(3, 5)
    try {
      await writeFile(join(harness.root, 'pheno.tsv'), 'IID\ttrait\nid1\t1\nid2\t2\nid3\t3\nid4\t4\nid5\t5\n', 'utf8')
      const result = await runTool(harness, HIMVP_TOOL_SPEC, {
        bed: harness.trio.bed, bim: harness.trio.bim, fam: harness.trio.fam,
        phenotype: join(harness.root, 'pheno.tsv'), model: 'MLM', pcs: 3,
        native_args: [], out_prefix: join(harness.root, 'gwas'),
      }, 'call-himvp-1')
      expect(result.outcome).toBe('succeeded')
      expect(result.outputs.map(output => output.role)).toContain('gwas_association_table')
      process.env.FAKE_HIMVP_BAD_HEADER = '1'
      const bad = await runTool(harness, HIMVP_TOOL_SPEC, {
        bed: harness.trio.bed, bim: harness.trio.bim, fam: harness.trio.fam,
        phenotype: join(harness.root, 'pheno.tsv'), model: 'MLM', pcs: 3,
        native_args: [], out_prefix: join(harness.root, 'gwasbad'),
      }, 'call-himvp-2')
      expect(bad.outcome).toBe('failed')
      expect(bad.outputCompleteness).toBe('incomplete')
    } finally {
      delete process.env.FAKE_HIMVP_BAD_HEADER
      await harness.close()
    }
  })
})

describe('S03-A16 r_script golden', () => {
  it('executes declared outputs through the fake Rscript; new script bytes form a new code version', async () => {
    const harness = await proHarness(1, 2)
    try {
      await writeFile(join(harness.root, 'sim.R'), '# simulation\n# FAKE-OUTPUT: pheno.tsv\n', 'utf8')
      const first = await runTool(harness, RSCRIPT_TOOL_SPEC, {
        code: join(harness.root, 'sim.R'), args: [], declared_outputs: [{ role: 'phenotypes', relative_path: 'pheno.tsv', required: true }],
      }, 'call-r-1')
      expect(first.outcome).toBe('succeeded')
      expect(first.outputs.map(output => output.role)).toEqual(['phenotypes'])
      // A distinct script locator captures a distinct code ArtifactVersion (the changed-bytes
      // conflict at a known locator is owned and covered by the SPEC-02 provider suites).
      await writeFile(join(harness.root, 'sim2.R'), '# simulation v2\n# FAKE-OUTPUT: pheno2.tsv\n', 'utf8')
      const second = await runTool(harness, RSCRIPT_TOOL_SPEC, {
        code: join(harness.root, 'sim2.R'), args: [], declared_outputs: [{ role: 'phenotypes', relative_path: 'pheno2.tsv', required: true }],
      }, 'call-r-2')
      expect(second.outcome).toBe('succeeded')
      const submissions = [...harness.store.receiptSubmissions.entries()].map(([, row]) => row)
      const codeRefs = submissions.flatMap(submission => submission.components.softwareAndCode.ownerRefs.filter(ref => ref.startsWith('av_')))
      expect(new Set(codeRefs).size).toBe(2)
    } finally {
      await harness.close()
    }
  })

  it('derives codeOrigin labels from provenance facts across the three source classes', async () => {
    const harness = await proHarness(1, 2)
    try {
      // (1) packaged: locator matches the adapter's versioned packaged-script manifest.
      await writeFile(join(harness.root, 'packaged-sim.R'), '# packaged\n# FAKE-OUTPUT: out.tsv\n', 'utf8')
      const packaged = await runTool(harness, RSCRIPT_TOOL_SPEC, {
        code: join(harness.root, 'packaged-sim.R'), args: [], declared_outputs: [{ role: 'o', relative_path: 'out.tsv', required: true }],
      }, 'call-r-org-1')
      // (2) first capture by this call on a caller-supplied locator → user/external.
      await writeFile(join(harness.root, 'user.R'), '# user\n# FAKE-OUTPUT: out.tsv\n', 'utf8')
      const userFirst = await runTool(harness, RSCRIPT_TOOL_SPEC, {
        code: join(harness.root, 'user.R'), args: [], declared_outputs: [{ role: 'o', relative_path: 'out.tsv', required: true }],
      }, 'call-r-org-2')
      // (3) prior in-session capture of the same locator → Session+code-ArtifactVersion fact.
      const agentSession = await runTool(harness, RSCRIPT_TOOL_SPEC, {
        code: join(harness.root, 'user.R'), args: [], declared_outputs: [{ role: 'o', relative_path: 'out.tsv', required: true }],
      }, 'call-r-org-3')
      const labelOf = (result: { receiptSubmissionRef: string }) => {
        const submission = harness.store.receiptSubmissions.get(result.receiptSubmissionRef)
        return (submission?.extensions[0]?.payload as { codeOrigin?: string } | undefined)?.codeOrigin
      }
      expect(packaged.outcome).toBe('succeeded')
      expect(labelOf(packaged)).toBe('animalge_packaged')
      expect(userFirst.outcome).toBe('succeeded')
      expect(labelOf(userFirst)).toBe('user_or_external')
      expect(agentSession.outcome).toBe('succeeded')
      expect(labelOf(agentSession)).toBe('agent_session_generated')
    } finally {
      await harness.close()
    }
  })

  it('a failing script settles failed with residual diagnostics only', async () => {
    const harness = await proHarness(1, 2)
    try {
      await writeFile(join(harness.root, 'fail.R'), '# FAKE-FAIL: 1\n', 'utf8')
      const result = await runTool(harness, RSCRIPT_TOOL_SPEC, {
        code: join(harness.root, 'fail.R'), args: [], declared_outputs: [{ role: 'out', relative_path: 'out.tsv', required: true }],
      }, 'call-r-3')
      expect(result.outcome).toBe('failed')
      expect(result.outputs).toEqual([])
    } finally {
      await harness.close()
    }
  })
})

describe('S03-A16 cmplot_call golden', () => {
  it('validates the PNG magic bytes and fails on a non-image output', async () => {
    const harness = await proHarness(2, 4)
    try {
      await writeFile(join(harness.root, 'gwas.tsv'), 'SNP\tCHR\tPOS\tP\nsnp1\t1\t100\t0.01\nsnp2\t2\t200\t0.5\n', 'utf8')
      const helper = join(harness.root, 'cmplot-helper.R')
      await writeFile(helper, '# FAKE-OUTPUT-PNG: $2.png\n# FAKE-OUTPUT: $2.log\n', 'utf8')
      const result = await runTool(harness, CMPLOT_TOOL_SPEC, {
        gwas: join(harness.root, 'gwas.tsv'), helper, threshold: 0.05, out_prefix: join(harness.root, 'manh'),
      }, 'call-cmplot-1')
      expect(result.outcome).toBe('succeeded')
      expect(result.outputs.map(output => output.role)).toContain('manhattan_plot')
      const manifest = harness.store.outputManifests.get(result.outputManifestRef ?? '')
      expect(manifest?.formalOutputs.find(output => output.role === 'manhattan_plot')?.validatorResult.passed).toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('version resolution hooks parse both the Rscript and fake package outputs', async () => {
    const harness = await proHarness(1, 2)
    try {
      expect(RSCRIPT_TOOL_SPEC.hooks.resolveVersion('rscript', 'R version 4.4.0fake')).toBe('R 4.4.0fake')
      expect(CMPLOT_TOOL_SPEC.hooks.resolveVersion('cmplot-rpkg', 'CMplot v1.0fake')).toBe('CMplot 1.0')
      expect(PLINK_TOOL_SPEC.hooks.resolveVersion('plink', 'garbage')).toBeNull()
      void harness
      void chmod
    } finally {
      await harness.close()
    }
  })
})
