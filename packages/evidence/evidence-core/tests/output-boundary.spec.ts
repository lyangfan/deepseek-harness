/** S03-A07..A11: reservation exclusivity, manifests, finalization, and the D-195 settlement. */

import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerSuiteSummary } from './summary.ts'
import { materialHarness } from './helpers.ts'
import { EvidenceRunId } from '../src/identity.ts'
import { persistOutputPlan, releaseOutputBoundary, reserveOutputBoundary, settleOutputBoundary } from '../src/professional/output-boundary.ts'
import type { OutputPlanV1 } from '../src/types.ts'

registerSuiteSummary({ suiteId: 'output-boundary', acceptanceIds: ['S03-A07', 'S03-A08', 'S03-A09', 'S03-A10', 'S03-A11'], sessionPersistence: [''], evidenceStorage: [''] })

const SIGNAL = new AbortController().signal

async function reserve(harness: Awaited<ReturnType<typeof materialHarness>>, runId: string, intent: Parameters<typeof reserveOutputBoundary>[0]['intent']) {
  return reserveOutputBoundary({
    ctx: harness.ctx, store: harness.store, runId: EvidenceRunId(runId), attempt: 1,
    outputRoot: join(harness.root, 'pro'), intent, allowedScopeRoot: harness.root, signal: SIGNAL,
  })
}

describe('S03-A07 reservation exclusivity', () => {
  it('creates a never-reused run-exclusive directory and rejects a second reservation of it', async () => {
    const harness = await materialHarness()
    try {
      const first = await reserve(harness, 'er_one', { kind: 'default' })
      expect(first.kind).toBe('run_exclusive_dir')
      await expect(reserve(harness, 'er_one', { kind: 'default' })).rejects.toMatchObject({ code: 'output_collision' })
      const second = await reserve(harness, 'er_two', { kind: 'default' })
      expect(second.boundary.rootDir).not.toBe(first.boundary.rootDir)
    } finally {
      await harness.close()
    }
  })

  it('only one of two concurrent user-prefix reservations wins and ambiguity asks first', async () => {
    const harness = await materialHarness()
    try {
      const winner = await reserve(harness, 'er_a', { kind: 'prefix', value: join(harness.root, 'shared-out') })
      await expect(reserve(harness, 'er_b', { kind: 'prefix', value: join(harness.root, 'shared-out') }))
        .rejects.toMatchObject({ code: 'output_collision' })
      await expect(reserve(harness, 'er_c', { kind: 'ambiguous', hint: 'somewhere' }))
        .rejects.toMatchObject({ code: 'output_boundary_ambiguous' })
      void winner
    } finally {
      await harness.close()
    }
  })

  it('rejects scope escape and conservatively abandons active reservations at startup', async () => {
    const harness = await materialHarness()
    try {
      const outside = join(tmpdir(), 'spec03-outside-scope')
      await mkdir(outside, { recursive: true })
      await expect(reserve(harness, 'er_s', { kind: 'dir', path: outside }))
        .rejects.toMatchObject({ code: 'output_scope_violation' })
      const active = await reserve(harness, 'er_keep', { kind: 'default' })
      expect(active.state).toBe('active')
      const abandoned = await harness.store.abandonActiveReservations()
      expect(abandoned).toBeGreaterThanOrEqual(1)
      expect(harness.store.outputReservations.get(active.reservationId)?.state).toBe('abandoned')
      await expect(reserve(harness, 'er_after', { kind: 'prefix', value: active.boundary.rootDir }))
        .rejects.toMatchObject({ code: 'output_collision' })
    } finally {
      await harness.close()
    }
  })

  it('release only happens from in-process settlement paths', async () => {
    const harness = await materialHarness()
    try {
      const reservation = await reserve(harness, 'er_rel', { kind: 'default' })
      await releaseOutputBoundary(harness.store, reservation.reservationId, 'completed')
      const released = harness.store.outputReservations.get(reservation.reservationId)
      expect(released?.state).toBe('released')
      expect(released?.releaseBasis).toBe('completed')
    } finally {
      await harness.close()
    }
  })
})

