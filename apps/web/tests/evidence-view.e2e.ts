// Web e2e contract for the SPEC-05 Evidence read channel: real chromium over the real
// base+web-app bundle composition with the evidence rows configured through a generated
// overlay, replay-scripted chat turns that execute a REAL `sci_run_code` subprocess
// (receipt + artifact + capture + commit), the stale/unavailable budget injections, and
// the semantic scenario through a deterministic in-process extraction adapter. No real
// model, no external network (spec §13.3, scenarios E01–E06).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { CallId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry, ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { graphStatusFacts, issueRecordsFor, verifyEvidenceExport, verifyStoredSnapshot } from '@deepseek-ai/dsh-evidence-core'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()

/** The evidence-core overlay config rows per scenario (config replaces the row wholesale). */
function evidenceOverlay(options: {
  readonly workspaceCwd: string
  readonly storageHardBytes?: number
  readonly idleMergeMs?: number
  readonly evidenceModel?: { provider: string; model: string }
}): string {
  const lines = [
    '- id: evidence-core',
    "  name: '@deepseek-ai/dsh-evidence-core'",
    '  config:',
    "    eligibleAgentPresetIds: ['standard']",
    '    deterministicRunSelection:',
    '      revision: spec05-web-e2e/v1',
    '      exactToolNames: []',
    `    idleMergeMs: ${String(options.idleMergeMs ?? 0)}`,
    '    runnerEnabled: true',
    `    runnerOutputRoot: ${JSON.stringify(join(options.workspaceCwd, '.evidence-runner-outputs'))}`,
    '    runnerDefaultTimeoutMs: 60000',
    '    professionalToolsEnabled: false',
    `    professionalOutputRoot: ${JSON.stringify(join(options.workspaceCwd, '.evidence-professional-outputs'))}`,
    '    storageHardBytes: 2147483664',
  ]
  if (options.storageHardBytes !== undefined) {
    lines[lines.length - 1] = `    storageSoftBytes: ${String(Math.max(1, Math.floor(options.storageHardBytes / 2)))}`
    lines.push(`    storageHardBytes: ${String(options.storageHardBytes)}`)
  }
  if (options.evidenceModel !== undefined) {
    lines.push('    evidenceModel:')
    lines.push(`      provider: ${JSON.stringify(options.evidenceModel.provider)}`)
    lines.push(`      model: ${JSON.stringify(options.evidenceModel.model)}`)
    lines.push('      timeoutMs: 60000')
  }
  return `${lines.join('\n')}\n`
}

interface TurnSpec {
  readonly prompt: string
  readonly marker: string
  readonly doneMarker: string
  readonly callId?: ReturnType<typeof CallId>
  readonly toolArgs?: string
  readonly plain?: boolean
}

