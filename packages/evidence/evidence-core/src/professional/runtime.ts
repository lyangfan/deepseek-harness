/** Shared Scientific Tool Runtime execution core (SPEC-03 §4): the single spawn site. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-jobs'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { eventRef } from '../capture.ts'
import type { RunnerInvocationBasisV1 } from '../types.ts'

/** Register the professional execution job kind (D-185; tool-pwsh declaration-merge precedent). */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'sci-tool': 'sci-tool'
  }
}

/** Provider identity of the Scientific Tool Runtime Local Execution Producer (SPEC-03 §9.1). */
export const SCIENTIFIC_TOOL_PROVIDER_ID = 'animalge-scientific-tool-runtime'
export const SCIENTIFIC_TOOL_PROVIDER_VERSION = 'spec03-runtime/v1'

/** Environment construction shared by the runner and every professional adapter (§4.1). */
export function buildChildEnv(
  defaultAllowlist: readonly string[],
  extraAllowlist: readonly string[],
  declaredEnv: readonly { readonly name: string; readonly value: string }[],
  signal: AbortSignal,
): { ok: true; env: Record<string, string> } | { ok: false; code: 'env_not_allowed'; name: string } {
  const allow = new Set([...defaultAllowlist, ...extraAllowlist])
  for (const entry of declaredEnv) {
    if (!allow.has(entry.name)) {
      void signal
      return { ok: false, code: 'env_not_allowed', name: entry.name }
    }
  }
  const scrubbed: Record<string, string> = scrubbedParentEnv()
  const childEnv: Record<string, string> = {}
  for (const name of defaultAllowlist) {
    const value = scrubbed[name]
    if (value !== undefined) childEnv[name] = value
  }
  for (const entry of declaredEnv) childEnv[entry.name] = entry.value
  return { ok: true, env: childEnv }
}

/** Terminal process facts for one managed spawn (§4.4): how the process ended, nothing more. */
export type ManagedProcessResult =
  | {
    readonly kind: 'spawned'
    readonly exitCode: number | null
    readonly timedOut: boolean
    readonly cancelled: boolean
    readonly logsCaptured: boolean
    readonly stdoutText: string | null
    readonly startedAt: number
    readonly endedAt: number
  }
  | { readonly kind: 'not_started'; readonly reason: 'spawn_pid_invalid' | 'spawn_failed' }
  | { readonly kind: 'unknown'; readonly cancelled: boolean }

export interface ManagedProcessOptions {
  readonly ctx: Context
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string>
  readonly timeoutMs: number
  readonly logCaptureMaxBytes: number
  readonly abortSignal: AbortSignal
  readonly stdoutLogPath: string | null
  readonly stderrLogPath: string | null
  /** Return the bounded stdout in memory instead of (or in addition to) the log file. */
  readonly captureStdoutText?: boolean
}

/**
 * Spawn one managed process tree via `ctx.subprocess` (§4.1: the only spawn site in this
 * package), collect bounded logs into the run-private log files, await termination, and
 * classify the terminal facts. Outcome mapping beyond these facts belongs to callers.
 */
export async function runManagedProcess(options: ManagedProcessOptions): Promise<ManagedProcessResult> {
  const { ctx, argv, cwd, env, timeoutMs, logCaptureMaxBytes, abortSignal, stdoutLogPath, stderrLogPath } = options
  const signalRef: { aborted: boolean } = abortSignal
  const timeout = new AbortController()
  const timer = setTimeout(() => { timeout.abort(new Error('managed process timeout')) }, timeoutMs)
  const signal = AbortSignal.any([abortSignal, timeout.signal])
  const startedAt = Date.now()
  try {
    const handle = ctx.subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: logCaptureMaxBytes, spill: { maxBytes: 16 * logCaptureMaxBytes } },
        stderr: { maxBytes: logCaptureMaxBytes, spill: { maxBytes: 16 * logCaptureMaxBytes } },
      },
      graceMs: 5_000,
      env,
      signal,
    })
    if (handle.pid < 0) return { kind: 'not_started', reason: 'spawn_pid_invalid' }
    const settled = await handle.done
    let logsCaptured = false
    let stdoutText: string | null = null
    if (options.captureStdoutText === true && handle.collected.stdout !== undefined) {
      stdoutText = handle.collected.stdout.readFrom(0).text
    }
    if (stdoutLogPath !== null && stderrLogPath !== null) {
      const stdout = handle.collected.stdout?.readFrom(0)
      const stderr = handle.collected.stderr?.readFrom(0)
      await ctx.fs.writeText(await ctx.fs.resolve(stdoutLogPath), stdout?.text ?? '', undefined, abortSignal)
      await ctx.fs.writeText(await ctx.fs.resolve(stderrLogPath), stderr?.text ?? '', undefined, abortSignal)
      logsCaptured = true
    }
    return {
      kind: 'spawned',
      exitCode: settled.exitCode,
      timedOut: timeout.signal.aborted,
      cancelled: signalRef.aborted,
      logsCaptured,
      stdoutText,
      startedAt,
      endedAt: Date.now(),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'not_started', reason: 'spawn_failed' }
    // Termination request failed or the final state cannot be confirmed (§4.3): stay unknown.
    return { kind: 'unknown', cancelled: signalRef.aborted }
  } finally {
    clearTimeout(timer)
  }
}

/** Resolve the producer-claimed invocation basis from the persisted Session prefix (§6.2). */
export function findOwnBasis(
  events: readonly SessionEvent[],
  header: SessionHeader,
  exec: ToolExecution,
): { readonly basis: RunnerInvocationBasisV1; readonly startSeq: number } | undefined {
  if (exec.parent === undefined) {
    const call = events.find((event): event is SessionEvent<'tool/call'> => event.type === 'tool/call' && event.data.callId === exec.callId)
    if (call === undefined) return undefined
    return { basis: { kind: 'direct', callId: exec.callId, startEventRef: eventRef(header, call) }, startSeq: call.seq }
  }
  const start = events.find((event): event is SessionEvent<'tool/code-dispatch-start'> => event.type === 'tool/code-dispatch-start' && event.data.subCallId === exec.callId)
  if (start === undefined) return undefined
  return {
    basis: { kind: 'code_dispatch', rootCallId: start.data.rootCallId, parentCallId: start.data.parentCallId, subCallId: start.data.subCallId, startEventRef: eventRef(header, start) },
    startSeq: start.seq,
  }
}
