/** Declarative scientific-code Runner execution contract (SPEC-02 §9): exclusive dir, declared outputs, Submission-before-return. */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { JsonValue, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types'
import { canonicalDigest } from '../canonical-json.ts'
import { eventRef } from '../capture.ts'
import { deriveRunId } from '../identity.ts'
import { ArtifactConflictError, type ArtifactProvider, type UnifiedFileHandle } from '../artifact.ts'
import { capturedComponent, missingComponent, persistReceiptSubmission } from '../receipt.ts'
import type { ReceiptComponentsV1, ReceiptSubmissionId, RunnerInvocationBasisV1, RunnerOutcome } from '../types.ts'
import type { EvidenceStore } from '../store.ts'
import type { AcceptanceLane } from '../acceptance.ts'
import { ContextEntityOwner } from '../context-entity.ts'
import { registeredProfile } from './profiles.ts'

/** Bounded model-visible result (SPEC-02 §9.5): no manifest ref, no fabricated acceptance. */
export interface SciRunCodeResult {
  readonly runId: string
  readonly outcome: RunnerOutcome
  readonly outputCompleteness: 'complete' | 'incomplete'
  readonly outputs: readonly { readonly role: string; readonly artifactVersionRef: string }[]
  readonly receiptSubmissionRef: string | null
  readonly error?: string
}

/** Typed input/execution failure surfaced by the Runner Tool boundary. */
export class RunnerInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RunnerInputError'
  }
}

export interface RunnerExecutionOptions {
  readonly languageProfile: string
  readonly code: { readonly locator: string; readonly expectedArtifactVersionRef?: string }
  readonly inputs: readonly { readonly role: string; readonly locator: string; readonly expectedArtifactVersionRef?: string }[]
  readonly declaredOutputs: readonly { readonly role: string; readonly relativePath: string; readonly required: boolean }[]
  readonly env: readonly { readonly name: string; readonly value: string; readonly secret?: boolean }[]
  readonly args: readonly string[]
  readonly timeoutMs: number
}

interface SettledOutput {
  readonly role: string
  readonly required: boolean
  readonly artifactVersionId: string | null
  readonly reason: string | null
}