function textStream(spec: TurnSpec): StreamChunk[] {
  const response = `${spec.marker} deterministic reply. ${spec.doneMarker}`
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: response },
    { type: 'block-end', index: 0, block: { type: 'text', text: response } },
    { type: 'usage', usage: { inputTokens: 64, outputTokens: 24 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolStream(spec: TurnSpec): StreamChunk[] {
  if (spec.callId === undefined || spec.toolArgs === undefined) throw new Error('tool turn lacks identity')
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: spec.callId, name: 'sci_run_code', argumentsDelta: spec.toolArgs },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: spec.callId, name: 'sci_run_code', arguments: spec.toolArgs } },
    { type: 'usage', usage: { inputTokens: 256, outputTokens: 24 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function replayScript(specs: readonly TurnSpec[], semanticFollowUps = 0): ReplayOverrideDoc {
  return specs.flatMap((spec): ReplayEntry[] => {
    const final: ReplayEntry = { kind: 'chunks', chunks: textStream(spec) }
    const tool: ReplayEntry[] = spec.plain === true || spec.callId === undefined ? [] : [{ kind: 'chunks', chunks: toolStream(spec) }]
    const semantic: ReplayEntry[] = Array.from({ length: semanticFollowUps }, () => ({ kind: 'chunks' as const, chunks: semanticStream() }))
    return [...tool, final, ...semantic]
  })
}

/** The deterministic semantic extraction served to the SPEC-04 lane in E06: one empty
 * candidates batch is a VALID strict output (schema requires arrays, not entries). */
function semanticStream(): StreamChunk[] {
  const payload = JSON.stringify({
    schemaVersion: 'animalge.semantic-extraction/v1',
    candidates: [],
    relations: [],
    sameAsProposals: [],
    runSelections: [],
  })
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: payload },
    { type: 'block-end', index: 0, block: { type: 'text', text: payload } },
    { type: 'usage', usage: { inputTokens: 512, outputTokens: 32 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function sciRunCodeArgs(scriptPath: string, csvName: string): string {
  return JSON.stringify({
    language_profile: 'bash',
    code: { locator: scriptPath },
    inputs: [{ role: 'script', locator: scriptPath }],
    declared_outputs: [{ role: 'association_table', relative_path: csvName, required: true }],
    env: [],
    args: [],
    timeout_ms: 60000,
  })
}

interface Scenario {
  readonly scaffold: WebScaffold
  readonly page: Page
  readonly workdir: string
  readonly replayDir: string
}

async function bootScenario(options: {
  readonly browser: Browser
  readonly specs: readonly TurnSpec[] | ((workdir: string) => readonly TurnSpec[])
  readonly setupScript?: { readonly name: string; readonly content: string }
  readonly semanticFollowUps?: number
  readonly storageHardBytes?: number
  readonly idleMergeMs?: number
  readonly evidenceModel?: { provider: string; model: string }
  readonly name: string
}): Promise<Scenario> {
  const workdir = await mkdtemp(join(tmpdir(), `dsh-evidence-${options.name}-`))
  const replayDir = await mkdtemp(join(tmpdir(), `dsh-evidence-${options.name}-replay-`))
  if (options.setupScript !== undefined) {
    await writeFile(join(workdir, options.setupScript.name), options.setupScript.content)
  }
  const overlayPath = join(workdir, 'evidence.overlay.yml')
  const overlayContent = evidenceOverlay({
    workspaceCwd: workdir,
    ...(options.storageHardBytes === undefined ? {} : { storageHardBytes: options.storageHardBytes }),
    ...(options.idleMergeMs === undefined ? {} : { idleMergeMs: options.idleMergeMs }),
    ...(options.evidenceModel === undefined ? {} : { evidenceModel: options.evidenceModel }),
  })
  await writeFile(overlayPath, overlayContent)
  const replayOverride = join(replayDir, 'replay.override.json')
  const specs = typeof options.specs === 'function' ? options.specs(workdir) : options.specs
  await writeFile(replayOverride, JSON.stringify(replayScript(specs, options.semanticFollowUps ?? 0)))
  const scaffold = await launchWebScaffold({
    replayFixture: join(replayDir, 'override-only.jsonl'),
    replayOverride,
    replayContextWindow: 10_000_000,
    paceMs: 5,
    extraOverlayPath: overlayPath,
  })
  const page = await newEnglishPage(options.browser, 1000)
  const tripwire = watchConsole(page)
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('[evidence-e2e:browser-error]', message.text())
  })
  page.on('pageerror', (error) => { console.log('[evidence-e2e:page-error]', String(error)) })
  void tripwire
  await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  await connectFreshWorkspace(page, scaffold.workspaceCwd, `evidence-${options.name}`)
  return { scaffold, page, workdir, replayDir }
}

async function driveTurn(scenario: Scenario, spec: TurnSpec): Promise<SessionId> {
  const { page, scaffold } = scenario
  const composer = page.locator('textarea:enabled').last()
  await composer.waitFor({ timeout: 15_000 })
  await composer.fill(spec.prompt)
  const settled = scaffold.whenTurnSettled(90_000)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await page.getByText(spec.doneMarker, { exact: false }).last().waitFor({ timeout: 30_000 })
  await settled
  await page.waitForFunction(() => document.querySelectorAll('[data-streaming="true"]').length === 0, undefined, { timeout: 15_000 })
  return settled
}

async function openEvidenceTab(scenario: Scenario): Promise<void> {
  await scenario.page.getByRole('tab', { name: 'Evidence', exact: true }).click()
  await scenario.page.locator('[data-evidence-session]').first().waitFor({ timeout: 15_000 })
}

interface StatusFace {
  kind: string
  currentSnapshotDigest?: string | null
  headRevision?: number
  freshness?: string
  semanticChannel?: string
  counts?: { candidates: number }
}

/** Host-side status assertion: the test process runs the HOST root context, which has
 * ctx.evidenceStore (the owner store) but NOT ctx.remote (a client-side Typert remote mounted
 * only in the browser). The production read channel (browser → Typert → EvidenceService) is
 * exercised by the DOM-side assertions (openEvidenceTab + .evidence-summary text). These
 * host reads are test assertions only, not the production path. */
async function serviceStatus(scenario: Scenario, sessionId: SessionId): Promise<StatusFace> {
  return serviceStatusViaStore(scenario, sessionId)
}

function serviceStatusViaStore(scenario: Scenario, sessionId: SessionId): StatusFace {
  const store = (scenario.scaffold.ctx as unknown as { evidenceStore: EvidenceStoreFace }).evidenceStore
  const bootstrap = store.sessionGraphs.get(sessionId)
  if (bootstrap === undefined) return { kind: 'no_graph' }
  const graphId = bootstrap.graphId
  const facts = graphStatusFacts(store as never, graphId as never, Date.now())
  let semanticChannel = 'not_configured'
  let candidates = 0
  if (store.semanticSwitch.get(graphId)?.enabled === false) {
    semanticChannel = 'disabled'
  } else if (facts.headSnapshotDigest !== null) {
    try {
      const payload = verifyStoredSnapshot(store.committedSnapshot(facts.headSnapshotDigest) as never)
      const semantic = payload.semanticWatermark
      semanticChannel = 'kind' in semantic ? semantic.kind : 'not_configured'
      for (const node of payload.nodes) {
        if (node.nodeKind === 'CandidateStatement' && node.projectionState !== 'excluded') candidates++
      }
    } catch {
      semanticChannel = 'not_configured'
    }
  } else {
    const record = store.semanticSwitch.get(graphId)
    semanticChannel = record === undefined ? 'not_configured' : record.enabled ? 'active' : 'disabled'
  }
  return {
    kind: 'graph',
    currentSnapshotDigest: facts.headSnapshotDigest,
    headRevision: facts.headRevision,
    freshness: facts.freshness,
    semanticChannel,
    counts: { candidates },
  }
}

interface EvidenceStoreFace {
  sessionGraphs: { get(id: string): { graphId: string } | undefined }
  committedSnapshot(digest: string): { payload: unknown }
  semanticSwitch: { get(graphId: string): { enabled: boolean } | undefined }
  receiptSubmissions: { entries(): Iterable<readonly [string, { receiptId: string; evidenceGraphId: string }]> }
  receiptAcceptances: { get(receiptId: string): { verdict: string } | undefined }
}

function receiptStateSync(scenario: Scenario, sessionId: SessionId): 'pending' | 'accepted' | 'rejected' | 'none' {
  const store = (scenario.scaffold.ctx as unknown as { evidenceStore: EvidenceStoreFace }).evidenceStore
  const bootstrap = store.sessionGraphs.get(sessionId)
  if (bootstrap === undefined) return 'none'
  for (const [, submission] of store.receiptSubmissions.entries()) {
    if (submission.evidenceGraphId !== bootstrap.graphId) continue
    const acceptance = store.receiptAcceptances.get(submission.receiptId)
    if (acceptance === undefined) return 'pending'
    return acceptance.verdict === 'accepted' ? 'accepted' : 'rejected'
  }
  return 'none'
}

/** Host-side issue assertion: reads the owner store directly (test-process-only path;
 * the browser's issue channel is exercised via DOM). */
async function issueCodes(scenario: Scenario, sessionId: SessionId): Promise<string[]> {
  const store = (scenario.scaffold.ctx as unknown as {
    evidenceStore: { sessionGraphs: { get(id: string): { graphId: string } | undefined } } & Parameters<typeof issueRecordsFor>[0]
  }).evidenceStore
  const bootstrap = store.sessionGraphs.get(sessionId)
  if (bootstrap === undefined) return []
  return issueRecordsFor(store as never, bootstrap.graphId as never).map(record => record.conditionCode)
}

async function graphIdOf(scenario: Scenario, sessionId: SessionId): Promise<string> {
  const bootstrap = (scenario.scaffold.ctx as unknown as {
    evidenceStore: { sessionGraphs: { get(id: string): { graphId: string } | undefined } }
  }).evidenceStore.sessionGraphs.get(sessionId)
  if (bootstrap === undefined) throw new Error('no evidence graph for session')
  return bootstrap.graphId
}

describe('web e2e: SPEC-05 evidence read channel over the real composition', () => {
  let browser: Browser
  const cleanups: Array<() => Promise<void>> = []

  beforeAll(async () => {
    browser = await chromium.launch()
  }, 60_000)

  afterAll(async () => {
    const failures: unknown[] = []
    for (const cleanup of cleanups.reverse()) await cleanup().catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'evidence e2e cleanup failed')
  })

  describe('E01/E02/E03: deterministic chain, fixed reading, export/preview/navigation', () => {
    let scenario: Scenario
    let sessionId: SessionId
    const scriptName = 'evidence-e01-script.sh'
    const csvName = 'evidence-e01-result.csv'
    const toolCallId = CallId('evidence-e01-run')

    beforeAll(async () => {
      scenario = await bootScenario({
        browser,
        name: 'main',
        // No buffered semantic entries: with E02/E03 skipped under the environment ruling,
        // nothing consumes them and the scaffold teardown rejects over-recorded fixtures.
        setupScript: {
          name: scriptName,
          content: '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'snp,pvalue\\nSSC7-001,1.2e-5\\nSSC7-002,3.4e-7\\n\'\n',
        },
        // Only the driven turns are recorded: E02/E03 are skipped under the
        // environment-limitation ruling, so their replay entries are absent (the scaffold's
        // full-consumption teardown contract rejects unconsumed recordings).
        specs: workdir => [
          {
            prompt: 'EV01_USER Run the deterministic evidence script and summarize.',
            marker: 'EV01_FIRST',
            doneMarker: 'EV01_DONE',
            callId: toolCallId,
            toolArgs: sciRunCodeArgs(join(workdir, scriptName), csvName),
          },
        ],
      })
      cleanups.push(async () => {
        await scenario.page.close().catch(() => {})
        await scenario.scaffold.close()
        await rm(scenario.workdir, { recursive: true, force: true })
        await rm(scenario.replayDir, { recursive: true, force: true })
      })
      sessionId = await driveTurn(scenario, {
        prompt: 'EV01_USER Run the deterministic evidence script and summarize.',
        marker: 'EV01_FIRST',
        doneMarker: 'EV01_DONE',
      })
      const events: string[] = []
      scenario.scaffold.ctx.on('session/event', (_s: unknown, event: SessionEvent) => {
        const toolName = (event.data as { name?: string } | undefined)?.name ?? ''
        const isError = (event.data as { isError?: boolean } | undefined)?.isError ?? ''
        events.push(event.type === 'tool/call' ? `tool/call:${toolName}` : event.type === 'tool/result' ? `tool/result:${isError}` : event.type)
      })
      ;(scenario as unknown as { eventLog: string[] }).eventLog = events
    }, 180_000)

    it.skipIf(MODE === 'record')('E01: real tool run commits a Snapshot; the tab shows the five-item summary', async () => {
      onTestFailed(() => saveFailureShot(scenario.page, 'web-e2e-evidence-e01'))
      await expect.poll(async () => (await serviceStatus(scenario, sessionId)).currentSnapshotDigest, { timeout: 30_000 }).toBeTruthy()
      // The receipt acceptance admits a second boundary after the first commit (§7.4 order);
      // freshness settles at current once that increment drains — poll, don't race it.
      await expect.poll(async () => (await serviceStatus(scenario, sessionId)).freshness, { timeout: 30_000 }).toBe('current')
      const status = await serviceStatus(scenario, sessionId)
      expect(status.semanticChannel).toBe('not_configured')
      expect(status.counts?.candidates).toBe(0)
      await openEvidenceTab(scenario)
      // Poll the rendered content itself (the section exists before the status loads).
      await expect.poll(async () => scenario.page.locator('.evidence-summary').textContent(), { timeout: 15_000 }).toContain('current version')
      const summary = await scenario.page.locator('.evidence-summary').textContent()
      expect(summary).toContain('AI candidate semantics: not configured')
      // Receipt acceptance (A07 browser leg): the AcceptanceLane's web-composition processing
      // does not settle within this scenario's window (owner-side design limitation — the
      // host process drives the lane, the browser only observes via the read service).
      // Registered as a documented soft-check under the 2026-08-31 environment-limitation
      // ruling (packet authority user-decision-browser-env-20260831); A07's pending/accepted
      // presentation semantics are covered by the DetailsPane receipt unit surface.
      const receiptResult = await expect.poll(() => receiptStateSync(scenario, sessionId), { timeout: 10_000 }).toBe('accepted').then(() => 'accepted', () => 'pending-or-other')
      console.log('[evidence-e2e:e01-receipt]', receiptResult)
    })

    // SKIPPED under the 2026-08-31 environment-limitation ruling (packet authority
    // user-decision-browser-env-20260831): the keyed toolview dispatch branch does not
    // render the tool-card link in the current web composition (DSH core, outside §12.2).
    it.skip('E01: the tool run is navigable from the tool card into the Evidence tab', async () => {
      const chatCallIds = await scenario.page.locator('[data-chat-call-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-chat-call-id')))
      console.log('[evidence-e2e:e01-chat-call-ids]', JSON.stringify(chatCallIds))
      const toolviewCount = await scenario.page.locator('[data-evidence-toolview]').count()
      const cardHtml = await scenario.page.locator('[data-chat-call-id="evidence-e01-run"]').innerHTML().catch(() => 'N/A')
      console.log('[evidence-e2e:e01-toolview-count]', String(toolviewCount))
      console.log('[evidence-e2e:e01-card-html]', cardHtml.slice(0, 3000))
      const cardHtml2 = await scenario.page.locator('[data-chat-call-id="evidence-e01-run"]').innerHTML().catch(() => 'N/A')
      console.log('[evidence-e2e:e01-card]', cardHtml2.slice(0, 3000))
      const link = scenario.page.locator(`[data-evidence-toolview="${String(toolCallId)}"]`).first()
      await link.waitFor({ timeout: 15_000 })
      await link.click()
      await expect.poll(async () => scenario.page.locator('[data-evidence-details="Run"]').count(), { timeout: 15_000 }).toBe(1)
      const details = await scenario.page.locator('[data-evidence-details="Run"]').textContent()
      expect(details).toContain('sci_run_code')
    })

    // SKIPPED under the same ruling: multi-turn replay consumption (entry 2 of the replay
    // stream is never consumed by the web chat loop — DSH core, outside §12.2).
    it.skip('E02: a newer current during an open view shows one inline notice and keeps the list', async () => {
      await openEvidenceTab(scenario)
      const before = await scenario.page.locator('.evidence-candidates').textContent()
      await driveTurn(scenario, {
        prompt: 'EV02_USER Add one plain deterministic turn.',
        marker: 'EV02_FIRST',
        doneMarker: 'EV02_DONE',
        plain: true,
      })
      await expect.poll(async () => scenario.page.locator('[data-evidence-notice="new-version"]').count(), { timeout: 30_000 }).toBe(1)
      const after = await scenario.page.locator('.evidence-candidates').textContent()
      expect(after).toBe(before)
      // Explicit switch: focus continues by precise identity — none selected → unselected home.
      await scenario.page.locator('[data-evidence-notice="new-version"] button').click()
      await expect.poll(async () => scenario.page.locator('[data-evidence-notice="new-version"]').count(), { timeout: 15_000 }).toBe(0)
    })

    // SKIPPED under the same ruling (multi-turn replay consumption blocks the E01-chain
    // prerequisite); the export verb itself is covered behaviorally by export.spec.ts
    // (externally re-verified canonical bytes) and the locator bug was fixed regardless.
    it.skip('E03: export downloads the exact canonical bytes bound to the viewed digest', async () => {
      const status = await serviceStatus(scenario, sessionId)
      const digest = status.currentSnapshotDigest
      expect(digest).toBeTruthy()
      const [downloadPath] = await Promise.all([
        scenario.page.waitForEvent('download', { timeout: 15_000 }).then(download => download.path()),
        // data-attribute locator: locale-independent (the button label is zh or en by locale).
        scenario.page.locator('[data-evidence-action="export"]').click(),
      ])
      const { readFile } = await import('node:fs/promises')
      const bytes = await readFile(downloadPath ?? '', 'utf8')
      const envelope = verifyEvidenceExport(bytes)
      expect(`sha256:${envelope.snapshotDigest.replace(/^sha256:/, '')}`).toBe(digest ?? '')
    })
  })

  describe('E04: stale budget injection keeps the last Snapshot readable', () => {
    let scenario: Scenario
    let sessionId: SessionId

    beforeAll(async () => {
      scenario = await bootScenario({
        browser,
        name: 'stale',
        idleMergeMs: 6000,
        setupScript: { name: 'evidence-e04-script.sh', content: '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'e04-output\\n\'\n' },
        specs: workdir => [
          { prompt: 'EV04_USER One deterministic turn.', marker: 'EV04_FIRST', doneMarker: 'EV04_DONE', plain: true },
          {
            prompt: 'EV04B_USER Run the script again.',
            marker: 'EV04B_FIRST',
            doneMarker: 'EV04B_DONE',
            callId: CallId('evidence-e04-run'),
            toolArgs: sciRunCodeArgs(join(workdir, 'evidence-e04-script.sh'), 'evidence-e04-result.txt'),
          },
        ],
      })
      cleanups.push(async () => {
        await scenario.page.close().catch(() => {})
        await scenario.scaffold.close()
        await rm(scenario.workdir, { recursive: true, force: true })
        await rm(scenario.replayDir, { recursive: true, force: true })
      })
      sessionId = await driveTurn(scenario, { prompt: 'EV04_USER One deterministic turn.', marker: 'EV04_FIRST', doneMarker: 'EV04_DONE', plain: true })
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline && ((await serviceStatus(scenario, sessionId)).currentSnapshotDigest ?? null) === null) {
        await new Promise((resolve) => { setTimeout(resolve, 100) })
      }
      if (((await serviceStatus(scenario, sessionId)).currentSnapshotDigest ?? null) === null) throw new Error('E04: first Snapshot never committed')
    }, 180_000)

    it.skipIf(MODE === 'record')('freshness turns stale with an attention issue; retry never spawns tools', async () => {
      const subprocessCount = countSpawnedProcesses(scenario)
      // Erratum 1: drive a second turn whose tool result creates a durable boundary; the compile
      // wakes through the same hint chain, dequeues the offset target, and fails terminally.
      const turn = driveTurn(scenario, { prompt: 'EV04B_USER Run the script again.', marker: 'EV04B_FIRST', doneMarker: 'EV04B_DONE' })
      await turn
      // Diagnostic: dump the outbox + attempts state after the tool turn
      await new Promise((resolve) => { setTimeout(resolve, 1000) })
      const storeD2 = (scenario.scaffold.ctx as unknown as {
        evidenceStore: QueueFace
      }).evidenceStore
      const outboxDump = [...storeD2.outbox.entries()].map(([_k, v]) => {
        const r = v as Record<string, unknown>
        return { target: r.targetNextSeqExclusive, inFlight: r.inFlightAttemptId, eligible: r.eligibleAfter, retry: r.retryNotBefore }
      })
      const attemptsDump = [...storeD2.attempts.entries()].map(([_k, v]) => {
        const r = v as Record<string, unknown>
        return {
          state: r.state, stage: r.stage, target: r.targetNextSeqExclusive,
          err: (r.terminalError as { code?: string } | null)?.code,
        }
      })
      console.log('[evidence-e2e:e04-post-turn]', JSON.stringify({ outboxDump, attemptsDump }))
      const injected = await offsetOutboxTarget(scenario, sessionId, 20_000)
      expect(injected).toBe(true)
      await expect.poll(async () => (await serviceStatus(scenario, sessionId)).freshness, { timeout: 120_000 }).toBe('stale').catch(async (error: unknown) => {
        // Final diagnostic: dump the full store state on failure
        const storeF = (scenario.scaffold.ctx as unknown as {
          evidenceStore: QueueFace
        }).evidenceStore
        const out = [...storeF.outbox.entries()].map(([, v]) => {
          const r = v as Record<string, unknown>
          return { target: r.targetNextSeqExclusive, inFlight: r.inFlightAttemptId, eligible: r.eligibleAfter, retry: r.retryNotBefore }
        })
        const att = [...storeF.attempts.entries()].map(([, v]) => {
          const r = v as Record<string, unknown>
          return {
            state: r.state, stage: r.stage, target: r.targetNextSeqExclusive,
            err: (r.terminalError as { code?: string } | null)?.code,
          }
        })
        console.log('[evidence-e2e:e04-final]', JSON.stringify({ out, att }))
        throw error
      })
      const status = await serviceStatus(scenario, sessionId)
      expect(status.currentSnapshotDigest).toBeTruthy()
      await expect.poll(async () => await issueCodes(scenario, sessionId), { timeout: 15_000 }).toContain('evidence_stale')
      await openEvidenceTab(scenario)
      // DOM-side assertions (B1C2-02): the production read channel is what the browser
      // renders — the five-item summary carries freshness=stale, the committed body stays
      // readable (never blanked by the pending layer), and the stale issue renders with
      // its unread mark-seen entry in the issues section.
      await expect.poll(async () => scenario.page.locator('.evidence-summary').textContent(), { timeout: 15_000 }).toContain('Freshness: stale')
      expect(await scenario.page.locator('.evidence-body').count()).toBeGreaterThan(0)
      await expect.poll(async () => scenario.page.locator('[data-evidence-issue="evidence_stale"]').count(), { timeout: 15_000 }).toBeGreaterThan(0)
      const issueRow = await scenario.page.locator('[data-evidence-issue="evidence_stale"]').first().textContent()
      expect(issueRow).toContain('Mark as seen')
      // §11.4-2/§13.3-E04: the retry is the process verb on the terminal backlog — the button
      // must be enabled (resume entry for a failed backlog) and re-arm the compile from the
      // persisted boundary, while never spawning a research tool subprocess.
      const processButton = scenario.page.locator('[data-evidence-action="process"]')
      expect(await processButton.isEnabled()).toBe(true)
      const attemptsBefore = attemptsCount(scenario)
      await processButton.click()
      // The re-armed boundary is consumed as a new compile attempt (it fails again — target
      // still offset — which is the honest outcome), and no capture is ever added.
      await expect.poll(() => attemptsCount(scenario), { timeout: 30_000 }).toBeGreaterThan(attemptsBefore)
      expect(countSpawnedProcesses(scenario)).toBe(subprocessCount + 1)
    })
  })

  describe('E05: unavailable from the first failed compile', () => {
    let scenario: Scenario
    let sessionId: SessionId

    beforeAll(async () => {
      scenario = await bootScenario({
        browser,
        name: 'unavailable',
        idleMergeMs: 4000,
        specs: [{ prompt: 'EV05_USER One deterministic turn.', marker: 'EV05_FIRST', doneMarker: 'EV05_DONE', plain: true }],
      })
      cleanups.push(async () => {
        await scenario.page.close().catch(() => {})
        await scenario.scaffold.close()
        await rm(scenario.workdir, { recursive: true, force: true })
        await rm(scenario.replayDir, { recursive: true, force: true })
      })
      const turn = driveTurn(scenario, { prompt: 'EV05_USER One deterministic turn.', marker: 'EV05_FIRST', doneMarker: 'EV05_DONE', plain: true })
      const injected = await offsetOutboxTarget(scenario, await firstGraphSession(scenario), 15_000)
      expect(injected).toBe(true)
      sessionId = await turn
    }, 180_000)

    it.skipIf(MODE === 'record')('the four first-empty states stay distinct; chat continues', async () => {
      await expect.poll(async () => (await serviceStatus(scenario, sessionId)).freshness, { timeout: 60_000 }).toBe('unavailable')
      await openEvidenceTab(scenario)
      await expect.poll(async () => scenario.page.locator('.evidence-summary').textContent(), { timeout: 15_000 }).toContain('Evidence unavailable')
      await expect.poll(async () => await issueCodes(scenario, sessionId), { timeout: 15_000 }).toContain('evidence_unavailable')
      expect(await scenario.page.locator('[data-streaming="true"]').count()).toBe(0)
    })
  })

  describe('E06: semantic channel through the replay provider; switch-off stays honest', () => {
    let scenario: Scenario
    let sessionId: SessionId

    beforeAll(async () => {
      scenario = await bootScenario({
        browser,
        name: 'semantic',
        evidenceModel: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        // No replayed semantic entry: the semantic lane's extraction is served by the
        // deterministic in-process adapter; a replayed follow-up stream would sit
        // unconsumed and fail the scaffold's full-consumption teardown contract.
        // One driven turn only: the fixture records exactly the streams the scenario
        // consumes (main + semantic follow-up) — an undriven second spec would leave
        // replay calls unconsumed and fail the scaffold teardown contract.
        specs: [
          { prompt: 'EV06_USER One deterministic turn with candidates.', marker: 'EV06_FIRST', doneMarker: 'EV06_DONE', plain: true },
        ],
      })
      cleanups.push(async () => {
        await scenario.page.close().catch(() => {})
        try {
          await scenario.scaffold.close()
        } catch (error: unknown) {
          // Teardown diagnostics: the scaffold aggregates inner failures without printing
          // them; surface each inner error so the cleanup contract is debuggable.
          const inner = (error as { errors?: unknown[] }).errors ?? [error]
          for (const one of inner) {
            const described = one instanceof Error ? `${one.name}: ${one.message}` : String(one)
            console.log('[evidence-e2e:teardown]', described)
          }
          throw error
        }
        await rm(scenario.workdir, { recursive: true, force: true })
        await rm(scenario.replayDir, { recursive: true, force: true })
      })
      sessionId = await driveTurn(scenario, { prompt: 'EV06_USER One deterministic turn with candidates.', marker: 'EV06_FIRST', doneMarker: 'EV06_DONE', plain: true })
    }, 180_000)

    it.skipIf(MODE === 'record')('an empty but valid extraction keeps the channel active and the Snapshot current', async () => {
      await expect.poll(async () => (await serviceStatus(scenario, sessionId)).semanticChannel, { timeout: 60_000 }).toBe('active')
      await expect.poll(async () => (await serviceStatus(scenario, sessionId)).freshness, { timeout: 60_000 }).toBe('current')
      const status = await serviceStatus(scenario, sessionId)
      expect(status.counts?.candidates).toBe(0)
      // DOM-side assertion (B1C2-02): the five-item summary renders the semantic channel
      // state through the production read channel, not only the owner-side probe.
      await openEvidenceTab(scenario)
      await expect.poll(async () => scenario.page.locator('.evidence-summary').textContent(), { timeout: 15_000 }).toContain('AI candidate semantics: enabled')
    })

    it.skipIf(MODE === 'record')('switch-off shows disabled with the deterministic Snapshot still current', async () => {
      const { setSemanticSwitchEnabled } = await import('@deepseek-ai/dsh-evidence-core')
      const graphId = await graphIdOf(scenario, sessionId)
      await setSemanticSwitchEnabled((scenario.scaffold.ctx as unknown as { evidenceStore: never }).evidenceStore, graphId as never, false)
      await expect.poll(async () => (await serviceStatus(scenario, sessionId)).semanticChannel, { timeout: 30_000 }).toBe('disabled')
      await expect.poll(async () => (await serviceStatus(scenario, sessionId)).freshness, { timeout: 30_000 }).toBe('current')
      // DOM-side assertion (B1C2-02): the summary flips to disabled through the production
      // read channel. A switch flip moves none of the three dedup tokens (§5.3 — the switch
      // is presentation state, not graph state), so no wake event reaches the client; the
      // §11.4-1 refresh action (re-query the service, nothing else) is the user path that
      // re-renders the channel state.
      await openEvidenceTab(scenario)
      await scenario.page.locator('[data-evidence-action="refresh"]').click()
      await expect.poll(async () => scenario.page.locator('.evidence-summary').textContent(), { timeout: 15_000 }).toContain('AI candidate semantics: disabled')
    })
  })
})

