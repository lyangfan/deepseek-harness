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
