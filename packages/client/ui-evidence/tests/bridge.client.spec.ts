// SPEC-05 §5.3 client-side dedup, behaviorally: the real createEvidenceBridge against a
// fake cordis remote — forwarded evidence/updated events wake the session's subscribers,
// equal three-token sets dedup (no wake, whether the baseline came from a query response
// or a previous event), any token change wakes again, and another Session's events never
// wake this Session's listeners. A wrong implementation that wakes on every event, never
// wakes, or crosses Session scopes is defeated.
import { describe, expect, it, vi } from 'vitest'
import { createEvidenceBridge } from '../src/client/api.ts'

interface Payload {
  sessionId: string
  materialStateDigest: string
  headRevision: number
  issuesRevision: string
  currentSnapshotDigest: string | null
}

function fakeRemoteCtx(): {
  ctx: Parameters<typeof createEvidenceBridge>[0]
  emit: (payload: Payload) => void
} {
  const handlers: Array<(payload: Payload) => void> = []
  const ctx = {
    remote: {
      $on: (name: string, handler: (payload: Payload) => void) => {
        if (name === 'evidence/updated') handlers.push(handler)
        return () => {}
      },
      evidence: {},
    },
    effect: (register: () => () => void) => { return register() },
  } as unknown as Parameters<typeof createEvidenceBridge>[0]
  return { ctx, emit: (payload) => { for (const handler of handlers) handler(payload) } }
}

const TOKENS_A = { materialStateDigest: 'sha256:a', headRevision: 1, issuesRevision: 'sha256:i1' }

describe('createEvidenceBridge subscription (§5.3)', () => {
  it('wakes the session subscriber on a forwarded event and dedups equal three-token sets', () => {
    const { ctx, emit } = fakeRemoteCtx()
    const bridge = createEvidenceBridge(ctx)
    const face = bridge.forSession('sess_sub01' as never)
    const listener = vi.fn()
    face.refresh.subscribe(listener)
    expect(face.refresh.version()).toBe(0)
    emit({ sessionId: 'sess_sub01', ...TOKENS_A, currentSnapshotDigest: null })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(face.refresh.version()).toBe(1)
    // Equal token triple carries no new state — the event is dropped (§5.3).
    emit({ sessionId: 'sess_sub01', ...TOKENS_A, currentSnapshotDigest: null })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(face.refresh.version()).toBe(1)
  })

  it('wakes again when any one of the three tokens changes', () => {
    const { ctx, emit } = fakeRemoteCtx()
    const face = createEvidenceBridge(ctx).forSession('sess_sub02' as never)
    const listener = vi.fn()
    face.refresh.subscribe(listener)
    emit({ sessionId: 'sess_sub02', ...TOKENS_A, currentSnapshotDigest: null })
    expect(listener).toHaveBeenCalledTimes(1)
    emit({ sessionId: 'sess_sub02', ...TOKENS_A, materialStateDigest: 'sha256:b', currentSnapshotDigest: null })
    expect(listener).toHaveBeenCalledTimes(2)
    emit({ sessionId: 'sess_sub02', ...TOKENS_A, headRevision: 2, currentSnapshotDigest: null })
    expect(listener).toHaveBeenCalledTimes(3)
    emit({ sessionId: 'sess_sub02', ...TOKENS_A, issuesRevision: 'sha256:i2', currentSnapshotDigest: null })
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it('treats tokens recorded from query responses as the dedup baseline', () => {
    const { ctx, emit } = fakeRemoteCtx()
    const face = createEvidenceBridge(ctx).forSession('sess_sub03' as never)
    const listener = vi.fn()
    face.refresh.subscribe(listener)
    // A successful query recorded tokens equal to the next event's — no wake.
    face.refresh.recordTokens(TOKENS_A)
    emit({ sessionId: 'sess_sub03', ...TOKENS_A, currentSnapshotDigest: null })
    expect(listener).not.toHaveBeenCalled()
    // A later event with a moved headRevision wakes.
    emit({ sessionId: 'sess_sub03', ...TOKENS_A, headRevision: 5, currentSnapshotDigest: 'sha256:snap' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('scopes wakes per session — another session\'s event never wakes this subscriber', () => {
    const { ctx, emit } = fakeRemoteCtx()
    const bridge = createEvidenceBridge(ctx)
    const mine = bridge.forSession('sess_mine' as never)
    const listener = vi.fn()
    mine.refresh.subscribe(listener)
    emit({ sessionId: 'sess_other', ...TOKENS_A, currentSnapshotDigest: null })
    emit({ sessionId: 'sess_other', ...TOKENS_A, headRevision: 9, currentSnapshotDigest: null })
    expect(listener).not.toHaveBeenCalled()
    expect(mine.refresh.version()).toBe(0)
  })
})
