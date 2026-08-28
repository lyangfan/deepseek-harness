import { Context } from '@deepseek-ai/cordis'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { foldCaptures, resolveSelection } from '../src/capture.ts'
import { compileSnapshot } from '../src/compiler.ts'
import { EvidenceGraphId } from '../src/identity.ts'
import { EvidenceStore } from '../src/store.ts'

export const header: SessionHeader = {
  version: 0,
  id: SessionId('spec-01-session'),
  createdAt: 1_700_000_000_000,
  agentPreset: 'animalge-open-test',
}

export const graphId = EvidenceGraphId('eg_spec01fixture')

export function topLevelEvents(toolName = 'bash'): SessionEvent[] {
  const callId = CallId('call-spec-01')
  return [
    { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 101, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 2, time: 102, data: { turn: 1, step: 1, callId, name: toolName, arguments: '{"cmd":"pwd"}' } },
    {
      type: 'tool/result', seq: 3, time: 103, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: '/tmp' }], isError: false }) },
    },
    { type: 'step/end', seq: 4, time: 104, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 105, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[]
}

export function compiledFixture(selectionRevision = 'selection/v1', scopeOverride?: { readonly kind: 'session'; readonly graphId: typeof graphId; readonly sessionId: typeof header.id; readonly sessionCreatedAt: number }) {
  const selection = resolveSelection(selectionRevision, ['bash'])
  const scope = scopeOverride ?? { kind: 'session' as const, graphId, sessionId: header.id, sessionCreatedAt: header.createdAt }
  const folded = foldCaptures(scope, header, topLevelEvents(), selection)
  const payload = compileSnapshot({
    scope,
    captures: folded.captures,
    baseSnapshotDigest: null,
    targetNextSeqExclusive: 6,
    sourceTimeUpperBound: 105,
    selectionRevision: selection.revision,
    selectionRuleDigest: selection.digest,
  })
  return { folded, payload, scope, selection }
}

export async function storeHarness(pool = new MemoryMediaPool()) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const store = await EvidenceStore.open(ctx)
  return {
    ctx,
    pool,
    store,
    close: async () => {
      await store.close()
      await ctx.fiber.dispose()
    },
  }
}

// --- SPEC-02 material harness ---

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { ArtifactProvider } from '../src/artifact.ts'
import { SourceAnchorOwner } from '../src/anchor.ts'
import { AcceptanceLane } from '../src/acceptance.ts'
import { ContextEntityOwner } from '../src/context-entity.ts'
import { RUNNER_PROVIDER_ID } from '../src/receipt.ts'
import { REGISTERED_CAPTURE_PROFILE_IDS } from '../src/runner/profiles.ts'

/** Real-fs + real-persistence harness for the SPEC-02 material owner suites. */
export async function materialHarness() {
  const root = await mkdtemp(join(tmpdir(), 'spec02-material-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool0()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none', writeBatchMaxDelayMs: 1 })
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(LocalSubprocessRuntime)
  const store = await EvidenceStore.open(ctx)
  const artifacts = new ArtifactProvider(ctx, store)
  const anchors = new SourceAnchorOwner(store, artifacts)
  const entities = new ContextEntityOwner(store)
  // SPEC-03 §11.4-1: the lane registry includes the professional producer versioned-incrementally.
  const lane = new AcceptanceLane(ctx, store, {
    providers: new Set([RUNNER_PROVIDER_ID, SCIENTIFIC_TOOL_PROVIDER_ID]),
    profiles: new Set([...REGISTERED_CAPTURE_PROFILE_IDS, ...PROFESSIONAL_CAPTURE_PROFILE_IDS]),
  })
  return {
    ctx, store, artifacts, anchors, entities, lane, root,
    createSession: async (id: string) => {
      const session = ctx.sessions.create(SessionId(id), { meta: { agentPreset: 'animalge-open-test' } })
      await store.bootstrap(session.header)
      return session
    },
    close: async () => {
      await store.close()
      await ctx.fiber.dispose()
    },
  }
}

function pool0() {
  return new MemoryMediaPool()
}

// --- SPEC-03 professional harness ---

