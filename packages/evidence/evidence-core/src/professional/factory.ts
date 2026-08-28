/** defineProfessionalTool(): the shared factory owning the authoritative pipeline (SPEC-03 §5.2). */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolResult } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { canonicalDigest } from '../canonical-json.ts'
import { deriveRunId } from '../identity.ts'
import type { ArtifactProvider } from '../artifact.ts'
import { capturedComponent, classifyReceiptExtension, missingComponent, persistReceiptSubmission, registerReceiptExtensionSchema } from '../receipt.ts'
import { ContextEntityOwner } from '../context-entity.ts'
import type { AcceptanceLane } from '../acceptance.ts'
import type { EvidenceStore } from '../store.ts'
import type { EvidenceRunReceiptSubmissionV1, EvidenceRunId, ProfessionalToolResultV1, ReceiptComponentsV1, RunnerInvocationBasisV1, RunnerOutcome } from '../types.ts'
import { EnvironmentGateError, verifyEnvironmentGate } from './environment.ts'
import { InputBundleError, normalizeInputBundle } from './bundles.ts'
import { PreflightBlockedError, runPreflight } from './preflight.ts'
import { persistResolvedParameterSet } from './parameters.ts'
import { OutputBoundaryError, persistOutputPlan, releaseOutputBoundary, reserveOutputBoundary, settleOutputBoundary, type OutputIntent } from './output-boundary.ts'
import { buildChildEnv, findOwnBasis, runManagedProcess, SCIENTIFIC_TOOL_PROVIDER_ID, SCIENTIFIC_TOOL_PROVIDER_VERSION } from './runtime.ts'
import { presentProfessionalResult, professionalPresentationMeta, renderProfessionalResult } from './result.ts'
import type { CodeOriginFacts, HookServices, ProfessionalToolSpecV1 } from './spec.ts'

/** Typed professional-tool failure surfaced through the DSH Tool error path (§9.4). */
export class ProfessionalToolError extends Error {
  constructor(readonly code: string, message: string, readonly result?: ProfessionalToolResultV1) {
    super(message)
    this.name = 'ProfessionalToolError'
  }
}

export interface ProfessionalRuntimeOptions {
  readonly store: EvidenceStore
  readonly artifacts: ArtifactProvider
  readonly lane: AcceptanceLane
  readonly config: {
    readonly professionalOutputRoot: string
    readonly professionalDefaultTimeoutMs: number
    readonly professionalLogCaptureMaxBytes: number
    readonly professionalMaxPlanOutputs: number
  }
}

/** Location of the shared Runtime's internal log files inside the reserved boundary (§8.3). */
const RUNTIME_LOG_DIR = '.runtime'

function professionalResultSchema(): never {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      runId: { type: 'string', required: true },
      outcome: { type: 'string', required: true, enum: ['succeeded', 'failed', 'cancelled', 'not_started', 'outcome_unknown'] },
      outputCompleteness: { type: 'string', required: true, enum: ['complete', 'incomplete', 'unknown'] },
      outputCompletenessReason: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      outputManifestRef: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      outputs: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            role: { type: 'string', required: true },
            artifactVersionRef: { type: 'string', required: true },
          },
        },
      },
      receiptSubmissionRef: { type: 'string', required: true },
      error: {
        type: 'object', additionalProperties: false,
        properties: { code: { type: 'string', required: true }, message: { type: 'string', required: true } },
      },
    },
  } as never
}

/** Prospective boundary targets from the intent, for the preflight collision check (§6.2). */
async function prospectiveTargets(ctx: Context, intent: OutputIntent, outputRoot: string, runId: string): Promise<string[]> {
  if (intent.kind === 'default') {
    const rootTarget = await ctx.fs.resolve(outputRoot)
    return [`${ctx.fs.processPath(rootTarget)}/runs/${runId}`]
  }
  if (intent.kind === 'dir') return [ctx.fs.processPath(await ctx.fs.resolve(intent.path))]
  if (intent.kind === 'prefix') return [ctx.fs.processPath(await ctx.fs.resolve(intent.value))]
  if (intent.kind === 'paths') {
    const targets: string[] = []
    for (const path of intent.paths) targets.push(ctx.fs.processPath(await ctx.fs.resolve(path)))
    return targets
  }
  return []
}

