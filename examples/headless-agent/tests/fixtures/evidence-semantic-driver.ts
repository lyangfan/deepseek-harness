#!/usr/bin/env node
/** Real Loader/Agent driver for the SPEC-04 candidate-semantics composition gate. */

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { writeFile } from 'node:fs/promises'

const NAME = 'evidence-semantic-test-driver'
const [configPath, mode, ...taskParts] = process.argv.slice(2)
if (configPath === undefined || mode === undefined || taskParts.length === 0) throw new Error(`${NAME}: expected <config-path> <mode: run|resume> <task...>`)

interface Table<K extends string, V> {
  entries(): IterableIterator<[K, V]>
  get(key: K): V | undefined
  size: number
}

interface HeadRow { snapshotDigest: string | null; headRevision: number }
interface LaneRow { nextSeqExclusive: number }
interface SwitchRow { enabled: boolean }

interface SnapshotProjection {
  schemaSet?: string[]
  semanticWatermark?: unknown
  nodes?: Array<{ nodeKind?: string }>
  edges?: Array<{ family?: string }>
}

interface SemanticPayload {
  type: 'semantic'
  mode: string
  headDigest: string | null
  headRevision: number
  schemaSetCandidate: boolean
  semanticWatermark: string
  candidateNodes: number
  candidateEdges: number
  modelCalls: number
  modelRequestEvents: number
  laneWatermark: number | null
  evidenceCalls: number
}

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const runtimeCtx = ctx
  const domain = runtimeCtx.storageDomain.get('animalge_evidence')
  if (domain === undefined) throw new Error(`${NAME}: animalge_evidence domain missing`)
  const table = <K extends string, V>(name: string) => domain.table(name) as Table<K, V>
  const heads = table<string, HeadRow>('heads')
  const snapshots = table<string, { payload: unknown }>('snapshots')
  const modelCalls = table<string, unknown>('model_calls')
  const semanticLane = table<string, LaneRow>('semantic_lane')
  const semanticSwitch = table<string, SwitchRow>('semantic_switch')

  const waitFor = (probe: () => boolean, timeoutMs: number, what: string) => new Promise<void>((resolve, reject) => {
    const started = Date.now()
    const poll = (): void => {
      if (probe()) resolve()
      else if (Date.now() - started > timeoutMs) reject(new Error(`${what} was not reached`))
      else setTimeout(poll, 25)
    }
    poll()
  })

  const committed = (): { digest: string | null; revision: number } => {
    const row = [...heads.entries()][0]?.[1]
    return { digest: row?.snapshotDigest ?? null, revision: row?.headRevision ?? 0 }
  }

  const payloadOf = (digest: string | null): SnapshotProjection | null => {
    if (digest === null) return null
    return snapshots.get(digest)?.payload as never
  }

  const summarize = (): SemanticPayload => {
    const { digest, revision } = committed()
    const payload = payloadOf(digest)
    const counters = globalThis as { __spec04EvidenceCalls?: number }
    return {
      type: 'semantic',
      mode,
      headDigest: digest,
      headRevision: revision,
      schemaSetCandidate: payload?.schemaSet?.includes('animalge.evidence.candidate/v1') ?? false,
      semanticWatermark: JSON.stringify(payload?.semanticWatermark ?? null),
      candidateNodes: payload?.nodes?.filter(node => node.nodeKind === 'CandidateStatement').length ?? 0,
      candidateEdges: payload?.edges?.filter(edge => edge.family === 'scientific_argument' || edge.family === 'conflict_candidate_identity').length ?? 0,
      modelCalls: modelCalls.size,
      modelRequestEvents: 0,
      laneWatermark: [...semanticLane.entries()][0]?.[1]?.nextSeqExclusive ?? null,
      evidenceCalls: counters.__spec04EvidenceCalls ?? 0,
    }
  }

  const requestEventCount = async (): Promise<number> => {
    const persistence = runtimeCtx.sessionPersistence
    const sessionIds = [...table<string, unknown>('session_graphs').entries()].map(([id]) => id)
    let total = 0
    for (const id of sessionIds) {
      const read = await persistence.readFrom(id as never, 0)
      total += read.events.filter(event => event.type === 'evidence/model-request').length
    }
    return total
  }

  if (mode === 'resume') {
    // The semantic channel only dispatches while its owning Session is live (§9.4), so the
    // resumed session must stay open until the crash-window suffix has been reprocessed.
    const resumed = await runtimeCtx.agents.resume({ resumeSessionId: SessionId('spec04-semantic-agent') })
    // Resume replays the persisted log asynchronously; the extraction target must exist in
    // the live session before the mock's seq export can be derived from it.
    await waitFor(() => resumed.agent.session.events.some(event => event.type === 'assistant/message'), 10_000, 'resumed assistant messages')
    const assistantSeqs = resumed.agent.session.events.filter(event => event.type === 'assistant/message').map(event => event.seq)
    process.env.DSH_CLI_MOCK_EVIDENCE_SEQ = String(assistantSeqs.at(-1) ?? -1)
    try {
      await waitFor(() => summarize().candidateNodes >= 1 && (summarize().laneWatermark ?? 0) >= 1, 60_000, 'resumed semantic candidate snapshot')
      const payload = { ...summarize(), modelRequestEvents: await requestEventCount() }
      process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(0))
    } finally {
      await resumed.dispose()
    }
  } else {
    const selection = { provider: 'cli-mock', model: 'cli-mock' }
    const handle = await runtimeCtx.agents.create({
      sessionId: SessionId('spec04-semantic-agent'),
      meta: { cwd: process.cwd(), agentPreset: 'animalge-open-test' },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: (agentCtx) => {
        const selected: ModelSelectionRef = { current: selection, assembled: undefined }
        installModelSelection(agentCtx, selected)
      },
    })
    if (process.env.SPEC04_CRASH_AFTER_TURN === '1') {
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: taskParts.join(' ') }],
        source: { kind: 'user' },
      }))
      await new Promise<never>((_park, fail) => {
        const timeout = setTimeout(() => { fail(new Error('crash window expired')) }, 60_000)
        const stop = runtimeCtx.on('session/event', (observed) => {
          if (observed.id !== handle.agent.session.id) return
          void (async () => {
            if ((domain.table('model_calls') as { size: number }).size < 1) return
            stop()
            await runtimeCtx.sessions.flush(handle.agent.session)
            await writeFile('.spec04-crash-marker.json', JSON.stringify({ type: 'crash-after-model-call' }))
            clearTimeout(timeout)
            process.kill(process.pid, 'SIGKILL')
          })()
        }, { global: true })
      })
    }
    if (process.env.SPEC04_SEMANTIC_OFF === '1') {
      // A08 disabled REAL path: flip the authoritative switch before any turn completes,
      // so the semantic lane must never dispatch while deterministic capture continues.
      const stopSwitch = runtimeCtx.on('session/event', (observed) => {
        if (observed.id !== handle.agent.session.id) return
        const graphRow = domain.table('session_graphs').get(observed.id) as { graphId: string } | undefined
        if (graphRow === undefined) return
        stopSwitch()
        void domain.table('semantic_switch').put(graphRow.graphId, { recordVersion: 'animalge.semantic-switch/v1', graphId: graphRow.graphId, enabled: false, updatedAt: Date.now() })
      }, { global: true })
    }
    await runFixtureTurn(ctx, { task: taskParts.join(' ') })
    // The mock extraction fixture targets the real assistant message: export its seq to
    // the in-process mock so the span proposal lands on a genuine event.
    const assistantSeqs = handle.agent.session.events.filter(event => event.type === 'assistant/message').map(event => event.seq)
    const lastAssistantSeq = assistantSeqs.at(-1) ?? -1
    process.env.DSH_CLI_MOCK_EVIDENCE_SEQ = String(lastAssistantSeq)
    // The semantic lane drains only after the deterministic row settles; give it a window.
    // Failure-mode runs wait only for the dispatch attempts — candidates must never appear.
    if (process.env.SPEC04_EXPECT_FAILURE === '1') {
      await waitFor(() => summarize().modelCalls >= 1 && summarize().headDigest !== null, 30_000, 'semantic dispatch attempt with a deterministic head')
    } else if (process.env.SPEC04_SEMANTIC_OFF === '1') {
      // Deterministic head must commit while zero evidence dispatches happen (D-155).
      await waitFor(() => summarize().headDigest !== null, 20_000, 'deterministic head under disabled semantic channel')
      await new Promise(resolve => setTimeout(resolve, 3_000))
    } else {
      await waitFor(() => summarize().candidateNodes >= 1 && summarize().laneWatermark !== null, 30_000, 'candidate nodes and lane watermark')
    }
    const switchRow = [...semanticSwitch.entries()][0]?.[1]
    const payload = {
      ...summarize(),
      modelRequestEvents: await requestEventCount(),
      semanticSwitchEnabled: switchRow === undefined ? 'default-on' : String(switchRow.enabled),
    } as SemanticPayload
    process.stdout.write(`${JSON.stringify(payload)}\n`, () => process.exit(0))
  }
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