import { writeFile, chmod } from 'node:fs/promises'
import { SCIENTIFIC_TOOL_PROVIDER_ID } from '../src/professional/runtime.ts'
import { PROFESSIONAL_CAPTURE_PROFILE_IDS } from '../src/professional/index.ts'
import { freezeTestedEnvironmentRevision } from '../src/professional/environment.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures/professional')

/** Install the fake software environment (real subprocesses) and freeze its revision. */
type MaterialHarness = Awaited<ReturnType<typeof materialHarness>>

export async function freezeFakeEnvironment(
  harness: MaterialHarness,
  extraSchemaRevisions: readonly string[] = [],
): Promise<void> {
  await chmod(join(FIXTURES, 'fake-plink'), 0o755)
  await chmod(join(FIXTURES, 'fake-himvp'), 0o755)
  await chmod(join(FIXTURES, 'fake-rscript'), 0o755)
  await freezeTestedEnvironmentRevision({
    ctx: harness.ctx,
    store: harness.store,
    input: {
      environmentSpecRevision: 'fake-env/v1',
      components: [
        { name: 'plink', kind: 'executable', resolvedPath: join(FIXTURES, 'fake-plink'), sourceRef: 'tests/fixtures/professional/fake-plink' },
        { name: 'himvp', kind: 'executable', resolvedPath: join(FIXTURES, 'fake-himvp'), sourceRef: 'tests/fixtures/professional/fake-himvp' },
        { name: 'rscript', kind: 'executable', resolvedPath: join(FIXTURES, 'fake-rscript'), sourceRef: 'tests/fixtures/professional/fake-rscript' },
        { name: 'cmplot-rpkg', kind: 'r_package', resolvedPath: join(FIXTURES, 'fake-cmplot-helper.R'), sourceRef: 'tests/fixtures/professional/fake-cmplot-helper.R' },
      ],
      parseVersion: (component, output) => {
        // Version strings must match exactly what each adapter's resolveVersion hook returns
        // (the per-call gate compares the frozen identity against the hook's parse).
        if (component === 'plink') {
          const match = /PLINK v([0-9.a-z]+)/u.exec(output)
          return match === null || match[1] === undefined ? null : `PLINK v${match[1]}`
        }
        if (component === 'himvp') {
          const match = /HiMVP v([0-9.a-z]+)/u.exec(output)
          return match === null || match[1] === undefined ? null : `HiMVP v${match[1]}`
        }
        const match = /R version ([0-9.]+[^\s]*)/u.exec(output)
        return match === null || match[1] === undefined ? null : `R ${match[1]}`
      },
      inputSchemaRevisions: ['plink-bed-set@v1', 'gwas-input@v1', 'r-script-input@v1', 'manhattan-data@v1', ...extraSchemaRevisions],
      signal: new AbortController().signal,
    },
  })
}

/** Generate a formula-consistent fake PLINK trio (SPEC-03 §13.3 dimension fixture). */
export async function writeFakePlinkTrio(
  root: string, name: string, bimRows: number, famRows: number, corruptBed = false,
): Promise<{ bed: string; bim: string; fam: string }> {
  const groups = Math.ceil(famRows / 4)
  const bedBytes = 3 + bimRows * groups + (corruptBed ? 1 : 0)
  const bed = join(root, `${name}.bed`)
  const bim = join(root, `${name}.bim`)
  const fam = join(root, `${name}.fam`)
  const bimLines = Array.from({ length: bimRows }, (_, index) => `snp${String(index + 1)}\tfake\t${String(index + 1)}\t1\tA\tG`)
  const famLines = Array.from({ length: famRows }, (_, index) => `id${String(index + 1)}\tid${String(index + 1)}\t0\t0\t1\t-9`)
  const header = Buffer.from([0x6c, 0x1b, 0x01, 0x01])
  const bedBuffer = Buffer.concat([header, Buffer.alloc(Math.max(0, bedBytes - header.length), 0)])
  await writeFile(bed, bedBuffer)
  await writeFile(bim, `${bimLines.join('\n')}\n`, 'utf8')
  await writeFile(fam, `${famLines.join('\n')}\n`, 'utf8')
  return { bed, bim, fam }
}
