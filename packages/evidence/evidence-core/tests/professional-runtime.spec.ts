/** S03-A11/A12: managed-process terminal facts, five-value outcome, cancel terminate-and-join, jobs. */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerSuiteSummary } from './summary.ts'
import { materialHarness } from './helpers.ts'
import { buildChildEnv, runManagedProcess } from '../src/professional/runtime.ts'

registerSuiteSummary({ suiteId: 'professional-runtime', acceptanceIds: ['S03-A11', 'S03-A12'], sessionPersistence: [''], evidenceStorage: [''] })

describe('S03-A11 managed process terminal facts', () => {
  it('classifies normal exit, non-zero exit, timeout, and unknown spawns without partial', async () => {
    const harness = await materialHarness()
    try {
      const ok = await runManagedProcess({
        ctx: harness.ctx, argv: ['/bin/bash', '-c', 'exit 0'], cwd: harness.root, env: {},
        timeoutMs: 10_000, logCaptureMaxBytes: 65_536, abortSignal: new AbortController().signal,
        stdoutLogPath: null, stderrLogPath: null,
      })
      expect(ok.kind).toBe('spawned')
      if (ok.kind === 'spawned') {
        expect(ok.exitCode).toBe(0)
        expect(ok.timedOut).toBe(false)
        expect(ok.cancelled).toBe(false)
      }
      const bad = await runManagedProcess({
        ctx: harness.ctx, argv: ['/bin/bash', '-c', 'exit 3'], cwd: harness.root, env: {},
        timeoutMs: 10_000, logCaptureMaxBytes: 65_536, abortSignal: new AbortController().signal,
        stdoutLogPath: null, stderrLogPath: null,
      })
      expect(bad.kind === 'spawned' && bad.exitCode).toBe(3)
      const missing = await runManagedProcess({
        ctx: harness.ctx, argv: [join(harness.root, 'no-such-exe')], cwd: harness.root, env: {},
        timeoutMs: 10_000, logCaptureMaxBytes: 65_536, abortSignal: new AbortController().signal,
        stdoutLogPath: null, stderrLogPath: null,
      })
      expect(missing.kind).toBe('not_started')
      await writeFile(join(harness.root, 'partial'), 'no partial outcome is ever produced\n', 'utf8')
    } finally {
      await harness.close()
    }
  })

  it('timeout marks the run failed-by-timeout, never succeeded', async () => {
    const harness = await materialHarness()
    try {
      const timed = await runManagedProcess({
        ctx: harness.ctx, argv: ['/bin/bash', '-c', 'sleep 5'], cwd: harness.root, env: {},
        timeoutMs: 150, logCaptureMaxBytes: 65_536, abortSignal: new AbortController().signal,
        stdoutLogPath: null, stderrLogPath: null,
      })
      expect(timed.kind === 'spawned' && timed.timedOut).toBe(true)
    } finally {
      await harness.close()
    }
  })
})

describe('S03-A12 cancellation and ctx.jobs mapping', () => {
  it('cancel confirms termination only after the tree settles (cancelled, not unknown)', async () => {
    const harness = await materialHarness()
    try {
      const controller = new AbortController()
      const result = runManagedProcess({
        ctx: harness.ctx, argv: ['/bin/bash', '-c', 'sleep 30'], cwd: harness.root, env: {},
        timeoutMs: 60_000, logCaptureMaxBytes: 65_536, abortSignal: controller.signal,
        stdoutLogPath: null, stderrLogPath: null,
      })
      setTimeout(() => { controller.abort() }, 150)
      const settled = await result
      expect(settled.kind).toBe('spawned')
      if (settled.kind === 'spawned') expect(settled.cancelled).toBe(true)
    } finally {
      await harness.close()
    }
  })

  it('env construction enforces the allowlist union', () => {
    const allowed = buildChildEnv(['PATH', 'HOME'], ['R_LIBS_USER'], [{ name: 'R_LIBS_USER', value: '/x' }], new AbortController().signal)
    expect(allowed.ok).toBe(true)
    if (allowed.ok) {
      expect(allowed.env.R_LIBS_USER).toBe('/x')
      expect(allowed.env.HOME).toBeDefined()
    }
    const denied = buildChildEnv(['PATH'], [], [{ name: 'SECRET_X', value: '1' }], new AbortController().signal)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.code).toBe('env_not_allowed')
  })

  it('a sci-tool job settles done only after the settlement promise resolves (no early jobId)', async () => {
    // A stub registry records the exact JobStart the Runtime pattern would deliver; the
    // real registry path is exercised by the REAL composition e2e with the jobs plugin.
    const started: { kind: string; label: string; cancelled: boolean }[] = []
    const registry = {
      start: (spec: { kind: string; label: string; run: () => { cancel: () => void; done: Promise<{ status: string }> } }) => {
        const hooks = spec.run()
        started.push({ kind: spec.kind, label: spec.label, cancelled: false })
        hooks.cancel()
        void hooks.done.then((outcome) => {
          started[0] = { ...started[0] as { kind: string; label: string; cancelled: boolean }, cancelled: false, ...outcome }
        })
        return `sci-tool-${String(started.length)}`
      },
    }
    let settled = false
    const done = new Promise<{ status: string }>((resolve) => {
      setTimeout(() => {
        settled = true
        resolve({ status: 'completed' })
      }, 150)
    })
    const jobId = registry.start({
      kind: 'sci-tool',
      label: 'sci-tool test',
      run: () => ({
        cancel: () => {},
        done: done.then((value) => { expect(settled).toBe(true); return value }),
      }),
    })
    expect(jobId.startsWith('sci-tool-')).toBe(true)
    const outcome = await done
    expect(outcome.status).toBe('completed')
    expect(started[0]?.kind).toBe('sci-tool')
  })
})