/** Build the shared professional Tool definition from one spec (§5.1—§5.2). */
export function defineProfessionalTool<P>(ctx: Context, options: ProfessionalRuntimeOptions, spec: ProfessionalToolSpecV1<P>) {
  registerReceiptExtensionSchema({
    namespace: spec.extension.namespace,
    schemaId: spec.extension.schemaId,
    revision: spec.specRevision,
    validate: spec.extension.validate,
  })
  return defineTool({
    name: spec.toolName,
    description: spec.modelDescription,
    parameters: spec.modelParameters as never,
    output: {
      schema: professionalResultSchema(),
      render: (_args, value) => renderProfessionalResult(value as unknown as ProfessionalToolResultV1),
      presentationMeta: (_args, value) =>
        professionalPresentationMeta(spec.toolName, value as unknown as ProfessionalToolResultV1) as unknown as JsonValue,
    },
    presentResult: (_args: unknown, result: ToolResult) => presentProfessionalResult((result as { meta?: unknown }).meta),
    async execute(args: unknown, exec: ToolExecution) {
      const value = await runProfessionalTool(ctx, options, spec, args as Record<string, unknown>, exec)
      if (value.outcome !== 'succeeded') {
        throw new ProfessionalToolError(
          value.outcome,
          JSON.stringify({
            runId: value.runId, outcome: value.outcome, outputCompleteness: value.outputCompleteness,
            outputManifestRef: value.outputManifestRef, receiptSubmissionRef: value.receiptSubmissionRef,
            error: value.error ?? null,
          }),
          value,
        )
      }
      return value as never
    },
  })
}

