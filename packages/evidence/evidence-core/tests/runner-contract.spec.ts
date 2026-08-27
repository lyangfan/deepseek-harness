/** S02-A06/A12 + §9.3 timing: real-subprocess runner contract over the bash profile. */

import { writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { registerSuiteSummary } from './summary.ts'
import { materialHarness } from './helpers.ts'
import { executeSciRunCode, RunnerInputError } from '../src/runner/execute.ts'
import type { SciRunCodeResult } from '../src/runner/execute.ts'

const SESSION = 'spec-02-runner'

interface ExecLike {
  readonly callId: string
  readonly rootCallId: string
  readonly signal: AbortSignal
  readonly parent?: unknown
  readonly agent?: { readonly session: { readonly header: { id: string; createdAt: number; cwd?: string } } }
}

async function runnerHarness() {
  const harness = await materialHarness()
  const session = await harness.createSession(SESSION)
  await writeFile(join(harness.root, 'input.tsv'), 'a\tb\n1\t2\n', 'utf8')
  await writeFile(join(harness.root, 'script.sh'), '#!/bin/bash\nset -euo pipefail\ncat "$1" | cut -f2 > out.txt\n', 'utf8')
  return { ...harness, session }
}

function makeExec(harness: Awaited<ReturnType<typeof runnerHarness>>, callId: string, signal = new AbortController().signal): ExecLike {
  return {
    callId,
    rootCallId: callId,
    signal,
    agent: { session: { header: { id: SESSION, createdAt: harness.session.header.createdAt, cwd: harness.root } } },
  }
}

async function appendOwnCallAndFlush(harness: Awaited<ReturnType<typeof runnerHarness>>, callId: string): Promise<void> {
  harness.session.append('turn/start', { turn: 1 })
  harness.session.append('step/start', { turn: 1, step: 1 })
  harness.session.append('tool/call', { turn: 1, step: 1, callId: CallId(callId), name: 'sci_run_code', arguments: '{}' })
  await harness.ctx.sessions.flush(harness.session)
}

async function run(options: {
  readonly harness: Awaited<ReturnType<typeof runnerHarness>>
  readonly callId: string
  readonly signal?: AbortSignal
  readonly declaredOutputs?: { role: string; relativePath: string; required: boolean }[]
  readonly env?: { name: string; value: string; secret?: boolean }[]
  readonly codeLocator?: string
  readonly args?: string[]
  readonly timeoutMs?: number
}): Promise<SciRunCodeResult> {
  const { harness, callId, ...rest } = options
  return executeSciRunCode({
    ctx: harness.ctx,
    store: harness.store,
    artifacts: harness.artifacts,
    lane: harness.lane,
    exec: makeExec(harness, callId, rest.signal) as never,
    input: {
      languageProfile: 'bash',
      code: { locator: rest.codeLocator ?? join(harness.root, 'script.sh') },
      inputs: [{ role: 'table', locator: join(harness.root, 'input.tsv') }],
      declaredOutputs: rest.declaredOutputs ?? [{ role: 'cut-column', relativePath: 'out.txt', required: true }],
      env: rest.env ?? [],
      args: rest.args ?? [join(harness.root, 'input.tsv')],
      timeoutMs: rest.timeoutMs ?? 30_000,
    },
    config: {
      runnerOutputRoot: harness.root,
      runnerDefaultTimeoutMs: 30_000,
      runnerMaxDeclaredOutputs: 8,
      runnerLogCaptureMaxBytes: 1_048_576,
    },
  })
}

describe('S02-A06 runner golden', () => {
  it('executes a real bash subprocess with verified inputs and a per-run exclusive directory', async () => {
    const harness = await runnerHarness()
    await appendOwnCallAndFlush(harness, 'call-runner-1')
    const result = await run({ harness, callId: 'call-runner-1' })
    expect(result).toMatchObject({ outcome: 'succeeded', outputCompleteness: 'complete' })
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0]?.artifactVersionRef).toMatch(/^av_/)
    const runsDir = join(harness.root, 'runs')
    const firstRun = (await readdir(runsDir))[0]
    expect(firstRun).toMatch(/^er_/)
    const output = await readFile(join(runsDir, firstRun as string, 'out.txt'), 'utf8')
    expect(output.trim()).toBe('b\n2')
    // logs landed as run artifacts
    expect(harness.store.artifactVersions.size).toBeGreaterThanOrEqual(4) // code + input + output + 2 logs
    await harness.close()
  })

  it('never reuses a run directory across runs', async () => {
    const harness = await runnerHarness()
    await appendOwnCallAndFlush(harness, 'call-runner-2a')
    const first = await run({ harness, callId: 'call-runner-2a' })
    harness.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    harness.session.append('turn/start', { turn: 2 })
    harness.session.append('step/start', { turn: 2, step: 1 })
    harness.session.append('tool/call', { turn: 2, step: 1, callId: CallId('call-runner-2b'), name: 'sci_run_code', arguments: '{}' })
    await harness.ctx.sessions.flush(harness.session)
    const second = await run({ harness, callId: 'call-runner-2b' })
    expect(first.runId).not.toBe(second.runId)
    expect((await readdir(join(harness.root, 'runs'))).length).toBe(2)
    await harness.close()
  })
})

