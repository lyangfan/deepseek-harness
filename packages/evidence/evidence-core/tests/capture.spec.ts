import { describe, expect, it } from 'vitest'
import { CallId, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import { canonicalDigest } from '../src/canonical-json.ts'
import { compileSnapshot } from '../src/compiler.ts'
import { completionBoundary, foldCaptures, resolveSelection, validateSuffix } from '../src/capture.ts'
import { graphId, header, topLevelEvents } from './helpers.ts'
import { registerSuiteSummary } from './summary.ts'

registerSuiteSummary({
  suiteId: 'capture',
  acceptanceIds: ['S01-A03', 'S01-A04', 'S01-A05', 'S01-A06'],
  sessionPersistence: [],
  evidenceStorage: [],
})

const scope = { kind: 'session' as const, graphId, sessionId: header.id, sessionCreatedAt: header.createdAt }

describe('S01-A03-A06 deterministic capture', () => {
  it('pairs a top-level invocation and emits only completion boundaries', () => {
    const folded = foldCaptures(scope, header, topLevelEvents(), resolveSelection('r1', ['bash']))
    expect(folded.captures).toHaveLength(1)
    expect(folded.captures[0]).toMatchObject({ toolName: 'bash', outcome: 'succeeded', selection: 'selected', startedAt: 102, endedAt: 103 })
    expect(folded.boundaries).toEqual([{ seq: 3, reason: 'tool_result' }, { seq: 5, reason: 'turn_end' }])
    expect(completionBoundary(topLevelEvents()[2]!)).toBeUndefined()
  })

  it('captures Code Mode dispatch with exact start/result pairing', () => {
    const root = CallId('root'); const child = CallId('child')
    const events = [
      { type: 'tool/code-dispatch-start', seq: 0, time: 10, data: { rootCallId: root, parentCallId: root, subCallId: child, name: 'bash', arguments: { cmd: 'pwd' } } },
      { type: 'tool/code-dispatch', seq: 1, time: 11, data: { rootCallId: root, parentCallId: root, subCallId: child, name: 'bash', arguments: { cmd: 'pwd' }, isError: false, content: [{ type: 'text', text: '/tmp' }] } },
    ] as SessionEvent[]
    const folded = foldCaptures(scope, header, events, resolveSelection('r1', ['bash']))
    expect(folded.captures[0]?.basis.kind).toBe('code_mode_dispatch')
    expect(folded.boundaries).toEqual([{ seq: 1, reason: 'code_dispatch' }])
  })

  it.each([
    ['not_started', TOOL_NOT_STARTED, 'ToolNotStartedError'],
    ['outcome_unknown', TOOL_OUTCOME_UNKNOWN, 'ToolOutcomeUnknownError'],
  ] as const)('maps DSH repair %s without inventing success', (outcome, code, name) => {
    const callId = CallId(`repair-${outcome}`)
    const assistant = { type: 'assistant/message', seq: 0, time: 10, surfaceOp: 'append', data: { turn: 1, step: 1, message: createMessage({ role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }], source: { kind: 'model', provider: 'mock', model: 'mock' } }) } } as SessionEvent
    const call = { type: 'tool/call', seq: 1, time: 11, data: { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' } } as SessionEvent
    const result = { type: 'tool/result', seq: 2, time: 12, surfaceOp: 'append', ...(outcome === 'outcome_unknown' ? { sourceEventSeqs: [1] } : {}), data: { turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: code }], isError: true }), error: { name, code } } } as SessionEvent
    const events = outcome === 'not_started' ? [assistant, result] : [assistant, call, result]
    expect(foldCaptures(scope, header, events, resolveSelection('r1', ['bash'])).captures[0]?.outcome).toBe(outcome)
  })

  it('fails closed on gaps, lifecycle mismatch and duplicate terminal evidence', () => {
    expect(() =>{  validateSuffix(header, header, 1, topLevelEvents()) }).toThrow(/contiguous/)
    expect(() =>{  validateSuffix({ ...header, createdAt: header.createdAt + 1 }, header, 0, []) }).toThrow(/lifecycle/)
    const duplicate = [...topLevelEvents(), { ...topLevelEvents()[3], seq: 6, time: 106 }] as SessionEvent[]
    expect(() => foldCaptures(scope, header, duplicate, resolveSelection('r1', ['bash']))).toThrow(/duplicate/)
  })

  it('treats a legal surface replacement as a non-terminal that changes nothing', () => {
    const base = topLevelEvents()
    const replacement = {
      type: 'tool/result', seq: 6, time: 106,
      surfaceOp: { op: 'replace', start: 3, end: 3 },
      data: {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId: CallId('call-spec-01'), content: [{ type: 'text', text: '/replaced' }], isError: false }),
      },
    } as SessionEvent
    const folded = foldCaptures(scope, header, [...base, replacement], resolveSelection('r1', ['bash']))
    expect(folded.captures).toHaveLength(1)
    expect(folded.captures[0]).toMatchObject({ outcome: 'succeeded', endedAt: 103 })
    expect(folded.captures[0]?.resultContentDigest).toBe(canonicalDigest([{ type: 'text', text: '/tmp' }] as never))
    expect(folded.boundaries).toEqual([{ seq: 3, reason: 'tool_result' }, { seq: 5, reason: 'turn_end' }])
  })

  it('keeps an unmatched start private with no capture and no invented outcome', () => {
    const callId = CallId('never-returns')
    const events = [
      { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 11, data: { turn: 1, step: 1 } },
      { type: 'tool/call', seq: 2, time: 12, data: { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' } },
      { type: 'turn/end', seq: 3, time: 13, data: { turn: 1, reason: { kind: 'interrupted' } } },
    ] as SessionEvent[]
    const folded = foldCaptures(scope, header, events, resolveSelection('r1', ['bash']))
    expect(folded.captures).toHaveLength(0)
    expect(folded.boundaries).toEqual([{ seq: 3, reason: 'turn_end' }])
  })

  it('keeps a not_selected capture private with no Run projection', () => {
    const folded = foldCaptures(scope, header, topLevelEvents('bash'), resolveSelection('r1', ['other-tool']))
    expect(folded.captures).toHaveLength(1)
    expect(folded.captures[0]).toMatchObject({ selection: 'not_selected', toolName: 'bash' })
    expect(folded.boundaries).toEqual([{ seq: 3, reason: 'tool_result' }, { seq: 5, reason: 'turn_end' }])
    const payload = compileSnapshot({
      scope, captures: folded.captures, baseSnapshotDigest: null,
      targetNextSeqExclusive: 6, sourceTimeUpperBound: 105,
      selectionRevision: 'r1', selectionRuleDigest: folded.captures[0]!.selectionRuleDigest,
    })
    expect(payload.nodes.filter(node => node.nodeKind === 'Run')).toHaveLength(0)
    expect(payload.deterministicWatermark.nextSeqExclusive).toBe(6)
  })
})