/** The authoritative ten-step pipeline (§5.2); every step before spawn failing yields not_started. */
export async function runProfessionalTool<P>(
  ctx: Context,
  options: ProfessionalRuntimeOptions,
  spec: ProfessionalToolSpecV1<P>,
  raw: Record<string, unknown>,
  exec: ToolExecution,
): Promise<ProfessionalToolResultV1> {
  const { store, artifacts, lane, config } = options
  const parsed = spec.parseArgs(raw)
  const header = exec.agent?.session.header
  if (header === undefined) throw new ProfessionalToolError('no_session', 'the professional tool requires an agent Session context')
  const bootstrap = store.sessionGraphs.get(header.id)
  if (bootstrap === undefined || bootstrap.state !== 'ready') throw new ProfessionalToolError('scope_not_ready', `Session '${header.id}' has no ready Evidence Graph`)
  const sessionHeader = header
  const graphBootstrap = bootstrap
  const cwd = sessionHeader.cwd
  const resolveOpts = cwd === undefined ? {} : { cwd }
  const persisted = await ctx.sessionPersistence.readFrom(sessionHeader.id, 0)
  const own = findOwnBasis(persisted.events, persisted.meta, exec)
  const invocationBasis: RunnerInvocationBasisV1 | null = own?.basis ?? null
  const startSeq = own?.startSeq ?? -1
  const runIdMaterial = invocationBasis === null ? null : invocationBasis.kind === 'direct'
    ? { graphId: graphBootstrap.graphId, basisKind: 'top_level_tool', sessionId: sessionHeader.id, callEventSeq: startSeq, callId: invocationBasis.callId }
    : {
      graphId: graphBootstrap.graphId, basisKind: 'code_mode_dispatch', sessionId: sessionHeader.id, startEventSeq: startSeq,
      rootCallId: invocationBasis.rootCallId, parentCallId: invocationBasis.parentCallId, subCallId: invocationBasis.subCallId,
    }
  const runId: EvidenceRunId | null = runIdMaterial === null ? null : deriveRunId(runIdMaterial)
  const receiptHolder: { value: EvidenceRunReceiptSubmissionV1 | null } = { value: null }
  const originHolder: { value: { readonly label: string; readonly basis: string } | undefined } = { value: undefined }
  const persist = async (settle: {
    readonly outcome: RunnerOutcome
    readonly startedAt: number | null
    readonly components: ReceiptComponentsV1
    readonly invocationDigestJson: JsonValue
    readonly argv: readonly string[]
  }): Promise<string> => {
    if (runId === null || invocationBasis === null) return 'unresolved'
    const extensionPayload = spec.extension.payloadOf(parsed.params, settle.argv) as { codeOrigin?: string; codeOriginBasis?: string }
    const extensionEntry = {
      namespace: spec.extension.namespace,
      schemaId: spec.extension.schemaId,
      revision: spec.specRevision,
      payload: {
        ...extensionPayload,
        ...(originHolder.value === undefined ? {} : { codeOrigin: originHolder.value.label, codeOriginBasis: originHolder.value.basis }),
      },
    }
    // §9.2: unknown or invalid extensions are retained verbatim as diagnostic; registered
    // ones ride along as software facts. Neither can touch public fields or components.
    void classifyReceiptExtension(extensionEntry)
    const submission = await persistReceiptSubmission(store, {
      evidenceGraphId: graphBootstrap.graphId,
      sessionId: sessionHeader.id,
      runId,
      invocationBasis,
      expectedResultCallId: exec.callId,
      toolName: spec.toolName,
      operationProfile: spec.specRevision,
      providerId: SCIENTIFIC_TOOL_PROVIDER_ID,
      providerVersion: SCIENTIFIC_TOOL_PROVIDER_VERSION,
      captureProfileId: `sci-tool:${spec.toolName}`,
      captureProfileRevision: spec.specRevision,
      invocationDigest: canonicalDigest(settle.invocationDigestJson),
      lifecycle: { startedAt: settle.startedAt, endedAt: Date.now() },
      outcome: settle.outcome,
      components: settle.components,
      extensions: [extensionEntry],
    })
    await lane.registerPending(sessionHeader.id, submission.receiptId)
    receiptHolder.value = submission
    return submission.receiptId
  }
  const notStarted = async (code: string, message: string, bundleRefs?: readonly string[]): Promise<ProfessionalToolResultV1> => {
    const components: ReceiptComponentsV1 = {
      inputs: bundleRefs === undefined ? missingComponent('bundle_not_captured') : capturedComponent([...bundleRefs]),
      outputs: missingComponent('output_absent'),
      softwareAndCode: capturedComponent([]),
      environment: missingComponent('environment_not_captured'),
      parameters: missingComponent('parameters_not_captured'),
      randomness: missingComponent('randomness_not_assessed_v0.1'),
      logs: missingComponent('logs_not_captured'),
    }
    const receiptRef = await persist({
      outcome: 'not_started',
      startedAt: null,
      components,
      invocationDigestJson: { toolName: spec.toolName, arguments: { raw: Object.keys(raw) } },
      argv: [],
    })
    return {
      runId: runId ?? 'unresolved',
      outcome: 'not_started',
      outputCompleteness: 'unknown',
      outputCompletenessReason: code,
      outputManifestRef: null,
      outputs: [],
      receiptSubmissionRef: receiptRef,
      error: { code, message },
    }
  }

  if (runId === null) return notStarted('start_event_unresolved', 'the tool could not resolve its own persisted start event')

  // §5.2 step 1: normalize the typed input bundle (expected refs fail closed, §6.1).
  let bundleRefs: string[] | undefined
  let bundle: Awaited<ReturnType<typeof normalizeInputBundle>> | undefined
  try {
    bundle = await normalizeInputBundle({
      store, artifacts,
      bundleKind: spec.inputBundle.bundleKind,
      schemaRevision: spec.inputBundle.schemaRevision,
      handles: spec.inputBundle.handlesOf(parsed.params),
      requiredRoles: spec.inputBundle.requiredRoles,
      ...resolveOpts,
      signal: exec.signal,
    })
    bundleRefs = bundle.components.map(component => component.artifactVersionId)
  } catch (error) {
    if (error instanceof InputBundleError) return notStarted(error.code, error.message)
    throw error
  }

  // §5.2 step 2: environment gate (digest/version/schema drift stops before spawn, §7.2).
  try {
    await verifyEnvironmentGate({
      ctx, store,
      componentNames: spec.executableBinding.components,
      inputBundleSchemaRevision: `${spec.inputBundle.bundleKind}@${spec.inputBundle.schemaRevision}`,
      parseVersion: spec.hooks.resolveVersion,
      signal: exec.signal,
    })
  } catch (error) {
    if (error instanceof EnvironmentGateError) return notStarted(error.code, error.message, bundleRefs)
    throw error
  }

  // §5.2 step 3: preflight (four states; incompatible/needs_clarification never spawn, §6.2).
  const contract = spec.operations.find(operation => operation.applies(parsed.params))
  const coverage = contract === undefined ? 'baseline_only' : 'operation_profile'
  const services: HookServices = {
    readBytes: async (locator, maxBytes) => ctx.fs.readBytes(await ctx.fs.resolve(locator, resolveOpts), exec.signal, maxBytes),
    readText: async (locator) => {
      const target = await ctx.fs.resolve(locator, resolveOpts)
      const bytes = await ctx.fs.readBytes(target, exec.signal, 1_048_576)
      return new TextDecoder().decode(bytes)
    },
    locatorOf: role => bundle.components.find(component => component.role === role)?.locator,
  }
  const collisionTargets = await prospectiveTargets(ctx, parsed.outputIntent, config.professionalOutputRoot, runId)
  try {
    await runPreflight({
      store, artifacts,
      bundle: bundle,
      profileIdentity: { contractId: contract?.contractId ?? `${spec.toolName}-baseline`, revision: spec.specRevision },
      softwareVersion: null,
      coverage,
      coverageGaps: contract?.coverageGaps?.(parsed.params) ?? (contract === undefined ? [`no_operation_profile:${spec.toolName}`] : []),
      plan: contract === undefined ? {} : contract.baselinePlan(parsed.params),
      softwareChecks: contract === undefined ? [] : contract.softwareChecks(parsed.params, services),
      boundaryTargets: collisionTargets,
      signal: exec.signal,
    })
  } catch (error) {
    if (error instanceof PreflightBlockedError) {
      return notStarted(error.status, error.message, bundleRefs)
    }
    throw error
  }

  // §5.2 step 4: the complete ResolvedParameterSet (five sources, §6.3).
  const entities = new ContextEntityOwner(store)
  const parametersEntity = await persistResolvedParameterSet({
    entities,
    toolName: spec.toolName,
    parameters: parsed.resolvedParameters,
    secretNames: new Set(parsed.env.filter(entry => entry.secret === true).map(entry => entry.name)),
  })

  // §5.2 step 5: exclusive reservation (anti-overwrite, ambiguity, scope; §8.1).
  let reservation: Awaited<ReturnType<typeof reserveOutputBoundary>>
  try {
    reservation = await reserveOutputBoundary({
      ctx, store, runId, attempt: 1,
      outputRoot: config.professionalOutputRoot,
      intent: parsed.outputIntent,
      allowedScopeRoot: cwd ?? config.professionalOutputRoot,
      signal: exec.signal,
    })
  } catch (error) {
    if (error instanceof OutputBoundaryError) return notStarted(error.code, error.message, bundleRefs)
    throw error
  }

  // §5.2 step 6: output plan for supported calls only (§8.2, D-195). An uncovered
  // baseline_only native call never gets a plan — it settles unknown + output_plan_absent.
  const planDraft = contract === undefined ? null : spec.hooks.buildOutputPlan(parsed.params, reservation.boundary.rootDir)
  if (planDraft !== null && planDraft.roles.length > config.professionalMaxPlanOutputs) {
    return notStarted('too_many_plan_outputs', `output plan exceeds the configured maximum of ${String(config.professionalMaxPlanOutputs)} roles`, bundleRefs)
  }
  const plan = planDraft === null ? null : await persistOutputPlan({
    store, runId,
    planRevision: spec.specRevision,
    generatedByHook: `${spec.extension.namespace}.buildOutputPlan`,
    roles: planDraft.roles,
    bundles: planDraft.bundles,
  })

  // Environment entries through the shared allowlist construction (§4.1).
  const childEnv = buildChildEnv(
    spec.executableBinding.defaultEnvAllowlist,
    spec.executableBinding.extraEnvAllowlist,
    parsed.env,
    exec.signal,
  )
  if (!childEnv.ok) return notStarted(childEnv.code, `environment variable '${childEnv.name}' is not allowlisted`, bundleRefs)

  // §5.2 step 7: spawn through the single Runtime core with the jobs projection (§4.2, D-185).
  const revisionState = store.environmentStateNow()
  const frozenRevision = revisionState?.currentRevisionId === null || revisionState === undefined
    ? undefined
    : store.environmentRevisions.get(revisionState.currentRevisionId)
  const mainComponent = frozenRevision?.components.find(component => component.name === spec.executableBinding.components[0])
  if (frozenRevision === undefined || mainComponent === undefined) {
    return notStarted('environment_not_ready', 'the frozen environment revision is missing the bound executable', bundleRefs)
  }
  const argv = [mainComponent.resolvedPath, ...spec.hooks.toInvocation(parsed.params, services), ...parsed.nativeArgs]
  // §10.3 codeOrigin facts: prior in-session capture vs first-capture-now vs older external.
  const codeComponent = bundle.components.find(component => component.role === 'code')
  const codePriorObservation = codeComponent === undefined
    ? undefined
    : [...store.locationObservations.entries()]
      .map(([, row]) => row)
      .filter(row => row.locator === codeComponent.locator && row.observedAt < bundle.createdAt)
      .sort((left, right) => right.observedAt - left.observedAt)[0]
  const codeOriginFacts: CodeOriginFacts = {
    firstObservedAt: codePriorObservation?.observedAt ?? null,
    sessionCreatedAt: sessionHeader.createdAt,
  }
  originHolder.value = spec.hooks.codeOrigin === undefined
    ? undefined
    : spec.hooks.codeOrigin(parsed.params, codeOriginFacts)
  const runtimeLogDir = `${reservation.boundary.rootDir}/${RUNTIME_LOG_DIR}`
  await mkdir(runtimeLogDir, { recursive: true })
  const jobs = ctx.get('jobs')
  const cancel = new AbortController()
  const signal = AbortSignal.any([exec.signal, cancel.signal])
  let jobOutcomeResolve: ((value: { status: 'completed' | 'killed' | 'failed'; detail?: string }) => void) | undefined
  const jobDone = new Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>((resolve) => { jobOutcomeResolve = resolve })
  if (jobs !== undefined) {
    jobs.start({
      kind: 'sci-tool',
      label: `${spec.toolName} run ${runId}`,
      ...(exec.agent === undefined ? {} : { owner: exec.agent }),
      run: () => ({
        cancel: () => { cancel.abort() },
        done: jobDone,
      }),
    })
  }
  let managed: Awaited<ReturnType<typeof runManagedProcess>>
  try {
    managed = await runManagedProcess({
      ctx,
      argv,
      cwd: reservation.boundary.rootDir,
      env: childEnv.env,
      timeoutMs: config.professionalDefaultTimeoutMs,
      logCaptureMaxBytes: config.professionalLogCaptureMaxBytes,
      abortSignal: signal,
      stdoutLogPath: `${runtimeLogDir}/stdout.log`,
      stderrLogPath: `${runtimeLogDir}/stderr.log`,
    })

    // §5.2 step 8: settle the boundary — formal/diagnostic manifest and finalization (§8.3—§8.5).
    const settle = await settleOutputBoundary({
      ctx, store, artifacts,
      reservation,
      plan,
      validateOutput: (role, locator, bytes) => spec.hooks.validateOutput(role, locator, bytes),
      signal: exec.signal,
    })
    let outcome: RunnerOutcome
    if (managed.kind === 'not_started') {
      outcome = 'not_started'
    } else if (managed.kind === 'unknown') {
      outcome = managed.cancelled ? 'cancelled' : 'outcome_unknown'
    } else if (managed.cancelled) {
      outcome = 'cancelled'
    } else if (managed.timedOut || !spec.executableBinding.acceptedExitCodes.includes(managed.exitCode ?? -1)) {
      outcome = 'failed'
    } else if (plan !== null) {
      outcome = settle.outputCompleteness === 'complete' ? 'succeeded' : 'failed'
    } else {
      outcome = 'succeeded'
    }

    // §4.5-style post-run freshness re-observation of every bundle component (D-174).
    const inputContinuityBroken: string[] = []
    for (const component of bundle.components) {
      try {
        const postRun = await artifacts.captureFile({ role: component.role, locator: component.locator }, { createdBy: 'runner_input', ...resolveOpts, signal: exec.signal })
        if (postRun.artifactVersionId !== component.artifactVersionId) inputContinuityBroken.push(component.role)
      } catch {
        inputContinuityBroken.push(component.role)
      }
    }
    const codeRef = bundle.components.find(component => component.role === 'code')?.artifactVersionId
    const logRefs: string[] = []
    if (managed.kind === 'spawned' && managed.logsCaptured) {
      for (const logPath of ['stdout', 'stderr']) {
        try {
          const captured = await artifacts.captureFile({ role: `runtime_${logPath}`, locator: `${runtimeLogDir}/${logPath}.log` }, { createdBy: 'runner_log', signal: exec.signal })
          logRefs.push(captured.artifactVersionId)
        } catch { /* an uncapturable log stays absent; the component reflects reality */ }
      }
    }
    const parameters = await entities.register({
      contextKind: 'parameter_set',
      name: `${spec.toolName}-invocation`,
      version: null,
      payload: { argv: [...argv], nativeArgs: [...parsed.nativeArgs] },
    })
    const software = await entities.register({
      contextKind: 'software',
      name: spec.softwareIdentity.name,
      version: mainComponent.identity.version,
      payload: { toolName: spec.toolName, specRevision: spec.specRevision, digest: mainComponent.identity.digest },
    })
    const environment = await entities.register({
      contextKind: 'environment',
      name: 'professional-local',
      version: null,
      payload: { os: process.platform, arch: process.arch, revisionId: frozenRevision.revisionId, cwd: reservation.boundary.rootDir },
    })
    const components: ReceiptComponentsV1 = {
      inputs: inputContinuityBroken.length > 0
        ? { state: 'missing' as const, reason: 'input_continuity_broken' as const, ownerRefs: [] as string[], captureBasis: null }
        : capturedComponent(bundle.components.map(component => component.artifactVersionId)),
      outputs: settle.validatedRoles.length === 0
        ? missingComponent(plan === null ? 'output_plan_absent' : settle.outputCompletenessReason ?? 'output_absent')
        : capturedComponent(settle.validatedRoles.map(item => item.artifactVersionId)),
      softwareAndCode: capturedComponent(codeRef === undefined ? [software.contextEntityId] : [software.contextEntityId, codeRef]),
      environment: capturedComponent([environment.contextEntityId]),
      parameters: capturedComponent([parametersEntity.contextEntityId, parameters.contextEntityId]),
      randomness: missingComponent('randomness_not_assessed_v0.1'),
      logs: logRefs.length === 0 ? missingComponent('logs_not_captured') : capturedComponent(logRefs),
    }

    // §5.2 step 9: the Submission is durable before the Tool result settles (§9.3, D-193).
    const invocationDigestJson = {
      toolName: spec.toolName,
      arguments: {
        params: parsed.resolvedParameters,
        env: Object.fromEntries(parsed.env.map(entry => [entry.name, entry.secret === true ? 'secret:hidden' : entry.value])),
        nativeArgs: [...parsed.nativeArgs],
        argv: [...argv],
      },
    } as unknown as JsonValue
    const receiptRef = await persist({
      outcome,
      startedAt: managed.kind === 'spawned' ? managed.startedAt : null,
      components,
      invocationDigestJson,
      argv,
    })
    // §8.1: release only on proven in-process settlement; unknown keeps the reservation active.
    if (outcome === 'succeeded') await releaseOutputBoundary(store, reservation.reservationId, 'completed')
    else if (outcome === 'failed') await releaseOutputBoundary(store, reservation.reservationId, 'failed')
    else if (outcome === 'cancelled') await releaseOutputBoundary(store, reservation.reservationId, 'cancelled_confirmed')
    if (jobOutcomeResolve !== undefined) {
      jobOutcomeResolve(outcome === 'succeeded' ? { status: 'completed', detail: `run ${runId}` } : outcome === 'cancelled' ? { status: 'killed', detail: `run ${runId}` } : { status: 'failed', detail: `run ${runId}` })
    }
    const result: ProfessionalToolResultV1 = {
      runId,
      outcome,
      outputCompleteness: settle.outputCompleteness,
      outputCompletenessReason: settle.outputCompletenessReason,
      outputManifestRef: settle.manifest.manifestId,
      outputs: settle.validatedRoles.map(item => ({ role: item.role, artifactVersionRef: item.artifactVersionId })),
      receiptSubmissionRef: receiptRef,
      ...(outcome === 'succeeded' ? {} : { error: { code: outcome, message: `see manifest ${settle.manifest.manifestId}${receiptHolder.value === null ? '' : ` and receipt ${receiptHolder.value.receiptId}`}` } }),
    }
    return result
  } catch (error) {
    if (jobOutcomeResolve !== undefined) jobOutcomeResolve({ status: 'failed', detail: `run ${runId}` })
    throw error
  }
}
