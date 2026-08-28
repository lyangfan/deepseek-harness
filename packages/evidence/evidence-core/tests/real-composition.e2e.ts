import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionPersistence from '@deepseek-ai/dsh-session-persistence-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as SqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import * as EvidenceCore from '../src/index.ts'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { CurrentHeadV1 } from '../src/types.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { recordSummaryPayload, registerSuiteSummary } from './summary.ts'

registerSuiteSummary({
  suiteId: 'real-composition',
  acceptanceIds: ['S01-A15', 'S01-A16'],
  sessionPersistence: ['jsonl', 'sqlite'],
  evidenceStorage: ['json', 'sqlite'],
  fixtures: [
    'examples/headless-agent/tests/fixtures/evidence-core-driver.ts',
    'examples/headless-agent/tests/fixtures/evidence-core.cordis.yml',
  ],
})

const roots: string[] = []
afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }) })

const evidenceConfig: EvidenceCore.Config = {
  eligibleAgentPresetIds: ['animalge-open-test'],
  deterministicRunSelection: { revision: 'spec-01-test/v1', exactToolNames: ['bash'] },
  idleMergeMs: 0,
  runnerEnabled: true,
  runnerOutputRoot: '.evidence-runner-outputs',
  runnerDefaultTimeoutMs: 60_000,
  runnerMaxDeclaredOutputs: 64,
  runnerLogCaptureMaxBytes: 1_048_576,
  materialHashCacheMaxEntries: 4_096,
  professionalToolsEnabled: false,
  professionalOutputRoot: '.evidence-professional-outputs',
  professionalDefaultTimeoutMs: 60_000,
  professionalLogCaptureMaxBytes: 1_048_576,
  professionalMaxPlanOutputs: 32,
  captureOutboxMaxBytes: 67_108_864,
  captureOutboxMaxBoundaries: 1_000,
  storageSoftBytes: 1_073_741_824,
  storageHardBytes: 2_147_483_648,
  stagingGcAgeMs: 86_400_000,
  orphanGcGraceMs: 604_800_000,
  gcIntervalMs: 86_400_000,
  maxRetryAttempts: 5,
  retryDelaysMs: [1_000, 2_000, 4_000, 8_000],
}

type PersistenceKind = 'jsonl' | 'sqlite'
type StorageKind = 'json' | 'sqlite'

async function boot(
  persistence: PersistenceKind,
  storage: StorageKind,
  existingRoot?: string,
  config: EvidenceCore.Config = evidenceConfig,
  configure?: (ctx: Context) => void,
) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), `dsh-evidence-${persistence}-${storage}-`))
  if (existingRoot === undefined) roots.push(root)
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    if (storage === 'json') await ctx.plugin(JsonStorage, { root: join(root, 'storage') })
    else await ctx.plugin(SqliteStorage, { path: join(root, 'storage.db'), journalMode: 'wal' })
    await ctx.plugin(StorageDomain, { backend: storage, routes: {} })
    await ctx.plugin(SessionStore)
    if (persistence === 'jsonl') await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none', writeBatchMaxDelayMs: 1 })
    else await ctx.plugin(SqliteSessionPersistence, { path: join(root, 'sessions.db'), journalMode: 'wal', busyTimeoutMs: 5_000, writeBatchMaxDelayMs: 1 })
    // SPEC-02: the material layer requires ctx.fs, and the Runner additionally
    // requires the subprocess service; provide both local providers so the
    // default composition stays activation-complete.
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(LocalSubprocessRuntime)
    // SPEC-01 regressions never invoke the Runner or professional Tools, so minimal
    // tools/jobs services satisfy registration; the real paths are covered by the
    // Loader app compositions.
    ctx.provide('tools', { register: () => {} } as never)
    ctx.provide('jobs', { start: () => 'sci-tool-0' } as never)
    configure?.(ctx)
    await ctx.plugin(EvidenceCore, config)
    return { ctx, root }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

function currentHead(ctx: Context): CurrentHeadV1 | undefined {
  const domain = ctx.storageDomain.get('animalge_evidence')
  if (domain === undefined) return undefined
  return [...domain.table('heads').entries()].map(([, value]) => value as CurrentHeadV1)[0]
}

