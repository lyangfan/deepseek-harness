/** r_script thin adapter (SPEC-03 §10.3, D-178): the only R entry besides cmplot_call. */

import type { ProfessionalToolSpecV1 } from '../spec.ts'
import type { OutputPlanV1 } from '../../types.ts'

/** Locator suffix of the adapter's packaged versioned scripts (§10.3 manifest). */
const PACKAGED_SCRIPT_NAME = 'packaged-sim.R'

export interface RscriptParams {
  readonly code: string
  readonly args: readonly string[]
  readonly declaredOutputs: readonly { readonly role: string; readonly relativePath: string; readonly required: boolean }[]
}

export const RSCRIPT_TOOL_SPEC: ProfessionalToolSpecV1<RscriptParams> = {
  toolName: 'r_script',
  softwareIdentity: { name: 'rscript', kind: 'cli' },
  specRevision: 'animalge-pro-r-script/v1',
  modelDescription: 'Execute one non-interactive R script through the controlled scientific tool runtime. The script becomes an exact code ArtifactVersion before execution; declare every expected output file (relative to the reserved boundary).',
  modelParameters: {
    code: { type: 'string', required: true, description: 'Locator of the R script (captured as an exact code ArtifactVersion).' },
    args: { type: 'array', required: true, items: { type: 'string' }, description: 'Arguments passed to the script.' },
    declared_outputs: {
      type: 'array', required: true,
      description: 'Outputs declared before execution; only declared and validated files become formal outputs.',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          role: { type: 'string', required: true, description: 'Output role name.' },
          relative_path: { type: 'string', required: true, description: 'Path relative to the reserved boundary root.' },
          required: { type: 'boolean', required: true, description: 'Whether the run fails when this output is missing.' },
        },
      },
    },
  },
  parseArgs: (raw) => {
    const str = (value: unknown, field: string): string => {
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`r_script: ${field} must be a non-empty string`)
      return value
    }
    const declared = Array.isArray(raw.declared_outputs) ? (raw.declared_outputs as unknown[]).map((value, index) => {
      if (typeof value !== 'object' || value === null) throw new Error(`r_script: declared_outputs[${String(index)}] must be an object`)
      const item = value as { role?: unknown; relative_path?: unknown; required?: unknown }
      if (typeof item.required !== 'boolean') throw new Error(`r_script: declared_outputs[${String(index)}].required must be boolean`)
      return { role: str(item.role, 'role'), relativePath: str(item.relative_path, 'relative_path'), required: item.required }
    }) : []
    if (declared.length === 0) throw new Error('r_script: at least one declared output is required')
    const args = Array.isArray(raw.args) ? (raw.args as unknown[]).map(item => str(item, 'args[]')) : []
    const params: RscriptParams = { code: str(raw.code, 'code'), args, declaredOutputs: declared }
    return {
      params,
      resolvedParameters: [
        { name: 'vanilla', value: '--vanilla', source: 'approved_profile', reason: 'r_script entry profile' },
        ...params.args.map((value, index) => ({ name: `arg${String(index)}`, value, source: 'user_supplied' as const, reason: 'user argument' })),
        ...declared.map(output => ({ name: `declared:${output.role}`, value: output.relativePath, source: 'user_supplied' as const, reason: 'user declaration' })),
      ],
      env: [],
      outputIntent: { kind: 'default' },
      nativeArgs: [],
    }
  },
  inputBundle: {
    bundleKind: 'r-script-input',
    schemaRevision: 'v1',
    requiredRoles: ['code'],
    handlesOf: params => [{ role: 'code', locator: params.code }],
  },
  executableBinding: {
    components: ['rscript'],
    argvMode: 'r_script_entry',
    defaultEnvAllowlist: ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'R_LIBS_USER', 'R_HOME'],
    extraEnvAllowlist: ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS'],
    acceptedExitCodes: [0],
  },
  guideRef: { path: 'docs/professional/r-script-guide.md', revision: 'fake-guide/v1', appliesToVersionRange: 'R fake 4.x' },
  operations: [
    {
      contractId: 'r-script-declared-v1',
      applies: params => params.declaredOutputs.length > 0,
      baselinePlan: () => ({}),
      softwareChecks: (): never[] => [],
    },
  ],
  hooks: {
    toInvocation: (params, services) => {
      const code = services.locatorOf('code') ?? params.code
      return ['--vanilla', code, ...params.args]
    },
    resolveVersion: (_component, output) => {
      const match = /R version ([0-9.]+[^\s]*)/u.exec(output)
      return match === null ? null : `R ${match[1] as string}`
    },
    buildOutputPlan: (params, rootDir) => {
      const roles: OutputPlanV1['roles'] = params.declaredOutputs.map(output => ({
        role: output.role,
        pathRule: { kind: 'exact' as const, value: `${rootDir}/${output.relativePath}` },
        required: output.required,
        cardinality: 'one' as const,
        bundle: null,
        validator: 'non-empty-file',
      }))
      return { roles, bundles: [] }
    },
    validateOutput: (_role, _locator, bytes) => ({ passed: bytes.length > 0 }),
    // §10.3: the label is DERIVED from provenance facts, never self-reported. Packaged
    // scripts match the adapter's versioned manifest locator; a prior in-session capture
    // of the code locator is the Session+code-ArtifactVersion fact; anything else the
    // caller supplied this call is user/external; unreadable facts stay external_unknown.
    codeOrigin: (params, facts) => {
      const packaged = params.code.endsWith(PACKAGED_SCRIPT_NAME)
      if (packaged) return { label: 'animalge_packaged', basis: `packaged manifest match: ${PACKAGED_SCRIPT_NAME}` }
      if (facts.firstObservedAt !== null && facts.firstObservedAt >= facts.sessionCreatedAt) {
        return { label: 'agent_session_generated', basis: 'prior in-session capture of the code locator' }
      }
      if (facts.firstObservedAt !== null) {
        return { label: 'user_or_external_precaptured', basis: 'captured before this session' }
      }
      return { label: 'user_or_external', basis: 'first captured by this call' }
    },
  },
  extension: {
    namespace: 'r_script@1',
    schemaId: 'animalge.pro.rscript.extension/v1',
    payloadOf: (params, argv) => ({
      nativeArgv: [...argv],
      declaredOutputRoles: params.declaredOutputs.map(output => output.role),
    }),
    validate: (payload) => {
      if (typeof payload !== 'object' || payload === null) return false
      const raw = payload as { nativeArgv?: unknown; codeOrigin?: unknown }
      return Array.isArray(raw.nativeArgv) && typeof raw.codeOrigin === 'string'
    },
  },
}
