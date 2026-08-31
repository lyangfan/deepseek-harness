/**
 * Internal query helpers of the Evidence read service: session→Graph resolution, verified
 * Snapshot loading, the opaque-cursor codec, and the owner→DTO projections. Read-only over the
 * provided store; the only write anywhere in this package is the markSeen delegation.
 */

import { canonicalJson, taggedSha256Digest } from '@deepseek-ai/dsh-evidence-core'
import type {
  CandidateCard,
  CandidateDetails,
  CandidatePage,
  EvidenceStatus,
  NavigateRequest,
  NavigationResolution,
  ObjectDetails,
  ObjectSummary,
  PathView,
  SemanticChannel,
  SnapshotHeader,
  Subtype,
  TypedObjectRef,
  VersionTokens,
} from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CandidateStatementPayloadV1,
  EvidenceNodeV1,
  EvidenceSnapshotPayloadV1,
  IssueRecordV1,
  IssueSeenV1,
  Sha256Digest,
  StoredSnapshotV1,
} from '@deepseek-ai/dsh-evidence-core/types'
import type { EvidenceGraphId } from '@deepseek-ai/dsh-evidence-core/types'
import type { EvidenceStore } from '@deepseek-ai/dsh-evidence-core'
import { graphStatusFacts, issueRecordsFor, issueSeenFor, issueStateRevision, openIssueCount, unreadIssueCount } from '@deepseek-ai/dsh-evidence-core'

/** Frozen page size (spec §4.4): a constant, not Config. */
export const CANDIDATES_PAGE_SIZE = 50
/** Frozen first-batch size per relation group (spec §4.5). */
export const PATH_GROUP_FIRST = 20
/** Cursor binding revision (spec §4.4): tagged digest over the five binding fields. */
const CURSOR_TAG = 'animalge:evidence-cursor/v1'

export interface GraphResolution {
  readonly graphId: EvidenceGraphId | null
}

/** Resolve the Session's Graph (v0.1 is strictly 1:1; no bootstrap row means no_graph). */
export function resolveGraph(store: EvidenceStore, sessionId: SessionId): GraphResolution {
  return { graphId: store.sessionGraphs.get(sessionId)?.graphId ?? null }
}

/** Load one committed Snapshot by exact digest; named error `snapshot_not_found` on any miss. */
type LoadedSnapshot = { record: StoredSnapshotV1; payload: EvidenceSnapshotPayloadV1 } | { notFound: true }

export function loadSnapshot(store: EvidenceStore, graphId: EvidenceGraphId, digest: string): LoadedSnapshot {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return { notFound: true }
  try {
    // committedSnapshot re-verifies digest + byte length on every read (integrity.ts).
    const record = store.committedSnapshot(digest as Sha256Digest)
    const payload = record.payload as unknown as EvidenceSnapshotPayloadV1
    if (payload.scope.graphId !== graphId) return { notFound: true }
    return { record, payload }
  } catch {
    return { notFound: true }
  }
}

/** Map a committed Snapshot to the header DTO (§4.3), flagging current vs historical. */
export function snapshotHeaderOf(
  store: EvidenceStore, graphId: EvidenceGraphId, record: StoredSnapshotV1, payload: EvidenceSnapshotPayloadV1,
): SnapshotHeader {
  const head = store.heads.get(graphId)
  const semantic = payload.semanticWatermark
  return {
    graphId,
    snapshotDigest: record.snapshotDigest,
    isCurrent: head?.snapshotDigest === record.snapshotDigest,
    committedAt: head !== undefined && head.snapshotDigest === record.snapshotDigest
      ? headCommitTime(store, graphId, head.headRevision)
      : 0,
    deterministicWatermark: payload.deterministicWatermark.nextSeqExclusive,
    semanticWatermark: 'kind' in semantic && semantic.kind === 'active'
      ? { kind: 'active', nextSeqExclusive: semantic.nextSeqExclusive }
      : 'kind' in semantic && semantic.kind === 'disabled'
        ? { kind: 'disabled', lastNextSeqExclusive: semantic.lastNextSeqExclusive }
        : { kind: 'not_configured' },
    schemaSet: [...payload.schemaSet],
    versions: responseTokens(store),
  }
}