async function oneRealSession(ctx: Context): Promise<void> {
  const session = ctx.sessions.create(SessionId('spec01-real-composition'), {
    meta: { createdAt: 1_700_000_000_000, agentPreset: 'animalge-open-test' },
  })
  const callId = CallId('real-bash-call')
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"pwd"}' })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: '/tmp' }], isError: false }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  expect(await ctx.sessions.flush(session)).toBe(true)
  await vi.waitFor(() => {
    expect(currentHead(ctx)?.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
  }, { timeout: 10_000, interval: 20 })
}

describe('S01-A13 budget and overflow gates', () => {
  const baseBudgetConfig = (overrides: {
    storageSoftBytes?: number
    storageHardBytes?: number
    idleMergeMs?: number
    captureOutboxMaxBoundaries?: number
  } = {}): EvidenceCore.Config => ({
    eligibleAgentPresetIds: ['animalge-open-test'],
    deterministicRunSelection: { revision: 'spec-01-test/v1', exactToolNames: ['bash'] },
    runnerEnabled: true,
    runnerOutputRoot: '.evidence-runner-outputs',
    runnerDefaultTimeoutMs: 60_000,
    professionalToolsEnabled: false,
    professionalOutputRoot: '.evidence-professional-outputs',
    professionalDefaultTimeoutMs: 60_000,
    professionalLogCaptureMaxBytes: 1_048_576,
    professionalMaxPlanOutputs: 32,
    runnerMaxDeclaredOutputs: 64,
    runnerLogCaptureMaxBytes: 1_048_576,
    materialHashCacheMaxEntries: 4_096,
    idleMergeMs: overrides.idleMergeMs ?? 0,
    captureOutboxMaxBytes: 67_108_864,
    captureOutboxMaxBoundaries: overrides.captureOutboxMaxBoundaries ?? 1_000,
    storageSoftBytes: overrides.storageSoftBytes ?? 1_073_741_824,
    storageHardBytes: overrides.storageHardBytes ?? 2_147_483_648,
    stagingGcAgeMs: 86_400_000,
    orphanGcGraceMs: 604_800_000,
    gcIntervalMs: 86_400_000,
    maxRetryAttempts: 5,
    retryDelaysMs: [1_000, 2_000, 4_000, 8_000],
  })

  it('pauses compilation at the hard budget while Sessions keep working', async () => {
    const { ctx } = await boot('jsonl', 'json', undefined, baseBudgetConfig({ storageSoftBytes: 1, storageHardBytes: 2 }))
    try {
      const session = ctx.sessions.create(SessionId('spec01-hard-budget'), {
        meta: { createdAt: 1_700_000_000_000, agentPreset: 'animalge-open-test' },
      })
      const callId = CallId('budget-bash')
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"pwd"}' })
      session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId, content: [{ type: 'text', text: '/tmp' }], isError: false }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(await ctx.sessions.flush(session)).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 500))
      const domain = ctx.storageDomain.get('animalge_evidence')!
      expect(domain.table('outbox').size).toBe(1)
      expect(domain.table('attempts').size).toBe(0)
      expect(currentHead(ctx)).toMatchObject({ snapshotDigest: null, headRevision: 0 })
      recordSummaryPayload({ hard_budget_paused_compile: true, hard_budget_attempts: 0 })
    } finally { await ctx.fiber.dispose() }
  })

  it('marks a merged outbox row overflowed past captureOutboxMaxBoundaries and pauses it', async () => {
    const { ctx } = await boot('jsonl', 'json', undefined, baseBudgetConfig({ idleMergeMs: 60_000, captureOutboxMaxBoundaries: 1 }))
    try {
      const session = ctx.sessions.create(SessionId('spec01-overflow'), {
        meta: { createdAt: 1_700_000_000_000, agentPreset: 'animalge-open-test' },
      })
      for (const turn of [1, 2]) {
        session.append('turn/start', { turn })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      expect(await ctx.sessions.flush(session)).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 500))
      const domain = ctx.storageDomain.get('animalge_evidence')!
      const row = [...domain.table('outbox').entries()].map(([, value]) => value as { overflowed?: boolean; firstRejectedTarget?: number; boundaryCount?: number })[0]
      expect(row).toMatchObject({ overflowed: true, boundaryCount: 2 })
      expect(row?.firstRejectedTarget).toBeGreaterThan(0)
      expect(domain.table('attempts').size).toBe(0)
      expect(currentHead(ctx)).toMatchObject({ snapshotDigest: null, headRevision: 0 })
      recordSummaryPayload({ outbox_overflow_merged: true, outbox_overflow_boundary_count: row?.boundaryCount ?? null })
    } finally { await ctx.fiber.dispose() }
  })
})

