/** S03-A02..A05: input bundle, four-state preflight, coverage levels, ResolvedParameterSet. */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerSuiteSummary } from './summary.ts'
import { materialHarness, writeFakePlinkTrio } from './helpers.ts'
import { normalizeInputBundle } from '../src/professional/bundles.ts'
import { foldStatus, runBaselineChecks, PreflightBlockedError, runPreflight } from '../src/professional/preflight.ts'
import { persistResolvedParameterSet } from '../src/professional/parameters.ts'
import { ContextEntityOwner } from '../src/context-entity.ts'

registerSuiteSummary({ suiteId: 'professional-preflight', acceptanceIds: ['S03-A02', 'S03-A03', 'S03-A04', 'S03-A05'], sessionPersistence: [''], evidenceStorage: [''] })

const SIGNAL = new AbortController().signal

describe('S03-A02 input bundle', () => {
  it('normalizes the unified handle into an immutable value object whose digest never rereads bytes', async () => {
    const harness = await materialHarness()
    try {
      const trio = await writeFakePlinkTrio(harness.root, 'in', 4, 6)
      const bundle = await normalizeInputBundle({
        store: harness.store, artifacts: harness.artifacts, bundleKind: 'plink-bed-set', schemaRevision: 'v1',
        handles: [{ role: 'bed', locator: trio.bed }, { role: 'bim', locator: trio.bim }, { role: 'fam', locator: trio.fam }],
        requiredRoles: ['bed', 'bim', 'fam'], signal: SIGNAL,
      })
      expect(bundle.components).toHaveLength(3)
      expect(bundle.bundleDigest).toMatch(/^sha256:/)
      expect(harness.store.inputBundles.get(bundle.bundleId)).toBeDefined()
    } finally {
      await harness.close()
    }
  })

  it('fails closed on expected-ref mismatch and missing required components', async () => {
    const harness = await materialHarness()
    try {
      const trio = await writeFakePlinkTrio(harness.root, 'in', 4, 6)
      await expect(normalizeInputBundle({
        store: harness.store, artifacts: harness.artifacts, bundleKind: 'plink-bed-set', schemaRevision: 'v1',
        handles: [{ role: 'bed', locator: trio.bed, expectedArtifactVersionRef: 'av_notthere' }],
        requiredRoles: ['bed'], signal: SIGNAL,
      })).rejects.toMatchObject({ code: 'content_mismatch' })
      await expect(normalizeInputBundle({
        store: harness.store, artifacts: harness.artifacts, bundleKind: 'plink-bed-set', schemaRevision: 'v1',
        handles: [{ role: 'bed', locator: trio.bed }],
        requiredRoles: ['bed', 'bim', 'fam'], signal: SIGNAL,
      })).rejects.toMatchObject({ code: 'bundle_component_missing' })
    } finally {
      await harness.close()
    }
  })
})

