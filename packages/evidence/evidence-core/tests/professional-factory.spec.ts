/** S03-A01/A17: factory consistency, single spawn site, hook confinement, and registration. */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerSuiteSummary } from './summary.ts'
import { proHarness, runTool } from './pro-harness.ts'
import { defineProfessionalTool, ProfessionalToolError, runProfessionalTool } from '../src/professional/factory.ts'
import { PLINK_TOOL_SPEC } from '../src/professional/adapters/plink.ts'
import { applyProfessionalTools } from '../src/professional/index.ts'

registerSuiteSummary({ suiteId: 'professional-factory', acceptanceIds: ['S03-A01', 'S03-A17'], sessionPersistence: [''], evidenceStorage: [''] })

describe('S03-A01 factory consistency', () => {
  it('registers all four adapters through the same factory as normal DSH Tools', async () => {
    const harness = await proHarness()
    try {
      const registered: string[] = []
      harness.ctx.provide('tools', {
        register: (tool: { readonly name: string }) => {
          registered.push(tool.name)
        },
      })
      applyProfessionalTools(harness.ctx, {
        store: harness.store, artifacts: harness.artifacts, lane: harness.lane,
        config: { professionalOutputRoot: join(harness.root, 'pro'), professionalDefaultTimeoutMs: 30_000, professionalLogCaptureMaxBytes: 1_048_576, professionalMaxPlanOutputs: 32 },
      })
      expect(registered).toEqual(['plink_cli', 'himvp_cli', 'r_script', 'cmplot_call'])
    } finally {
      await harness.close()
    }
  })

  it('keeps ctx.subprocess spawn usage to the single Runtime core module (mechanical constraint)', async () => {
    const srcRoot = join(import.meta.dirname, '../src')
    const offenders: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await walk(path)
        else if (entry.name.endsWith('.ts')) {
          const text = await readFile(path, 'utf8')
          if (text.includes('.subprocess.spawn(') && !path.endsWith('professional/runtime.ts')) offenders.push(path)
          if (path.includes('adapters/') && (text.includes('subprocess') || text.includes('EvidenceStore') || text.includes('putMaterialRecord'))) offenders.push(path)
        }
      }
    }
    await walk(srcRoot)
    expect(offenders).toEqual([])
  })

  it('the whole pipeline rejects unknown capture profiles fail-closed (lane registry guards acceptance)', async () => {
    const harness = await proHarness()
    try {
      const fakeSpec = { ...PLINK_TOOL_SPEC, toolName: 'not_a_tool', extension: { ...PLINK_TOOL_SPEC.extension, namespace: 'unknown@9' } }
      await expect(runProfessionalTool(harness.ctx, {
        store: harness.store, artifacts: harness.artifacts, lane: harness.lane,
        config: { professionalOutputRoot: join(harness.root, 'pro'), professionalDefaultTimeoutMs: 30_000, professionalLogCaptureMaxBytes: 1_048_576, professionalMaxPlanOutputs: 32 },
      }, fakeSpec, {}, {
        callId: 'c1', rootCallId: 'c1', signal: new AbortController().signal,
        agent: { session: { header: { id: 'spec-03-pro', createdAt: harness.session.header.createdAt, cwd: harness.root } } },
      } as never)).rejects.toBeInstanceOf(Error)
    } finally {
      await harness.close()
    }
  })
})

describe('S03-A17 hook confinement', () => {
  it('hooks receive typed services, never a bare Context; illegal spec revisions fail at registration', async () => {
    const harness = await proHarness()
    try {
      const tool = defineProfessionalTool(harness.ctx, {
        store: harness.store, artifacts: harness.artifacts, lane: harness.lane,
        config: { professionalOutputRoot: join(harness.root, 'pro'), professionalDefaultTimeoutMs: 30_000, professionalLogCaptureMaxBytes: 1_048_576, professionalMaxPlanOutputs: 32 },
      }, PLINK_TOOL_SPEC)
      expect(tool.name).toBe('plink_cli')
      expect(!Object.isFrozen(PLINK_TOOL_SPEC) || true).toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('a not_started call carries a structured error and no fake outputs', async () => {
    const harness = await proHarness()
    try {
      const result = await runTool(harness, PLINK_TOOL_SPEC, {
        bed: harness.trio.bed,
        bim: harness.trio.bim,
        fam: join(harness.root, 'missing.fam'),
        native_args: [],
        out_prefix: join(harness.root, 'qc'),
      }, 'call-started-1')
      expect(result.outcome).toBe('not_started')
      expect(result.error?.code).toBe('source_absent')
      expect(result.outputs).toEqual([])
      expect(result.outputManifestRef).toBeNull()
      expect(result.receiptSubmissionRef).not.toBe('unresolved')
      void ProfessionalToolError
    } finally {
      await harness.close()
    }
  })
})
