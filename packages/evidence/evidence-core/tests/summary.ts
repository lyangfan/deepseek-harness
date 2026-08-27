/**
 * SPEC-01 machine-readable suite summaries (spec §12.1): every spec-specific
 * suite writes one JSON artifact to `<repo>/.artifacts/spec-01-evidence-core/`
 * with the DSH revision, candidate package digest, per-test results, backend
 * matrix and fixture digests. The exit code is appended by the gate runner
 * because a suite cannot observe its own process exit status.
 */

import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, onTestFinished } from 'vitest'

const sha256 = (data: string | Buffer): string => `sha256:${createHash('sha256').update(data).digest('hex')}`

const packageRoot = fileURLToPath(new URL('../', import.meta.url))

function git(query: string): string | undefined {
  try {
    return execSync(`git ${query}`, { cwd: packageRoot, encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

const repoRoot = git('rev-parse --show-toplevel')

async function digestFile(path: string): Promise<string> {
  return sha256(await readFile(path))
}

async function collectFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.DS_Store' || entry.name.endsWith('.tsbuildinfo')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await collectFiles(path, out)
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** Deterministic digest over the sorted per-file SHA-256 manifest of the package. */
async function packageContentDigest(): Promise<{ digest: string; file_count: number }> {
  const files = (await collectFiles(packageRoot)).sort()
  const manifest = await Promise.all(files.map(async path => `${path.slice(packageRoot.length)}  ${await digestFile(path)}`))
  return { digest: sha256(manifest.join('\n')), file_count: files.length }
}

export interface SuiteSummaryOptions {
  /** Stable suite identifier used as the artifact filename. */
  readonly suiteId: string
  /** Acceptance IDs this suite evidences. */
  readonly acceptanceIds: readonly string[]
  /** Session persistence backends exercised by this suite ('' axis for pure unit suites). */
  readonly sessionPersistence: readonly string[]
  /** Evidence storage backends exercised by this suite. */
  readonly evidenceStorage: readonly string[]
  /** Repository-relative fixture paths whose digests must be pinned. */
  readonly fixtures?: readonly string[]
}

interface RecordedTest {
  readonly id: string
  readonly status: string
  readonly duration_ms: number
}

const startedAt = new Date()
const recordedTests: RecordedTest[] = []
let suitePayload: Record<string, unknown> = {}
let registered: SuiteSummaryOptions | undefined

/** Merge suite-specific key measurements (digests, percentiles, counters) into the artifact. */
export function recordSummaryPayload(payload: Record<string, unknown>): void {
  suitePayload = { ...suitePayload, ...payload }
}

function fullNameOf(test: { name: string; suite?: { name?: string; suite?: unknown } }): string {
  const names: string[] = []
  let node: { name?: string; suite?: unknown } | undefined = test.suite
  while (node !== undefined) {
    if (node.name !== undefined) names.unshift(node.name)
    node = node.suite as { name?: string; suite?: unknown } | undefined
  }
  return [...names, test.name].join(' > ')
}

/** Register per-test collection and the afterAll artifact write for one suite file. */
export function registerSuiteSummary(options: SuiteSummaryOptions): void {
  if (registered !== undefined) throw new Error(`summary already registered for '${registered.suiteId}'`)
  registered = options

  beforeEach(() => {
    const startedAt = performance.now()
    onTestFinished((context) => {
      const test = context.task
      recordedTests.push({
        id: `${options.suiteId}::${fullNameOf(test)}`,
        status: test.result?.state ?? 'unknown',
        duration_ms: typeof test.result?.duration === 'number'
          ? Math.round(test.result.duration)
          : Math.round(performance.now() - startedAt),
      })
    })
  })

  afterAll(async () => {
    const endedAt = new Date()
    const [manifest, pkgRaw] = await Promise.all([packageContentDigest(), readFile(join(packageRoot, 'package.json'), 'utf8')])
    const pkg = JSON.parse(pkgRaw) as { name: string; version: string }
    const fixtureDigests: Record<string, string> = {}
    for (const fixture of options.fixtures ?? []) {
      if (repoRoot !== undefined) fixtureDigests[fixture] = await digestFile(join(repoRoot, fixture))
    }
    const counts = { total: recordedTests.length, pass: 0, fail: 0, skip: 0 }
    for (const test of recordedTests) {
      if (test.status === 'pass') counts.pass++
      else if (test.status === 'fail') counts.fail++
      else if (test.status === 'skipped') counts.skip++
    }
    const summary = {
      schema: 'spec-01-suite-summary/v1',
      spec_id: 'SPEC-01',
      suite_id: options.suiteId,
      acceptance_ids: options.acceptanceIds,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: endedAt.getTime() - startedAt.getTime(),
      command: {
        cwd: process.cwd(),
        worker_argv: process.argv,
        npm_lifecycle_event: process.env.npm_lifecycle_event ?? null,
      },
      environment: { node: process.version, platform: `${process.platform}/${process.arch}` },
      dsh: { revision: git('rev-parse HEAD'), branch: git('branch --show-current') },
      package: { name: pkg.name, version: pkg.version, content_digest: manifest.digest, content_file_count: manifest.file_count },
      backend_matrix: { session_persistence: options.sessionPersistence, evidence_storage: options.evidenceStorage },
      fixtures: fixtureDigests,
      tests: recordedTests,
      counts,
      payload: suitePayload,
      exit_code: null,
    }
    if (repoRoot !== undefined) {
      const artifacts = join(repoRoot, '.artifacts', 'spec-01-evidence-core')
      await mkdir(artifacts, { recursive: true })
      await writeFile(join(artifacts, `${options.suiteId}.summary.json`), `${JSON.stringify(summary, null, 2)}\n`)
    }
  })
}
