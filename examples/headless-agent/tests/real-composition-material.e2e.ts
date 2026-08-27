/**
 * S02-A16 REAL composition: real Loader/app Session calling the registered Runner Tool
 * through a real subprocess into a receipt-backed committed Snapshot, plus the
 * crash-after-submission restart recovery.
 * @module examples/headless-agent/tests/real-composition-material.e2e.ts
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

const here = join(fileURLToPath(import.meta.url), '..')
const driver = join(here, 'fixtures', 'evidence-material-driver.ts')
const config = join(here, 'fixtures', 'evidence-material.cordis.yml')

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface MaterialPayload {
  readonly type: string
  readonly snapshotDigest: string | null
  readonly acceptanceCount: number
  readonly acceptedCount: number
  readonly receiptBackedRuns: number
  readonly artifactNodes: number
  readonly contextNodes: number
  readonly usedEdges: number
  readonly llmCalls: number
  readonly finalText?: string
}

function runDriver(root: string, extraEnv: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), driver, config, 'Run the declared analysis script.'], {
      cwd: root,
      env: {
        ...process.env,
        ...extraEnv,
        DSH_CLI_MOCK_TOOL: 'sci_run_code',
        DSH_CLI_MOCK_COUNT: '1',
        DSH_CLI_MOCK_TOOL_ARGS: JSON.stringify({
          language_profile: 'bash',
          code: { locator: 'script.sh' },
          inputs: [{ role: 'gwas-table', locator: 'input.tsv' }],
          declared_outputs: [{ role: 'filtered-table', relative_path: 'out.txt', required: true }],
          env: [],
          args: [],
          timeout_ms: 30000,
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '' as string
    let stderr = '' as string
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => { resolve({ code, stdout, stderr }) })
  })
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-spec02-real-'))
  roots.push(root)
  await writeFile(join(root, 'script.sh'), `#!/bin/bash\nset -euo pipefail\ncut -f2 ${join(root, 'input.tsv')} > out.txt\n`, 'utf8')
  await writeFile(join(root, 'input.tsv'), 'snp\tp\nrs1\t1e-9\nrs2\t2e-7\n', 'utf8')
  return root
}

describe('S02-A16 real composition', () => {
  it('drives a real Loader session through the Runner Tool to a receipt-backed committed Snapshot', { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS }, async () => {
    const root = await workspace()
    const { code, stdout, stderr } = await runDriver(root, {})
    expect(stderr).toBe('')
    expect(code).toBe(0)
    const payload = JSON.parse(stdout.trim().split('\n').at(-1) as string) as MaterialPayload
    expect(payload.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(payload.acceptedCount).toBeGreaterThanOrEqual(1)
    expect(payload.receiptBackedRuns).toBeGreaterThanOrEqual(1)
    expect(payload.artifactNodes).toBeGreaterThanOrEqual(3)
    expect(payload.contextNodes).toBeGreaterThanOrEqual(2)
    expect(payload.usedEdges).toBeGreaterThanOrEqual(1)
    // Exactly the two scripted model turns: any Evidence-side LLM call would inflate this.
    expect(payload.llmCalls).toBe(2)
    const runDirs = await import('node:fs/promises').then(fs => fs.readdir(join(root, '.evidence-runner-outputs', 'runs')))
    expect(runDirs.length).toBe(1)
    expect(runDirs[0]).toMatch(/^er_/)
    const output = await readFile(join(root, '.evidence-runner-outputs', 'runs', runDirs[0] as string, 'out.txt'), 'utf8')
    expect(output.trim()).toBe('p\n1e-9\n2e-7')
  })

  it('completes acceptance after a crash between Submission persistence and the result event', { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS }, async () => {
    const root = await workspace()
    const crashed = await runDriver(root, { SPEC02_CRASH_AFTER_SUBMISSION: '1' })
    expect(crashed.code === null || crashed.code === 137 || crashed.code === 0).toBe(true)
    expect(JSON.parse(await readFile(join(root, '.spec02-crash-marker.json'), 'utf8'))).toMatchObject({ type: 'crash-after-submission' })
    const resumed = await runDriver(root, { SPEC02_RESUME_ONLY: '1' })
    expect(resumed.code).toBe(0)
    const payload = JSON.parse(resumed.stdout.trim().split('\n').at(-1) as string) as MaterialPayload
    expect(payload.acceptedCount).toBeGreaterThanOrEqual(1)
    expect(payload.receiptBackedRuns).toBeGreaterThanOrEqual(1)
    expect(payload.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