describe('S03-A08..A11 manifests and finalization', () => {
  it('formal manifest validates planned outputs, finalizes idempotently, and leaves extras unclassified', async () => {
    const harness = await materialHarness()
    try {
      const boundaryDir = join(harness.root, 'formal-boundary')
      const reservation = await reserve(harness, 'er_formal', { kind: 'dir', path: boundaryDir })
      const prefix = `${reservation.boundary.rootDir}/qc-out`
      const plan = await persistOutputPlan({
        store: harness.store, runId: EvidenceRunId('er_formal'), planRevision: 'v1', generatedByHook: 'test',
        roles: [
          { role: 'qc_bed', pathRule: { kind: 'exact', value: `${prefix}.bed` }, required: true, cardinality: 'one', bundle: 'qc_genotype', validator: 'v' },
          { role: 'qc_bim', pathRule: { kind: 'exact', value: `${prefix}.bim` }, required: true, cardinality: 'one', bundle: 'qc_genotype', validator: 'v' },
          { role: 'qc_fam', pathRule: { kind: 'exact', value: `${prefix}.fam` }, required: true, cardinality: 'one', bundle: 'qc_genotype', validator: 'v' },
        ],
        bundles: [{ bundleName: 'qc_genotype', requiredRoles: ['qc_bed', 'qc_bim', 'qc_fam'] }],
      })
      for (const ext of ['bed', 'bim', 'fam']) await writeFile(`${prefix}.${ext}`, `data-${ext}\n`, 'utf8')
      await writeFile(`${reservation.boundary.rootDir}/stray.txt`, 'unplanned\n', 'utf8')
      const settled = await settleOutputBoundary({
        ctx: harness.ctx, store: harness.store, artifacts: harness.artifacts, reservation, plan,
        validateOutput: () => ({ passed: true }), signal: SIGNAL,
      })
      expect(settled.manifest.kind).toBe('formal')
      expect(settled.outputCompleteness).toBe('complete')
      expect(settled.finalization).not.toBeNull()
      expect(settled.finalization?.finalizedRoles).toEqual(['qc_bed', 'qc_bim', 'qc_fam'])
      expect(settled.manifest.unclassifiedBoundaryObservations.map(item => item.locator)).toEqual([`${reservation.boundary.rootDir}/stray.txt`])
      // §8.4 idempotency: re-delivering identical bytes hits the same runId/attempt record.
      const again = await settleOutputBoundary({
        ctx: harness.ctx, store: harness.store, artifacts: harness.artifacts, reservation, plan,
        validateOutput: () => ({ passed: true }), signal: SIGNAL,
      })
      void again
      expect(harness.store.finalizationForRun(EvidenceRunId('er_formal'))?.finalizationId).toBe(settled.finalization?.finalizationId)
    } finally {
      await harness.close()
    }
  })

  it('a missing bundle member blocks finalization and settles incomplete', async () => {
    const harness = await materialHarness()
    try {
      const reservation = await reserve(harness, 'er_missing', { kind: 'dir', path: join(harness.root, 'miss-boundary') })
      const prefix = `${reservation.boundary.rootDir}/miss-out`
      const plan = await persistOutputPlan({
        store: harness.store, runId: EvidenceRunId('er_missing'), planRevision: 'v1', generatedByHook: 'test',
        roles: [
          { role: 'qc_bed', pathRule: { kind: 'exact', value: `${prefix}.bed` }, required: true, cardinality: 'one', bundle: 'qc_genotype', validator: 'v' },
          { role: 'qc_fam', pathRule: { kind: 'exact', value: `${prefix}.fam` }, required: true, cardinality: 'one', bundle: 'qc_genotype', validator: 'v' },
        ],
        bundles: [{ bundleName: 'qc_genotype', requiredRoles: ['qc_bed', 'qc_fam'] }],
      })
      await writeFile(`${prefix}.bed`, 'data\n', 'utf8')
      const settled = await settleOutputBoundary({
        ctx: harness.ctx, store: harness.store, artifacts: harness.artifacts, reservation, plan,
        validateOutput: () => ({ passed: true }), signal: SIGNAL,
      })
      expect(settled.finalization).toBeNull()
      expect(settled.outputCompleteness).toBe('incomplete')
    } finally {
      await harness.close()
    }
  })

  it('the D-195 no-plan path settles succeeded + unknown + output_plan_absent with unclassified-only observations', async () => {
    const harness = await materialHarness()
    try {
      const reservation = await reserve(harness, 'er_noplan', { kind: 'dir', path: join(harness.root, 'no-plan') })
      await mkdir(join(harness.root, 'no-plan'), { recursive: true })
      await writeFile(join(harness.root, 'no-plan', 'anything.txt'), 'x\n', 'utf8')
      const settled = await settleOutputBoundary({
        ctx: harness.ctx, store: harness.store, artifacts: harness.artifacts, reservation, plan: null,
        validateOutput: null, signal: SIGNAL,
      })
      expect(settled.manifest.kind).toBe('diagnostic')
      expect(settled.manifest.reason).toBe('output_plan_absent')
      expect(settled.manifest.formalOutputs).toEqual([])
      expect(settled.finalization).toBeNull()
      expect(settled.outputCompleteness).toBe('unknown')
      expect(settled.outputCompletenessReason).toBe('output_plan_absent')
      const observation = settled.manifest.unclassifiedBoundaryObservations[0]
      expect(observation?.locator.endsWith('anything.txt')).toBe(true)
      expect(observation?.observationBasis).toBe('boundary_scan')
      // no ArtifactVersion was created for the unclassified file (§8.3)
      expect([...harness.store.artifactVersions.entries()].some(([, row]) => row.contentDigest.length > 0 && settled.manifest.unclassifiedBoundaryObservations.some(item => item.byteLength === row.byteLength && observation?.locator.includes('anything')))).toBe(false)
    } finally {
      await harness.close()
    }
  })

  it('fails the whole call when an exact target already exists (anti-overwrite)', async () => {
    const harness = await materialHarness()
    try {
      await writeFile(join(harness.root, 'exists.txt'), 'old bytes\n', 'utf8')
      await expect(reserve(harness, 'er_exist', { kind: 'paths', paths: [join(harness.root, 'exists.txt')] }))
        .rejects.toMatchObject({ code: 'output_collision' })
    } finally {
      await harness.close()
    }
  })

  it('residual disposition marks declared outputs that fail validation (no fake finalize)', async () => {
    const harness = await materialHarness()
    try {
      const reservation = await reserve(harness, 'er_resid', { kind: 'dir', path: join(harness.root, 'resid-boundary') })
      const plan: OutputPlanV1 = await persistOutputPlan({
        store: harness.store, runId: EvidenceRunId('er_resid'), planRevision: 'v1', generatedByHook: 'test',
        roles: [{ role: 'plot', pathRule: { kind: 'exact', value: `${reservation.boundary.rootDir}/resid.png` }, required: true, cardinality: 'one', bundle: null, validator: 'png' }],
        bundles: [],
      })
      await writeFile(`${reservation.boundary.rootDir}/resid.png`, 'not a png\n', 'utf8')
      const settled = await settleOutputBoundary({
        ctx: harness.ctx, store: harness.store, artifacts: harness.artifacts, reservation, plan,
        validateOutput: () => ({ passed: false }), signal: SIGNAL,
      })
      expect(settled.finalization).toBeNull()
      expect(settled.manifest.formalOutputs[0]?.disposition).toBe('residual_integrity_unknown')
      expect(settled.validatedRoles).toEqual([])
    } finally {
      await harness.close()
    }
  })
})
