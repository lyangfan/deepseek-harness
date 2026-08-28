/** S04-A08/A09/A11(unit): switch semantics, tri-state watermark input, failure retry state. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { materialHarness } from './helpers.ts'
import { SemanticLane } from '../src/semantic/lane.ts'
import { resolveEvidenceModelRoute, resolveSemanticProjectionConfig } from '../src/semantic/model-route.ts'
import { setSemanticSwitchEnabled, semanticSwitchEnabled } from '../src/semantic/switch.ts'
import { foldCaptures, resolveSelection } from '../src/capture.ts'
import { materialSnapshotFor } from '../src/materialize.ts'
import { compileSnapshot } from '../src/compiler.ts'

const route = resolveEvidenceModelRoute({ provider: 'cli-mock', model: 'ev' }) as NonNullable<ReturnType<typeof resolveEvidenceModelRoute>>
const config = resolveSemanticProjectionConfig(undefined)
const selection = resolveSelection('spec04-lane/v1', [])

async function laneHarness() {
  const harness = await materialHarness()
  const calls: Array<{ messages: unknown[]; system?: string | undefined }> = []
  const stream = (options: { messages: unknown[]; system?: string | undefined }): AsyncIterable<{ type: string; text?: string }> => {
    calls.push({ messages: options.messages, system: options.system })
    const text = '```json\n' + JSON.stringify({ schemaVersion: 'animalge.semantic-extraction/v1', candidates: [], relations: [], sameAsProposals: [], runSelections: [] }) + '\n```'
    return (async function* () {
      yield { type: 'text-delta', text }
      yield { type: 'finish' }
    })()
  }
  harness.ctx.provide('llm', { stream } as never)
  const lane = new SemanticLane(harness.ctx, harness.store, route, config, selection, [10, 20, 40, 80], 5, () => false,
    new AbortController().signal)
  return { harness, lane, calls }
}

type Appendable = { append: (type: never, data: never, opts?: { surfaceOp?: string }  ) => unknown }
const asAppendable = (session: unknown): Appendable => session as Appendable

function turn(session: Appendable, events: SessionEvent[]): void {
  for (const event of events) {
    const surface = 'surfaceOp' in event ? { surfaceOp: (event as { surfaceOp?: string }).surfaceOp } : undefined
    session.append(event.type as never, event.data as never, surface as never)
  }
}

describe('S04-A08/A09 switch and watermark semantics', () => {
  it('backlog requires the switch on; switching off empties the backlog and keeps the record', async () => {
    const { harness, lane } = await laneHarness()
    try {
      const session = await harness.createSession('spec04-lane-a')
      turn(asAppendable(session), [
        { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
        { type: 'user/message', seq: 1, time: 101, surfaceOp: 'append', data: { message: { role: 'user', content: [{ type: 'text', text: 'q' }] } } } as unknown as SessionEvent,
        { type: 'turn/end', seq: 2, time: 102, data: { turn: 1, reason: { kind: 'completed' } } },
      ])
      const graphScope = harness.store.sessionGraphs.get(session.header.id)
      expect(graphScope).toBeDefined()
      const graphId = graphScope!.graphId
      // No committed head yet → no backlog entry.
      expect(lane.backlog()).toHaveLength(0)
      // Switch off: the backlog stays empty and the authoritative record reads disabled.
      await setSemanticSwitchEnabled(harness.store, graphId, false)
      expect(semanticSwitchEnabled(harness.store, graphId)).toBe(false)
      expect(lane.backlog()).toHaveLength(0)
      expect(lane.semanticInputFor(graphId).watermark).toEqual({ kind: 'disabled', lastNextSeqExclusive: 0 })
      // Re-enable restores the default-on state without touching any history.
      await setSemanticSwitchEnabled(harness.store, graphId, true)
      expect(semanticSwitchEnabled(harness.store, graphId)).toBe(true)
      expect(lane.semanticInputFor(graphId).watermark).toEqual({ kind: 'active', nextSeqExclusive: 0 })
    } finally {
      await harness.close()
    }
  })

  it('a cold (non-live) session never yields a backlog entry — the backlog waits for liveness (§9.4)', async () => {
    const { harness, lane } = await laneHarness()
    try {
      // A Graph with a committed head whose Session is not live: the semantic backlog
      // exists in the lane record, but no entry may be offered until the Session is live.
      const coldHeader = { version: 0, id: 'spec04-lane-cold' as never, createdAt: 1_700_000_000_000, agentPreset: 'animalge-open-test' }
      const scope = await harness.store.bootstrap(coldHeader)
      const selection = resolveSelection('spec04-cold/v1', [])
      const payload = compileSnapshot({
        scope, captures: [], baseSnapshotDigest: null, targetNextSeqExclusive: 1,
        sourceTimeUpperBound: null, selectionRevision: selection.revision, selectionRuleDigest: selection.digest,
        material: materialSnapshotFor(harness.store, scope.graphId),
        semantic: { ledger: { candidates: new Map(), relations: new Map(), runSelections: new Map() }, watermark: { kind: 'active', nextSeqExclusive: 1 } },
      })
      await harness.store.commit({
        recordVersion: 'animalge.compile-attempt/v1',
        attemptId: 'ca_cold' as never, graphId: scope.graphId, sessionId: coldHeader.id,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 1,
        baseSnapshotDigest: null, baseHeadRevision: 0,
        state: 'succeeded', stage: 'finalize',
        revisions: payload.revisions, retryOf: null, startedAt: 1, updatedAt: 1,
        terminalError: null, stagingId: null, resultSnapshotDigest: null,
      }, payload)
      expect(harness.ctx.sessions.get(coldHeader.id)).toBeUndefined()
      expect(lane.backlog().find(entry => entry.graphId === scope.graphId)).toBeUndefined()
    } finally {
      await harness.close()
    }
  })

  it('S04-A11(unit) retry state parks after the D-145 ladder is exhausted', async () => {
    const { harness, lane } = await laneHarness()
    try {
      const session = await harness.createSession('spec04-lane-retry')
      const graphId = harness.store.sessionGraphs.get(session.header.id)!.graphId
      // Simulate five exhausted attempts: the lane must stop offering the backlog.
      const privateRetries = (lane as unknown as { retries: Map<string, { attempts: number; notBefore: number }> }).retries
      privateRetries.set(graphId, { attempts: 5, notBefore: 0 })
      expect(lane.backlog().find(entry => entry.graphId === graphId)).toBeUndefined()
      expect(lane.nextRetryAt()).toBe(0)
      privateRetries.set(graphId, { attempts: 1, notBefore: Date.now() + 60_000 })
      expect(lane.nextRetryAt()).toBeGreaterThan(Date.now())
    } finally {
      await harness.close()
    }
  })

  it('S04-A18 dispose aborts an in-flight model call (settled aborted, not a model error)', async () => {
    const harness = await materialHarness()
    let resolveStream: ((stream: AsyncIterable<{ type: string; text?: string }>) => void) | undefined
    let dispatchSignal: AbortSignal | undefined
    const streamReady = new Promise<AbortSignal>((resolveSignal) => {
      resolveStream = (stream) => {
        harness.ctx.provide('llm', {
          stream(options: { signal?: AbortSignal }) {
            dispatchSignal = options.signal
            resolveSignal(options.signal as AbortSignal)
            return stream as never
          },
        } as never)
      }
    })
    try {
      const session = await harness.createSession('spec04-lane-dispose')
      turn(asAppendable(session), [
        { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 101, data: { turn: 1, reason: { kind: 'completed' } } },
      ])
      const graphScope = harness.store.sessionGraphs.get(session.header.id)
      expect(graphScope).toBeDefined()
      const graphId = graphScope!.graphId
      const selection = resolveSelection('spec04-dispose/v1', [])
      const folded = foldCaptures(graphScope!.initialScope, session.header, session.events, selection)
      const payload = compileSnapshot({
        scope: graphScope!.initialScope, captures: folded.captures, baseSnapshotDigest: null,
        targetNextSeqExclusive: 2, sourceTimeUpperBound: 101,
        selectionRevision: selection.revision, selectionRuleDigest: selection.digest,
        material: materialSnapshotFor(harness.store, graphId),
        semantic: { ledger: { candidates: new Map(), relations: new Map(), runSelections: new Map() }, watermark: { kind: 'active', nextSeqExclusive: 2 } },
      })
      await harness.store.commit({
        recordVersion: 'animalge.compile-attempt/v1',
        attemptId: 'ca_dispose' as never, graphId, sessionId: session.header.id,
        fromNextSeqExclusive: 0, targetNextSeqExclusive: 2, baseSnapshotDigest: null, baseHeadRevision: 0,
        state: 'succeeded', stage: 'finalize', revisions: payload.revisions,
        retryOf: null, startedAt: 1, updatedAt: 1, terminalError: null, stagingId: null, resultSnapshotDigest: null,
      }, payload)
      // A real adapter aborts its underlying transport when options.signal fires; the
      // fake reproduces that contract by rejecting the hang on abort (D-llm signal).
      resolveStream?.((async function* () {
        const signal = dispatchSignal
        await new Promise((_, rejectHang) => {
          signal?.addEventListener('abort', (event) => {
            rejectHang(new Error(String((event.target as AbortSignal & { reason?: Error }).reason ?? 'aborted')))
          })
        })
        yield { type: 'text-delta', text: 'x' }
      })())
      const runtimeAbort = new AbortController()
      const lane = new SemanticLane(harness.ctx, harness.store, route, config, selection, [1_000], 5, () => false, runtimeAbort.signal)
      const attempt = lane.runOne({ graphId, sessionId: session.header.id, target: 2, header: session.header, session })
      const signal = await streamReady
      expect(signal.aborted).toBe(false)
      // Runtime dispose: the plugin aborts its controller; the hanging stream's consumer
      // aborts (settled aborted, never a model-error retry).
      runtimeAbort.abort(new Error('evidence-core disposed'))
      await attempt
      const semanticAttempts = [...harness.store.attempts.entries()].map(([, row]) => row).filter(row => row.channel === 'semantic')
      expect(semanticAttempts.length).toBeGreaterThanOrEqual(1)
      expect(['failed', 'cancelled']).toContain(semanticAttempts[0]?.state)
      const modelCalls = [...harness.store.modelCalls.entries()].map(([, row]) => row)
      expect(modelCalls[0]?.outcome).toBe('aborted')
    } finally {
      await harness.close()
    }
  }, 30_000)

  it('deterministic snapshots embed the semantic input as the tri-state watermark (§8.4)', async () => {
    const { harness, lane } = await laneHarness()
    try {
      const session = await harness.createSession('spec04-lane-wm')
      const graphId = harness.store.sessionGraphs.get(session.header.id)!.graphId
      const scope = harness.store.graphs.get(graphId)!.scope
      const input = lane.semanticInputFor(graphId)
      const payload = compileSnapshot({
        scope,
        captures: [],
        baseSnapshotDigest: null,
        targetNextSeqExclusive: 1,
        sourceTimeUpperBound: null,
        selectionRevision: selection.revision,
        selectionRuleDigest: selection.digest,
        material: materialSnapshotFor(harness.store, graphId),
        semantic: { ledger: input.ledger, watermark: input.watermark },
      })
      expect(payload.semanticWatermark).toEqual({ kind: 'active', nextSeqExclusive: 0 })
      await setSemanticSwitchEnabled(harness.store, graphId, false)
      expect(lane.semanticInputFor(graphId).watermark).toEqual({ kind: 'disabled', lastNextSeqExclusive: 0 })
    } finally {
      await harness.close()
    }
  })
})