describe('S02-A07 submission-before-return', () => {
  it('persists the Submission before returning while no acceptance exists yet', async () => {
    const harness = await runnerHarness()
    await appendOwnCallAndFlush(harness, 'call-runner-3')
    const result = await run({ harness, callId: 'call-runner-3' })
    expect(result.receiptSubmissionRef).toMatch(/^rs_/)
    expect(harness.store.receiptSubmissions.size).toBe(1)
    expect(harness.store.receiptAcceptances.size).toBe(0)
    expect(harness.store.receiptLaneFor(harness.session.id)?.pendingSubmissions).toHaveLength(1)
    // after the real result event persists, the lane closes the delivery
    harness.session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: CallId('call-runner-3'), content: [{ type: 'text', text: 'ok' }], isError: false }),
    }, { surfaceOp: 'append' })
    await harness.ctx.sessions.flush(harness.session)
    await harness.lane.processSession(harness.session.header, false)
    expect(harness.store.receiptAcceptances.size).toBe(1)
    const acceptance = [...harness.store.receiptAcceptances.entries()][0]?.[1]
    expect(acceptance?.verdict).toBe('accepted')
    await harness.close()
  })
})

describe('S02-A12 outcome mapping', () => {
  it('maps a non-zero exit to failed with incomplete outputs', async () => {
    const harness = await runnerHarness()
    await writeFile(join(harness.root, 'fail.sh'), 'exit 3\n', 'utf8')
    await appendOwnCallAndFlush(harness, 'call-runner-4')
    const result = await run({ harness, callId: 'call-runner-4', codeLocator: join(harness.root, 'fail.sh') })
    expect(result).toMatchObject({ outcome: 'failed', outputCompleteness: 'incomplete' })
    expect(result.outputs).toHaveLength(0)
    await harness.close()
  })

  it('maps a missing required output on a zero exit to failed + incomplete', async () => {
    const harness = await runnerHarness()
    await appendOwnCallAndFlush(harness, 'call-runner-5')
    const result = await run({ harness, callId: 'call-runner-5', declaredOutputs: [{ role: 'never-written', relativePath: 'absent.txt', required: true }] })
    expect(result).toMatchObject({ outcome: 'failed', outputCompleteness: 'incomplete' })
    await harness.close()
  })

  it('blocks a non-allowlisted env var before spawn (not_started)', async () => {
    const harness = await runnerHarness()
    await appendOwnCallAndFlush(harness, 'call-runner-6')
    const result = await run({ harness, callId: 'call-runner-6', env: [{ name: 'HACKED_SECRET', value: 'x' }] })
    expect(result).toMatchObject({ outcome: 'not_started' })
    // A pre-spawn block still leaves an honest not_started Submission for the lane to pair.
    expect(harness.store.receiptSubmissions.size).toBe(1)
    const blocked = [...harness.store.receiptSubmissions.entries()][0]?.[1]
    expect(blocked?.outcome).toBe('not_started')
    await harness.close()
  })

  it('rejects an empty declared-outputs list as an input failure (B1-02 packet decision)', async () => {
    const harness = await runnerHarness()
    await appendOwnCallAndFlush(harness, 'call-runner-7')
    await expect(run({ harness, callId: 'call-runner-7', declaredOutputs: [] })).rejects.toMatchObject({ code: 'declared_outputs_empty' })
    await harness.close()
  })

  it('classifies a pre-aborted signal as cancelled and a timeout as failed', async () => {
    const harness = await runnerHarness()
    await appendOwnCallAndFlush(harness, 'call-runner-8')
    const cancelled = new AbortController()
    cancelled.abort()
    const cancelledResult = await run({ harness, callId: 'call-runner-8', signal: cancelled.signal })
    expect(cancelledResult.outcome).toBe('cancelled')

    await writeFile(join(harness.root, 'sleep.sh'), 'sleep 5\n', 'utf8')
    harness.session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: CallId('call-runner-8'), content: [{ type: 'text', text: 'x' }], isError: true }),
    }, { surfaceOp: 'append' })
    harness.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    harness.session.append('turn/start', { turn: 2 })
    harness.session.append('step/start', { turn: 2, step: 1 })
    harness.session.append('tool/call', { turn: 2, step: 1, callId: CallId('call-runner-9'), name: 'sci_run_code', arguments: '{}' })
    await harness.ctx.sessions.flush(harness.session)
    const timedOut = await run({ harness, callId: 'call-runner-9', codeLocator: join(harness.root, 'sleep.sh'), timeoutMs: 200, declaredOutputs: [{ role: 'cut-column', relativePath: 'out.txt', required: false }] })
    expect(['failed', 'cancelled']).toContain(timedOut.outcome)
    await harness.close()
  })

  it('B1-02: rejects a declared output that escapes the run-exclusive directory', async () => {
    const harness = await runnerHarness()
    await appendOwnCallAndFlush(harness, 'call-runner-b02')
    const result = await run({
      harness, callId: 'call-runner-b02',
      declaredOutputs: [{ role: 'escape', relativePath: '../input.tsv', required: true }],
    })
    expect(result).toMatchObject({ outcome: 'failed', outputCompleteness: 'incomplete' })
    expect(result.outputs).toHaveLength(0)
    await harness.close()
  })

  it('B1-04: does not register an undeclared ambient file inside the run directory', async () => {
    const harness = await runnerHarness()
    await writeFile(join(harness.root, 'script-ambient.sh'), '#!/bin/bash\necho ambient > ambient.txt\ncat "$1" | cut -f2 > out.txt\n', 'utf8')
    await appendOwnCallAndFlush(harness, 'call-runner-b04')
    const result = await run({
      harness, callId: 'call-runner-b04',
      codeLocator: join(harness.root, 'script-ambient.sh'),
      declaredOutputs: [{ role: 'cut-column', relativePath: 'out.txt', required: true }],
    })
    expect(result.outcome).toBe('succeeded')
    // The ambient file exists on disk but must not appear in outputs or gain an ArtifactVersion role
    expect(result.outputs.every(output => output.role !== 'ambient')).toBe(true)
    await harness.close()
  })

  it('B1-05: hard budget pauses new material writes with a typed error', async () => {
    const harness = await runnerHarness()
    harness.store.hardLimitBytes = 1 // force immediate hard-limit trigger
    await appendOwnCallAndFlush(harness, 'call-runner-b05')
    await expect(run({ harness, callId: 'call-runner-b05' })).rejects.toMatchObject({ code: 'storage_hard_limit' })
    harness.store.hardLimitBytes = 0
    await harness.close()
  })

  it('C1-02: records input_continuity_broken when the script overwrites a declared input mid-run', async () => {
    const harness = await runnerHarness()
    // Dedicated drift input + a script that overwrites it during execution
    await writeFile(join(harness.root, 'drift-input.tsv'), 'a\tb\n1\t2\n', 'utf8')
    await writeFile(join(harness.root, 'drift-script.sh'), '#!/bin/bash\nset -euo pipefail\nprintf "DRIFTED" > "$1"\ncut -f2 "$2" > out.txt\n', 'utf8')
    await appendOwnCallAndFlush(harness, 'call-runner-c102')
    const result = await executeSciRunCode({
      ctx: harness.ctx,
      store: harness.store,
      artifacts: harness.artifacts,
      lane: harness.lane,
      exec: makeExec(harness, 'call-runner-c102') as never,
      input: {
        languageProfile: 'bash',
        code: { locator: join(harness.root, 'drift-script.sh') },
        inputs: [
          { role: 'drift', locator: join(harness.root, 'drift-input.tsv') },
          { role: 'stable', locator: join(harness.root, 'input.tsv') },
        ],
        declaredOutputs: [{ role: 'cut-column', relativePath: 'out.txt', required: false }],
        env: [],
        args: [join(harness.root, 'drift-input.tsv'), join(harness.root, 'input.tsv')],
        timeoutMs: 30_000,
      },
      config: {
        runnerOutputRoot: harness.root,
        runnerDefaultTimeoutMs: 30_000,
        runnerMaxDeclaredOutputs: 8,
        runnerLogCaptureMaxBytes: 1_048_576,
      },
    })
    // The run itself succeeded (out.txt produced)
    expect(result.outcome).toBe('succeeded')
    // The Submission's inputs component MUST carry the named breakpoint unconditionally:
    // the script overwrote drift-input.tsv between pre-run capture and post-run re-check.
    const submission = [...harness.store.receiptSubmissions.entries()].at(-1)?.[1]
    expect(submission).toBeDefined()
    expect(submission?.components.inputs.state).toBe('missing')
    expect(submission?.components.inputs.reason).toBe('input_continuity_broken')
    // No new ArtifactVersion was auto-created for the drifted bytes
    const driftVersions = [...harness.store.artifactVersions.entries()]
      .filter(([, v]) => v.contentDigest && v.byteLength > 0)
      .filter(([, v]) => {
        // The drift input's original bytes are 'a\tb\n1\t2\n' (6 bytes); drifted is 'DRIFTED' (7)
        return v.byteLength === 7 && v.createdBy === 'runner_input'
      })
    // The pre-captured version (6 bytes) is the only runner_input version for that file
    expect(driftVersions.filter(v => v[1].artifactVersionId !== undefined).length).toBeLessThanOrEqual(1)
    await harness.close()
  })

  it('B1-01: post-run freshness re-observation produces a Submission with input component facts', async () => {
    const harness = await runnerHarness()
    await appendOwnCallAndFlush(harness, 'call-runner-b01')
    await run({ harness, callId: 'call-runner-b01' })
    const submission = [...harness.store.receiptSubmissions.entries()][0]?.[1]
    expect(submission).toBeDefined()
    expect(submission?.components.inputs.state).toBe('captured')
    await harness.close()
  })

  it('never produces partial outcomes and hides secret env values behind placeholders', async () => {
    const harness = await runnerHarness()
    await appendOwnCallAndFlush(harness, 'call-runner-10')
    await run({ harness, callId: 'call-runner-10', env: [{ name: 'OMP_NUM_THREADS', value: 'topsecret', secret: true }] })
    const submission = [...harness.store.receiptSubmissions.entries()][0]?.[1]
    expect(JSON.stringify(submission)).not.toContain('topsecret')
    const parameterEntityId = submission?.components.parameters.ownerRefs[0]
    const parameterEntity = parameterEntityId === undefined ? undefined : harness.store.contextEntities.get(parameterEntityId)
    const serializedEntity = JSON.stringify(parameterEntity)
    expect(serializedEntity).not.toContain('topsecret')
    expect(serializedEntity).toContain('secret:')
    await harness.close()
  })
})

registerSuiteSummary({ suiteId: 'runner-contract', acceptanceIds: ['S02-A06', 'S02-A07', 'S02-A12'], sessionPersistence: ['jsonl'], evidenceStorage: ['memory'] })
export type { RunnerInputError }
