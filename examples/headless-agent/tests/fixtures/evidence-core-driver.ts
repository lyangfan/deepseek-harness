#!/usr/bin/env node
/** Real Loader/Agent/Tool driver for the SPEC-01 Evidence composition gate. */

import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { writeFile } from 'node:fs/promises'

const NAME = 'evidence-core-test-driver'
const [configPath, ...taskParts] = process.argv.slice(2)
if (configPath === undefined || taskParts.length === 0) throw new Error(`${NAME}: expected <config-path> <task...>`)

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const domain = ctx.storageDomain.get('animalge_evidence')
  const waitForHead = () => new Promise<{ snapshotDigest: string; headCount: number; commitCount: number }>((resolve, reject) => {
    const started = Date.now()
    const poll = (): void => {
      const heads = domain === undefined ? [] : [...domain.table('heads').entries()]
      const head = heads[0]?.[1] as { snapshotDigest?: string | null } | undefined
      const commitCount = domain?.table('head_commits').size ?? 0
      if (typeof head?.snapshotDigest === 'string' && commitCount >= 1) {
        resolve({ snapshotDigest: head.snapshotDigest, headCount: heads.length, commitCount })
      } else if (Date.now() - started > 10_000) reject(new Error('Evidence head was not published'))
      else setTimeout(poll, 20)
    }
    poll()
  })
  if (process.env.SPEC01_RESTART_ONLY === '1') {
    // Resuming the persisted session is what performs the DSH cold-load repair
    // (interrupted-turn closers are committed durably); disposing it afterwards
    // hands the repaired boundary to the Evidence capture path.
    const resumed = await ctx.agents.resume({ resumeSessionId: SessionId('spec01-loader-agent') })
    await resumed.dispose()
    const head = await waitForHead()
    const persisted = await ctx.sessionPersistence.inspect(SessionId('spec01-loader-agent'))
    const events = persisted.events as ReadonlyArray<{ type: string; data?: { error?: { code?: string } } }>
    const repaired = events.find(event => event.type === 'tool/result' && event.data?.error?.code === 'TOOL_OUTCOME_UNKNOWN')
    let repairedOutcome: string | undefined
    if (domain !== undefined && typeof head.snapshotDigest === 'string') {
      const stored = domain.table('snapshots').get(head.snapshotDigest) as { payload?: { nodes?: Array<{ nodeKind: string; payload?: { outcome?: string } }> } } | undefined
      repairedOutcome = stored?.payload?.nodes?.find(node => node.nodeKind === 'Run')?.payload?.outcome
    }
    process.stdout.write(`${JSON.stringify({
      type: 'recovered', ...head,
      toolCalls: events.filter(event => event.type === 'tool/call').length,
      ...(repaired === undefined ? {} : { repairCode: 'TOOL_OUTCOME_UNKNOWN' }),
      ...(repairedOutcome === undefined ? {} : { repairedOutcome }),
    })}\n`, () => process.exit(0))
  } else {
    const selection = { provider: 'cli-mock', model: 'cli-mock' }
    const handle = await ctx.agents.create({
      sessionId: SessionId('spec01-loader-agent'),
      meta: { cwd: process.cwd(), agentPreset: 'animalge-open-test' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        const selected: ModelSelectionRef = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selected)
      },
    })
    if (process.env.SPEC01_CRASH_MID_TURN === '1') {
      // Kill the process after the tool/call event is durably persisted but before its
      // terminal result, so the restart must settle a real DSH crash repair.
      const runtime = ctx
      const session = handle.agent.session
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: taskParts.join(' ') }],
        source: { kind: 'user' },
      }))
      await new Promise<never>((_park, fail) => {
        const timeout = setTimeout(() => { fail(new Error('mid-turn crash window expired')) }, 30_000)
        const stop = runtime.on('session/event', (observed, event) => {
          if (observed.id !== session.id || event.type !== 'tool/call') return
          stop()
          void (async () => {
            await runtime.sessions.flush(session)
            await writeFile('.spec01-crash-marker.json', JSON.stringify({ type: 'crash-mid-turn', toolCalls: 1 }))
            clearTimeout(timeout)
            process.kill(process.pid, 'SIGKILL')
          })()
        }, { global: true })
      })
    } else {
      const result = await runFixtureTurn(ctx, { task: taskParts.join(' ') })
      const head = await waitForHead()
      const payload = { ...result, ...head }
      if (process.env.SPEC01_CRASH_AFTER_HEAD === '1') {
        await writeFile('.spec01-crash-marker.json', JSON.stringify(payload))
        process.kill(process.pid, 'SIGKILL')
      } else {
        process.stdout.write(`${JSON.stringify(payload)}\n`)
      }
    }
  }
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
