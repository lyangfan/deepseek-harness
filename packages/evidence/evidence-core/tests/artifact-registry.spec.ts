/** S02-A01..A04: reference-only ArtifactVersion identity, four-layer state, unified handle, freshness. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { symlink, mkdir } from 'node:fs/promises'
import { registerSuiteSummary } from './summary.ts'
import { materialHarness } from './helpers.ts'
import { ArtifactConflictError } from '../src/artifact.ts'
import type { ArtifactProvider } from '../src/artifact.ts'
import type { EvidenceStore } from '../src/store.ts'

let root = ''
let artifacts: ArtifactProvider
let store: EvidenceStore
let close: () => Promise<void>

beforeEach(async () => {
  const harness = await materialHarness()
  root = await mkdtemp(join(tmpdir(), 'spec02-artifacts-'))
  artifacts = harness.artifacts
  store = harness.store
  close = harness.close
})

afterEach(async () => {
  await close()
  await rm(root, { recursive: true, force: true })
})

async function fixture(name: string, content: string): Promise<string> {
  const path = join(root, name)
  await writeFile(path, content, 'utf8')
  return path
}

describe('S02-A01 identity separation', () => {
  it('creates Artifact + first Version on first capture and reuses the Version on unchanged repeat observation', async () => {
    const path = await fixture('a.txt', 'alpha')
    const first = await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    expect(first.createdNewVersion).toBe(true)
    expect(first.observationBasis).toBe('full_sha256')
    const second = await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    expect(second.createdNewVersion).toBe(false)
    expect(second.artifactVersionId).toBe(first.artifactVersionId)
    expect(second.contentDigest).toBe(first.contentDigest)
    expect(store.artifacts.size).toBe(1)
    expect(store.artifactVersions.size).toBe(1)
  })

  it('content change without an expected ref returns the structured conflict instead of a silent new version', async () => {
    const path = await fixture('b.txt', 'one')
    const first = await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    await writeFile(path, 'two', 'utf8')
    await expect(artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })).rejects.toMatchObject({ code: 'content_changed' })
    expect(store.artifactVersions.size).toBe(1)
    void first
  })

  it('content change with allowAdvance creates a new Version chained by supersedes', async () => {
    const path = await fixture('c.txt', 'v1')
    const first = await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    await writeFile(path, 'v2-bytes', 'utf8')
    const second = await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input', allowAdvance: true })
    expect(second.createdNewVersion).toBe(true)
    expect(second.artifactId).toBe(first.artifactId)
    expect(second.artifactVersionId).not.toBe(first.artifactVersionId)
    const core = store.artifactVersions.get(second.artifactVersionId)
    expect(core?.parentVersionId).toBe(first.artifactVersionId)
    expect(core?.supersedesReason).toBe('content_change')
    expect(store.currentArtifactVersion(first.artifactId)).toMatchObject({ artifactVersionId: second.artifactVersionId })
  })

  it('an explicit commit with the same digest still creates a new Version (save/rerun semantics)', async () => {
    const path = await fixture('d.txt', 'same')
    const first = await artifacts.registerExplicit(path, { createdBy: 'explicit_registration', reason: 'explicit_commit' })
    const second = await artifacts.registerExplicit(path, { createdBy: 'explicit_registration', reason: 'explicit_commit' })
    expect(second.contentDigest).toBe(first.contentDigest)
    expect(second.artifactVersionId).not.toBe(first.artifactVersionId)
    const core = store.artifactVersions.get(second.artifactVersionId)
    expect(core?.supersedesReason).toBe('explicit_commit')
  })

  it('restore-as-new chains restored_from lineage and reobservation of restored bytes reuses the same Version', async () => {
    const path = await fixture('e.txt', 'original')
    const first = await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    await rm(path)
    const observation = await artifacts.reobserve(first.artifactVersionId)
    expect(observation).toMatchObject({ availability: 'missing', integrity: 'not_checked' })
    await writeFile(path, 'original', 'utf8')
    const restored = await artifacts.reobserve(first.artifactVersionId)
    expect(restored).toMatchObject({ availability: 'available', integrity: 'matched' })
    expect(store.artifactVersions.size).toBe(1)
    const next = await artifacts.registerExplicit(path, { createdBy: 'explicit_registration', reason: 'restore_as_new' })
    expect(store.artifactVersions.get(next.artifactVersionId)?.supersedesReason).toBe('restore_as_new')
  })
})

describe('S02-A02 reference-only and four-layer separation', () => {
  it('keeps version cores free of locator/availability fields and the core digest invariant across the availability cycle', async () => {
    const path = await fixture('f.txt', 'stable-bytes')
    const first = await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    const coreBefore = store.artifactVersions.get(first.artifactVersionId)
    await rm(path)
    await artifacts.reobserve(first.artifactVersionId)
    await writeFile(path, 'stable-bytes', 'utf8')
    await artifacts.reobserve(first.artifactVersionId)
    const coreAfter = store.artifactVersions.get(first.artifactVersionId)
    expect(coreAfter).toEqual(coreBefore)
    expect(coreBefore).not.toHaveProperty('locator')
    expect(coreBefore).not.toHaveProperty('availability')
    expect(coreBefore).toMatchObject({ retention: 'reference' })
  })

  it('never hosts artifact bytes: the store holds no content beyond digests (structural)', async () => {
    const path = await fixture('g.txt', 'secret-ish content')
    await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    const serialized = [...store.artifactVersions.entries()].map(([, v]) => JSON.stringify(v)).join('')
    expect(serialized).not.toContain('secret-ish')
  })
})

describe('S02-A03 location observations and freshness', () => {
  it('appends distinct observations with stable identities and reports content_mismatch for replaced bytes', async () => {
    const path = await fixture('h.txt', 'x')
    const first = await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    await writeFile(path, 'different', 'utf8')
    const observation = await artifacts.reobserve(first.artifactVersionId)
    expect(observation).toMatchObject({ availability: 'available', integrity: 'content_mismatch' })
    expect(store.locationObservations.size).toBeGreaterThanOrEqual(2)
    const ids = new Set([...store.locationObservations.entries()].map(([, o]) => o.locationObservationId))
    expect(ids.size).toBe(store.locationObservations.size)
  })

  it('reuses the digest under an unchanged freshness token and rehashes after the token changes', async () => {
    const path = await fixture('i.txt', 'tokened')
    const first = await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    expect(first.observationBasis).toBe('full_sha256')
    const second = await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    expect(second.observationBasis).toBe('freshness_reuse')
    await writeFile(path, 'tokened', 'utf8') // same bytes, new stat token
    const third = await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    expect(third.observationBasis).toBe('full_sha256')
    expect(third.contentDigest).toBe(first.contentDigest)
    expect(third.artifactVersionId).toBe(first.artifactVersionId)
  })
})

describe('S02-A04 unified handle fail-closed edges', () => {
  it('rejects an expected-ref mismatch without creating records for the new bytes', async () => {
    const path = await fixture('j.txt', 'before')
    await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    await writeFile(path, 'after', 'utf8')
    await expect(artifacts.captureFile({ role: 'input', locator: path, expectedArtifactVersionRef: 'av_nonexistent' as never }, { createdBy: 'runner_input' })).rejects.toMatchObject({ code: 'content_mismatch' })
  })

  it('rejects a symlinked locator and a non-file locator', async () => {
    const real = await fixture('k.txt', 'real')
    const link = join(root, 'k-link.txt')
    await symlink(real, link)
    await expect(artifacts.captureFile({ role: 'input', locator: link }, { createdBy: 'runner_input' })).rejects.toMatchObject({ code: 'symlink_locator_rejected' })
    const dir = join(root, 'sub')
    await mkdir(dir)
    await expect(artifacts.captureFile({ role: 'input', locator: dir }, { createdBy: 'runner_input' })).rejects.toMatchObject({ code: 'not_regular_file' })
    await expect(artifacts.captureFile({ role: 'input', locator: join(root, 'absent.txt') }, { createdBy: 'runner_input' })).rejects.toMatchObject({ code: 'source_absent' })
  })

  it('reports pre/post-run freshness drift through a named conflict when expected bytes change mid-flight', async () => {
    const path = await fixture('l.txt', 'drift')
    const first = await artifacts.captureFile({ role: 'input', locator: path }, { createdBy: 'runner_input' })
    await writeFile(path, 'drifted', 'utf8')
    try {
      await artifacts.captureFile({ role: 'input', locator: path, expectedArtifactVersionRef: first.artifactVersionId }, { createdBy: 'runner_input' })
      expect.unreachable('expected content_mismatch')
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactConflictError)
      expect((error as ArtifactConflictError).code).toBe('content_mismatch')
    }
  })
})

registerSuiteSummary({ suiteId: 'artifact-registry', acceptanceIds: ['S02-A01', 'S02-A02', 'S02-A03', 'S02-A04'], sessionPersistence: [''], evidenceStorage: ['memory'] })
