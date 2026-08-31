// SPEC-05 §13.2 mechanical constraints: the service is read-only over the owner store
// (the only non-query paths are the markSeen and processBacklog owner functions), and
// the UI never imports the evidence-core owner package.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SERVICE_SRC = join(import.meta.dirname, '..', 'src')

describe('SPEC-05 mechanical constraints', () => {
  it('evidence-service source contains zero sessionProjections references (D-154)', () => {
    const files = ['index.ts', 'internal.ts', 'preview.ts', 'types.ts'] as const
    for (const file of files) {
      const text = readFileSync(join(SERVICE_SRC, file), 'utf8')
      expect(text.includes('sessionProjections'), `${file} references sessionProjections`).toBe(false)
    }
  })

  it('evidence-service source calls no Store write method (both non-query paths go through evidence-core owner functions, §12.2)', () => {
    // The service's only non-query verbs are `markSeen` and `processBacklog`, both of which
    // must call the exported evidence-core owner functions (markIssuesSeen / processBacklog) —
    // never a Store write method directly.
    const WRITE_METHODS = ['saveCapture(', 'commit(', 'failAttempt(', 'cancelAttempt(', 'bootstrap(', 'putMaterialRecord(', 'updateSemanticSwitch(', 'startSemanticAttempt(', 'markIssuesSeenRows(', 'processBacklogRow(', 'recomputeIssuesFor(', 'admitOutbox(']
    const files = ['index.ts', 'internal.ts', 'preview.ts'] as const
    for (const file of files) {
      const text = readFileSync(join(SERVICE_SRC, file), 'utf8')
      for (const method of WRITE_METHODS) {
        expect(text.includes(method), `${file} calls Store write method ${method}`).toBe(false)
      }
    }
  })

  it('ui-evidence source has zero evidence-core imports (§3.3 single read channel)', async () => {
    const { readdirSync, statSync } = await import('node:fs')
    const walk = (dir: string): string[] => {
      const entries: string[] = []
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) entries.push(...walk(path))
        else if (path.endsWith('.ts') || path.endsWith('.tsx')) entries.push(path)
      }
      return entries
    }
    const uiDir = join(import.meta.dirname, '..', '..', '..', 'client', 'ui-evidence', 'src')
    for (const file of walk(uiDir)) {
      const text = readFileSync(file, 'utf8')
      const valueImport = /import\s+\{[^}]*\}\s+from\s+'@deepseek-ai\/dsh-evidence-core'/.test(text)
      const defaultImport = /import\s+\w+\s+from\s+'@deepseek-ai\/dsh-evidence-core'/.test(text)
      expect(valueImport || defaultImport, `${file} has a runtime evidence-core import`).toBe(false)
    }
  })
})
