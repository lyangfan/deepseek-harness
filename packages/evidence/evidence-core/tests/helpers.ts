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
  const lane = new AcceptanceLane(ctx, store, { providers: new Set([RUNNER_PROVIDER_ID]), profiles: REGISTERED_CAPTURE_PROFILE_IDS })
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
