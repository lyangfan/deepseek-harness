// SPEC-05 §13.2 mechanical constraints: ui-evidence source has zero runtime
// evidence-core imports, zero sessionProjections references, and registers exactly
// the three slots from §9.1.
// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(import.meta.dirname, '..', 'src')

function walk(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files.push(...walk(p))
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) files.push(p)
  }
  return files
}

describe('SPEC-05 ui-evidence mechanical constraints', () => {
  it('has zero runtime evidence-core imports (§3.3 single read channel)', () => {
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8')
      const valueImport = /import\s+\{[^}]*\}\s+from\s+'@deepseek-ai\/dsh-evidence-core'/.test(text)
      const defaultImport = /import\s+\w+\s+from\s+'@deepseek-ai\/dsh-evidence-core'/.test(text)
      expect(valueImport || defaultImport, `${file} has a runtime evidence-core import`).toBe(false)
    }
  })

  it('has zero sessionProjections references (D-154)', () => {
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8')
      expect(text.includes('sessionProjections'), `${file} references sessionProjections`).toBe(false)
    }
  })

  it('registers exactly the three §9.1 slots', () => {
    const indexText = readFileSync(join(SRC, 'client', 'index.ts'), 'utf8')
    const slots = [
      { slot: "'conversation.view'", id: "'evidence'", count: 2 }, // inject + register
      { slot: "'conversation.session.header.actions'", id: "'evidence-status'", count: 2 }, // inject + register
      { slot: "'tool.call.toolview'", id: undefined, count: 2 }, // inject line + loop reference
    ]
    for (const { slot, count } of slots) {
      const occurrences = indexText.split(slot).length - 1
      expect(occurrences, `slot ${slot} registered ${occurrences} times`).toBe(count)
    }
  })

  it('does not register any conversation.chat.node entries', () => {
    const indexText = readFileSync(join(SRC, 'client', 'index.ts'), 'utf8')
    expect(indexText.includes("'conversation.chat.node'")).toBe(false)
  })
})
