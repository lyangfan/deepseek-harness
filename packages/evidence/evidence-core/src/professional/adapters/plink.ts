/** plink_cli thin adapter (SPEC-03 §10.1): argv/executable separation, QC output plan. */

import { basename, join } from 'node:path'
import type { PreflightCheckItem } from '../preflight.ts'
import type { ProfessionalToolSpecV1 } from '../spec.ts'
import type { OutputPlanV1 } from '../../types.ts'

export interface PlinkParams {
  readonly bed: string
  readonly bim: string
  readonly fam: string
  readonly maf: number | null
  readonly geno: number | null
  readonly mind: number | null
  readonly chr: string | null
  readonly nativeArgs: readonly string[]
  readonly outPrefix: string
}

const PLINK_BED_MAGIC = [0x6c, 0x1b, 0x01]

function validatePlinkOutput(role: string, bytes: Uint8Array): { passed: boolean } {
  if (role === 'qc_bed') {
    return { passed: bytes.length > 3 && PLINK_BED_MAGIC.every((byte, index) => bytes[index] === byte) }
  }
  if (role === 'qc_bim' || role === 'qc_fam' || role === 'software_log') {
    return { passed: new TextDecoder().decode(bytes).trim().length > 0 }
  }
  return { passed: false }
}

export const PLINK_TOOL_SPEC: ProfessionalToolSpecV1<PlinkParams> = {
  toolName: 'plink_cli',
  softwareIdentity: { name: 'plink', kind: 'cli' },
  specRevision: 'animalge-pro-plink-cli/v1',
  modelDescription: 'Run PLINK genotype QC through the controlled scientific tool runtime. Inputs are a bed/bim/fam bundle; outputs are declared before execution and only validated outputs become formal Evidence outputs.',
  modelParameters: {
    bed: { type: 'string', required: true, description: 'Locator of the .bed file of the input bundle.' },
    bim: { type: 'string', required: true, description: 'Locator of the .bim file of the input bundle.' },
    fam: { type: 'string', required: true, description: 'Locator of the .fam file of the input bundle.' },
    maf: { type: 'number', description: 'MAF filter threshold.' },
    geno: { type: 'number', description: 'Missing-genotype per-marker threshold.' },
    mind: { type: 'number', description: 'Missing-genotype per-sample threshold.' },
    chr: { type: 'string', description: 'Explicit chromosome selection (e.g. "1-10").' },
    native_args: {
      type: 'array', required: true, items: { type: 'string' },
      description: 'Unmodelled native PLINK flags passed through verbatim (the call then settles baseline_only).',
    },
    out_prefix: { type: 'string', required: true, description: 'Output prefix (PLINK --out) under the reserved boundary.' },
  },
  parseArgs: (raw) => {
    const str = (value: unknown, field: string): string => {
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`plink_cli: ${field} must be a non-empty string`)
      return value
    }
    const num = (value: unknown, field: string): number | null => {
      if (value === undefined) return null
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`plink_cli: ${field} must be a finite number`)
      return value
    }
    const params: PlinkParams = {
      bed: str(raw.bed, 'bed'),
      bim: str(raw.bim, 'bim'),
      fam: str(raw.fam, 'fam'),
      maf: num(raw.maf, 'maf'),
      geno: num(raw.geno, 'geno'),
      mind: num(raw.mind, 'mind'),
      chr: raw.chr === undefined ? null : str(raw.chr, 'chr'),
      nativeArgs: Array.isArray(raw.native_args) ? (raw.native_args as unknown[]).map(item => str(item, 'native_args[]')) : [],
      outPrefix: str(raw.out_prefix, 'out_prefix'),
    }
    const resolved = [
      { name: 'maf', value: params.maf, source: 'user_supplied' as const, reason: 'user argument' },
      { name: 'geno', value: params.geno, source: 'user_supplied' as const, reason: 'user argument' },
      { name: 'mind', value: params.mind, source: 'user_supplied' as const, reason: 'user argument' },
      { name: 'chr', value: params.chr, source: 'user_supplied' as const, reason: 'user argument' },
      { name: 'allow-extra-chr', value: 'software-default-materialized', source: 'software_default_materialized' as const, reason: 'materialized from the PLINK 1.9 profile' },
    ]
    return {
      params,
      resolvedParameters: resolved.filter(entry => entry.value !== null),
      env: [],
      outputIntent: { kind: 'prefix' as const, value: params.outPrefix },
      nativeArgs: params.nativeArgs,
    }
  },
  inputBundle: {
    bundleKind: 'plink-bed-set',
    schemaRevision: 'v1',
    requiredRoles: ['bed', 'bim', 'fam'],
    handlesOf: params => [
      { role: 'bed', locator: params.bed },
      { role: 'bim', locator: params.bim },
      { role: 'fam', locator: params.fam },
    ],
  },
  executableBinding: {
    components: ['plink'],
    argvMode: 'cli_argv',
    defaultEnvAllowlist: ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'],
    extraEnvAllowlist: ['OMP_NUM_THREADS'],
    acceptedExitCodes: [0],
  },
  guideRef: { path: 'docs/professional/plink-cli-guide.md', revision: 'fake-guide/v1', appliesToVersionRange: 'PLINK v1.90fake' },
  operations: [
    {
      contractId: 'plink-qc-v1',
      applies: params => params.nativeArgs.length === 0,
      baselinePlan: () => ({
        dimensionConsistency: { bedRole: 'bed', bimRole: 'bim', famRole: 'fam' },
        inputOutputCollision: true,
      }),
      softwareChecks: (): readonly PreflightCheckItem[] => [],
    },
  ],
  hooks: {
    toInvocation: (params, services) => {
      const bed = services.locatorOf('bed') ?? params.bed
      const bfile = bed.endsWith('.bed') ? bed.slice(0, -4) : bed
      void services
      const argv = ['--bfile', bfile]
      if (params.maf !== null) argv.push('--maf', String(params.maf))
      if (params.geno !== null) argv.push('--geno', String(params.geno))
      if (params.mind !== null) argv.push('--mind', String(params.mind))
      if (params.chr !== null) argv.push('--chr', params.chr)
      argv.push('--out', params.outPrefix)
      return argv
    },
    resolveVersion: (_component, output) => {
      const match = /PLINK v([0-9.a-z]+)/u.exec(output)
      return match === null ? null : `PLINK v${match[1] as string}`
    },
    buildOutputPlan: (params, rootDir) => {
      // Anchor every rule on the reserved boundary's normalized root; the model-facing
      // prefix contributes only its basename so path aliasing can never split a bundle.
      const prefix = join(rootDir, basename(params.outPrefix))
      const roles: OutputPlanV1['roles'] = [
        { role: 'qc_bed', pathRule: { kind: 'exact', value: `${prefix}.bed` }, required: true, cardinality: 'one', bundle: 'qc_genotype', validator: 'plink-bed-magic' },
        { role: 'qc_bim', pathRule: { kind: 'exact', value: `${prefix}.bim` }, required: true, cardinality: 'one', bundle: 'qc_genotype', validator: 'non-empty-text' },
        { role: 'qc_fam', pathRule: { kind: 'exact', value: `${prefix}.fam` }, required: true, cardinality: 'one', bundle: 'qc_genotype', validator: 'non-empty-text' },
        { role: 'software_log', pathRule: { kind: 'exact', value: `${prefix}.log` }, required: false, cardinality: 'one', bundle: null, validator: 'non-empty-text' },
      ]
      const bundles: OutputPlanV1['bundles'] = [{ bundleName: 'qc_genotype', requiredRoles: ['qc_bed', 'qc_bim', 'qc_fam'] }]
      return { roles, bundles }
    },
    validateOutput: (role, _locator, bytes) => validatePlinkOutput(role, bytes),
  },
  extension: {
    namespace: 'plink_cli@1',
    schemaId: 'animalge.pro.plink.extension/v1',
    payloadOf: (params, argv) => ({
      nativeArgv: [...argv],
      inputRoleMapping: { bed: params.bed, bim: params.bim, fam: params.fam },
    }),
    validate: (payload) => {
      if (typeof payload !== 'object' || payload === null) return false
      const raw = payload as { nativeArgv?: unknown; inputRoleMapping?: unknown }
      return Array.isArray(raw.nativeArgv) && typeof raw.inputRoleMapping === 'object' && raw.inputRoleMapping !== null
    },
  },
}