/** Count captured tool runs (owner store): the Evidence retry must never add one (§11.4). */
function countSpawnedProcesses(scenario: Scenario): number {
  const store = (scenario.scaffold.ctx as unknown as { evidenceStore: { captures: { size: number } } }).evidenceStore
  return store.captures.size
}

/** Count compile attempts (owner store): the §11.4-2 process verb re-arms the durable
 * boundary as a new attempt without ever adding a capture. */
function attemptsCount(scenario: Scenario): number {
  const store = (scenario.scaffold.ctx as unknown as { evidenceStore: { attempts: { size: number } } }).evidenceStore
  return store.attempts.size
}

interface QueueFace {
  outbox: { entries(): Iterable<readonly [string, unknown]> }
  attempts: { entries(): Iterable<readonly [string, unknown]> }
}

interface OutboxFace {
  outbox: {
    get(graphId: string): Record<string, unknown> & {
      graphId: string
      targetNextSeqExclusive: number
      inFlightAttemptId: string | null
    } | undefined
    put(graphId: string, row: Record<string, unknown>): Promise<unknown>
  }
}

function graphIdFor(scenario: Scenario, sessionId: SessionId): string {
  const store = (scenario.scaffold.ctx as unknown as {
    evidenceStore: { sessionGraphs: { get(id: string): { graphId: string } | undefined } }
  }).evidenceStore
  const bootstrap = store.sessionGraphs.get(sessionId)
  if (bootstrap === undefined) throw new Error('no evidence graph')
  return bootstrap.graphId
}

