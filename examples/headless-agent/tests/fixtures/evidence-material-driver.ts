#!/usr/bin/env node
/** Real Loader/Agent/Runner driver for the SPEC-02 Evidence material composition gate. */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { writeFile } from 'node:fs/promises'

const NAME = 'evidence-material-test-driver'
const [configPath, ...taskParts] = process.argv.slice(2)
if (configPath === undefined || taskParts.length === 0) throw new Error(`${NAME}: expected <config-path> <task...>`)

interface MaterialPayload {
  type: string
  snapshotDigest: string | null
  headCount: number
  commitCount: number
  acceptanceCount: number
  acceptedCount: number
  receiptBackedRuns: number
  artifactNodes: number
  contextNodes: number
  usedEdges: number
  generatedByEdges: number
  llmCalls: number
}

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const runtimeCtx = ctx
  const domain = runtimeCtx.storageDomain.get('animalge_evidence')
  const waitFor = (probe: () => boolean, timeoutMs: number, what: string) => new Promise<void>((resolve, reject) => {
    const started = Date.now()
    const poll = (): void => {
      if (probe()) resolve()
      else if (Date.now() - started > timeoutMs) reject(new Error(`${what} was not reached`))
      else setTimeout(poll, 20)
    }
    poll()
  })
  const acceptanceCount = () => domain?.table('receipt_acceptances').size ?? 0
  const committedHead = () => {
    const heads = domain === undefined ? [] : [...domain.table('heads').entries()]
    const head = heads[0]?.[1] as { snapshotDigest?: string | null } | undefined
    const commitCount = domain?.table('head_commits').size ?? 0
    return typeof head?.snapshotDigest === 'string' && commitCount >= 1 ? head.snapshotDigest : null
  }
  const summarize = (): MaterialPayload => {
    const snapshotDigest = committedHead()
    const stored = snapshotDigest === null || domain === undefined
      ? undefined
      : domain.table('snapshots').get(snapshotDigest) as { payload?: { nodes?: Array<{ nodeKind: string; payloadSchema?: string }>; edges?: Array<{ edgeType: string }> } } | undefined
    const nodes = stored?.payload?.nodes ?? []
    const edges = stored?.payload?.edges ?? []
    return {
      type: 'material',
      snapshotDigest,
      headCount: domain === undefined ? 0 : domain.table('heads').size,
      commitCount: domain?.table('head_commits').size ?? 0,
      acceptanceCount: acceptanceCount(),
      acceptedCount: domain === undefined ? 0 : [...domain.table('receipt_acceptances').entries()].filter(([, row]) => (row as { verdict?: string }).verdict === 'accepted').length,
      receiptBackedRuns: nodes.filter(node => node.payloadSchema === 'animalge.run.receipt-backed/v1').length,
      artifactNodes: nodes.filter(node => node.nodeKind === 'ArtifactVersion').length,
      contextNodes: nodes.filter(node => node.nodeKind === 'ContextEntity').length,
      usedEdges: edges.filter(edge => edge.edgeType === 'used').length,
      generatedByEdges: edges.filter(edge => edge.edgeType === 'generated_by' && nodes.some(n => n.nodeKind === 'ArtifactVersion')).length,
      llmCalls: (globalThis as { __spec02LlmCalls?: number }).__spec02LlmCalls ?? 0,
    }
  }

  if (process.env.SPEC02_RESUME_ONLY === '1') {
    const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('spec02-loader-agent') })
    await resumed.dispose()
    await waitFor(() => acceptanceCount() >= 1 && committedHead() !== null && summarize().receiptBackedRuns >= 1, 20_000, 'post-crash acceptance and receipt-backed head')
    const payload = summarize()
    process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(0))
  } else {
    const selection = { provider: 'cli-mock', model: 'cli-mock' }
    const handle = await ctx.agents.create({
      sessionId: SessionId('spec02-loader-agent'),
      meta: { cwd: process.cwd(), agentPreset: 'animalge-open-test' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        const selected: ModelSelectionRef = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selected)
      },
    })
    if (process.env.SPEC02_CRASH_AFTER_SUBMISSION === '1') {
      // Kill once the Submission is durable but before the tool result can settle,
      // so the restart must complete acceptance from the persisted prefix.
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
            await writeFile('.spec02-crash-marker.json', JSON.stringify({ type: 'crash-after-submission', submissions: domain?.table('receipt_submissions').size }))
            clearTimeout(timeout)
            process.kill(process.pid, 'SIGKILL')
          })()
        }, { global: true })
      })
    } else {
      const result = await runFixtureTurn(ctx, { task: taskParts.join(' ') })
      await waitFor(() => acceptanceCount() >= 1 && summarize().receiptBackedRuns >= 1, 20_000, 'receipt-backed committed Snapshot')
      const payload = { ...result, ...summarize() }
      process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(0))
    }
  }
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
