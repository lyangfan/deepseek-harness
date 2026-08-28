/** Shared professional-layer test harness: exec stubs, persisted tool calls, fake env. */

import { join } from 'node:path'
import type { Session } from '@deepseek-ai/dsh-session'
import { CallId } from '@deepseek-ai/dsh-llm'
import { freezeFakeEnvironment, materialHarness, writeFakePlinkTrio } from './helpers.ts'
import { runProfessionalTool } from '../src/professional/factory.ts'
import type { ProfessionalRuntimeOptions } from '../src/professional/factory.ts'
import type { ProfessionalToolSpecV1 } from '../src/professional/spec.ts'
import type { ProfessionalToolResultV1 } from '../src/types.ts'

export interface ProHarness {
  readonly ctx: Awaited<ReturnType<typeof materialHarness>>['ctx']
  readonly store: Awaited<ReturnType<typeof materialHarness>>['store']
  readonly artifacts: Awaited<ReturnType<typeof materialHarness>>['artifacts']
  readonly lane: Awaited<ReturnType<typeof materialHarness>>['lane']
  readonly root: string
  readonly session: Session
  readonly trio: { readonly bed: string; readonly bim: string; readonly fam: string }
  close: () => Promise<void>
}

export async function proHarness(bimRows = 4, famRows = 6): Promise<ProHarness> {
  const harness = await materialHarness()
  const session = await harness.createSession('spec-03-pro')
  await freezeFakeEnvironment(harness)
  const trio = await writeFakePlinkTrio(harness.root, 'input', bimRows, famRows)
  return {
    ctx: harness.ctx, store: harness.store, artifacts: harness.artifacts, lane: harness.lane,
    root: harness.root, session, trio,
    close: harness.close,
  }
}

export function proExec(harness: ProHarness, callId: string, signal = new AbortController().signal) {
  return {
    callId,
    rootCallId: callId,
    signal,
    agent: { session: { header: { id: 'spec-03-pro', createdAt: harness.session.header.createdAt, cwd: harness.root } } },
  }
}

export async function ownCallFlushed(harness: ProHarness, callId: string, toolName: string): Promise<void> {
  harness.session.append('turn/start', { turn: 1 })
  harness.session.append('step/start', { turn: 1, step: 1 })
  harness.session.append('tool/call', { turn: 1, step: 1, callId: CallId(callId), name: toolName, arguments: '{}' })
  await harness.ctx.sessions.flush(harness.session)
}

export function runtimeOptions(harness: ProHarness): ProfessionalRuntimeOptions {
  return {
    store: harness.store,
    artifacts: harness.artifacts,
    lane: harness.lane,
    config: {
      professionalOutputRoot: join(harness.root, 'pro-outputs'),
      professionalDefaultTimeoutMs: 30_000,
      professionalLogCaptureMaxBytes: 1_048_576,
      professionalMaxPlanOutputs: 32,
    },
  }
}

export async function runTool<P>(
  harness: ProHarness,
  spec: ProfessionalToolSpecV1<P>,
  raw: Record<string, unknown>,
  callId: string,
  signal?: AbortSignal,
): Promise<ProfessionalToolResultV1> {
  await ownCallFlushed(harness, callId, spec.toolName)
  return runProfessionalTool(harness.ctx, runtimeOptions(harness), spec, raw, proExec(harness, callId, signal) as never)
}