function headCommitTime(store: EvidenceStore, graphId: EvidenceGraphId, headRevision: number): number {
  return store.headCommits.get(`${graphId}:${headRevision}`)?.committedAt ?? 0
}

/** Response tokens: materialStateDigest + per-Graph head revision + issuesRevision (§5.3). */
export function responseTokens(store: EvidenceStore, graphId?: EvidenceGraphId): VersionTokens {
  return {
    materialStateDigest: store.materialStateDigest(),
    headRevision: graphId === undefined ? 0 : store.heads.get(graphId)?.headRevision ?? 0,
    issuesRevision: issueStateRevision(store),
  }
}

/** Semantic channel state (§4.2): the committed tri-state watermark is the authority; the
 * switch record covers graphs that have not committed their first Snapshot yet. */
export function semanticChannelOf(
  store: EvidenceStore, graphId: EvidenceGraphId, payload: EvidenceSnapshotPayloadV1 | null,
): SemanticChannel {
  // The session-level switch record is the live override: an explicit off shows 'disabled'
  // even while the last committed Snapshot still carries an 'active' watermark kind (§4.3).
  if (store.semanticSwitchFor(graphId)?.enabled === false) return 'disabled'
  if (payload !== null) {
    const semantic = payload.semanticWatermark
    if ('kind' in semantic) return semantic.kind
    return 'not_configured'
  }
  const record = store.semanticSwitchFor(graphId)
  if (record === undefined) return 'not_configured'
  return record.enabled ? 'active' : 'disabled'
}

/** Full status DTO (§4.2) from the shared single derivation (§11.2). */
export function statusOf(store: EvidenceStore, graphId: EvidenceGraphId): EvidenceStatus {
  const facts = graphStatusFacts(store, graphId, Date.now())
  let candidates = 0
  let payload: EvidenceSnapshotPayloadV1 | null = null
  if (facts.headSnapshotDigest !== null) {
    const loaded = loadSnapshot(store, graphId, facts.headSnapshotDigest)
    if ('payload' in loaded) {
      payload = loaded.payload
      candidates = countCandidates(loaded.payload)
    }
  }
  return {
    kind: 'graph',
    graphId,
    currentSnapshotDigest: facts.headSnapshotDigest,
    headRevision: facts.headRevision,
    freshness: facts.freshness,
    pending: facts.pending,
    semanticChannel: semanticChannelOf(store, graphId, payload),
    counts: { candidates, openIssues: openIssueCount(store, graphId) },
    versions: responseTokens(store, graphId),
  }
}

function countCandidates(payload: EvidenceSnapshotPayloadV1): number {
  let count = 0
  for (const node of payload.nodes) {
    if (node.nodeKind === 'CandidateStatement' && node.projectionState !== 'excluded') count++
  }
  return count
}

/** The candidate card's five display fields + identity/projection (§4.4, D-137). */
interface BreakpointFact { code: string; relatedObjectIds: readonly string[] }

export function candidateCardOf(node: EvidenceNodeV1, breakpoints: readonly BreakpointFact[]): CandidateCard {
  const payload = node.payload as CandidateStatementPayloadV1
  const nodeId = node.nodeId
  const topBreakpoint = breakpoints.find(breakpoint => breakpoint.relatedObjectIds.includes(nodeId))?.code ?? null
  return {
    candidateId: payload.candidateId,
    subtype: payload.subtype,
    text: payload.text,
    relationSummary: payload.relationSummary,
    sourceLabel: `Agent 消息 #${String(payload.sourceBinding.eventSeq)}`,
    topBreakpoint,
    projectionState: node.projectionState === 'diagnostic' ? 'diagnostic' : 'active',
  }
}

interface CursorBinding {
  readonly snapshotDigest: string
  readonly kind: 'candidates'
  readonly subtypes: readonly Subtype[]
  readonly sort: 'candidateId'
  readonly lastSeenCandidateId: string
  readonly binding: string
}

