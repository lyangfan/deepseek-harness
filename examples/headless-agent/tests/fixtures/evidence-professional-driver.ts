#!/usr/bin/env node
/** Real Loader/Agent driver for the SPEC-03 professional composition gate (S03-A18). */

import { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { freezeCurrentEnvironment } from '@deepseek-ai/dsh-evidence-core'

const NAME = 'evidence-professional-test-driver'
const [configPath, ...taskParts] = process.argv.slice(2)
if (configPath === undefined || taskParts.length === 0) throw new Error(`${NAME}: expected <config-path> <task...>`)

interface ProfessionalPayload {
  type: string
  snapshotDigest: string | null
  commitCount: number
  acceptanceCount: number
  acceptedCount: number
  receiptBackedRuns: number
  artifactNodes: number
  contextNodes: number
  usedEdges: number
  generatedByEdges: number
  finalizationCount: number
  manifestCount: number
  reservationReleased: number
  llmCalls: number
}

const REPO_ROOT = resolve(import.meta.dirname, '../../../..')
const FIXTURES = join(REPO_ROOT, 'packages/evidence/evidence-core/tests/fixtures/professional')

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const runtimeCtx = ctx
  const domain = runtimeCtx.storageDomain.get('animalge_evidence')
  const waitFor = (probe: () => boolean, timeoutMs: number, what: string) => new Promise<void>((resolveWait, reject) => {
    const started = Date.now()
    const poll = (): void => {
      if (probe()) resolveWait()
      else if (Date.now() - started > timeoutMs) reject(new Error(`${what} was not reached`))
      else setTimeout(poll, 20)
    }
    poll()
  })

  // Install the fake software environment as real subprocesses and freeze its
  // TestedEnvironmentRevision through the package's owner API before any session runs.
  const envRoot = join(process.cwd(), '.spec03-fake-env')
  await mkdir(envRoot, { recursive: true })
  const fakePlink = join(envRoot, 'fake-plink')
  await copyFile(join(FIXTURES, 'fake-plink'), fakePlink)
  await chmod(fakePlink, 0o755)
  // Freeze the fake environment through the plugin's own live store (same owner, same
  // domain instance — the only same-process writer beside the plugin itself).
  await freezeCurrentEnvironment({
    ctx: runtimeCtx,
    input: {
      environmentSpecRevision: 'fake-env/v1',
      components: [
        { name: 'plink', kind: 'executable', resolvedPath: fakePlink, sourceRef: 'tests/fixtures/professional/fake-plink' },
      ],
      parseVersion: (_component: string, output: string) => {
        const match = /PLINK v([0-9.a-z]+)/u.exec(output)
        return match === null || match[1] === undefined ? null : `PLINK v${match[1]}`
      },
      inputSchemaRevisions: ['plink-bed-set@v1'],
      signal: new AbortController().signal,
    },
  })

  // Deterministic fake PLINK trio input under the run cwd.
  const bimRows = 4
  const famRows = 6
  const groups = Math.ceil(famRows / 4)
  await writeFile('input.bed', Buffer.concat([Buffer.from([0x6c, 0x1b, 0x01, 0x01]), Buffer.alloc(3 + bimRows * groups - 4)]))
  await writeFile('input.bim', Array.from({ length: bimRows }, (_, i) => `snp${String(i + 1)}\tfake\t${String(i + 1)}\t1\tA\tG`).join('\n') + '\n')
  await writeFile('input.fam', Array.from({ length: famRows }, (_, i) => `id${String(i + 1)}\tid${String(i + 1)}\t0\t0\t1\t-9`).join('\n') + '\n')

  const acceptanceCount = () => domain?.table('receipt_acceptances').size ?? 0
  const committedHead = () => {
    const heads = domain === undefined ? [] : [...domain.table('heads').entries()]
    const head = heads[0]?.[1] as { snapshotDigest?: string | null } | undefined
    return typeof head?.snapshotDigest === 'string' ? head.snapshotDigest : null
  }
  const summarize = (): ProfessionalPayload => {
    const snapshotDigest = committedHead()
    const stored = snapshotDigest === null || domain === undefined
      ? undefined
      : domain.table('snapshots').get(snapshotDigest) as { payload?: { nodes?: Array<{ nodeKind: string; payloadSchema?: string }>; edges?: Array<{ edgeType: string }> } } | undefined
    const nodes = stored?.payload?.nodes ?? []
    const edges = stored?.payload?.edges ?? []
    return {
      type: 'professional',
      snapshotDigest,
      commitCount: domain?.table('head_commits').size ?? 0,
      acceptanceCount: acceptanceCount(),
      acceptedCount: domain === undefined ? 0 : [...domain.table('receipt_acceptances').entries()].filter(([, row]) => (row as { verdict?: string }).verdict === 'accepted').length,
      receiptBackedRuns: nodes.filter(node => node.payloadSchema === 'animalge.run.receipt-backed/v1').length,
      artifactNodes: nodes.filter(node => node.nodeKind === 'ArtifactVersion').length,
      contextNodes: nodes.filter(node => node.nodeKind === 'ContextEntity').length,
      usedEdges: edges.filter(edge => edge.edgeType === 'used').length,
      generatedByEdges: edges.filter(edge => edge.edgeType === 'generated_by' && nodes.some(n => n.nodeKind === 'ArtifactVersion')).length,
      finalizationCount: domain?.table('output_finalizations').size ?? 0,
      manifestCount: domain?.table('output_manifests').size ?? 0,
      reservationReleased: domain === undefined ? 0 : [...domain.table('output_reservations').entries()].filter(([, row]) => (row as { state?: string }).state === 'released').length,
      llmCalls: (globalThis as { __spec02LlmCalls?: number }).__spec02LlmCalls ?? 0,
    }
  }

  if (process.env.SPEC03_RESUME_ONLY === '1') {
    const resumed = await runtimeCtx.agents.resume({ resumeSessionId: SessionId('spec03-loader-agent') })
    await resumed.dispose()
    await waitFor(() => acceptanceCount() >= 1 && committedHead() !== null && summarize().receiptBackedRuns >= 1, 30_000, 'post-crash acceptance and receipt-backed head')
    const payload = summarize()
    process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(0))
  } else if (process.env.SPEC03_CRASH_AFTER_SUBMISSION === '1') {
    await handleCrashWindow()
  } else {
    const selection = { provider: 'cli-mock', model: 'cli-mock' }
    const handle = await runtimeCtx.agents.create({
      sessionId: SessionId('spec03-loader-agent'),
      meta: { cwd: process.cwd(), agentPreset: 'animalge-open-test' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        const selected: ModelSelectionRef = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selected)
      },
    })
    void handle
    const result = await runFixtureTurn(ctx, { task: taskParts.join(' ') })
    await waitFor(() => acceptanceCount() >= 1 && summarize().receiptBackedRuns >= 1 && summarize().finalizationCount >= 1, 30_000, 'receipt-backed Snapshot with a finalization marker')
    const payload = { ...result, ...summarize() }
    process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(0))
  }

  function handleCrashWindow(): Promise<never> {
    return runCrashWindow()
  }
  async function runCrashWindow(): Promise<never> {
    const selection = { provider: 'cli-mock', model: 'cli-mock' }
    const handle = await runtimeCtx.agents.create({
      sessionId: SessionId('spec03-loader-agent'),
      meta: { cwd: process.cwd(), agentPreset: 'animalge-open-test' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        const selected: ModelSelectionRef = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selected)
      },
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: taskParts.join(' ') }],
      source: { kind: 'user' },
    }))
    await new Promise<never>((_park, fail) => {
      const timeout = setTimeout(() => { fail(new Error('crash window expired')) }, 60_000)
      const stop = runtimeCtx.on('session/event', (observed) => {
        if (observed.id !== handle.agent.session.id) return
        void (async () => {
          if ((domain?.table('receipt_submissions').size ?? 0) < 1) return
          stop()
          await runtimeCtx.sessions.flush(handle.agent.session)
          await writeFile('.spec03-crash-marker.json', JSON.stringify({ type: 'crash-after-submission', submissions: domain?.table('receipt_submissions').size }))
          clearTimeout(timeout)
          process.kill(process.pid, 'SIGKILL')
        })()
      }, { global: true })
    })
    throw new Error('unreachable crash window exit')
  }
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
