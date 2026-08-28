/** S03-A06: environment contract — real-probe freezing and per-call drift gates. */

import { chmod, copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { registerSuiteSummary } from './summary.ts'
import { freezeFakeEnvironment, materialHarness } from './helpers.ts'
import { currentEnvironmentRevision, EnvironmentGateError, freezeTestedEnvironmentRevision, verifyEnvironmentGate } from '../src/professional/environment.ts'

registerSuiteSummary({ suiteId: 'professional-environment', acceptanceIds: ['S03-A06'], sessionPersistence: [''], evidenceStorage: [''] })

describe('S03-A06 environment contract', () => {
  it('freezes a revision from real probes and reprobes hit the same identity', async () => {
    const harness = await materialHarness()
    try {
      expect(currentEnvironmentRevision(harness.store)).toBeUndefined()
      await freezeFakeEnvironment(harness)
      const revision = currentEnvironmentRevision(harness.store)
      expect(revision).toBeDefined()
      expect(revision?.components.map(component => component.name)).toEqual(['plink', 'himvp', 'rscript', 'cmplot-rpkg'])
      expect(revision?.components[0]?.identity.version).toBe('PLINK v1.90fake')
      const again = await verifyEnvironmentGate({
        ctx: harness.ctx, store: harness.store, componentNames: ['plink'], inputBundleSchemaRevision: 'plink-bed-set@v1',
        parseVersion: (_c, output) => /PLINK v\S+/u.exec(output)?.[0] ?? null,
        signal: new AbortController().signal,
      })
      expect(again.probes[0]?.executableDigest).toBe(revision?.components[0]?.identity.digest)
    } finally {
      await harness.close()
    }
  })

  it('stops with environment_revision_mismatch when the executable bytes drift', async () => {
    const harness = await materialHarness()
    try {
      // Freeze against a private copy: the repo fixture must never be mutated in place
      // (the dual vitest projects rerun this file against the same working tree).
      const copy = join(harness.root, 'fake-plink-copy')
      await copyFile(join(import.meta.dirname, 'fixtures/professional/fake-plink'), copy)
      await chmod(copy, 0o755)
      await freezeTestedEnvironmentRevision({
        ctx: harness.ctx, store: harness.store,
        input: {
          environmentSpecRevision: 'copy-env/v1',
          components: [{ name: 'plink', kind: 'executable', resolvedPath: copy, sourceRef: null }],
          parseVersion: (_c, output) => /PLINK v\S+/u.exec(output)?.[0] ?? null,
          inputSchemaRevisions: ['plink-bed-set@v1'],
          signal: new AbortController().signal,
        },
      })
      const revision = currentEnvironmentRevision(harness.store)
      expect(revision?.components[0]?.identity.version).toBe('PLINK v1.90fake')
      await writeFile(copy, '#!/bin/bash\necho "PLINK v1.91tampered"\n', 'utf8')
      await chmod(copy, 0o755)
      await expect(verifyEnvironmentGate({
        ctx: harness.ctx, store: harness.store, componentNames: ['plink'], inputBundleSchemaRevision: 'plink-bed-set@v1',
        parseVersion: (_c, output) => /PLINK v\S+/u.exec(output)?.[0] ?? null,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'environment_revision_mismatch' })
    } finally {
      await harness.close()
    }
  })

  it('stops with environment_not_ready before any revision is frozen or when probing fails', async () => {
    const harness = await materialHarness()
    try {
      await expect(verifyEnvironmentGate({
        ctx: harness.ctx, store: harness.store, componentNames: ['plink'], inputBundleSchemaRevision: 'plink-bed-set@v1',
        signal: new AbortController().signal,
      })).rejects.toBeInstanceOf(EnvironmentGateError)
      await expect(freezeTestedEnvironmentRevision({
        ctx: harness.ctx, store: harness.store,
        input: {
          environmentSpecRevision: 'missing/v1',
          components: [{ name: 'plink', kind: 'executable', resolvedPath: join(harness.root, 'no-such-file'), sourceRef: null }],
          inputSchemaRevisions: [],
          signal: new AbortController().signal,
        },
      })).rejects.toMatchObject({ code: 'environment_not_ready' })
    } finally {
      await harness.close()
    }
  })

  it('rejects an input schema the frozen revision does not accept (unsupported_input_revision)', async () => {
    const harness = await materialHarness()
    try {
      await freezeFakeEnvironment(harness)
      await expect(verifyEnvironmentGate({
        ctx: harness.ctx, store: harness.store, componentNames: ['plink'], inputBundleSchemaRevision: 'plink-bed-set@v999',
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'unsupported_input_revision' })
    } finally {
      await harness.close()
    }
  })
})
