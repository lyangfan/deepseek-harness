/** S04-A07 + §11.2 mechanical constraints: explicit route, no implicit inheritance, single ctx.llm site. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelRouteError, resolveEvidenceModelRoute, resolveSemanticProjectionConfig } from '../src/semantic/model-route.ts'

describe('S04-A07 evidenceModel explicit route', () => {
  it('absent config resolves to undefined (not_configured)', () => {
    expect(resolveEvidenceModelRoute(undefined)).toBeUndefined()
    expect(resolveEvidenceModelRoute(null)).toBeUndefined()
    expect(resolveEvidenceModelRoute({})).toBeUndefined()
  })

  const codeOf = (input: unknown): string => {
    try {
      resolveEvidenceModelRoute(input)
    } catch (error) {
      return (error as ModelRouteError).code
    }
    return 'none'
  }

  it('provider and model must be supplied together or not at all', () => {
    expect(() => resolveEvidenceModelRoute({ provider: 'cli-mock' })).toThrow(ModelRouteError)
    expect(codeOf({ provider: 'cli-mock' })).toBe('route_pair_required')
    expect(codeOf({ model: 'm1' })).toBe('route_pair_required')
  })

  it('a valid pair resolves with the frozen default timeout and passthrough generation params', () => {
    const route = resolveEvidenceModelRoute({ provider: 'cli-mock', model: 'evidence-1' })
    expect(route).toMatchObject({ provider: 'cli-mock', model: 'evidence-1', timeoutMs: 120_000 })
    const tuned = resolveEvidenceModelRoute({ provider: 'p', model: 'm', reasoningEffort: 'opaque-id', temperature: 0.2, maxTokens: 512, stop: ['\n'], timeoutMs: 5_000 })
    expect(tuned).toMatchObject({ reasoningEffort: 'opaque-id', temperature: 0.2, maxTokens: 512, stop: ['\n'], timeoutMs: 5_000 })
  })

  it('rejects half-typed generation params instead of guessing', () => {
    expect(codeOf({ provider: 'p', model: 'm', maxTokens: 0 })).toBe('route_invalid')
    expect(codeOf({ provider: 'p', model: 'm', reasoningEffort: '  ' })).toBe('route_invalid')
  })

  it('projection bounds default to the frozen spec values and reject non-positive bounds', () => {
    expect(resolveSemanticProjectionConfig(undefined)).toEqual({ perItemTruncationChars: 16_384, toolResultSummaryChars: 2_048,
      runSummaryChars: 1_024 })
    try {
      resolveSemanticProjectionConfig({ perItemTruncationChars: 0 })
      expect.unreachable('bounds must reject')
    } catch (error) {
      expect((error as ModelRouteError).code).toBe('projection_config_invalid')
    }
  })
})

describe('S04 §11.2 mechanical source constraints', () => {
  const src = join(import.meta.dirname, '../src')

  it('ctx.llm is referenced only by the semantic model-call core', () => {
    const offenders: string[] = []
    for (const file of ['index.ts', 'compiler.ts', 'store.ts', 'integrity.ts', 'capture.ts', 'materialize.ts', 'acceptance.ts', 'runner/execute.ts', 'professional/factory.ts', 'semantic/lane.ts', 'semantic/projection.ts', 'semantic/model-request.ts', 'semantic/proposals.ts', 'semantic/candidates.ts', 'semantic/switch.ts', 'semantic/model-route.ts']) {
      const text = readFileSync(join(src, file), 'utf8')
      if (text.includes('ctx.llm')) offenders.push(file)
    }
    expect(offenders).toEqual([])
    const modelCall = readFileSync(join(src, 'semantic/model-call.ts'), 'utf8')
    expect(modelCall.includes('ctx.llm')).toBe(true)
  })

  it('the deterministic snapshot write path consumes ledgers only — no model-call import', () => {
    const compiler = readFileSync(join(src, 'compiler.ts'), 'utf8')
    expect(compiler.includes('model-call')).toBe(false)
    expect(compiler.includes('dispatchEvidenceModelCall')).toBe(false)
  })
})