/** Erratum 1 injection: offset the session's pending outbox target by +1 so the next
 * compile fails terminally (§13.3 E04/E05; see the change-impact manifest). */
async function offsetOutboxTarget(scenario: Scenario, sessionId: SessionId, windowMs: number): Promise<boolean> {
  const store = (scenario.scaffold.ctx as unknown as { evidenceStore: OutboxFace }).evidenceStore
  const graphId = graphIdFor(scenario, sessionId)
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline) {
    const row = store.outbox.get(graphId)
    if (row !== undefined && row.inFlightAttemptId === null) {
      // Spread the full row: only the target changes; all other fields (reasonCounts,
      // eligibleAfter, fairTicket, etc.) must survive for the compile to dequeue correctly.
      await store.outbox.put(row.graphId, { ...row, targetNextSeqExclusive: row.targetNextSeqExclusive + 1 })
      return true
    }
    await new Promise((resolve) => { setTimeout(resolve, 50) })
  }
  return false
}

async function firstGraphSession(scenario: Scenario): Promise<SessionId> {
  const store = (scenario.scaffold.ctx as unknown as {
    evidenceStore: { sessionGraphs: { entries(): Iterable<readonly [string, { state: string }]> } }
  }).evidenceStore
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    for (const [id, row] of store.sessionGraphs.entries()) {
      if (row.state !== 'initializing') return id as SessionId
    }
    await new Promise((resolve) => { setTimeout(resolve, 50) })
  }
  throw new Error('no evidence graph session appeared')
}
