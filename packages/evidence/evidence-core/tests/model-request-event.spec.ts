/** S04-A10: evidence/model-request persisted and durability-verified strictly before dispatch. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { materialHarness } from './helpers.ts'
import { ModelRequestError, persistModelRequest } from '../src/semantic/model-request.ts'
import { canonicalJson } from '../src/canonical-json.ts'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'

describe('S04-A10 evidence/model-request persistence-before-dispatch', () => {
  it('appends the log-only event, flushes, readFrom-verifies, and returns the identity', async () => {
    const harness = await materialHarness()
    try {
      const session = await harness.createSession('spec04-model-request-a')
      const verified = await persistModelRequest({
        ctx: harness.ctx,
        session,
        header: session.header,
        graphId: 'eg_spec04a' as never,
        attemptId: 'ca_spec04a' as never,
        requestPayload: { schemaVersion: 'animalge.semantic-request/v1', provider: 'cli-mock', model: 'ev', system: 's', messages: [], generationParams: {} },
        projectionDigest: ('sha256:' + '1'.repeat(64)) as never,
        sourceRefs: [],
        targetNextSeqExclusive: 4,
      })
      expect(verified.modelCallId).toMatch(/^mc_/)
      const persisted = await harness.ctx.sessionPersistence.readFrom(session.header.id, 0)
      const event = persisted.events.find(candidate => candidate.type === 'evidence/model-request')
      expect(event).toBeDefined()
      const data = event?.data as { modelCallId: string; purpose: string; projectionDigest: string }
      expect(data.modelCallId).toBe(verified.modelCallId)
      expect(data.purpose).toBe('candidate-semantics')
      expect(data.projectionDigest).toBe('sha256:' + '1'.repeat(64))
      // The event carries the de-keyed canonical payload verbatim (D-164).
      expect(canonicalJson((event?.data as { requestPayload: JsonValue }).requestPayload)).toBe(canonicalJson({ schemaVersion: 'animalge.semantic-request/v1', provider: 'cli-mock', model: 'ev', system: 's', messages: [], generationParams: {} }))
    } finally {
      await harness.close()
    }
  })

  it('fails closed when no durability listener participates (no dispatch, typed error)', async () => {
    // A Session store with NO persistence backend: flush cannot reach a durability
    // listener, so the request must fail closed before any dispatch could happen.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    try {
      const orphan = ctx.sessions.create('spec04-model-request-b' as never, { meta: { agentPreset: 'animalge-open-test' } })
      const failure = await persistModelRequest({
        ctx,
        session: orphan,
        header: orphan.header,
        graphId: 'eg_spec04b' as never,
        attemptId: 'ca_spec04b' as never,
        requestPayload: {},
        projectionDigest: ('sha256:' + '2'.repeat(64)) as never,
        sourceRefs: [],
        targetNextSeqExclusive: 2,
      }).then(
        (value): { resolved: unknown } => ({ resolved: value }),
        (error: unknown): { error: ModelRequestError } => ({ error: error as ModelRequestError }),
      )
      expect('error' in failure && failure.error instanceof ModelRequestError).toBe(true)
      expect((failure as { error: ModelRequestError }).error.code).toBe('flush_unavailable')
      // No evidence/model-request event may survive a failed persistence attempt.
      const appended = orphan.events.filter(event => event.type === 'evidence/model-request')
      expect(appended).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('the event type is part of the regenerated known-event catalog (D-153)', () => {
    const catalog = readFileSync(join(import.meta.dirname, '../../../core/session/src/known-event-types.ts'), 'utf8')
    expect(catalog.includes('\'evidence/model-request\'')).toBe(true)
  })

  it('S04-A10 readFrom verification failure fails closed with the typed code (no dispatch)', async () => {
    const harness = await materialHarness()
    try {
      const session = await harness.createSession('spec04-model-request-c')
      const realReadFrom = harness.ctx.sessionPersistence.readFrom.bind(harness.ctx.sessionPersistence)
      let restored = false
      harness.ctx.sessionPersistence.readFrom = (async (id: unknown, from: number) => {
        if (restored) return realReadFrom(id as never, from)
        // Simulate the persisted prefix lagging behind the appended event: the target
        // event is not yet visible in the durable read.
        const read = await realReadFrom(id as never, 0)
        return { meta: read.meta, events: read.events.filter(event => event.type !== 'evidence/model-request') }
      })
      const failure = await persistModelRequest({
        ctx: harness.ctx,
        session,
        header: session.header,
        graphId: 'eg_spec04c' as never,
        attemptId: 'ca_spec04c' as never,
        requestPayload: {},
        projectionDigest: 'sha256:' + '4'.repeat(64) as never,
        sourceRefs: [],
        targetNextSeqExclusive: 2,
      }).then(value => ({ resolved: value }), (error: unknown): { error: ModelRequestError } => ({ error: error as ModelRequestError }))
      restored = true
      expect((failure as { error: ModelRequestError }).error.code).toBe('request_event_not_durable')
    } finally {
      await harness.close()
    }
  })
})
