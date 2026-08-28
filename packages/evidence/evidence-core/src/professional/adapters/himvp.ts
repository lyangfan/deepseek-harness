/** himvp_cli thin adapter (SPEC-03 §10.2): structured GWAS params and required-column validation. */

import { basename, join } from 'node:path'
import type { PreflightCheckItem } from '../preflight.ts'
import type { ProfessionalToolSpecV1 } from '../spec.ts'
import type { OutputPlanV1 } from '../../types.ts'

export interface HimvpParams {
  readonly bed: string
  readonly bim: string
  readonly fam: string
  readonly phenotype: string
  readonly model: 'MLM' | 'GLM'
  readonly pcs: number
  readonly nativeArgs: readonly string[]
  readonly outPrefix: string
}

function validateHimvpOutput(role: string, bytes: Uint8Array): { passed: boolean } {
  if (role === 'gwas_association_table') {
    const header = (new TextDecoder().decode(bytes).split('\n')[0] ?? '').split('\t').map(value => value.trim())
    return { passed: ['SNP', 'CHR', 'POS', 'P'].every(column => header.includes(column)) }
  }
  if (role === 'software_log') return { passed: new TextDecoder().decode(bytes).trim().length > 0 }
  return { passed: false }
}

export const HIMVP_TOOL_SPEC: ProfessionalToolSpecV1<HimvpParams> = {
  toolName: 'himvp_cli',
  softwareIdentity: { name: 'himvp', kind: 'cli' },
  specRevision: 'animalge-pro-himvp-cli/v1',
  modelDescription: 'Run a HiMVP GWAS through the controlled scientific tool runtime with verified genotype and phenotype inputs; the association table is validated before it becomes a formal Evidence output.',
  modelParameters: {
    bed: { type: 'string', required: true, description: 'Locator of the .bed genotype file.' },
    bim: { type: 'string', required: true, description: 'Locator of the .bim marker file.' },
    fam: { type: 'string', required: true, description: 'Locator of the .fam sample file.' },
    phenotype: { type: 'string', required: true, description: 'Locator of the tab-separated phenotype table (header IID, trait).' },
    model: { type: 'string', required: true, enum: ['MLM', 'GLM'], description: 'GWAS model.' },
    pcs: { type: 'number', required: true, description: 'Number of PC covariates.' },
    native_args: {
      type: 'array', required: true, items: { type: 'string' },
      description: 'Unmodelled native HiMVP flags passed through verbatim (baseline_only settlement).',
    },
    out_prefix: { type: 'string', required: true, description: 'Output prefix under the reserved boundary.' },
  },
  parseArgs: (raw) => {
    const str = (value: unknown, field: string): string => {
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`himvp_cli: ${field} must be a non-empty string`)
      return value
    }
    if (raw.model !== 'MLM' && raw.model !== 'GLM') throw new Error('himvp_cli: model must be MLM or GLM')
    if (typeof raw.pcs !== 'number' || !Number.isSafeInteger(raw.pcs) || raw.pcs < 0) throw new Error('himvp_cli: pcs must be a non-negative integer')
    const params: HimvpParams = {
      bed: str(raw.bed, 'bed'),
      bim: str(raw.bim, 'bim'),
      fam: str(raw.fam, 'fam'),
      phenotype: str(raw.phenotype, 'phenotype'),
      model: raw.model,
      pcs: raw.pcs,
      nativeArgs: Array.isArray(raw.native_args) ? (raw.native_args as unknown[]).map(item => str(item, 'native_args[]')) : [],
      outPrefix: str(raw.out_prefix, 'out_prefix'),
    }
    return {
      params,
      resolvedParameters: [
        { name: 'model', value: params.model, source: 'user_supplied', reason: 'user argument' },
        { name: 'pcs', value: params.pcs, source: 'user_supplied', reason: 'user argument' },
        { name: 'loco', value: 'software-default-materialized', source: 'software_default_materialized', reason: 'materialized from the HiMVP fake profile' },
      ],
      env: [],
      outputIntent: { kind: 'prefix', value: params.outPrefix },
      nativeArgs: params.nativeArgs,
    }
  },
  inputBundle: {
    bundleKind: 'gwas-input',
    schemaRevision: 'v1',
    requiredRoles: ['bed', 'bim', 'fam', 'phenotype'],
    handlesOf: params => [
      { role: 'bed', locator: params.bed },
      { role: 'bim', locator: params.bim },
      { role: 'fam', locator: params.fam },
      { role: 'phenotype', locator: params.phenotype },
    ],
  },
  executableBinding: {
    components: ['himvp'],
    argvMode: 'cli_argv',
    defaultEnvAllowlist: ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'],
    extraEnvAllowlist: ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS'],
    acceptedExitCodes: [0],
  },
  guideRef: { path: 'docs/professional/himvp-cli-guide.md', revision: 'fake-guide/v1', appliesToVersionRange: 'HiMVP v0.fake' },
  operations: [
    {
      contractId: 'himvp-gwas-v1',
      applies: params => params.nativeArgs.length === 0,
      baselinePlan: () => ({
        sampleIntersection: { genotypeIdsRole: 'fam', phenotypeRole: 'phenotype', idColumn: 0 },
        requiredColumns: { role: 'phenotype', columns: ['IID', 'trait'], delimiter: '\t' },
        inputOutputCollision: true,
      }),
      softwareChecks: (): readonly PreflightCheckItem[] => [],
    },
  ],
  hooks: {
    toInvocation: (params, services) => {
      const bed = services.locatorOf('bed') ?? params.bed
      const bfile = bed.endsWith('.bed') ? bed.slice(0, -4) : bed
      const phenotype = services.locatorOf('phenotype') ?? params.phenotype
      return ['--bfile', bfile, '--pheno', phenotype, '--model', params.model, '--pc', String(params.pcs), '--out', params.outPrefix]
    },
    resolveVersion: (_component, output) => {
      const match = /HiMVP v([0-9.a-z-]+)/u.exec(output)
      return match === null ? null : `HiMVP v${match[1] as string}`
    },
    buildOutputPlan: (params, rootDir) => {
      const prefix = join(rootDir, basename(params.outPrefix))
      const roles: OutputPlanV1['roles'] = [
        { role: 'gwas_association_table', pathRule: { kind: 'exact', value: `${prefix}.assoc.tsv` }, required: true, cardinality: 'one', bundle: null, validator: 'gwas-required-columns' },
        { role: 'software_log', pathRule: { kind: 'exact', value: `${prefix}.log` }, required: false, cardinality: 'one', bundle: null, validator: 'non-empty-text' },
      ]
      return { roles, bundles: [] }
    },
    validateOutput: (role, _locator, bytes) => validateHimvpOutput(role, bytes),
  },
  extension: {
    namespace: 'himvp_cli@1',
    schemaId: 'animalge.pro.himvp.extension/v1',
    payloadOf: (params, argv) => ({
      nativeArgv: [...argv],
      inputRoleMapping: { bed: params.bed, bim: params.bim, fam: params.fam, phenotype: params.phenotype },
    }),
    validate: (payload) => {
      if (typeof payload !== 'object' || payload === null) return false
      const raw = payload as { nativeArgv?: unknown; inputRoleMapping?: unknown }
      return Array.isArray(raw.nativeArgv) && typeof raw.inputRoleMapping === 'object' && raw.inputRoleMapping !== null
    },
  },
}
