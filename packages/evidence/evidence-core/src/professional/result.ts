/** Shared minimal canonical result, JSON renderer, and replay-only generic card (SPEC-03 §9.4). */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ProfessionalToolResultV1 } from '../types.ts'

/** Bounded meta projected into persistent `tool/result.meta` for the generic card replay. */
export interface ProfessionalResultMeta {
  readonly toolName: string
  readonly runId: string
  readonly outcome: string
  readonly outputCompleteness: string
  readonly outputCompletenessReason: string | null
  readonly outputManifestRef: string | null
  readonly receiptSubmissionRef: string
  readonly outputs: readonly { readonly role: string; readonly artifactVersionRef: string }[]
}

/** The one shared, deterministic, no-LLM JSON renderer for every professional Tool (§9.4). */
export function renderProfessionalResult(value: ProfessionalToolResultV1): ContentBlock[] {
  const line = {
    runId: value.runId,
    outcome: value.outcome,
    outputCompleteness: value.outputCompleteness,
    outputCompletenessReason: value.outputCompletenessReason,
    outputManifestRef: value.outputManifestRef,
    outputs: value.outputs.map(output => ({ role: output.role, artifactVersionRef: output.artifactVersionRef })),
    receiptSubmissionRef: value.receiptSubmissionRef,
  }
  return [{ type: 'text', text: JSON.stringify(line) }]
}

/** Bounded presentationMeta: never the manifest, receipt body, or artifact content (§9.4). */
export function professionalPresentationMeta(toolName: string, value: ProfessionalToolResultV1): ProfessionalResultMeta {
  return {
    toolName,
    runId: value.runId,
    outcome: value.outcome,
    outputCompleteness: value.outputCompleteness,
    outputCompletenessReason: value.outputCompletenessReason,
    outputManifestRef: value.outputManifestRef,
    receiptSubmissionRef: value.receiptSubmissionRef,
    outputs: value.outputs.map(output => ({ role: output.role, artifactVersionRef: output.artifactVersionRef })),
  }
}

function decodeMeta(meta: unknown): ProfessionalResultMeta | null {
  if (typeof meta !== 'object' || meta === null) return null
  const raw = meta as {
    toolName?: unknown
    runId?: unknown
    outcome?: unknown
    outputCompleteness?: unknown
    receiptSubmissionRef?: unknown
  }
  if (typeof raw.toolName !== 'string' || typeof raw.runId !== 'string' || typeof raw.outcome !== 'string') return null
  return meta as ProfessionalResultMeta
}

/**
 * The shared replay-only generic result card (§9.4): rebuilt solely from persisted
 * content/meta. The D-195 case renders three separated lines — run terminal state,
 * unverified outputs, and zero formal Evidence outputs — never one merged "all done".
 */
export function professionalResultCardLines(meta: ProfessionalResultMeta): string[] {
  const runLine = `运行：${meta.outcome === 'succeeded' ? '已正常结束' : meta.outcome}`
  if (meta.outputCompleteness === 'unknown' && meta.outputCompletenessReason === 'output_plan_absent') {
    return [
      runLine,
      '输出验证：未完成——当前调用没有 Output Plan',
      '正式 Evidence 输出：0',
    ]
  }
  const roles = meta.outputs.map(output => output.role).join(', ')
  return [
    runLine,
    `输出验证：${meta.outputCompleteness}${meta.outputCompletenessReason === null ? '' : `（${meta.outputCompletenessReason}）`}`,
    `正式 Evidence 输出：${String(meta.outputs.length)}${roles === '' ? '' : `（${roles}）`}`,
  ]
}

/** presentResult projection for defineTool: a generic card from persisted meta only. */
export function presentProfessionalResult(meta: unknown): { card: 'generic'; title: string; content: ContentBlock[] } | undefined {
  const decoded = decodeMeta(meta)
  if (decoded === null) return undefined
  return {
    card: 'generic',
    title: `${decoded.toolName} ${decoded.outcome}`,
    content: [{ type: 'text', text: professionalResultCardLines(decoded).join('\n') }],
  }
}