describe('S01-A04 Code Mode part_of projection', () => {
  it('emits one part_of edge from a selected child Run to its selected parent Run', () => {
    const parent = CallId('parent-call'); const child = CallId('child-call')
    const events = [
      { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
      { type: 'step/start', seq: 1, time: 11, data: { turn: 1, step: 1 } },
      { type: 'tool/call', seq: 2, time: 12, data: { turn: 1, step: 1, callId: parent, name: 'bash', arguments: '{"cmd":"pwd"}' } },
      {
        type: 'tool/result', seq: 3, time: 13, surfaceOp: 'append',
        data: { turn: 1, step: 1, message: createToolResultMessage({ callId: parent, content: [{ type: 'text', text: '/tmp' }], isError: false }) },
      },
      { type: 'tool/code-dispatch-start', seq: 4, time: 14, data: { rootCallId: parent, parentCallId: parent, subCallId: child, name: 'bash', arguments: { cmd: 'ls' } } },
      { type: 'tool/code-dispatch', seq: 5, time: 15, data: { rootCallId: parent, parentCallId: parent, subCallId: child, name: 'bash', arguments: { cmd: 'ls' }, isError: false, content: [{ type: 'text', text: '/tmp' }] } },
      { type: 'step/end', seq: 6, time: 16, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 7, time: 17, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    const selection = resolveSelection('r1', ['bash'])
    const folded = foldCaptures(scope, header, events, selection)
    expect(folded.captures).toHaveLength(2)
    expect(folded.captures.map(capture => capture.basis.kind).sort()).toEqual(['code_mode_dispatch', 'top_level_tool'])
    const payload = compileSnapshot({
      scope, captures: folded.captures, baseSnapshotDigest: null,
      targetNextSeqExclusive: 8, sourceTimeUpperBound: 17,
      selectionRevision: selection.revision, selectionRuleDigest: selection.digest,
    })
    const runs = payload.nodes.filter(node => node.nodeKind === 'Run')
    expect(runs).toHaveLength(2)
    const partOf = payload.edges.filter(edge => edge.edgeType === 'part_of')
    expect(partOf).toHaveLength(1)
    expect(runs.map(run => run.nodeId)).toContain(partOf[0]!.to)
    expect(runs.map(run => run.nodeId)).toContain(partOf[0]!.from)
    expect(partOf[0]!.from).not.toBe(partOf[0]!.to)
  })

  it('drops part_of when the parent is not projected in the same target', () => {
    const parent = CallId('parent-only'); const child = CallId('child-only')
    const events = [
      { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } },
      { type: 'tool/code-dispatch-start', seq: 1, time: 11, data: { rootCallId: parent, parentCallId: parent, subCallId: child, name: 'bash', arguments: { cmd: 'ls' } } },
      { type: 'tool/code-dispatch', seq: 2, time: 12, data: { rootCallId: parent, parentCallId: parent, subCallId: child, name: 'bash', arguments: { cmd: 'ls' }, isError: false, content: [{ type: 'text', text: '/tmp' }] } },
      { type: 'turn/end', seq: 3, time: 13, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    const selection = resolveSelection('r1', ['bash'])
    const folded = foldCaptures(scope, header, events, selection)
    const payload = compileSnapshot({
      scope, captures: folded.captures, baseSnapshotDigest: null,
      targetNextSeqExclusive: 4, sourceTimeUpperBound: 13,
      selectionRevision: selection.revision, selectionRuleDigest: selection.digest,
    })
    expect(payload.edges.filter(edge => edge.edgeType === 'part_of')).toHaveLength(0)
    expect(payload.edges.every(edge => edge.edgeType === 'generated_by')).toBe(true)
  })
})
