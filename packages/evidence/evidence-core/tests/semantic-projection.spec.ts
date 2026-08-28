/** S04-A16: bounded projection, hard exclusions, canonical requestPayload + projectionDigest. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { buildSemanticProjection, projectionDigestOf, truncateHeadTail } from '../src/semantic/projection.ts'
import { resolveEvidenceModelRoute, resolveSemanticProjectionConfig } from '../src/semantic/model-route.ts'
import { header } from './helpers.ts'

const assistantEvent = (seq: number, text: string, extraBlocks: unknown[] = []): SessionEvent => ({
  type: 'assistant/message',
  seq,
  time: 100 + seq,
  surfaceOp: 'append',
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }, ...extraBlocks] } },
} as unknown as SessionEvent)

const userEvent = (seq: number, text: string): SessionEvent => ({
  type: 'user/message',
  seq,
  time: 100 + seq,
  data: { message: { role: 'user', content: [{ type: 'text', text }] } },
} as unknown as SessionEvent)

const route = resolveEvidenceModelRoute({ provider: 'cli-mock', model: 'ev' }) as NonNullable<ReturnType<typeof resolveEvidenceModelRoute>>
const config = resolveSemanticProjectionConfig(undefined)

describe('S04-A16 hard exclusions and bounded projection', () => {
  it('reasoning/CoT blocks never enter the projection (D-105)', () => {
    const projection = buildSemanticProjection({
      header: header,
      graphId: 'eg_spec01fixture',
      events: [assistantEvent(3, 'visible analysis', [{ type: 'reasoning', text: 'SECRET chain of thought' }])],
      fromNextSeqExclusive: 0,
      targetNextSeqExclusive: 4,
      captures: [],
      selectedRunIds: new Set(),
      existingCandidates: [],
      route,
      config,
    })
    const serialized = JSON.stringify(projection.requestPayload)
    expect(serialized).toContain('visible analysis')
    expect(serialized).not.toContain('SECRET chain of thought')
  })

  it('declared head_tail truncation applies past the per-item bound', () => {
    const long = 'x'.repeat(20_000)
    const bounded = truncateHeadTail(long, 1_000)
    expect(bounded.truncated).toBe(true)
    expect(bounded.text).toContain('head_tail_v1')
    expect(bounded.text.length).toBeLessThan(long.length)
    const projection = buildSemanticProjection({
      header: header,
      graphId: 'eg_spec01fixture',
      events: [assistantEvent(3, long)],
      fromNextSeqExclusive: 0,
      targetNextSeqExclusive: 4,
      captures: [],
      selectedRunIds: new Set(),
      existingCandidates: [],
      route,
      config,
    })
    const assistant = projection.items.find(item => item.kind === 'assistant_message')
    expect(assistant?.truncated).toBe(true)
  })

  it('evidence/model-request events are excluded from the projection input domain', () => {
    const projection = buildSemanticProjection({
      header: header,
      graphId: 'eg_spec01fixture',
      events: [
        assistantEvent(3, 'analysis text'),
        { type: 'evidence/model-request', seq: 4, time: 104, data: { schemaVersion: 'animalge.evidence.model-request/v1', modelCallId: 'mc_x', purpose: 'candidate-semantics', requestPayload: {}, sourceRefs: [], targetNextSeqExclusive: 5 } } as unknown as SessionEvent,
      ],
      fromNextSeqExclusive: 0,
      targetNextSeqExclusive: 5,
      captures: [],
      selectedRunIds: new Set(),
      existingCandidates: [],
      route,
      config,
    })
    expect(projection.items).toHaveLength(1)
    expect(projection.sourceRefs.every(ref => ref.seq < 5)).toBe(true)
  })

  it('pending run summaries carry the observationId endpoint handle', () => {
    const projection = buildSemanticProjection({
      header: header,
      graphId: 'eg_spec01fixture',
      events: [userEvent(2, 'question')],
      fromNextSeqExclusive: 0,
      targetNextSeqExclusive: 4,
      captures: [{
        recordVersion: 'animalge.captured-invocation/v1',
        graphId: 'eg_spec01fixture' as never,
        sessionId: header.id,
        runId: 'er_fixture' as never,
        basis: {
          kind: 'top_level_tool',
          callId: 'call-1' as never,
          callEvent: { schemaVersion: 'animalge.session-event-ref/v1', sessionId: header.id, seq: 1, eventType: 'tool/call', eventTime: 101, eventDigest: ('sha256:' + 'a'.repeat(64)) as never },
          resultEvent: { schemaVersion: 'animalge.session-event-ref/v1', sessionId: header.id, seq: 3, eventType: 'tool/result', eventTime: 103, eventDigest: ('sha256:' + 'b'.repeat(64)) as never },
        },
        toolName: 'bash',
        argumentsDigest: ('sha256:' + 'c'.repeat(64)) as never,
        resultContentDigest: ('sha256:' + 'd'.repeat(64)) as never,
        resultBlockCount: 1,
        isError: false,
        outcome: 'succeeded',
        startedAt: 101,
        endedAt: 103,
        invocationDigest: ('sha256:' + 'e'.repeat(64)) as never,
        selection: 'not_selected',
        selectionRuleDigest: ('sha256:' + 'f'.repeat(64)) as never,
        captureContractRevision: 'animalge-capture/v1',
      }],
      selectedRunIds: new Set(),
      existingCandidates: [],
      route,
      config,
    })
    const runSummary = projection.items.find(item => item.kind === 'run_summary')
    expect(runSummary).toBeDefined()
    expect((runSummary?.meta as { observationId?: string } | undefined)?.observationId).toMatch(/^eo_/)
  })

  it('C1-03 regression: the projection carries existing-object summaries for Observations (B1-03)', () => {
    const captureLike = ({
      recordVersion: 'animalge.captured-invocation/v1',
      graphId: 'eg_spec01fixture',
      sessionId: header.id,
      runId: 'er_proj' as never,
      basis: {
        kind: 'top_level_tool',
        callId: 'call-proj' as never,
        callEvent: { schemaVersion: 'animalge.session-event-ref/v1', sessionId: header.id, seq: 1, eventType: 'tool/call', eventTime: 101, eventDigest: ('sha256:' + 'a'.repeat(64)) as never },
        resultEvent: { schemaVersion: 'animalge.session-event-ref/v1', sessionId: header.id, seq: 3, eventType: 'tool/result', eventTime: 103, eventDigest: ('sha256:' + 'b'.repeat(64)) as never },
      },
      toolName: 'bash',
      argumentsDigest: ('sha256:' + 'c'.repeat(64)) as never,
      resultContentDigest: ('sha256:' + 'd'.repeat(64)) as never,
      resultBlockCount: 1,
      isError: false,
      outcome: 'succeeded' as const,
      startedAt: 101,
      endedAt: 103,
      invocationDigest: ('sha256:' + 'e'.repeat(64)) as never,
      selection: 'selected' as const,
      selectionRuleDigest: ('sha256:' + 'f'.repeat(64)) as never,
      captureContractRevision: 'animalge-capture/v1',
    }) as never
    const projection = buildSemanticProjection({
      header,
      graphId: 'eg_spec01fixture',
      events: [],
      fromNextSeqExclusive: 0,
      targetNextSeqExclusive: 4,
      captures: [captureLike],
      selectedRunIds: new Set(['er_proj']),
      existingCandidates: [],
      route,
      config,
    })
    const observationItems = projection.items.filter(item => (item.meta as { nodeKind?: string } | undefined)?.nodeKind === 'Observation')
    expect(observationItems.length).toBeGreaterThanOrEqual(1)
    expect(observationItems[0]?.text).toContain('[Observation]')
    expect((observationItems[0]?.meta as { observationId?: string }).observationId).toMatch(/^eo_/)
  })

  it('the canonical requestPayload deterministically recomputes its projection digest (D-164)', () => {
    const events = [userEvent(2, 'question'), assistantEvent(3, 'answer with arguable claim')]
    const build = () => buildSemanticProjection({
      header: header,
      graphId: 'eg_spec01fixture',
      events,
      fromNextSeqExclusive: 0,
      targetNextSeqExclusive: 4,
      captures: [],
      selectedRunIds: new Set(),
      existingCandidates: [],
      route,
      config,
    })
    const first = build()
    const second = build()
    expect(first.projectionDigest).toBe(second.projectionDigest)
    expect(projectionDigestOf(first.requestPayload).digest).toBe(first.projectionDigest)
  })
})