function secretPlaceholder(value: string): string {
  return `secret:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

/** Resolve the producer-claimed invocation basis from the persisted Session prefix (§6.2). */
function findOwnBasis(
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

/**
 * Execute one declarative scientific-code run under the frozen §9.3 order. Every step before
 * `spawn` failing yields `not_started`; the Submission persists durably before this function
 * returns. When the producer cannot resolve its own start event, the run settles WITHOUT a
 * receipt (receiptSubmissionRef null) and the SPEC-01 event path owns the facts.
 */
/**
 * Execute one declarative scientific-code run under the frozen §9.3 order.
 * @param options Context, store, providers, exec context, input, and runner config.
 * @returns The bounded model-visible result (Submission already durable).
 */
export async function executeSciRunCode(options: {
  readonly ctx: Context
  readonly store: EvidenceStore
  readonly artifacts: ArtifactProvider
  readonly lane: AcceptanceLane
  readonly exec: ToolExecution
  readonly input: RunnerExecutionOptions
  readonly config: {
    readonly runnerOutputRoot: string
    readonly runnerDefaultTimeoutMs: number
    readonly runnerMaxDeclaredOutputs: number
    readonly runnerLogCaptureMaxBytes: number
  }
}): Promise<SciRunCodeResult> {
  const { ctx, store, artifacts, lane, exec, input, config } = options
  const profile = registeredProfile(input.languageProfile)
  if (profile === undefined) throw new RunnerInputError('profile_not_registered', `language profile '${input.languageProfile}' is not registered`)
  // B1-02 packet decision: the runner always has declarations; an empty list is an input failure.
  if (input.declaredOutputs.length === 0) throw new RunnerInputError('declared_outputs_empty', 'the runner requires at least one declared output')
  if (input.declaredOutputs.length > config.runnerMaxDeclaredOutputs) throw new RunnerInputError('too_many_declared_outputs', `at most ${String(config.runnerMaxDeclaredOutputs)} declared outputs`)
  const header = exec.agent?.session.header
  if (header === undefined) throw new RunnerInputError('no_session', 'the runner requires an agent Session context')
  const bootstrap = store.sessionGraphs.get(header.id)
  if (bootstrap === undefined || bootstrap.state !== 'ready') throw new RunnerInputError('scope_not_ready', `Session '${header.id}' has no ready Evidence Graph`)
  // Capture the narrowed values for the closures below (TS does not carry early-throw
  // narrowing of captured bindings into nested function declarations).
  const sessionHeader = header
  const graphBootstrap = bootstrap
  const activeProfile = profile

  const cwd = sessionHeader.cwd
  const resolveOpts = cwd === undefined ? {} : { cwd }
  const toolName = 'sci_run_code'

  // Producer basis: read the persisted prefix once to resolve the exact start event (§6.2).
  const persisted = await ctx.sessionPersistence.readFrom(sessionHeader.id, 0)
  const own = findOwnBasis(persisted.events, persisted.meta, exec)
  const invocationBasis: RunnerInvocationBasisV1 | null = own?.basis ?? null
  const startSeq = own?.startSeq ?? -1
  const runIdMaterial = (): JsonValue | null => {
    if (invocationBasis === null) return null
    if (invocationBasis.kind === 'direct') {
      return {
        graphId: graphBootstrap.graphId,
        basisKind: 'top_level_tool',
        sessionId: sessionHeader.id,
        callEventSeq: startSeq,
        callId: invocationBasis.callId,
      }
    }
    return {
      graphId: graphBootstrap.graphId,
      basisKind: 'code_mode_dispatch',
      sessionId: sessionHeader.id,
      startEventSeq: startSeq,
      rootCallId: invocationBasis.rootCallId,
      parentCallId: invocationBasis.parentCallId,
      subCallId: invocationBasis.subCallId,
    }
  }
  const material = runIdMaterial()
  const runId = material === null ? null : deriveRunId(material)

  const stdoutLogTarget = { path: '' }
  const stderrLogTarget = { path: '' }
  let codeCapture: Awaited<ReturnType<ArtifactProvider['captureFile']>> | undefined
  const timeoutMs = input.timeoutMs > 0 ? input.timeoutMs : config.runnerDefaultTimeoutMs
  const signalRef: { aborted: boolean } = exec.signal
  const settleCancelled = async (): Promise<SciRunCodeResult> => {
    const receiptId = runId === null || invocationBasis === null ? null : await persist({
      outcome: 'cancelled' as const, startedAt: null, settledOutputs: [] as SettledOutput[],
      completeness: 'incomplete' as const, logsCaptured: false, inputContinuityBroken: [] as string[],
    })
    return { runId: runId ?? 'unresolved', outcome: 'cancelled', outputCompleteness: 'incomplete', outputs: [], receiptSubmissionRef: receiptId }
  }
  if (exec.signal.aborted) return settleCancelled()

  const notStarted = async (_code: string, message: string): Promise<SciRunCodeResult> => {
    const receiptId = runId === null || invocationBasis === null ? null : await persist({
      outcome: 'not_started' as const, startedAt: null, settledOutputs: [] as SettledOutput[],
      completeness: 'incomplete' as const, logsCaptured: false, inputContinuityBroken: [] as string[],
    })
    return { runId: runId ?? 'unresolved', outcome: 'not_started', outputCompleteness: 'incomplete', outputs: [], receiptSubmissionRef: receiptId, error: message }
  }

  // §9.3 step 1: resolve + hash inputs and code before anything spawns.
  const inputCaptures: Array<{ readonly role: string; readonly versionId: string; readonly observationBasis: 'full_sha256' | 'freshness_reuse'; readonly locator: string }> = []
  try {
    const codeHandle: UnifiedFileHandle = { role: 'code', locator: input.code.locator, ...(input.code.expectedArtifactVersionRef === undefined ? {} : { expectedArtifactVersionRef: input.code.expectedArtifactVersionRef as never }) }
    codeCapture = await artifacts.captureFile(codeHandle, { createdBy: 'runner_code', ...resolveOpts, signal: exec.signal })
    for (const handle of input.inputs) {
      const expected = handle.expectedArtifactVersionRef
      const capturedHandle = {
        role: handle.role,
        locator: handle.locator,
        ...(expected === undefined ? {} : { expectedArtifactVersionRef: expected as never }),
      }
      const captured = await artifacts.captureFile(capturedHandle, { createdBy: 'runner_input', ...resolveOpts, signal: exec.signal })
      inputCaptures.push({
        role: handle.role,
        versionId: captured.artifactVersionId,
        observationBasis: captured.observationBasis,
        locator: handle.locator,
      })
    }
  } catch (error) {
    if (signalRef.aborted) return settleCancelled()
    if (error instanceof ArtifactConflictError) return await notStarted(error.code, error.message)
    throw error
  }

  // §9.3 step 2: run-exclusive output directory derived from runId, never reused.
  if (runId === null) return notStarted('start_event_unresolved', 'the runner could not resolve its own persisted start event')
  const rootTarget = await ctx.fs.resolve(config.runnerOutputRoot)
  const runsParent = `${ctx.fs.processPath(rootTarget)}/runs`
  const runDirPath = `${runsParent}/${runId}`
  try {
    await mkdir(runsParent, { recursive: true })
    await mkdir(runDirPath, { recursive: false, mode: 0o700 })
    const runDirTarget = await ctx.fs.resolve(runDirPath)
    if (!ctx.fs.contains(rootTarget, runDirTarget)) throw new RunnerInputError('output_boundary_violation', `run directory '${runDirPath}' escapes the configured output root`)
  } catch (error) {
    if (error instanceof RunnerInputError) return notStarted(error.code, error.message)
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return notStarted('output_boundary_violation', `run directory '${runDirPath}' already exists`)
    throw error
  }
  stdoutLogTarget.path = `${runDirPath}/stdout.log`
  stderrLogTarget.path = `${runDirPath}/stderr.log`

  // Environment allowlist (§9.3): scrubbed parent base ∩ allowlist, plus declared entries.
  const allow = new Set([...activeProfile.defaultEnvAllowlist, ...activeProfile.extraEnvAllowlist])
  for (const entry of input.env) {
    if (!allow.has(entry.name)) return notStarted('env_not_allowed', `environment variable '${entry.name}' is not allowlisted`)
  }
  const scrubbed: Record<string, string> = scrubbedParentEnv()
  const childEnv: Record<string, string> = {}
  for (const name of activeProfile.defaultEnvAllowlist) {
    const value = scrubbed[name]
    if (value !== undefined) childEnv[name] = value
  }
  for (const entry of input.env) childEnv[entry.name] = entry.value

  // §9.3 steps 3–6: write the exact code bytes, spawn, collect, terminate.
  const codeBytes = await artifacts.readVersionBytes(codeCapture.artifactVersionId, exec.signal)
  const scriptPath = `${runDirPath}/script.sh`
  await ctx.fs.writeText(await ctx.fs.resolve(scriptPath), new TextDecoder().decode(codeBytes), undefined, exec.signal)

  const timeout = new AbortController()
  const timer = setTimeout(() => { timeout.abort(new Error('runner timeout')) }, timeoutMs)
  const signal = AbortSignal.any([exec.signal, timeout.signal])
  let outcome: RunnerOutcome = 'succeeded'
  let logsCaptured = false
  try {
    const handle = ctx.subprocess.spawn({
      argv: [...activeProfile.argvTemplate, scriptPath, ...input.args],
      cwd: runDirPath,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: config.runnerLogCaptureMaxBytes, spill: { maxBytes: 16 * config.runnerLogCaptureMaxBytes } },
        stderr: { maxBytes: config.runnerLogCaptureMaxBytes, spill: { maxBytes: 16 * config.runnerLogCaptureMaxBytes } },
      },
      graceMs: 5_000,
      env: childEnv,
      signal,
    })
    if (handle.pid < 0) {
      outcome = 'not_started'
    } else {
      const settled = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0)
      const stderr = handle.collected.stderr?.readFrom(0)
      await ctx.fs.writeText(await ctx.fs.resolve(stdoutLogTarget.path), stdout?.text ?? '', undefined, exec.signal)
      await ctx.fs.writeText(await ctx.fs.resolve(stderrLogTarget.path), stderr?.text ?? '', undefined, exec.signal)
      logsCaptured = true
      if (signalRef.aborted) outcome = 'cancelled'
      else if (timeout.signal.aborted || settled.exitCode !== 0) outcome = 'failed'
      else outcome = 'succeeded'
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return await notStarted('interpreter_unavailable', `interpreter for profile '${activeProfile.profileId}' could not be resolved`)
    }
    // Termination request failed or the final state cannot be confirmed (§9.3): stay unknown.
    outcome = signalRef.aborted ? 'cancelled' : 'outcome_unknown'
  } finally {
    clearTimeout(timer)
  }

  // §9.4: settle declared outputs — only declared files, only inside the exclusive directory.
  const settledOutputs: SettledOutput[] = []
  const runDirTarget = await ctx.fs.resolve(runDirPath)
  for (const declared of input.declaredOutputs) {
    try {
      const outputTarget = await ctx.fs.resolve(`${runDirPath}/${declared.relativePath}`)
      if (!ctx.fs.contains(runDirTarget, outputTarget)) {
        settledOutputs.push({ role: declared.role, required: declared.required, artifactVersionId: null, reason: 'output_boundary_escape' })
        continue
      }
      const captured = await artifacts.captureFile({ role: declared.role, locator: `${runDirPath}/${declared.relativePath}` }, { createdBy: 'runner_output', signal: exec.signal })
      settledOutputs.push({ role: declared.role, required: declared.required, artifactVersionId: captured.artifactVersionId, reason: null })
    } catch (error) {
      if (error instanceof ArtifactConflictError) {
        settledOutputs.push({ role: declared.role, required: declared.required, artifactVersionId: null, reason: error.code })
        continue
      }
      throw error
    }
  }
  const requiredMissing = settledOutputs.filter(item => item.required && item.artifactVersionId === null)
  const completeness: 'complete' | 'incomplete' = requiredMissing.length === 0 ? 'complete' : 'incomplete'
  if (outcome === 'succeeded' && completeness === 'incomplete') outcome = 'failed'

  // §4.5: post-run freshness re-observation of every declared input; token drift produces
  // the named input_continuity_broken breakpoint on the Submission's inputs component.
  const inputContinuityBroken: string[] = []
  for (const inputCapture of inputCaptures) {
    try {
      const postRun = await artifacts.captureFile(
        { role: inputCapture.role, locator: inputCapture.locator },
        { createdBy: 'runner_input', signal: exec.signal },
      )
      if (postRun.artifactVersionId !== inputCapture.versionId) {
        inputContinuityBroken.push(inputCapture.role)
      }
    } catch {
      inputContinuityBroken.push(inputCapture.role)
    }
  }

  const receiptId = await persist({ outcome, startedAt: Date.now(), settledOutputs, completeness, logsCaptured, inputContinuityBroken })
  return {
    runId,
    outcome,
    outputCompleteness: completeness,
    outputs: settledOutputs
      .filter(item => item.artifactVersionId !== null)
      .map(item => ({ role: item.role, artifactVersionRef: item.artifactVersionId as string })),
    receiptSubmissionRef: receiptId,
  }

  /** Build the seven components and persist the Submission (§6.3, §9.6) — durable before return. */
  async function persist(settle: {
    readonly outcome: RunnerOutcome
    readonly startedAt: number | null
    readonly settledOutputs: readonly SettledOutput[]
    readonly completeness: 'complete' | 'incomplete'
    readonly logsCaptured: boolean
    readonly inputContinuityBroken: readonly string[]
  }): Promise<ReceiptSubmissionId | null> {
    if (runId === null || invocationBasis === null || codeCapture === undefined) return null
    const logRefs: string[] = []
    if (settle.logsCaptured) {
      for (const logPath of [stdoutLogTarget.path, stderrLogTarget.path]) {
        if (logPath === '') continue
        try {
          const captured = await artifacts.captureFile({ role: logPath.endsWith('stdout.log') ? 'runtime_stdout' : 'runtime_stderr', locator: logPath }, { createdBy: 'runner_log', signal: exec.signal })
          logRefs.push(captured.artifactVersionId)
        } catch {
          // A log file that could not be captured stays absent; the component reflects reality.
        }
      }
    }
    const parameterSet: JsonValue = {
      argv: [...input.args],
      declaredEnv: Object.fromEntries(input.env.map(entry =>
        [entry.name, entry.secret === true ? secretPlaceholder(entry.value) : entry.value])),
      timeoutMs,
      languageProfile: activeProfile.profileId,
    }
    const entities = new ContextEntityOwner(store)
    const software = await entities.register({
      contextKind: 'software',
      name: activeProfile.profileId,
      version: null,
      payload: { argvTemplate: [...activeProfile.argvTemplate] },
    })
    const environment = await entities.register({
      contextKind: 'environment',
      name: 'runner-local',
      version: null,
      payload: {
        cwd: runDirPath,
        os: process.platform,
        allowlist: [...activeProfile.defaultEnvAllowlist, ...activeProfile.extraEnvAllowlist],
      },
    })
    const parameters = await entities.register({
      contextKind: 'parameter_set',
      name: 'runner-parameters',
      version: null,
      payload: parameterSet,
    })
    const outputsCaptured = settle.settledOutputs
      .filter(item => item.artifactVersionId !== null)
      .map(item => item.artifactVersionId as string)
    const firstMissingReason = settle.settledOutputs.find(item => item.artifactVersionId === null)?.reason ?? 'output_absent'
    const components: ReceiptComponentsV1 = {
      inputs: settle.inputContinuityBroken.length > 0
        ? { state: 'missing' as const, reason: 'input_continuity_broken' as const, ownerRefs: [] as string[], captureBasis: null }
        : capturedComponent([codeCapture.artifactVersionId, ...inputCaptures.map(item => item.versionId)]),
      outputs: settle.settledOutputs.length === 0 || outputsCaptured.length === 0
        ? missingComponent(firstMissingReason)
        : capturedComponent(outputsCaptured),
      softwareAndCode: capturedComponent([software.contextEntityId, codeCapture.artifactVersionId]),
      environment: capturedComponent([environment.contextEntityId]),
      parameters: capturedComponent([parameters.contextEntityId]),
      randomness: missingComponent('randomness_not_assessed_v0.1'),
      logs: logRefs.length === 0 ? missingComponent('logs_not_captured') : capturedComponent(logRefs),
    }
    const invocationDigest = canonicalDigest({
      toolName,
      arguments: {
        languageProfile: input.languageProfile,
        code: input.code.locator,
        inputs: input.inputs,
        declaredOutputs: input.declaredOutputs,
        env: parameterSet.declaredEnv,
        args: input.args,
        timeoutMs,
      },
    } as unknown as JsonValue)
    const submission = await persistReceiptSubmission(store, {
      evidenceGraphId: graphBootstrap.graphId,
      sessionId: sessionHeader.id,
      runId,
      invocationBasis,
      expectedResultCallId: exec.callId,
      toolName,
      languageProfile: activeProfile.profileId,
      invocationDigest,
      lifecycle: { startedAt: settle.startedAt, endedAt: Date.now() },
      outcome: settle.outcome,
      components,
    })
    await lane.registerPending(sessionHeader.id, submission.receiptId)
    return submission.receiptId
  }
}