function cursorBindingDigest(snapshotDigest: string, subtypes: readonly Subtype[], sort: string): string {
  return taggedSha256Digest(CURSOR_TAG, { snapshotDigest, kind: 'candidates', subtypes: [...subtypes].sort(), sort })
}

/** Encode a page cursor: opaque base64url of the canonical binding JSON (§4.4). */
export function encodeCursor(snapshotDigest: string, subtypes: readonly Subtype[], lastSeenCandidateId: string): string {
  const sorted = [...subtypes].sort()
  const binding: CursorBinding = {
    snapshotDigest, kind: 'candidates', subtypes: sorted, sort: 'candidateId',
    lastSeenCandidateId, binding: cursorBindingDigest(snapshotDigest, sorted, 'candidateId'),
  }
  return Buffer.from(canonicalJson(binding as never), 'utf8').toString('base64url')
}

/** Decode and re-validate a cursor against the request context; named error on drift (§4.4). */
type DecodedCursor = { lastSeenCandidateId: string } | { invalid: true }

export function decodeCursor(cursor: string, snapshotDigest: string, subtypes: readonly Subtype[]): DecodedCursor {
  // Wire cursors are untrusted JSON: validate field-by-field instead of trusting a cast.
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    return { invalid: true }
  }
  const row = parsed as { kind?: unknown; sort?: unknown; binding?: unknown; lastSeenCandidateId?: unknown }
  const expected = cursorBindingDigest(snapshotDigest, [...subtypes].sort(), 'candidateId')
  if (row.binding !== expected || row.kind !== 'candidates' || row.sort !== 'candidateId') return { invalid: true }
  if (typeof row.lastSeenCandidateId !== 'string' || row.lastSeenCandidateId.length === 0) return { invalid: true }
  return { lastSeenCandidateId: row.lastSeenCandidateId }
}

/** Build one candidate page from the snapshot payload (§4.4: page 50 + exact total). */
export function candidatePageOf(
  store: EvidenceStore, payload: EvidenceSnapshotPayloadV1, snapshotDigest: string,
  cursor: string | null, subtypes: readonly Subtype[],
): CandidatePage | { cursorInvalid: true } {
  const filter = new Set<Subtype>(subtypes)
  const matching: CandidateCard[] = []
  for (const node of payload.nodes) {
    if (node.nodeKind !== 'CandidateStatement' || node.projectionState === 'excluded') continue
    const card = candidateCardOf(node, payload.breakpoints)
    if (filter.size > 0 && !filter.has(card.subtype)) continue
    matching.push(card)
  }
  matching.sort((left, right) => left.candidateId.localeCompare(right.candidateId))
  let start = 0
  if (cursor !== null) {
    const decoded = decodeCursor(cursor, snapshotDigest, subtypes)
    if ('invalid' in decoded) return { cursorInvalid: true }
    const index = matching.findIndex(card => card.candidateId === decoded.lastSeenCandidateId)
    start = index < 0 ? matching.length : index + 1
  }
  const items = matching.slice(start, start + CANDIDATES_PAGE_SIZE)
  const hasNext = start + CANDIDATES_PAGE_SIZE < matching.length
  return {
    items,
    total: matching.length,
    from: matching.length === 0 || items.length === 0 ? 0 : start + 1,
    to: start + items.length,
    nextCursor: (() => {
      const lastCard = items[items.length - 1]
      return hasNext && lastCard !== undefined ? encodeCursor(snapshotDigest, subtypes, lastCard.candidateId) : null
    })(),
    versions: responseTokens(store, payload.scope.graphId),
  }
}

/** Object summary label per kind (short, human-readable; full fields live in details). */
export function objectSummaryOf(node: EvidenceNodeV1): ObjectSummary {
  const label = node.nodeKind === 'CandidateStatement'
    ? (node.payload).text.split('\n')[0] ?? ''
    : node.nodeKind === 'Run'
      ? `Run ${(node.payload as { operation?: { toolName?: string } }).operation?.toolName ?? ''}`.trim()
      : node.nodeKind
  return { ref: refOfNode(node), label, projectionState: node.projectionState }
}