describe('S03-A03 four preflight states', () => {
  it('dimension_consistency fails closed on a corrupted bed length', async () => {
    const harness = await materialHarness()
    try {
      const trio = await writeFakePlinkTrio(harness.root, 'bad', 4, 6, true)
      const bundle = await normalizeInputBundle({
        store: harness.store, artifacts: harness.artifacts, bundleKind: 'plink-bed-set', schemaRevision: 'v1',
        handles: [{ role: 'bed', locator: trio.bed }, { role: 'bim', locator: trio.bim }, { role: 'fam', locator: trio.fam }],
        requiredRoles: ['bed', 'bim', 'fam'], signal: SIGNAL,
      })
      const items = await runBaselineChecks({
        artifacts: harness.artifacts, bundle, signal: SIGNAL, boundaryTargets: [],
        plan: { dimensionConsistency: { bedRole: 'bed', bimRole: 'bim', famRole: 'fam' } },
      })
      expect(foldStatus(items)).toBe('incompatible')
    } finally {
      await harness.close()
    }
  })

  it('sample_intersection yields ready, warning with counts, or incompatible on zero overlap', async () => {
    const harness = await materialHarness()
    try {
      const trio = await writeFakePlinkTrio(harness.root, 'in', 2, 4)
      await writeFile(join(harness.root, 'full.tsv'), 'IID\ttrait\nid1\t1\nid2\t2\nid3\t3\nid4\t4\n', 'utf8')
      await writeFile(join(harness.root, 'partial.tsv'), 'IID\ttrait\nid1\t1\nzzz\t2\n', 'utf8')
      await writeFile(join(harness.root, 'none.tsv'), 'IID\ttrait\nxxx\t1\nyyy\t2\n', 'utf8')
      for (const [file, expected] of [['full.tsv', 'ready'], ['partial.tsv', 'ready_with_warnings'], ['none.tsv', 'incompatible']] as const) {
        const bundle = await normalizeInputBundle({
          store: harness.store, artifacts: harness.artifacts, bundleKind: 'gwas-input', schemaRevision: 'v1',
          handles: [{ role: 'fam', locator: trio.fam }, { role: 'phenotype', locator: join(harness.root, file) }],
          requiredRoles: ['fam', 'phenotype'], signal: SIGNAL,
        })
        const items = await runBaselineChecks({
          artifacts: harness.artifacts, bundle, signal: SIGNAL, boundaryTargets: [],
          plan: { sampleIntersection: { genotypeIdsRole: 'fam', phenotypeRole: 'phenotype', idColumn: 0 } },
        })
        expect(foldStatus(items)).toBe(expected)
        if (expected === 'ready_with_warnings') {
          const observed = items.find(item => item.checkId === 'sample_intersection')?.observed as { intersection: number; excluded: number }
          expect(observed.intersection).toBe(1)
          expect(observed.excluded).toBe(1)
        }
      }
    } finally {
      await harness.close()
    }
  })

  it('needs_clarification blocks the process with a structured report and no force flag exists', async () => {
    const harness = await materialHarness()
    try {
      const trio = await writeFakePlinkTrio(harness.root, 'in', 2, 4)
      const bundle = await normalizeInputBundle({
        store: harness.store, artifacts: harness.artifacts, bundleKind: 'plink-bed-set', schemaRevision: 'v1',
        handles: [{ role: 'bed', locator: trio.bed }, { role: 'bim', locator: trio.bim }, { role: 'fam', locator: trio.fam }],
        requiredRoles: ['bed', 'bim', 'fam'], signal: SIGNAL,
      })
      await expect(runPreflight({
        store: harness.store, artifacts: harness.artifacts, bundle,
        profileIdentity: { contractId: 'c', revision: 'r' }, softwareVersion: null,
        coverage: 'operation_profile', coverageGaps: [],
        plan: { assemblyOrAlleleDirection: { requiresAssembly: true, assemblyRole: null } },
        softwareChecks: [], boundaryTargets: [], signal: SIGNAL,
      })).rejects.toBeInstanceOf(PreflightBlockedError)
      const reports = [...harness.store.preflightReports.entries()]
      expect(reports).toHaveLength(1)
      expect(reports[0]?.[1].status).toBe('needs_clarification')
      expect(reports[0]?.[1].clarification).not.toBeNull()
    } finally {
      await harness.close()
    }
  })

  it('recomputes identical status for identical inputs (deterministic)', async () => {
    const harness = await materialHarness()
    try {
      const trio = await writeFakePlinkTrio(harness.root, 'in', 4, 6)
      const bundle = await normalizeInputBundle({
        store: harness.store, artifacts: harness.artifacts, bundleKind: 'plink-bed-set', schemaRevision: 'v1',
        handles: [{ role: 'bed', locator: trio.bed }, { role: 'bim', locator: trio.bim }, { role: 'fam', locator: trio.fam }],
        requiredRoles: ['bed', 'bim', 'fam'], signal: SIGNAL,
      })
      const first = await runBaselineChecks({
        artifacts: harness.artifacts, bundle, signal: SIGNAL, boundaryTargets: [],
        plan: { dimensionConsistency: { bedRole: 'bed', bimRole: 'bim', famRole: 'fam' } },
      })
      const second = await runBaselineChecks({
        artifacts: harness.artifacts, bundle, signal: SIGNAL, boundaryTargets: [],
        plan: { dimensionConsistency: { bedRole: 'bed', bimRole: 'bim', famRole: 'fam' } },
      })
      expect(first).toEqual(second)
    } finally {
      await harness.close()
    }
  })
})

describe('S03-A04/A05 coverage and parameters', () => {
  it('coverage gaps are named when no operation profile applies', async () => {
    const harness = await materialHarness()
    try {
      const trio = await writeFakePlinkTrio(harness.root, 'in', 2, 4)
      const bundle = await normalizeInputBundle({
        store: harness.store, artifacts: harness.artifacts, bundleKind: 'plink-bed-set', schemaRevision: 'v1',
        handles: [{ role: 'bed', locator: trio.bed }], requiredRoles: ['bed'], signal: SIGNAL,
      })
      const report = await runPreflight({
        store: harness.store, artifacts: harness.artifacts, bundle,
        profileIdentity: { contractId: 'baseline', revision: 'r' }, softwareVersion: null,
        coverage: 'baseline_only', coverageGaps: ['no_operation_profile:plink_cli'],
        plan: {}, softwareChecks: [], boundaryTargets: [], signal: SIGNAL,
      })
      expect(report.coverage).toBe('baseline_only')
      expect(report.coverageGaps).toEqual(['no_operation_profile:plink_cli'])
    } finally {
      await harness.close()
    }
  })

  it('persists the five-source ResolvedParameterSet with materialized software defaults and secret placeholders', async () => {
    const harness = await materialHarness()
    try {
      const entities = new ContextEntityOwner(harness.store)
      const record = await persistResolvedParameterSet({
        entities, toolName: 'plink_cli',
        parameters: [
          { name: 'maf', value: 0.05, source: 'user_supplied', reason: 'user argument' },
          { name: 'allow-extra-chr', value: 'x', source: 'software_default_materialized', reason: 'materialized' },
          { name: 'threads', value: '2', source: 'deterministic_derived', reason: 'derived' },
          { name: 'token', value: 'supersecret', source: 'agent_selected', reason: 'agent' },
        ],
        secretNames: new Set(['token']),
      })
      const payload = record.payload as { name: string; value: string | number; source: string }[]
      expect(payload.map(item => item.source)).toEqual(expect.arrayContaining(['user_supplied', 'software_default_materialized', 'deterministic_derived', 'agent_selected']))
      expect(payload.find(item => item.name === 'token')?.value).toMatch(/^secret:[0-9a-f]{16}$/u)
    } finally {
      await harness.close()
    }
  })
})
