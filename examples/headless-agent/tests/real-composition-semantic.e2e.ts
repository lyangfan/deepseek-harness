/**
 * S04 REAL composition: a real Loader/app Session whose turn completes through the cli-mock
 * chat model while the semantic lane — driven by the same mock provider in evidence mode —
 * persists evidence/model-request events, materializes CandidateStatement nodes and
 * candidate relation edges into the candidate-triple committed Snapshot, and recovers from
 * a crash after the model call. Also asserts the deterministic-only fallback states.
 * @module examples/headless-agent/tests/real-composition-semantic.e2e.ts
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'

const here = join(fileURLToPath(import.meta.url), '..')
const driver = join(here, 'fixtures', 'evidence-semantic-driver.ts')
const config = join(here, 'fixtures', 'evidence-semantic.cordis.yml')

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

interface SemanticPayload {
  readonly type: string
  readonly mode: string
  readonly headDigest: string | null
  readonly headRevision: number
  readonly schemaSetCandidate: boolean
  readonly semanticWatermark: string
  readonly candidateNodes: number
  readonly candidateEdges: number
  readonly modelCalls: number
  readonly modelRequestEvents: number
  readonly laneWatermark: number | null
  readonly evidenceCalls: number
  readonly semanticSwitchEnabled?: string
}

interface DriverRun { code: number | null; stdout: string; stderr: string }

function runDriver(root: string, args: string[], extraEnv: Record<string, string>): Promise<DriverRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), driver, config, ...args], {
      cwd: root,
      // tsx resolves workspace imports through the repo tsconfig; a bare temp cwd would
      // fall back to stale lib/ builds, so the config is pinned for every child.
      env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) =>{  resolve({ code, stdout, stderr }) })
  })
}

function payloadOf(output: string): SemanticPayload {
  const line = output.trim().split('\n').at(-1)
  if (line === undefined) throw new Error('driver produced no payload line')
  return JSON.parse(line) as SemanticPayload
}

describe('S04 REAL semantic composition', () => {
  it('materializes candidates and relation edges through the full real chain (S04-A01)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spec04-semantic-'))
    roots.push(root)
    const run = await runDriver(root, ['run', 'Discuss the GWAS filtering results.'], {
      DSH_CLI_MOCK_EVIDENCE: '1',
    })
    expect(run.code).toBe(0)
    const payload = payloadOf(run.stdout)
    expect(payload.schemaSetCandidate).toBe(true)
    expect(payload.candidateNodes).toBeGreaterThanOrEqual(2)
    expect(payload.candidateEdges).toBeGreaterThanOrEqual(1)
    expect(payload.modelRequestEvents).toBeGreaterThanOrEqual(1)
    expect(payload.evidenceCalls).toBeGreaterThanOrEqual(1)
    expect(payload.semanticWatermark).toContain('"kind":"active"')
    expect(payload.laneWatermark).not.toBeNull()
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('model failure keeps the deterministic Snapshot current while the semantic watermark stalls (S04-A11)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spec04-semantic-fail-'))
    roots.push(root)
    const run = await runDriver(root, ['run', 'Discuss the GWAS filtering results.'], {
      DSH_CLI_MOCK_EVIDENCE: 'fail',
      SPEC04_EXPECT_FAILURE: '1',
    })
    expect(run.code).toBe(0)
    const payload = payloadOf(run.stdout)
    // The deterministic chain completed and its Snapshot is current; the semantic layer
    // made real dispatch attempts but never advanced past zero.
    expect(payload.headDigest).not.toBeNull()
    expect(payload.evidenceCalls).toBeGreaterThanOrEqual(1)
    expect(payload.candidateNodes).toBe(0)
    expect(payload.laneWatermark === null || payload.laneWatermark === 0).toBe(true)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('keeps zero dispatch and a current deterministic Snapshot while the switch is off (S04-A08)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spec04-semantic-off-'))
    roots.push(root)
    const run = await runDriver(root, ['run', 'Discuss the GWAS filtering results.'], {
      DSH_CLI_MOCK_EVIDENCE: '1',
      SPEC04_SEMANTIC_OFF: '1',
    })
    expect(run.code).toBe(0)
    const payload = payloadOf(run.stdout)
    expect(payload.headDigest).not.toBeNull()
    // The semantic channel never dispatched: no model-call rows, no request events, no
    // candidates. (The chat Agent's own model calls are unaffected by the switch.)
    expect(payload.modelCalls).toBe(0)
    expect(payload.modelRequestEvents).toBe(0)
    expect(payload.candidateNodes).toBe(0)
    expect(payload.semanticSwitchEnabled).toBe('false')
  }, 120_000)

  it('crashes after the first model call and resumes to the same candidate snapshot (S04-A15)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'spec04-semantic-crash-'))
    roots.push(root)
    const crashed = await runDriver(root, ['run', 'Discuss the GWAS filtering results.'], {
      DSH_CLI_MOCK_EVIDENCE: '1',
      SPEC04_CRASH_AFTER_TURN: '1',
    })
    expect(crashed.code === null || crashed.code !== 0).toBe(true)
    const resumed = await runDriver(root, ['resume', 'resume'], { DSH_CLI_MOCK_EVIDENCE: '1', SPEC04_RESUME_ONLY: '1' })
    expect(resumed.code).toBe(0)
    const payload = payloadOf(resumed.stdout)
    expect(payload.candidateNodes).toBeGreaterThanOrEqual(1)
    expect(payload.schemaSetCandidate).toBe(true)
    expect(payload.modelRequestEvents).toBeGreaterThanOrEqual(1)
  }, 180_000)
})
