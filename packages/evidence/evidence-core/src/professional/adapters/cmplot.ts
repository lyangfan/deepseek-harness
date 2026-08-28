/** cmplot_call thin adapter (SPEC-03 §10.4, D-178): structured Manhattan plotting entry. */

import { basename, join } from 'node:path'
import type { ProfessionalToolSpecV1 } from '../spec.ts'
import type { OutputPlanV1 } from '../../types.ts'

export interface CmplotParams {
  readonly gwas: string
  readonly helper: string
  readonly threshold: number | null
  readonly outPrefix: string
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

function validateCmplotOutput(role: string, bytes: Uint8Array): { passed: boolean } {
  if (role === 'manhattan_plot') {
    return { passed: bytes.length > 8 && PNG_MAGIC.every((byte, index) => bytes[index] === byte) }
  }
  if (role === 'software_log') return { passed: new TextDecoder().decode(bytes).trim().length > 0 }
  return { passed: false }
}

export const CMPLOT_TOOL_SPEC: ProfessionalToolSpecV1<CmplotParams> = {
  toolName: 'cmplot_call',
  softwareIdentity: { name: 'cmplot-helper', kind: 'r_package_entry' },
  specRevision: 'animalge-pro-cmplot-call/v1',
  modelDescription: 'Produce a Manhattan plot from a GWAS result table through the controlled CMplot adaptation. Inputs and the plot format are validated; the image becomes a formal Evidence output only after passing the format validator.',
  modelParameters: {
    gwas: { type: 'string', required: true, description: 'Locator of the tab-separated GWAS result (header SNP, CHR, POS, P).' },
    helper: { type: 'string', required: true, description: 'Locator of the controlled CMplot helper script (r_package component).' },
    threshold: { type: 'number', description: 'Suggestive significance line.' },
    out_prefix: { type: 'string', required: true, description: 'Output prefix under the reserved boundary.' },
  },
  parseArgs: (raw) => {
    const str = (value: unknown, field: string): string => {
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`cmplot_call: ${field} must be a non-empty string`)
      return value
    }
    const params: CmplotParams = {
      gwas: str(raw.gwas, 'gwas'),
      helper: str(raw.helper, 'helper'),
      threshold: typeof raw.threshold === 'number' && Number.isFinite(raw.threshold) ? raw.threshold : null,
      outPrefix: str(raw.out_prefix, 'out_prefix'),
    }
    return {
      params,
      resolvedParameters: [
        { name: 'plot.type', value: 'manhattan', source: 'approved_profile', reason: 'cmplot_call entry profile' },
        { name: 'threshold', value: params.threshold, source: params.threshold === null ? 'software_default_materialized' : 'user_supplied', reason: params.threshold === null ? 'materialized default' : 'user argument' },
      ],
      env: [],
      outputIntent: { kind: 'prefix', value: params.outPrefix },
      nativeArgs: [],
    }
  },
  inputBundle: {
    bundleKind: 'manhattan-data',
    schemaRevision: 'v1',
    requiredRoles: ['gwas', 'cmplot_helper'],
    handlesOf: params => [
      { role: 'gwas', locator: params.gwas },
      { role: 'cmplot_helper', locator: params.helper },
    ],
  },
  executableBinding: {
    components: ['rscript', 'cmplot-rpkg'],
    argvMode: 'r_script_entry',
    defaultEnvAllowlist: ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'R_LIBS_USER', 'R_HOME'],
    extraEnvAllowlist: ['OMP_NUM_THREADS'],
    acceptedExitCodes: [0],
  },
  guideRef: { path: 'docs/professional/cmplot-guide.md', revision: 'fake-guide/v1', appliesToVersionRange: 'CMplot fake 1.x' },
  operations: [
    {
      contractId: 'cmplot-manhattan-v1',
      applies: () => true,
      baselinePlan: () => ({
        requiredColumns: { role: 'gwas', columns: ['SNP', 'CHR', 'POS', 'P'], delimiter: '\t' },
        joinKeyUniqueness: { role: 'gwas', keyColumn: 0, required: false },
        inputOutputCollision: true,
      }),
      softwareChecks: (): never[] => [],
    },
  ],
  hooks: {
    toInvocation: (params, services) => {
      const helper = services.locatorOf('cmplot_helper') ?? params.helper
      const gwas = services.locatorOf('gwas') ?? params.gwas
      const argv = ['--vanilla', helper, gwas, params.outPrefix]
      if (params.threshold !== null) argv.push(String(params.threshold))
      return argv
    },
    resolveVersion: (component, output) => {
      if (component === 'cmplot-rpkg') {
        const match = /CMplot v([0-9.]+)/u.exec(output)
        return match === null ? null : `CMplot ${match[1] as string}`
      }
      const match = /R version ([0-9.]+[^\s]*)/u.exec(output)
      return match === null ? null : `R ${match[1] as string}`
    },
    buildOutputPlan: (params, rootDir) => {
      const prefix = join(rootDir, basename(params.outPrefix))
      const roles: OutputPlanV1['roles'] = [
        { role: 'manhattan_plot', pathRule: { kind: 'exact', value: `${prefix}.png` }, required: true, cardinality: 'one', bundle: null, validator: 'png-magic' },
        { role: 'software_log', pathRule: { kind: 'exact', value: `${prefix}.log` }, required: false, cardinality: 'one', bundle: null, validator: 'non-empty-text' },
      ]
      return { roles, bundles: [] }
    },
    validateOutput: (role, _locator, bytes) => validateCmplotOutput(role, bytes),
  },
  extension: {
    namespace: 'cmplot_call@1',
    schemaId: 'animalge.pro.cmplot.extension/v1',
    payloadOf: (params, argv) => ({
      nativeArgv: [...argv],
      inputRoleMapping: { gwas: params.gwas, cmplot_helper: params.helper },
    }),
    validate: (payload) => {
      if (typeof payload !== 'object' || payload === null) return false
      const raw = payload as { nativeArgv?: unknown; inputRoleMapping?: unknown }
      return Array.isArray(raw.nativeArgv) && typeof raw.inputRoleMapping === 'object' && raw.inputRoleMapping !== null
    },
  },
}
