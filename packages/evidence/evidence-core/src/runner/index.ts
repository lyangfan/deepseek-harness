/** Model-visible registration of the declarative scientific-code Runner Tool (SPEC-02 §9.1). */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executeSciRunCode, RunnerInputError } from './execute.ts'
import type { RunnerExecutionOptions } from './execute.ts'
import type { AcceptanceLane } from '../acceptance.ts'
import type { ArtifactProvider } from '../artifact.ts'
import type { EvidenceStore } from '../store.ts'

export interface RunnerRegistrationOptions {
  readonly store: EvidenceStore
  readonly artifacts: ArtifactProvider
  readonly lane: AcceptanceLane
  readonly config: {
    readonly runnerOutputRoot: string
    readonly runnerDefaultTimeoutMs: number
    readonly runnerMaxDeclaredOutputs: number
    readonly runnerLogCaptureMaxBytes: number
  }
}

interface RawHandle {
  readonly role?: unknown
  readonly locator?: unknown
  readonly expected_artifact_version_ref?: unknown
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new RunnerInputError('invalid_argument', `${field} must be a non-empty string`)
  return value
}

function asHandle(value: unknown, field: string): { locator: string; expectedArtifactVersionRef?: string } {
  if (typeof value !== 'object' || value === null) throw new RunnerInputError('invalid_argument', `${field} must be an object`)
  const raw = value as RawHandle
  const locator = asString(raw.locator, `${field}.locator`)
  const expected = raw.expected_artifact_version_ref
  return { locator, ...(typeof expected === 'string' && expected !== '' ? { expectedArtifactVersionRef: expected } : {}) }
}

function asArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new RunnerInputError('invalid_argument', `${field} must be an array`)
  return value
}

function parseRunnerArgs(args: Record<string, unknown>): RunnerExecutionOptions {
  const declaredOutputs = asArray(args.declared_outputs, 'declared_outputs').map((value, index) => {
    if (typeof value !== 'object' || value === null) throw new RunnerInputError('invalid_argument', `declared_outputs[${index}] must be an object`)
    const raw = value as { role?: unknown; relative_path?: unknown; required?: unknown }
    if (typeof raw.required !== 'boolean') throw new RunnerInputError('invalid_argument', `declared_outputs[${index}].required must be boolean`)
    return { role: asString(raw.role, `declared_outputs[${index}].role`), relativePath: asString(raw.relative_path, `declared_outputs[${index}].relative_path`), required: raw.required }
  })
  const env = asArray(args.env, 'env').map((value, index) => {
    if (typeof value !== 'object' || value === null) throw new RunnerInputError('invalid_argument', `env[${index}] must be an object`)
    const raw = value as { name?: unknown; value?: unknown; secret?: unknown }
    return {
      name: asString(raw.name, `env[${index}].name`),
      value: typeof raw.value === 'string' ? raw.value : (() => { throw new RunnerInputError('invalid_argument', `env[${index}].value must be a string`) })(),
      ...(raw.secret === true ? { secret: true } : {}),
    }
  })
  const timeoutMs = args.timeout_ms
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new RunnerInputError('invalid_argument', 'timeout_ms must be a non-negative integer')
  return {
    languageProfile: asString(args.language_profile, 'language_profile'),
    code: asHandle(args.code, 'code'),
    inputs: asArray(args.inputs, 'inputs').map((value, index) => {
      const handle = asHandle(value, `inputs[${index}]`)
      const role = typeof value === 'object' && value !== null && 'role' in value ? asString((value as { role?: unknown }).role, `inputs[${index}].role`) : (() => { throw new RunnerInputError('invalid_argument', `inputs[${index}].role is required`) })()
      return { role, locator: handle.locator, ...('expectedArtifactVersionRef' in handle ? { expectedArtifactVersionRef: handle.expectedArtifactVersionRef } : {}) }
    }),
    declaredOutputs,
    env,
    args: asArray(args.args, 'args').map((value, index) => asString(value, `args[${index}]`)),
    timeoutMs,
  }
}

