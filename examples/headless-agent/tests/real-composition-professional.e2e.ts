/**
 * S03-A18 REAL composition: real Loader/app Session calling the registered plink_cli Tool
 * through a real fake-executable subprocess into a receipt-backed committed Snapshot whose
 * generated_by lineage passes the finalization gate, plus the crash-after-submission
 * restart recovery.
 * @module examples/headless-agent/tests/real-composition-professional.e2e.ts
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

const here = join(fileURLToPath(import.meta.url), '..')
const driver = join(here, 'fixtures', 'evidence-professional-driver.ts')
const config = join(here, 'fixtures', 'evidence-professional.cordis.yml')

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface ProfessionalPayload {
  readonly type: string
  readonly snapshotDigest: string | null
  readonly commitCount: number
  readonly acceptanceCount: number
  readonly acceptedCount: number
  readonly receiptBackedRuns: number
  readonly artifactNodes: number
  readonly contextNodes: number
  readonly usedEdges: number
  readonly generatedByEdges: number
  readonly finalizationCount: number
  readonly manifestCount: number
  readonly reservationReleased: number
  readonly llmCalls: number
}

function runDriver(root: string, extraEnv: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), driver, config, 'Run the PLINK genotype QC.'], {
      cwd: root,
      env: {
        ...process.env,
        ...extraEnv,
        DSH_CLI_MOCK_TOOL: 'plink_cli',
        DSH_CLI_MOCK_COUNT: '1',
        DSH_CLI_MOCK_TOOL_ARGS: JSON.stringify({
          bed: 'input.bed',
          bim: 'input.bim',
          fam: 'input.fam',
          maf: 0.05,
          geno: 0.1,
          mind: 0.1,
          native_args: [],
          out_prefix: 'qc-result',
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => { resolve({ code, stdout, stderr }) })
  })
}

function parsePayload(stdout: string): ProfessionalPayload {
  const line = stdout.trim().split('\n').at(-1)
  return JSON.parse(line ?? '{}') as ProfessionalPayload
}

describe('S03-A18 professional REAL composition', () => {
  it(
    'runs plink_cli through the real Loader composition into a finalization-gated receipt-backed Snapshot',
    { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'spec03-pro-real-'))
      roots.push(root)
      const { code, stdout, stderr } = await runDriver(root, {})
      expect(stderr).toBe('')
      expect(code).toBe(0)
      const payload = parsePayload(stdout)
      expect(payload.type).toBe('professional')
      expect(payload.snapshotDigest).not.toBeNull()
      expect(payload.acceptedCount).toBeGreaterThanOrEqual(1)
      expect(payload.receiptBackedRuns).toBeGreaterThanOrEqual(1)
      expect(payload.artifactNodes).toBeGreaterThanOrEqual(4)
      expect(payload.contextNodes).toBeGreaterThanOrEqual(2)
      expect(payload.finalizationCount).toBeGreaterThanOrEqual(1)
      expect(payload.manifestCount).toBeGreaterThanOrEqual(1)
      expect(payload.reservationReleased).toBeGreaterThanOrEqual(1)
      // The finalization gate: formal outputs (bed/bim/fam/log) carry generated_by edges.
      expect(payload.generatedByEdges).toBeGreaterThanOrEqual(4)
      expect(payload.usedEdges).toBeGreaterThanOrEqual(1)
      expect(payload.llmCalls).toBeLessThanOrEqual(2)
    },
  )

  it(
    'recovers acceptance and the receipt-backed head after a crash following the Submission',
    { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'spec03-pro-crash-'))
      roots.push(root)
      const crashed = await runDriver(root, { SPEC03_CRASH_AFTER_SUBMISSION: '1' })
      expect(crashed.code).not.toBe(0)
      const resumed = await runDriver(root, { SPEC03_RESUME_ONLY: '1' })
      expect(resumed.code).toBe(0)
      const payload = parsePayload(resumed.stdout)
      expect(payload.acceptedCount).toBeGreaterThanOrEqual(1)
      expect(payload.receiptBackedRuns).toBeGreaterThanOrEqual(1)
      expect(payload.snapshotDigest).not.toBeNull()
    },
  )
})
