/** The single ctx.llm call site for the semantic channel (SPEC-04 §4.2, mechanical §11.2 constraint). */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { canonicalJson } from '../canonical-json.ts'
import type { EvidenceModelRouteV1 } from './model-route.ts'
import type { VerifiedModelRequest } from './model-request.ts'
import type { SemanticExtractionOutput } from './output-schema.ts'

export type ModelCallTerminal = 'succeeded' | 'aborted' | 'timed_out' | 'failed'

/** Aggregated outcome of one dispatched evidence model call (result side, SPEC-04 §6.3). */
export interface ModelCallOutcome {
  readonly terminal: ModelCallTerminal
  readonly output: SemanticExtractionOutput | null
  readonly outputText: string
  readonly usage: JsonValue | null
  readonly errorDigest: string | null
}

export class ModelCallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ModelCallError'
  }
}

const MODEL_CALL_TIMEOUT_CODE = 'semantic-model-timeout'

/**
 * Dispatch one already-persisted model request through the explicit route (SPEC-04 §4.2).
 * The messages/system/generation parameters are rebuilt from the SAME canonical
 * requestPayload bytes that were persisted (D-164: dispatch reuses the recorded input);
 * the signal deadline never enters the payload. Streaming chunks are aggregated; a
 * timeout aborts the stream and settles as timed_out; a parse failure is a failed call
 * (retryable at the lane layer), never a partial output.
 */
export async function dispatchEvidenceModelCall(options: {
  readonly ctx: Context
  readonly route: EvidenceModelRouteV1
  readonly request: VerifiedModelRequest
  readonly signal?: AbortSignal
}): Promise<ModelCallOutcome> {
  const payload = options.request.data.requestPayload as {
    system?: unknown
    messages?: Array<{ role?: unknown; content?: unknown }>
    generationParams?: unknown
  }
  if (!Array.isArray(payload.messages)) throw new ModelCallError('payload_invalid', 'requestPayload.messages must be an array')
  // D-164: dispatch reuses the persisted canonical bytes verbatim. The canonical form stores
  // each message's visible text; the wire reconstruction wraps exactly that text in one text
  // block per message — an isomorphic projection that adds no model-visible content.
  const messages = payload.messages.map((message, index) => ({
    id: MessageId(`msg-semantic-${String(index)}`),
    role: message.role === 'assistant' ? 'assistant' as const : message.role === 'system' ? 'system' as const : 'user' as const,
    content: [{ type: 'text' as const, text: typeof message.content === 'string' ? message.content : '' }],
    source: { kind: 'plugin' as const, plugin: 'evidence-core' },
  }))
  const system = typeof payload.system === 'string' ? payload.system : undefined
  const params = (typeof payload.generationParams === 'object' && payload.generationParams !== null ? payload.generationParams : {}) as Record<string, unknown>
  const startedAt = Date.now()
  const timer = new AbortController()
  const armTimeout = (): void => {
    setTimeout(() => { timer.abort(new Error(MODEL_CALL_TIMEOUT_CODE)) }, Math.max(0, startedAt + options.route.timeoutMs - Date.now()))
  }
  armTimeout()
  const outerSignal = options.signal === undefined ? timer.signal : AbortSignal.any([options.signal, timer.signal])
  const timedOut = (): boolean => {
    const reason = (timer.signal.reason as Error | undefined)?.message
    return timer.signal.aborted && String(reason).includes(MODEL_CALL_TIMEOUT_CODE)
  }
  let usage: JsonValue | null = null
  const chunks: string[] = []
  const llm = options.ctx.get('llm')
  if (llm === undefined) {
    return {
      terminal: 'failed',
      output: null,
      outputText: '',
      usage: null,
      errorDigest: digestOf('llm_service_missing'),
    }
  }
  try {
    const stream = llm.stream({
      provider: options.route.provider,
      model: options.route.model,
      ...(system === undefined ? {} : { system }),
      messages: messages,
      ...(typeof params.reasoningEffort === 'string' ? { reasoningEffort: params.reasoningEffort as never } : {}),
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(typeof params.maxTokens === 'number' ? { maxTokens: params.maxTokens } : {}),
      ...(Array.isArray(params.stop) ? { stop: params.stop as string[] } : {}),
      signal: outerSignal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        chunks.push(chunk.text)
      } else if (chunk.type === 'usage') {
        usage = chunk.usage as unknown as JsonValue
      } else if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        return {
          terminal: timedOut() ? 'timed_out' : 'failed',
          output: null,
          outputText: chunks.join(''),
          usage,
          errorDigest: digestOf(`finish_error:${chunk.reason.failure.message}`),
        }
      } else if (chunk.type === 'finish' && chunk.reason.kind === 'aborted') {
        return {
          terminal: timedOut() ? 'timed_out' : 'aborted',
          output: null,
          outputText: chunks.join(''),
          usage,
          errorDigest: digestOf(`finish_aborted:${chunk.reason.failure.message}`),
        }
      }
    }
  } catch (error) {
    return {
      terminal: options.signal?.aborted === true ? 'aborted' : timedOut() ? 'timed_out' : 'failed',
      output: null,
      outputText: chunks.join(''),
      usage,
      errorDigest: digestOf(error instanceof Error ? error.message : String(error)),
    }
  }
  const outputText = chunks.join('')
  const parsed = parseExtractionOutput(outputText)
  return {
    terminal: 'succeeded',
    output: parsed,
    outputText,
    usage,
    errorDigest: parsed === null ? digestOf('unparseable_model_output') : null,
  }
}

function digestOf(message: string): string {
  // Short stable error identity; full messages never enter durable model-call records.
  let hash = 0x811c9dc5
  for (let index = 0; index < message.length; index++) {
    hash ^= message.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a:${String(hash)}`
}

/**
 * Parse the aggregated model text into the strict extraction shape (SPEC-04 §7.3).
 * A single fenced JSON block is tolerated; any parse failure returns null — the call
 * then settles as a retryable model failure, never a partial materialization.
 */
export function parseExtractionOutput(text: string): SemanticExtractionOutput | null {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed)
  const candidate = fenced === null ? trimmed : fenced[1] ?? ''
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as SemanticExtractionOutput
  } catch {
    return null
  }
}

/** Canonical digest for accepted structured outputs (§6.3 acceptedOutputDigest). */
export function outputDigestOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value as JsonValue)).digest('hex')}`
}