/** Register `sci_run_code` (§9.1: final tool name frozen here per the packet decision). */
export function applySciRunCodeTool(ctx: Context, options: RunnerRegistrationOptions): void {
  ctx.tools.register(defineTool({
    name: 'sci_run_code',
    description: 'Run a declared non-interactive scientific script (bash) with verified inputs, an exclusive output directory, and an evidence receipt. Declare every expected output file before execution.',
    parameters: {
      language_profile: { type: 'string', required: true, description: 'Registered language profile id (v0.1: "bash").' },
      code: {
        type: 'object', required: true, additionalProperties: false,
        description: 'Code file handle: the script is registered as an exact ArtifactVersion before execution.',
        properties: {
          locator: { type: 'string', required: true, description: 'Path of the script file.' },
          expected_artifact_version_ref: { type: 'string', description: 'Optional exact ArtifactVersion guard; mismatching bytes fail closed.' },
        },
      },
      inputs: {
        type: 'array', required: true,
        description: 'Input file handles resolved and hashed before the process starts.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            role: { type: 'string', required: true, description: 'Input role name.' },
            locator: { type: 'string', required: true, description: 'Path of the input file.' },
            expected_artifact_version_ref: { type: 'string', description: 'Optional exact-version guard.' },
          },
        },
      },
      declared_outputs: {
        type: 'array', required: true,
        description: 'Outputs declared before execution; only these can become formal outputs (at least one required).',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            role: { type: 'string', required: true, description: 'Output role name.' },
            relative_path: { type: 'string', required: true, description: 'Path relative to the run-exclusive output directory.' },
            required: { type: 'boolean', required: true, description: 'Whether the run fails when this output is missing.' },
          },
        },
      },
      env: {
        type: 'array', required: true,
        description: 'Additional environment entries; names must be allowlisted by the profile.',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Variable name.' },
            value: { type: 'string', required: true, description: 'Variable value.' },
            secret: { type: 'boolean', description: 'Mark the value secret: a stable placeholder is recorded instead of the value.' },
          },
        },
      },
      args: { type: 'array', required: true, description: 'Arguments passed to the script after its path.', items: { type: 'string' } },
      timeout_ms: { type: 'number', required: true, description: 'Execution timeout in milliseconds (0 uses the deployment default).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          outcome: { type: 'string', required: true, enum: ['succeeded', 'failed', 'cancelled', 'not_started', 'outcome_unknown'] },
          outputCompleteness: { type: 'string', required: true, enum: ['complete', 'incomplete'] },
          outputs: {
            type: 'array', required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string', required: true },
                artifactVersionRef: { type: 'string', required: true },
              },
            },
          },
          receiptSubmissionRef: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
          error: { type: 'string' },
        },
      } as never,
      render: (_args, value) => [{ type: 'text', text: formatSciRunResult(value as SciRunResultView) }],
    },
    async execute(args, exec) {
      const input = parseRunnerArgs(args as Record<string, unknown>)
      const value = await executeSciRunCode({
        ctx,
        store: options.store,
        artifacts: options.artifacts,
        lane: options.lane,
        exec,
        input,
        config: options.config,
      })
      if (value.outcome === 'not_started' || value.outcome === 'failed' || value.outcome === 'outcome_unknown') {
        throw new RunnerInputError(value.outcome, value.error ?? `${value.outcome}: outputCompleteness=${value.outputCompleteness}`)
      }
      return value as never
    },
  }))
}

interface SciRunResultView {
  readonly runId: string
  readonly outcome: string
  readonly outputCompleteness: string
  readonly outputs: readonly { role: string }[]
  readonly receiptSubmissionRef: string | null
}

function formatSciRunResult(value: SciRunResultView): string {
  const outputs = value.outputs.map(output => output.role).join(', ')
  const receipt = value.receiptSubmissionRef === null ? 'no receipt (start event unresolved)' : `receipt pending acceptance: ${value.receiptSubmissionRef}`
  return `sci_run_code ${value.outcome} (outputs ${value.outputCompleteness}: ${outputs === '' ? 'none' : outputs}; ${receipt}; run ${value.runId})`
}