describe('S01-A09 transient read failures retry within the §8.5 budget', () => {
  const retryConfig = (maxRetryAttempts: number, retryDelaysMs: number[]): EvidenceCore.Config => ({
    eligibleAgentPresetIds: ['animalge-open-test'],
    deterministicRunSelection: { revision: 'spec-01-test/v1', exactToolNames: ['bash'] },
    runnerEnabled: true,
    runnerOutputRoot: '.evidence-runner-outputs',
    runnerDefaultTimeoutMs: 60_000,
    professionalToolsEnabled: false,
    professionalOutputRoot: '.evidence-professional-outputs',
    professionalDefaultTimeoutMs: 60_000,
    professionalLogCaptureMaxBytes: 1_048_576,
    professionalMaxPlanOutputs: 32,
    runnerMaxDeclaredOutputs: 64,
    runnerLogCaptureMaxBytes: 1_048_576,
    materialHashCacheMaxEntries: 4_096,
    idleMergeMs: 0,
    captureOutboxMaxBytes: 67_108_864,
    captureOutboxMaxBoundaries: 1_000,
    storageSoftBytes: 1_073_741_824,
    storageHardBytes: 2_147_483_648,
    stagingGcAgeMs: 86_400_000,
    orphanGcGraceMs: 604_800_000,
    gcIntervalMs: 86_400_000,
    maxRetryAttempts,
    retryDelaysMs,
  })

  // Fail only compile-phase boundary reads (from > 0); capture reads start at watermark 0.
  // The instance method is shadowed in place because the service value lives on the
  // persistence plugin's own fiber and cannot be swapped via reflect.set from the root.
  const failBoundaryReads = (ctx: Context, failures: number): void => {
    const real = ctx.sessionPersistence
    const original = real.readFrom.bind(real)
    let remaining = failures
    real.readFrom = async (id, from, signal) => {
      if (from > 0 && remaining !== 0) {
        remaining = remaining === Infinity ? Infinity : remaining - 1
        throw new Error(`injected transient read failure at seq ${from}`)
      }
      return original(id, from, signal)
    }
  }

  const appendTurn = (ctx: Context, callId: CallId): void => {
    const session = ctx.sessions.create(SessionId('spec01-retry'), {
      meta: { createdAt: 1_700_000_000_000, agentPreset: 'animalge-open-test' },
    })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"pwd"}' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: '/tmp' }], isError: false }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }

  it('retries one transient boundary-read failure within the budget and still publishes', async () => {
    const { ctx } = await boot('jsonl', 'json', undefined, retryConfig(3, [10, 20]), (ctx) => { failBoundaryReads(ctx, 1) })
    try {
      appendTurn(ctx, CallId('retry-once'))
      const domain = ctx.storageDomain.get('animalge_evidence')!
      await vi.waitFor(() => {
        expect(currentHead(ctx)?.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
        const settled = [...domain.table('attempts').entries()].map(([, value]) => value as { state: string })
        expect(settled.filter(attempt => attempt.state === 'succeeded')).toHaveLength(1)
      }, { timeout: 10_000 })
      const attempts = [...domain.table('attempts').entries()].map(([, value]) => value as { state: string })
      expect(attempts.filter(attempt => attempt.state === 'failed')).toHaveLength(1)
      expect(domain.table('outbox').size).toBe(0)
      recordSummaryPayload({ transient_read_retried_attempts: attempts.length })
    } finally { await ctx.fiber.dispose() }
  })

  it('hard-stops after exhausting the retry budget while Sessions keep working', async () => {
    const { ctx } = await boot('jsonl', 'json', undefined, retryConfig(3, [10, 20]), (ctx) => { failBoundaryReads(ctx, Number.POSITIVE_INFINITY) })
    try {
      appendTurn(ctx, CallId('retry-exhausted'))
      await new Promise(resolve => setTimeout(resolve, 400))
      const domain = ctx.storageDomain.get('animalge_evidence')!
      const attempts = [...domain.table('attempts').entries()].map(([, value]) => value as { state: string })
      expect(attempts).toHaveLength(3)
      expect(attempts.every(attempt => attempt.state === 'failed')).toBe(true)
      expect(currentHead(ctx)).toMatchObject({ snapshotDigest: null, headRevision: 0 })
      expect(domain.table('outbox').size).toBe(1)
      const session = ctx.sessions.get(SessionId('spec01-retry'))!
      expect(await ctx.sessions.flush(session)).toBe(true)
      recordSummaryPayload({ retry_budget_exhausted_attempts: attempts.length })
    } finally { await ctx.fiber.dispose() }
  })
})

describe('S01-A15 real persistence/storage contract matrix', () => {
  for (const persistence of ['jsonl', 'sqlite'] as const) {
    for (const storage of ['json', 'sqlite'] as const) {
      it(`${persistence} persistence × ${storage} storage publishes and cold-reopens the same digest`, async () => {
        const first = await boot(persistence, storage)
        await oneRealSession(first.ctx)
        const digest = currentHead(first.ctx)?.snapshotDigest
        recordSummaryPayload({ [`matrix_${persistence}_${storage}_digest`]: digest ?? null })
        await first.ctx.fiber.dispose()

        const second = await boot(persistence, storage, first.root)
        try {
          await vi.waitFor(() => { expect(currentHead(second.ctx)?.snapshotDigest).toBe(digest) }, { timeout: 10_000 })
          const domain = second.ctx.storageDomain.get('animalge_evidence')!
          expect(domain.table('heads').size).toBe(1)
          expect(domain.table('snapshots').size).toBe(1)
        } finally { await second.ctx.fiber.dispose() }
      }, 30_000)
    }
  }

  it('boots the real Loader/app process and captures a real bash Tool round trip', async () => {
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const binScript = join(repoRoot, 'examples/headless-agent/tests/fixtures/evidence-core-driver.ts')
    const configPath = join(repoRoot, 'examples/headless-agent/tests/fixtures/evidence-core.cordis.yml')
    const result = await runLoaderSmoke({
      label: 'SPEC-01 Evidence Core',
      tempDirPrefix: 'dsh-spec01-loader-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'prove the Evidence Tool path'],
      tsconfigPath: join(repoRoot, 'tsconfig.json'),
    })
    expect(result.stderr).toBe('')
    const payload = JSON.parse(result.stdout.trimEnd().split('\n').at(-1)!) as Record<string, unknown>
    expect(String(payload.output)).toContain('CLI_TOOL_ROUND_TRIP')
    expect(payload.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(payload.headCount).toBe(1)
    recordSummaryPayload({
      loader_round_trip: true,
      loader_snapshot_digest: payload.snapshotDigest ?? null,
      loader_head_count: payload.headCount ?? null,
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('keeps the synchronous listener below p95/p99 budgets with zero hot-path persistence calls', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend())
    const facility = new StorageDomain.DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(SessionStore)
    // Minimal SPEC-02 service stubs: the hot path never touches them, but the plugin's
    // `inject` waits for fs/subprocess and the runner stays off for this composition.
    ctx.provide('fs', {} as never)
    ctx.provide('subprocess', {} as never)
    ctx.provide('tools', { register: vi.fn() } as never)
    ctx.provide('jobs', { start: () => 'sci-tool-0' } as never)
    const readFrom = vi.fn(async () => { throw new Error('background read is outside the measured hot path') })
    ctx.provide('sessionPersistence', {
      listSnapshots: vi.fn(async () => []),
      readFrom,
    } as never)
    let llmAccesses = 0
    ctx.provide('llm', new Proxy({}, {
      get() {
        llmAccesses++
        throw new Error('evidence-core must not touch the LLM service')
      },
    }) as never)
    const listenerConfig: import('../src/index.ts').Config = Object.assign({}, evidenceConfig, { runnerEnabled: false })
    await ctx.plugin(EvidenceCore, listenerConfig)
    const session = ctx.sessions.create(SessionId('listener-budget'), { meta: { agentPreset: 'animalge-open-test' } })
    const flush = vi.spyOn(ctx.sessions, 'flush')
    const samples: number[] = []
    const event = { type: 'assistant/chunk', seq: 0, time: 0, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } } as const
    for (let index = 0; index < 2_000; index++) {
      const started = performance.now()
      ctx.emit('session/event', session, event)
      samples.push(performance.now() - started)
    }
    const hotPathFlushCalls = flush.mock.calls.length
    const hotPathReadFromCalls = readFrom.mock.calls.length
    expect(hotPathFlushCalls).toBe(0)
    expect(hotPathReadFromCalls).toBe(0)
    samples.sort((left, right) => left - right)
    const p95Ms = samples[Math.floor(samples.length * 0.95)]!
    const p99Ms = samples[Math.floor(samples.length * 0.99)]!
    expect(p95Ms).toBeLessThanOrEqual(25)
    expect(p99Ms).toBeLessThanOrEqual(100)
    // A real completion boundary may wake the background capture path, but the
    // Evidence package must still never reach the LLM service (spec §12.3).
    ctx.emit('session/event', session, { type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } } as const)
    await vi.waitFor(() => { expect(flush).toHaveBeenCalled() }, { timeout: 5_000, interval: 10 })
    expect(llmAccesses).toBe(0)
    recordSummaryPayload({
      listener_p95_ms: p95Ms,
      listener_p99_ms: p99Ms,
      listener_samples: samples.length,
      hot_path_flush_calls: hotPathFlushCalls,
      hot_path_read_from_calls: hotPathReadFromCalls,
      llm_service_accesses: llmAccesses,
    })
    await ctx.fiber.dispose()
  })

  it('cold-restarts a mid-turn SIGKILLed Loader process twice with a real DSH crash repair', async () => {
    const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-spec01-crash-')); roots.push(cwd)
    const driver = join(repoRoot, 'examples/headless-agent/tests/fixtures/evidence-core-driver.ts')
    const config = join(repoRoot, 'examples/headless-agent/tests/fixtures/evidence-core.cordis.yml')
    const run = async (phase: 'crash' | 'restart') => new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), driver, config, 'prove crash recovery'], {
        cwd,
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json'),
          DSH_HOME: join(cwd, '.dsh'),
          DSH_AGENTS_HOME: join(cwd, '.agents'),
          ...(phase === 'crash'
            ? { SPEC01_CRASH_MID_TURN: '1', DSH_CLI_MOCK_COMMAND: 'sleep 30' }
            : { SPEC01_RESTART_ONLY: '1' }),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''; let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string | Buffer) => { stdout += chunk.toString() })
      child.stderr.setEncoding('utf8').on('data', (chunk: string | Buffer) => { stderr += chunk.toString() })
      child.once('error', reject)
      child.once('close', (code, signal) => { resolve({ code, signal, stdout, stderr }) })
    })
    const crashed = await run('crash')
    expect(crashed.signal).toBe('SIGKILL')
    const marker = JSON.parse(await readFile(join(cwd, '.spec01-crash-marker.json'), 'utf8')) as Record<string, unknown>
    expect(marker).toMatchObject({ type: 'crash-mid-turn', toolCalls: 1 })
    const restart1 = await run('restart')
    const restart2 = await run('restart')
    expect(restart1).toMatchObject({ code: 0, signal: null, stderr: '' })
    expect(restart2).toMatchObject({ code: 0, signal: null, stderr: '' })
    const recovered1 = JSON.parse(restart1.stdout.trimEnd().split('\n').at(-1)!) as Record<string, unknown>
    const recovered2 = JSON.parse(restart2.stdout.trimEnd().split('\n').at(-1)!) as Record<string, unknown>
    expect(String(recovered1.snapshotDigest)).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(recovered1).toMatchObject({
      repairCode: 'TOOL_OUTCOME_UNKNOWN',
      repairedOutcome: 'outcome_unknown',
      headCount: 1,
      commitCount: 1,
      toolCalls: 1,
    })
    expect(recovered2).toEqual(recovered1)
    recordSummaryPayload({
      crash_signal: 'SIGKILL',
      crash_phase: 'mid-turn (tool/call persisted, no terminal)',
      crash_restarts: 2,
      crash_repair_code: 'TOOL_OUTCOME_UNKNOWN',
      crash_repaired_outcome: 'outcome_unknown',
      crash_snapshot_digest: recovered1.snapshotDigest ?? null,
      crash_digest_stable: recovered1.snapshotDigest === recovered2.snapshotDigest,
      crash_tool_calls_not_rerun: recovered1.toolCalls ?? null,
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
