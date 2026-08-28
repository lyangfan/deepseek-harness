import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

const HIGH = ReasoningEffortId('high')
const OFF = ReasoningEffortId('off')

/** Keyless headless-agent adapter: one real bash call followed by a final answer. */
class CliMockAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      reasoning: {
        efforts: [
          { id: OFF, name: 'Off' },
          { id: HIGH, name: 'High' },
        ],
        defaultEffort: HIGH,
      },
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (process.env.DSH_CLI_MOCK_FAILURE === '1') {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'CLI mock provider failed' } } }
      return
    }
    if (process.env.DSH_CLI_MOCK_EVIDENCE === '1') {
      // SPEC-04 evidence mode: deterministic structured extraction for the semantic
      // channel. Counting lets the suites assert zero dispatch while the switch is off.
      const counters = globalThis as { __spec04EvidenceCalls?: number }
      counters.__spec04EvidenceCalls = (counters.__spec04EvidenceCalls ?? 0) + 1
      const output = evidenceOutputFor(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: output }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: output } }
      yield { type: 'usage', usage: { inputTokens: 31, outputTokens: 17 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (process.env.DSH_CLI_MOCK_EVIDENCE === 'fail') {
      const counters = globalThis as { __spec04EvidenceCalls?: number }
      counters.__spec04EvidenceCalls = (counters.__spec04EvidenceCalls ?? 0) + 1
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'evidence mock failure' } } }
      return
    }
    if (process.env.DSH_CLI_MOCK_EVIDENCE === 'garbage') {
      const counters = globalThis as { __spec04EvidenceCalls?: number }
      counters.__spec04EvidenceCalls = (counters.__spec04EvidenceCalls ?? 0) + 1
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'not json at all' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'not json at all' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (process.env.DSH_CLI_MOCK_COUNT === '1') {
      const counters = globalThis as { __spec02LlmCalls?: number }
      counters.__spec02LlmCalls = (counters.__spec02LlmCalls ?? 0) + 1
    }
    // Scan backwards: some tool pipelines append trailing non-result messages after the
    // tool result; the reply branch must still trigger for any completed tool call.
    const toolResult = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
      ?? [...options.messages].reverse().map(message => message.content.find(block => block.type === 'tool-result')).find(block => block !== undefined)
    if (toolResult === undefined) {
      if (process.env.DSH_CLI_MOCK_TOOL === 'sci_run_code' || process.env.DSH_CLI_MOCK_TOOL === 'plink_cli') {
        const toolName = process.env.DSH_CLI_MOCK_TOOL
        const toolArgs = JSON.stringify(JSON.parse(process.env.DSH_CLI_MOCK_TOOL_ARGS ?? '{}'))
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: CallId('cli-smoke-call'), name: toolName, argumentsDelta: toolArgs }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('cli-smoke-call'), name: toolName, arguments: toolArgs } }
        yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const command = process.env.DSH_CLI_MOCK_COMMAND ?? 'printf CLI_TOOL_ROUND_TRIP'
      const args = JSON.stringify({ command, description: 'Prove the CLI tool round trip.' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('cli-smoke-call'), name: 'bash', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('cli-smoke-call'), name: 'bash', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const toolText = toolResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reply = `CLI tool round trip complete: ${toolText.trim()}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'cli-mock-llm'
export const inject = ['llm']

const EVIDENCE_SYSTEM_MARKER = 'AnimalGE evidence candidate-semantics extractor'

/**
 * Deterministic extraction fixture for the SPEC-04 REAL composition. The semantic channel
 * reconstructs its messages from the persisted canonical requestPayload, so the span is
 * derived from the actual last assistant message the projection carried — the fixture can
 * never invent text that was not model-visible (D-164 reuse semantics).
 */
function evidenceOutputFor(options: GenerateOptions): string {
  const assistant = [...options.messages].reverse().find(message => message.role === 'assistant')
  const system = options.system ?? ''
  if (!system.includes(EVIDENCE_SYSTEM_MARKER) || assistant === undefined) {
    return JSON.stringify({
      schemaVersion: 'animalge.semantic-extraction/v1',
      candidates: [],
      relations: [],
      sameAsProposals: [],
      runSelections: [],
    })
  }
  const text = assistant.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  const spanEnd = Math.min(24, text.length)
  const candidateText = text.slice(0, spanEnd)
  return [
    '```json',
    JSON.stringify({
      schemaVersion: 'animalge.semantic-extraction/v1',
      candidates: [
        { localId: 'c1', sourceEventSeq: Number(process.env.DSH_CLI_MOCK_EVIDENCE_SEQ ?? '-1'), spanStart: 0, spanEnd, subtype: 'interpretation', text: candidateText },
        { localId: 'c2', sourceEventSeq: Number(process.env.DSH_CLI_MOCK_EVIDENCE_SEQ ?? '-1'), spanStart: 0, spanEnd, subtype: 'limitation', text: candidateText },
      ],
      relations: [
        { type: 'qualifies', fromRef: { kind: 'BatchCandidate', localId: 'c2' }, toRef: { kind: 'BatchCandidate', localId: 'c1' }, sourceEventSeqs: [Number(process.env.DSH_CLI_MOCK_EVIDENCE_SEQ ?? '-1')] },
      ],
      sameAsProposals: [],
      runSelections: [],
    }),
    '```',
  ].join('\n')
}

/** Register the keyless `cli-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['cli-mock'], new CliMockAdapter())
  ctx.on('agent/request', async ({ step }, next) => {
    const config = await next()
    return step === 2 ? { ...config, reasoningEffort: OFF } : config
  })
}
