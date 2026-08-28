/** Shared Preflight Engine: four states, baseline checks, and two-level coverage (SPEC-03 §6.2). */

import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { canonicalDigest } from '../canonical-json.ts'
import { newPreflightReportId } from '../identity.ts'
import type { ArtifactProvider } from '../artifact.ts'
import type { EvidenceStore } from '../store.ts'
import type { InputBundleV1, PreflightReportV1 } from '../types.ts'

/** Baseline check ids (v0.1 frozen table, SPEC-03 §6.2). */
export type BaselineCheckId =
  | 'bundle_structure'
  | 'dimension_consistency'
  | 'join_key_uniqueness'
  | 'sample_intersection'
  | 'required_columns'
  | 'input_output_collision'
  | 'assembly_or_allele_direction'

export type PreflightStatus = PreflightReportV1['status']

/** One structured check item contributed by the engine or a software hook (§6.2). */
export interface PreflightCheckItem {
  readonly checkId: string
  readonly severity: 'incompatible' | 'needs_clarification' | 'warning'
  readonly result: 'pass' | 'fail' | 'clarify'
  readonly observed: JsonValue | null
}

/** Declarative applicability of the baseline checks for one operation (hook-provided). */
export interface BaselineCheckPlan {
  readonly dimensionConsistency?: {
    readonly bedRole: string
    readonly bimRole: string
    readonly famRole: string
  }
  readonly joinKeyUniqueness?: { readonly role: string; readonly keyColumn: number; required: boolean }
  readonly sampleIntersection?: { readonly genotypeIdsRole: string; readonly phenotypeRole: string; readonly idColumn: number }
  readonly requiredColumns?: { readonly role: string; readonly columns: readonly string[]; readonly delimiter: string }
  readonly inputOutputCollision?: boolean
  readonly assemblyOrAlleleDirection?: { readonly requiresAssembly: boolean; readonly assemblyRole: string | null }
}

/** Preflight blocked before process start; the structured clarification rides along (§6.2). */
export class PreflightBlockedError extends Error {
  constructor(
    readonly status: 'incompatible' | 'needs_clarification',
    readonly report: PreflightReportV1,
    message: string,
  ) {
    super(message)
    this.name = 'PreflightBlockedError'
  }
}

interface BundleBytes {
  readonly bytes: Uint8Array
  readonly text: string
}

async function bundleBytesFor(
  artifacts: ArtifactProvider, bundle: InputBundleV1, role: string, signal: AbortSignal,
): Promise<BundleBytes | undefined> {
  const component = bundle.components.find(item => item.role === role)
  if (component === undefined) return undefined
  const bytes = await artifacts.readVersionBytes(component.artifactVersionId, signal)
  return { bytes, text: new TextDecoder().decode(bytes) }
}