/** The typed identity tuple of one node (owner ids as plain wire strings). */
export function refOfNode(node: EvidenceNodeV1): TypedObjectRef {
  const id = node.nodeKind === 'CandidateStatement'
    ? (node.payload).candidateId
    : node.nodeKind === 'ArtifactVersion'
      ? (node.payload as { artifactVersionId: string }).artifactVersionId
      : node.nodeKind === 'Observation'
        ? (node.payload as { observationId?: string }).observationId ?? node.nodeId
        : node.nodeKind === 'ContextEntity'
          ? (node.payload as { contextEntityId: string }).contextEntityId
          : (node.payload as { runId: string }).runId
  return { kind: node.nodeKind, id }
}

/** One-hop path view around a center object (§4.5: per-group first 20 + exact totals). */
export function pathViewOf(
  store: EvidenceStore, payload: EvidenceSnapshotPayloadV1, center: TypedObjectRef,
): PathView | { notFound: true } {
  const byId = new Map<string, EvidenceNodeV1>()
  for (const node of payload.nodes) {
    if (refOfNode(node).id === center.id && node.nodeKind === center.kind) byId.set(node.nodeId, node)
  }
  const centerNode = [...byId.values()][0]
  if (centerNode === undefined) return { notFound: true }
  const groups = new Map<string, { direction: 'in' | 'out'; edgeType: string; items: ObjectSummary[]; total: number }>()
  for (const edge of payload.edges) {
    if (edge.projectionState === 'excluded') continue
    const direction = edge.to === centerNode.nodeId ? 'in' : edge.from === centerNode.nodeId ? 'out' : null
    if (direction === null) continue
    const otherId = direction === 'in' ? edge.from : edge.to
    const other = payload.nodes.find(node => node.nodeId === otherId && node.projectionState !== 'excluded')
    if (other === undefined) continue
    const key = `${direction}:${edge.edgeType}`
    const group = groups.get(key) ?? { direction, edgeType: edge.edgeType, items: [], total: 0 }
    group.total++
    if (group.items.length < PATH_GROUP_FIRST) group.items.push(objectSummaryOf(other))
    groups.set(key, group)
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group)
  return {
    center: objectSummaryOf(centerNode),
    groups: sorted,
    versions: responseTokens(store, payload.scope.graphId),
  }
}

/** Issue rows + seen state → wire view with the unread count (§6.4). */
export function issuesViewOf(
  store: EvidenceStore, graphId: EvidenceGraphId, includeResolved: boolean,
): { items: IssueViewRow[]; unread: number } {
  const records = issueRecordsFor(store, graphId).filter(record => includeResolved || record.resolvedAt === null)
  const seen = issueSeenFor(store, records.map(record => record.issueKey))
  const items = records.map(record => issueViewOf(record, seen.get(record.issueKey)))
  return { items, unread: unreadIssueCount(store, graphId) }
}

export interface IssueViewRow {
  readonly issueKey: string
  readonly severity: 'attention' | 'action_required'
  readonly conditionCode: string
  readonly targetKind: string
  readonly targetId: string
  readonly applicableSnapshotDigest: string | null
  readonly applicableWatermark: number
  readonly firstSeenAt: number
  readonly lastSeenAt: number
  readonly occurrenceCount: number
  readonly resolvedAt: number | null
  readonly seenAt: number | null
}

function issueViewOf(record: IssueRecordV1, seen: IssueSeenV1 | undefined): IssueViewRow {
  return {
    issueKey: record.issueKey,
    severity: record.severity,
    conditionCode: record.conditionCode,
    targetKind: record.targetKind,
    targetId: record.targetId,
    applicableSnapshotDigest: record.applicableSnapshotDigest,
    applicableWatermark: record.applicableWatermark,
    firstSeenAt: record.firstSeenAt,
    lastSeenAt: record.lastSeenAt,
    occurrenceCount: record.occurrenceCount,
    resolvedAt: record.resolvedAt,
    seenAt: seen?.seenAt ?? null,
  }
}


