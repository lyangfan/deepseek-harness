/**
 * The Evidence read service (SPEC-05): a host-plane Typert Remote over the private evidence-core
 * owner store. Every method is session-scoped (first param `agent`, resolved from the wire
 * SessionId), read-only, and returns typed result unions so the frozen named error codes survive
 * the wire (thrown errors degrade to `internal` + message). The two non-query methods are
 * `markSeen` (notification-seen timestamps — the 2026-08-28 user decision recorded in spec §6.5)
 * and `processBacklog` (the §11.4-2 backlog verb — priority/resume of the persisted compile
 * backlog via the evidence-core owner function; never runs research tools).
 */

import { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { buildEvidenceExport } from '@deepseek-ai/dsh-evidence-core'
import type {
  CandidatePage,
  EvidenceStatus,
  ExportResponse,
  ExportResult,
  IssuesResponse,
  MarkSeenResponse,
  MarkSeenResult,
  NavigateRequest,
  NavigateResponse,
  ObjectDetailsResponse,
  OpenTargetResponse,
  PathResponse,
  PreviewRequest,
  PreviewResponse,
  PreviewResult,
  ProcessBacklogResponse,
  ReceiptResponse,
  ReceiptStatus,
  ServiceError,
  SnapshotHeader,
  SnapshotRequest,
  SnapshotResponse,
  StatusResponse,
  Subtype,
  TypedObjectRef,
} from './types.ts'
import type { EvidenceSnapshotPayloadV1 } from '@deepseek-ai/dsh-evidence-core/types'
import type { EvidenceStore } from '@deepseek-ai/dsh-evidence-core'
import { markIssuesSeen, processBacklog as processBacklogRows } from '@deepseek-ai/dsh-evidence-core'
import {
  candidatePageOf,
  detailsOf,
  issuesViewOf,
  loadSnapshot,
  navigateWithin,
  pathViewOf,
  refOfNode,
  resolveGraph,
  responseTokens,
  snapshotHeaderOf,
  statusOf,
} from './internal.ts'
import { DEFAULT_PREVIEW_BUDGETS, buildOpenTarget, buildPreview } from './preview.ts'
import type { PreviewBudgets } from './preview.ts'

/** Deployment-adjustable preview budgets (D-145; spec §13.1). */
export interface Config {
  preview: {
    fragmentMaxBytes: number
    textMaxLines: number
    tableMaxRows: number
    tableMaxColumns: number
    tableMaxCells: number
  }
}

function error(code: string, message: string): ServiceError {
  return { code, message }
}

function notFound(digest: string): ServiceError {
  return error('snapshot_not_found', `Snapshot '${digest}' is not committed readable history for this Graph`)
}

/**
 * Evidence read service (`ctx.remote.evidence` on the client). Activation waits for the
 * evidence-core owner's narrow store service, the fs service (preview byte re-verification)
 * and the agent registry (wire identity resolution).
 */
export class EvidenceService extends TypertRemoteService {
  static inject = ['evidenceStore', 'fs', 'agents']

  static Config: s<Config> = s.object({
    preview: s.object({
      fragmentMaxBytes: s.natural().default(DEFAULT_PREVIEW_BUDGETS.fragmentMaxBytes),
      textMaxLines: s.natural().default(DEFAULT_PREVIEW_BUDGETS.textMaxLines),
      tableMaxRows: s.natural().default(DEFAULT_PREVIEW_BUDGETS.tableMaxRows),
      tableMaxColumns: s.natural().default(DEFAULT_PREVIEW_BUDGETS.tableMaxColumns),
      tableMaxCells: s.natural().default(DEFAULT_PREVIEW_BUDGETS.tableMaxCells),
    }),
  })

  private readonly store: EvidenceStore
  private readonly budgets: PreviewBudgets

  constructor(ctx: Context, config: Config = {} as Config) {
    super(ctx, 'evidence')
    this.store = ctx.evidenceStore
    // Partial-typed read: bare-test constructions pass `{}`; schemastery supplies defaults in real assembly.
    this.budgets = (config as Partial<Config>).preview ?? DEFAULT_PREVIEW_BUDGETS
  }

  /** Session→Graph + snapshot load shared by every snapshot-bound method. */
  private snapshotFor(agent: Agent, requestedDigest: string | null):
    { graphId: string; payload: EvidenceSnapshotPayloadV1; header: SnapshotHeader }
    | { failure: ServiceError } {
    const { graphId } = resolveGraph(this.store, agent.session.id)
    if (graphId === null) return { failure: error('scope_mismatch', 'the Session owns no Evidence Graph') }
    const digest = requestedDigest ?? this.store.heads.get(graphId)?.snapshotDigest ?? null
    if (digest === null) return { failure: error('snapshot_not_found', 'the Graph has no committed Snapshot yet') }
    const loaded = loadSnapshot(this.store, graphId, digest)
    if ('notFound' in loaded) return { failure: notFound(digest) }
    return { graphId, payload: loaded.payload, header: snapshotHeaderOf(this.store, graphId, loaded.record, loaded.payload) }
  }

  /** §4.2: the Header/View status entry (single derivation shared with the issue module). */
  @Remote('status')
  status(agent: Agent): StatusResponse {
    const { graphId } = resolveGraph(this.store, agent.session.id)
    if (graphId === null) return { ok: true, status: { kind: 'no_graph' } }
    const status: EvidenceStatus = statusOf(this.store, graphId)
    return { ok: true, status }
  }

  /** §4.3: current or fixed-historical Snapshot header (historical reads never move the head). */
  @Remote('snapshot')
  snapshot(agent: Agent, request: SnapshotRequest): SnapshotResponse {
    const result = this.snapshotFor(agent, request.requestedDigest)
    if ('failure' in result) return { ok: false, error: result.failure }
    return { ok: true, header: result.header }
  }

  /** §4.4: candidate-first page (50 per page + exact total; identity-bound opaque cursor). */
  @Remote('candidates')
  candidates(agent: Agent, request: {
    snapshotDigest: string
    cursor: string | null
    filter: { subtypes: Subtype[] } | null
  }): { ok: true; page: CandidatePage } | { ok: false; error: ServiceError } {
    const result = this.snapshotFor(agent, request.snapshotDigest)
    if ('failure' in result) return { ok: false, error: result.failure }
    const subtypes = request.filter?.subtypes ?? []
    const page = candidatePageOf(this.store, result.payload, request.snapshotDigest, request.cursor, subtypes)
    if ('cursorInvalid' in page) return { ok: false, error: error('cursor_out_of_scope', 'the cursor does not bind to this Snapshot/filter/sort context') }
    return { ok: true, page }
  }

  /** §4.5: one-hop path around a center object (per-group first 20 + exact totals). */
  @Remote('path')
  path(agent: Agent, request: { snapshotDigest: string; center: TypedObjectRef }): PathResponse {
    const result = this.snapshotFor(agent, request.snapshotDigest)
    if ('failure' in result) return { ok: false, error: result.failure }
    const view = pathViewOf(this.store, result.payload, request.center)
    if ('notFound' in view) return { ok: false, error: error('not_in_snapshot', `object '${request.center.kind}/${request.center.id}' is not in this Snapshot`) }
    return { ok: true, view: view }
  }

  /** §4.6: object-level technical details (the only place full technical fields appear). */
  @Remote('objectDetails')
  objectDetails(agent: Agent, request: { snapshotDigest: string; ref: TypedObjectRef }): ObjectDetailsResponse {
    const result = this.snapshotFor(agent, request.snapshotDigest)
    if ('failure' in result) return { ok: false, error: result.failure }
    const node = result.payload.nodes.find(
      candidate => refOfNode(candidate).id === request.ref.id && candidate.nodeKind === request.ref.kind,
    )
    if (node === undefined) {
      return { ok: false, error: error('not_in_snapshot', `object '${request.ref.kind}/${request.ref.id}' is not in this Snapshot`) }
    }
    const details = detailsOf(this.store, node)
    return { ok: true, details }
  }

  /** §4.7: Receipt acceptance display state (canonical results never fabricate `accepted`). */
  @Remote('receipt')
  receipt(agent: Agent, request: { submissionRef: string }): ReceiptResponse {
    void agent
    const submission = this.store.receiptSubmissions.get(request.submissionRef)
    if (submission === undefined) return { ok: false, error: error('not_in_snapshot', `receipt submission '${request.submissionRef}' does not exist`) }
    const acceptance = this.store.acceptanceFor(request.submissionRef)
    const receipt: ReceiptStatus = acceptance === undefined
      ? { state: 'pending', acceptedAt: null, rejectedReason: null }
      : acceptance.verdict === 'accepted'
        ? { state: 'accepted', acceptedAt: acceptance.acceptedAt, rejectedReason: null }
        : { state: 'rejected', acceptedAt: null, rejectedReason: acceptance.rejectedReason }
    return { ok: true, receipt }
  }

  /** §6.4: the full issue list + unread count (informational never persists, D-130). */
  @Remote('issues')
  issues(agent: Agent, request: { includeResolved: boolean }): IssuesResponse {
    const { graphId } = resolveGraph(this.store, agent.session.id)
    if (graphId === null) return { ok: false, error: error('scope_mismatch', 'the Session owns no Evidence Graph') }
    const view = issuesViewOf(this.store, graphId, request.includeResolved)
    return { ok: true, view: { items: view.items, unread: view.unread, versions: responseTokens(this.store, graphId) } }
  }

  /** §4.8: conditional precise navigation (read-only four-state resolution, D-162). */
  @Remote('navigate')
  navigate(agent: Agent, request: NavigateRequest): NavigateResponse {
    const result = this.snapshotFor(agent, request.snapshotDigest)
    if ('failure' in result) return { ok: false, error: result.failure }
    const resolution = navigateWithin(result.payload, request)
    return { ok: true, resolution }
  }

  /** §7: Preview Lite — owner re-verification, then one bounded fragment of the six kinds. */
  @Remote('preview')
  preview(agent: Agent, request: PreviewRequest): Promise<PreviewResponse> {
    return this.previewFor(agent, request)
  }

  private async previewFor(agent: Agent, request: PreviewRequest): Promise<PreviewResponse> {
    const result = this.snapshotFor(agent, request.snapshotDigest)
    if ('failure' in result) return { ok: false, error: result.failure }
    const preview: PreviewResult = await buildPreview(
      this.ctx, this.store, result.graphId as never, result.payload,
      request.artifactVersionId, request.sourceAnchorId, this.budgets,
    )
    return { ok: true, preview }
  }

  /** §7.5: full-file open handoff after digest/length re-verification. */
  @Remote('openTarget')
  openTarget(agent: Agent, request: { snapshotDigest: string; artifactVersionId: string }): Promise<OpenTargetResponse> {
    return this.openFor(agent, request)
  }

  private async openFor(agent: Agent, request: { snapshotDigest: string; artifactVersionId: string }): Promise<OpenTargetResponse> {
    const result = this.snapshotFor(agent, request.snapshotDigest)
    if ('failure' in result) return { ok: false, error: result.failure }
    return { result: await buildOpenTarget(this.ctx, this.store, result.payload, request.artifactVersionId) }
  }

  /** §8: canonical Snapshot export bound to the exact requested digest (D-131). */
  @Remote('exportSnapshot')
  exportSnapshot(agent: Agent, request: { snapshotDigest: string }): ExportResponse {
    const result = this.snapshotFor(agent, request.snapshotDigest)
    if ('failure' in result) return { ok: false, error: result.failure }
    const record = this.store.committedSnapshot(result.header.snapshotDigest as never)
    const exported = buildEvidenceExport(record)
    const hex = result.header.snapshotDigest.replace(/^sha256:/, '')
    const value: ExportResult = { filename: `animalge-evidence-${hex}.json`, canonicalJson: exported.bytes }
    return { ok: true, export: value }
  }

  /** §6.4: the single non-query method — idempotent notification-seen write (user decision 2026-08-28). */
  @Remote('markSeen')
  markSeen(agent: Agent, request: { issueKeys: string[] }): Promise<MarkSeenResponse> {
    return this.markSeenFor(agent, request)
  }

  private async markSeenFor(agent: Agent, request: { issueKeys: string[] }): Promise<MarkSeenResponse> {
    const { graphId } = resolveGraph(this.store, agent.session.id)
    if (graphId === null) return { ok: false, error: error('scope_mismatch', 'the Session owns no Evidence Graph') }
    const result: MarkSeenResult = await markIssuesSeen(this.store, agent.session.id, request.issueKeys)
    return { ok: true, result }
  }

  /** §11.4-2: "立即处理/重试 Evidence 更新" — the second and only other non-query method
   * (owner function beside markSeen; user ruling recorded in the C2→new-cycle disposition).
   * Acts only on the persisted backlog (priority raise / resume from the durable compile
   * boundary); never runs research tools; `busy` is the same-target-active-attempt signal
   * the View uses for its disabled condition. */
  @Remote('processBacklog')
  processBacklog(agent: Agent): Promise<ProcessBacklogResponse> {
    const { graphId } = resolveGraph(this.store, agent.session.id)
    if (graphId === null) return Promise.resolve({ ok: false, error: error('scope_mismatch', 'the Session owns no Evidence Graph') })
    return processBacklogRows(this.store, graphId).then(outcome => ({ ok: true as const, outcome }))
  }
}

export default EvidenceService