function lineCount(text: string): number {
  if (text === '') return 0
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

function csvColumn(text: string, column: number, delimiter: string): string[] {
  return text.split('\n').filter(line => line !== '').map(line => (line.split(delimiter)[column] ?? '').trim())
}

/** Run the declarative baseline checks over the normalized bundle (§6.2 frozen table). */
export async function runBaselineChecks(options: {
  readonly artifacts: ArtifactProvider
  readonly bundle: InputBundleV1
  readonly plan: BaselineCheckPlan
  readonly boundaryTargets: readonly string[]
  readonly signal: AbortSignal
}): Promise<PreflightCheckItem[]> {
  const { artifacts, bundle, plan, boundaryTargets, signal } = options
  const items: PreflightCheckItem[] = []
  const componentRoles = new Set(bundle.components.map(item => item.role))
  items.push({
    checkId: 'bundle_structure',
    severity: 'incompatible',
    result: bundle.components.length > 0 && bundle.components.every(item => item.artifactVersionId !== '' ) ? 'pass' : 'fail',
    observed: { roles: [...componentRoles] },
  })
  if (plan.dimensionConsistency !== undefined) {
    const { bedRole, bimRole, famRole } = plan.dimensionConsistency
    const bed = await bundleBytesFor(artifacts, bundle, bedRole, signal)
    const bim = await bundleBytesFor(artifacts, bundle, bimRole, signal)
    const fam = await bundleBytesFor(artifacts, bundle, famRole, signal)
    let result: 'pass' | 'fail' = 'fail'
    let observed: JsonValue = { bedRole, bimRole, famRole }
    if (bed !== undefined && bim !== undefined && fam !== undefined) {
      const expected = 3 + lineCount(bim.text) * Math.ceil(Math.max(1, lineCount(fam.text)) / 4)
      result = bed.bytes.byteLength === expected ? 'pass' : 'fail'
      observed = { bedBytes: bed.bytes.byteLength, expected, bimRows: lineCount(bim.text), famRows: lineCount(fam.text) }
    }
    items.push({ checkId: 'dimension_consistency', severity: 'incompatible', result, observed })
  }
  if (plan.joinKeyUniqueness !== undefined) {
    const { role, keyColumn, required } = plan.joinKeyUniqueness
    const table = await bundleBytesFor(artifacts, bundle, role, signal)
    let result: 'pass' | 'fail' = 'fail'
    let observed: JsonValue = { role, duplicates: 0 }
    if (table !== undefined) {
      const keys = csvColumn(table.text, keyColumn, '\t').concat(csvColumn(table.text, keyColumn, ','))
      const unique = new Set(keys)
      const duplicates = keys.length - unique.size
      result = duplicates === 0 ? 'pass' : 'fail'
      observed = { role, duplicates }
    }
    items.push({ checkId: 'join_key_uniqueness', severity: required ? 'incompatible' : 'warning', result, observed })
  }
  if (plan.sampleIntersection !== undefined) {
    const { genotypeIdsRole, phenotypeRole, idColumn } = plan.sampleIntersection
    const genotypeIds = await bundleBytesFor(artifacts, bundle, genotypeIdsRole, signal)
    const phenotype = await bundleBytesFor(artifacts, bundle, phenotypeRole, signal)
    let result: 'pass' | 'fail' | 'clarify' = 'fail'
    let observed: JsonValue = { genotypeIdsRole, phenotypeRole }
    let severity: 'incompatible' | 'warning' = 'incompatible'
    if (genotypeIds !== undefined && phenotype !== undefined) {
      const ids = new Set(csvColumn(genotypeIds.text, 0, '\t').concat(csvColumn(genotypeIds.text, 0, ' ')))
      // The phenotype table carries a header row; sample ids start below it.
      const phenoRows = phenotype.text.split('\n').filter(line => line !== '').slice(1)
      const phenoIds = phenoRows.map(line => (line.split('\t')[idColumn] ?? line.split(',')[idColumn] ?? '').trim()).filter(value => value !== '')
      const intersection = phenoIds.filter(id => ids.has(id))
      const unique = new Set(intersection)
      if (unique.size === 0) {
        result = 'fail'
        observed = { intersection: 0 }
      } else if (intersection.length === phenoIds.length && unique.size === phenoIds.length) {
        result = 'pass'
        observed = { intersection: intersection.length }
      } else {
        result = 'pass'
        severity = 'warning'
        observed = { intersection: intersection.length, phenotypeRows: phenoIds.length, excluded: phenoIds.length - intersection.length }
      }
    }
    items.push({ checkId: 'sample_intersection', severity, result, observed })
  }
  if (plan.requiredColumns !== undefined) {
    const { role, columns, delimiter } = plan.requiredColumns
    const table = await bundleBytesFor(artifacts, bundle, role, signal)
    let result: 'pass' | 'fail' = 'fail'
    let observed: JsonValue = { role, columns: [...columns] }
    if (table !== undefined) {
      const header = (table.text.split('\n')[0] ?? '').split(delimiter).map(value => value.trim())
      const missing = columns.filter(column => !header.includes(column))
      result = missing.length === 0 ? 'pass' : 'fail'
      observed = { role, header, missing }
    }
    items.push({ checkId: 'required_columns', severity: 'incompatible', result, observed })
  }
  if (plan.inputOutputCollision === true) {
    const inputPaths = new Set(bundle.components.map(item => item.locator))
    const collisions = boundaryTargets.filter(target => inputPaths.has(target))
    items.push({
      checkId: 'input_output_collision',
      severity: 'incompatible',
      result: collisions.length === 0 ? 'pass' : 'fail',
      observed: { collisions },
    })
  }
  if (plan.assemblyOrAlleleDirection !== undefined && plan.assemblyOrAlleleDirection.requiresAssembly) {
    items.push({
      checkId: 'assembly_or_allele_direction',
      severity: 'needs_clarification',
      result: 'clarify',
      observed: { assemblyRole: plan.assemblyOrAlleleDirection.assemblyRole },
    })
  }
  return items
}

/** Fold check items into exactly one of the four states (§6.2). */
export function foldStatus(items: readonly PreflightCheckItem[]): PreflightStatus {
  if (items.some(item => item.result === 'fail' && item.severity === 'incompatible')) return 'incompatible'
  if (items.some(item => item.result === 'clarify' || (item.result === 'fail' && item.severity === 'needs_clarification'))) return 'needs_clarification'
  if (items.some(item => item.result === 'fail' && item.severity === 'warning')) return 'ready_with_warnings'
  if (items.some(item => item.severity === 'warning' && item.result === 'pass')) return 'ready_with_warnings'
  return 'ready'
}

/** Build and persist one immutable PreflightReport (§6.2; identical inputs recompute identically). */
export async function runPreflight(options: {
  readonly store: EvidenceStore
  readonly artifacts: ArtifactProvider
  readonly bundle: InputBundleV1
  readonly profileIdentity: { readonly contractId: string; readonly revision: string }
  readonly softwareVersion: string | null
  readonly coverage: 'operation_profile' | 'baseline_only'
  readonly coverageGaps: readonly string[]
  readonly plan: BaselineCheckPlan
  readonly softwareChecks: readonly PreflightCheckItem[]
  readonly boundaryTargets: readonly string[]
  readonly signal: AbortSignal
}): Promise<PreflightReportV1> {
  const { store, artifacts, bundle, signal } = options
  const { profileIdentity, softwareVersion, coverage, coverageGaps } = options
  const { plan, softwareChecks, boundaryTargets } = options
  const baseline = await runBaselineChecks({ artifacts, bundle, plan, boundaryTargets, signal })
  const checks = [...baseline, ...softwareChecks].sort((left, right) => left.checkId.localeCompare(right.checkId)
      || left.severity.localeCompare(right.severity))
  const status = foldStatus(checks)
  const warnings = checks
    .filter(item => item.result === 'fail' && item.severity === 'warning')
    .map(item => ({ code: `${item.checkId}_warning`, detail: JSON.stringify(item.observed) }))
  const clarifyItem = checks.find(item => item.result === 'clarify')
  const report: Omit<PreflightReportV1, 'reportDigest'> = {
    recordVersion: 'animalge.preflight-report/v1',
    reportId: newPreflightReportId(),
    profileIdentity,
    softwareVersion,
    inputBundleRef: bundle.bundleId,
    coverage,
    status,
    checks,
    coverageGaps: [...coverageGaps],
    warnings,
    clarification: clarifyItem === undefined ? null : { question: `clarify ${clarifyItem.checkId}`, candidates: clarifyItem.observed ?? null },
    computedAt: Date.now(),
  }
  const reportDigest = canonicalDigest({ ...report, reportId: report.reportId } as unknown as JsonValue)
  const persisted: PreflightReportV1 = { ...report, reportDigest: reportDigest }
  await store.putMaterialRecord(store.preflightReports, persisted.reportId, persisted)
  if (status === 'incompatible' || status === 'needs_clarification') {
    throw new PreflightBlockedError(status, persisted, `preflight ${status}: the professional process must not start`)
  }
  return persisted
}