/** Per-kind technical details projection (§4.6; JSON-stringified provenance blocks stay exact). */
export function detailsOf(store: EvidenceStore, node: EvidenceNodeV1): ObjectDetails {
  if (node.nodeKind === 'Run') {
    const payload = node.payload
    const receiptBacked = payload.runSchema === 'animalge.run.receipt-backed/v1'
    const finalization = store.finalizationForRun(payload.runId)
    const manifest = finalization === undefined ? undefined : store.outputManifests.get(finalization.manifestId)
    return {
      kind: 'Run',
      callId: payload.primaryCallId,
      toolName: payload.operation.toolName,
      argumentsDigest: payload.invocationDigest,
      captureBasis: receiptBacked ? 'receipt' : 'event',
      selectionBasis: JSON.stringify(payload.selectionBasis),
      outcome: payload.outcome,
      eventSeqRange: payload.eventSeqRange,
      receiptSubmissionRef: receiptBacked ? (payload).receiptId : null,
      outputManifestRef: finalization === undefined ? null : `output-manifest:${String(finalization.manifestId)}`,
      outputs: manifest?.formalOutputs.map(output => ({ role: output.role, artifactVersionRef: String(output.artifactVersionId) })) ?? [],
    }
  }
  if (node.nodeKind === 'ArtifactVersion') {
    const payload = node.payload
    const frozen = store.locationObservations.get(payload.frozenLocationObservationId)
    const anchors: { sourceAnchorId: string; sourceKind: string }[] = []
    for (const [, anchor] of store.sourceAnchors.entries()) {
      if (anchor.sourceVersionRef === payload.artifactVersionId) {
        anchors.push({ sourceAnchorId: anchor.anchorId, sourceKind: anchor.sourceKind })
      }
    }
    anchors.sort((left, right) => left.sourceAnchorId.localeCompare(right.sourceAnchorId))
    return {
      kind: 'ArtifactVersion',
      artifactId: payload.artifactId,
      artifactVersionId: payload.artifactVersionId,
      contentDigest: payload.contentDigest,
      byteLength: payload.byteLength,
      mediaType: payload.mediaType,
      frozenLocator: frozen?.locator ?? null,
      frozenAvailability: frozen?.availability ?? null,
      anchors,
    }
  }
  if (node.nodeKind === 'Observation') {
    const payload = node.payload
    return { kind: 'Observation', observationKind: payload.observationKind, runId: payload.runId, outcome: payload.outcome, resultBlockCount: payload.resultBlockCount }
  }
  if (node.nodeKind === 'CandidateStatement') {
    const payload = node.payload
    const details: CandidateDetails = {
      kind: 'CandidateStatement',
      candidateId: payload.candidateId,
      subtype: payload.subtype,
      text: payload.text,
      sourceBinding: JSON.stringify(payload.sourceBinding),
      generationProvenance: JSON.stringify(payload.generationProvenance),
      relationSummary: payload.relationSummary,
    }
    return details
  }
  const payload = node.payload
  return { kind: 'ContextEntity', contextKind: payload.contextKind, name: payload.identity.name, version: payload.identity.version }
}

/** Four-state navigation inside one Snapshot (§4.8): only exact identities match. */
export function navigateWithin(payload: EvidenceSnapshotPayloadV1, request: NavigateRequest): NavigationResolution {
  if (request.source.kind === 'session_event') {
    // SourceAssertion nodes fail closed in v0.1: the honest resolution is not_in_snapshot.
    return { result: 'not_in_snapshot' }
  }
  const matches: TypedObjectRef[] = []
  for (const node of payload.nodes) {
    if (node.projectionState === 'excluded') continue
    if (request.source.kind === 'tool_call' && node.nodeKind === 'Run') {
      const runPayload = node.payload
      if (runPayload.primaryCallId === request.source.callId) matches.push(refOfNode(node))
    }
    if (request.source.kind === 'artifact_version' && node.nodeKind === 'ArtifactVersion') {
      const artifactPayload = node.payload
      if (artifactPayload.artifactVersionId === request.source.artifactVersionId) matches.push(refOfNode(node))
    }
  }
  const exact = matches[0]
  if (matches.length === 1 && exact !== undefined) return { result: 'found', target: exact }
  if (matches.length > 1) return { result: 'multiple', alternatives: matches }
  return { result: 'not_in_snapshot' }
}
