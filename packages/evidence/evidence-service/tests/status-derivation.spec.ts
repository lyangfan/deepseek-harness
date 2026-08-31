// SPEC-05 §11.2 status derivation unit tests: the frozen freshness/pending projection.
import { describe, expect, it } from 'vitest'
import { pendingIncrementOf, freshnessOf, graphStatusFacts } from '@deepseek-ai/dsh-evidence-core'
import type { EvidenceStore } from '@deepseek-ai/dsh-evidence-core'

// Minimal store mock exposing only what graphStatusFacts reads
function mockStore(overrides: {
  head?: { snapshotDigest: string | null } | undefined
  outbox?: Record<string, unknown> | undefined
}): EvidenceStore {
  return {
    heads: { get: () => overrides.head },
    outbox: { get: () => overrides.outbox },
    snapshotWatermark: () => 20,
  } as unknown as EvidenceStore
}

describe('freshnessOf (§11.2)', () => {
  it('pending=none → current (covered)', () => {
    expect(freshnessOf(true, 'none')).toBe('current')
    expect(freshnessOf(false, 'none')).toBe('current')
  })

  it('pending in working set → updating', () => {
    for (const p of ['capture_pending', 'compile_queued', 'compiling', 'retrying'] as const) {
      expect(freshnessOf(true, p)).toBe('updating')
      expect(freshnessOf(false, p)).toBe('updating')
    }
  })

  it('pending=failed with snapshot → stale', () => {
    expect(freshnessOf(true, 'failed')).toBe('stale')
  })

  it('pending=failed without snapshot → unavailable', () => {
    expect(freshnessOf(false, 'failed')).toBe('unavailable')
  })
})

describe('pendingIncrementOf (§11.2)', () => {
  it('no outbox row → none', () => {
    expect(pendingIncrementOf(mockStore({ outbox: undefined }), 'eg_1' as never, Date.now())).toBe('none')
  })

  it('in-flight attempt → compiling', () => {
    expect(pendingIncrementOf(mockStore({ outbox: { inFlightAttemptId: 'ca_1', retryNotBefore: 0, eligibleAfter: 0 } }), 'eg_1' as never, Date.now())).toBe('compiling')
  })

  it('retryNotBefore = MAX → failed (terminal)', () => {
    expect(pendingIncrementOf(mockStore({ outbox: { inFlightAttemptId: null, retryNotBefore: Number.MAX_SAFE_INTEGER, eligibleAfter: 0 } }), 'eg_1' as never, Date.now())).toBe('failed')
  })

  it('retryNotBefore in future → retrying', () => {
    const future = Date.now() + 10_000
    expect(pendingIncrementOf(mockStore({ outbox: { inFlightAttemptId: null, retryNotBefore: future, eligibleAfter: 0 } }), 'eg_1' as never, Date.now())).toBe('retrying')
  })

  it('eligibleAfter in future → capture_pending (idle merge window)', () => {
    const future = Date.now() + 5_000
    expect(pendingIncrementOf(mockStore({ outbox: { inFlightAttemptId: null, retryNotBefore: 0, eligibleAfter: future } }), 'eg_1' as never, Date.now())).toBe('capture_pending')
  })

  it('all clear → compile_queued', () => {
    const past = Date.now() - 1_000
    expect(pendingIncrementOf(mockStore({ outbox: { inFlightAttemptId: null, retryNotBefore: 0, eligibleAfter: past } }), 'eg_1' as never, Date.now())).toBe('compile_queued')
  })
})

describe('graphStatusFacts (§11.2 single implementation)', () => {
  it('no head → hasValidSnapshot=false, coveredWatermark=0', () => {
    const facts = graphStatusFacts(mockStore({ head: undefined, outbox: undefined }), 'eg_1' as never, Date.now())
    expect(facts.hasValidSnapshot).toBe(false)
    expect(facts.coveredWatermark).toBe(0)
    expect(facts.pendingTarget).toBeNull()
  })

  it('head with digest → hasValidSnapshot=true, watermark from snapshot', () => {
    const facts = graphStatusFacts(mockStore({ head: { snapshotDigest: 'sha256:abc' }, outbox: undefined }), 'eg_1' as never, Date.now())
    expect(facts.hasValidSnapshot).toBe(true)
    expect(facts.coveredWatermark).toBe(20)
  })

  it('head with null digest → hasValidSnapshot=false', () => {
    const facts = graphStatusFacts(mockStore({ head: { snapshotDigest: null }, outbox: undefined }), 'eg_1' as never, Date.now())
    expect(facts.hasValidSnapshot).toBe(false)
  })
})
