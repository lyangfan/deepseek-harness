/** S03-A15: shared canonical result, bounded meta, and the three-line D-195 card. */

import { describe, expect, it } from 'vitest'
import { registerSuiteSummary } from './summary.ts'
import { professionalPresentationMeta, professionalResultCardLines, presentProfessionalResult, renderProfessionalResult } from '../src/professional/result.ts'
import type { ProfessionalToolResultV1 } from '../src/types.ts'

registerSuiteSummary({ suiteId: 'professional-result', acceptanceIds: ['S03-A15'], sessionPersistence: [''], evidenceStorage: [''] })

const successResult: ProfessionalToolResultV1 = {
  runId: 'er_x',
  outcome: 'succeeded',
  outputCompleteness: 'complete',
  outputCompletenessReason: null,
  outputManifestRef: 'omf_1',
  outputs: [{ role: 'qc_bed', artifactVersionRef: 'av_1' }],
  receiptSubmissionRef: 'rs_1',
}

const noPlanResult: ProfessionalToolResultV1 = {
  runId: 'er_y',
  outcome: 'succeeded',
  outputCompleteness: 'unknown',
  outputCompletenessReason: 'output_plan_absent',
  outputManifestRef: 'omf_2',
  outputs: [],
  receiptSubmissionRef: 'rs_2',
}

describe('S03-A15 shared result projection', () => {
  it('renders the minimal referencing JSON without tables, logs, or report bodies', () => {
    const blocks = renderProfessionalResult(successResult)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.type).toBe('text')
    const parsed = JSON.parse(blocks[0]?.type === 'text' ? blocks[0].text : '{}') as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['outcome', 'outputCompleteness', 'outputCompletenessReason', 'outputManifestRef', 'outputs', 'receiptSubmissionRef', 'runId'])
  })

  it('presentationMeta stays bounded: only references, never content', () => {
    const meta = professionalPresentationMeta('plink_cli', successResult)
    expect(meta.toolName).toBe('plink_cli')
    expect(meta.outputs).toHaveLength(1)
    expect(JSON.stringify(meta).length).toBeLessThan(500)
    expect(JSON.stringify(meta)).not.toContain('table bytes')
  })

  it('the D-195 card renders three separated lines and never a merged all-done', () => {
    const meta = professionalPresentationMeta('plink_cli', noPlanResult)
    const lines = professionalResultCardLines(meta)
    expect(lines).toEqual(['运行：已正常结束', '输出验证：未完成——当前调用没有 Output Plan', '正式 Evidence 输出：0'])
  })

  it('the replay card only rebuilds from persisted meta and returns undefined for foreign shapes', () => {
    const card = presentProfessionalResult(professionalPresentationMeta('plink_cli', successResult))
    expect(card?.card).toBe('generic')
    expect(card?.content[0]).toBeDefined()
    expect(presentProfessionalResult({ nope: 1 })).toBeUndefined()
  })
})
