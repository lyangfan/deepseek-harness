/**
 * The Evidence remote API wrapper and the refresh channel (SPEC-05 §5.3): every call flattens
 * the wire `RemoteResult` layer onto the service's typed result unions, and the forwarded
 * `evidence/updated` event is deduped against the last recorded three version tokens —
 * equal tokens drop the event, any change wakes the session's subscribers. Views record the
 * tokens of each successful response so dedup always compares real query output.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the cordis Events declaration for 'evidence/updated' ($on key typing).
import type {} from '@deepseek-ai/dsh-evidence-core/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CandidatesResponse,
  ExportResponse,
  IssuesResponse,
  MarkSeenResponse,
  NavigationResolution,
  ObjectDetailsResponse,
  OpenTargetResponse,
  PathResponse,
  PreviewResponse,
  ProcessBacklogResponse,
  ReceiptResponse,
  ServiceError,
  SnapshotResponse,
  StatusResponse,
  VersionTokens,
} from '@deepseek-ai/dsh-evidence-service/client'

/** Navigation source input mirrored from the wire DTO (kept structural for the view). */
export type NavigationSourceInput =
  | { kind: 'tool_call'; callId: string }
  | { kind: 'artifact_version'; artifactVersionId: string }
  | { kind: 'session_event'; eventSeq: number }

/** Flattened navigation outcome: the four-state resolution or a transport error;
 * `found` results from navigateCurrent additionally carry the bound snapshotDigest (§10.4). */
export type NavigationOutcome = NavigationResolution | { result: 'error'; error: ServiceError } | { result: 'found'; target: { kind: string; id: string }; snapshotDigest: string }

/** The per-session verb face handed to the view components (§4/§6/§7/§8 unions as-is). */
export interface EvidenceApi {
  status(): Promise<StatusResponse>
  snapshot(requestedDigest: string | null): Promise<SnapshotResponse>
  candidates(snapshotDigest: string, cursor: string | null, subtypes: readonly string[]): Promise<CandidatesResponse>
  path(snapshotDigest: string, center: { kind: string; id: string }): Promise<PathResponse>
  objectDetails(snapshotDigest: string, ref: { kind: string; id: string }): Promise<ObjectDetailsResponse>
  receipt(submissionRef: string): Promise<ReceiptResponse>
  issues(includeResolved: boolean): Promise<IssuesResponse>
  navigate(snapshotDigest: string, source: NavigationSourceInput): Promise<NavigationOutcome>
  navigateCurrent(source: NavigationSourceInput): Promise<NavigationOutcome>
  preview(snapshotDigest: string, artifactVersionId: string, sourceAnchorId: string): Promise<PreviewResponse>
  openTarget(snapshotDigest: string, artifactVersionId: string): Promise<OpenTargetResponse>
  exportSnapshot(snapshotDigest: string): Promise<ExportResponse>
  markSeen(issueKeys: readonly string[]): Promise<MarkSeenResponse>
  processBacklog(): Promise<ProcessBacklogResponse>
}

/** The per-session refresh face: token-deduped `evidence/updated` wake (§5.3). */
export interface EvidenceRefresh {
  subscribe(listener: () => void): () => void
  version(): number
  recordTokens(tokens: VersionTokens): void
}

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: ServiceError }
type Wire = {
  status(sessionId: SessionId): Promise<RemoteResult<StatusResponse>>
  snapshot(sessionId: SessionId, request: { requestedDigest: string | null }): Promise<RemoteResult<SnapshotResponse>>
  candidates(sessionId: SessionId, request: {
    snapshotDigest: string
    cursor: string | null
    filter: { subtypes: unknown[] } | null
  }): Promise<RemoteResult<CandidatesResponse>>
  path(sessionId: SessionId, request: { snapshotDigest: string; center: unknown }): Promise<RemoteResult<PathResponse>>
  objectDetails(sessionId: SessionId, request: { snapshotDigest: string; ref: unknown }): Promise<RemoteResult<ObjectDetailsResponse>>
  receipt(sessionId: SessionId, request: { submissionRef: string }): Promise<RemoteResult<ReceiptResponse>>
  issues(sessionId: SessionId, request: { includeResolved: boolean }): Promise<RemoteResult<IssuesResponse>>
  navigate(
    sessionId: SessionId, request: { snapshotDigest: string; source: unknown },
  ): Promise<RemoteResult<{ ok: true; resolution: NavigationResolution } | { ok: false; error: ServiceError }>>
  preview(sessionId: SessionId, request: {
    snapshotDigest: string
    sourceAssertionId: string | null
    artifactVersionId: string
    sourceAnchorId: string
  }): Promise<RemoteResult<PreviewResponse>>
  openTarget(sessionId: SessionId, request: {
    snapshotDigest: string
    artifactVersionId: string
  }): Promise<RemoteResult<OpenTargetResponse>>
  exportSnapshot(sessionId: SessionId, request: {
    snapshotDigest: string
  }): Promise<RemoteResult<ExportResponse>>
  markSeen(sessionId: SessionId, request: { issueKeys: string[] }): Promise<RemoteResult<MarkSeenResponse>>
  processBacklog(sessionId: SessionId): Promise<RemoteResult<ProcessBacklogResponse>>
}

/** Build the shared API + refresh pair (one per plugin; per-session faces close over the SessionId). */
export function createEvidenceBridge(ctx: Context): { forSession(sessionId: SessionId): { api: EvidenceApi; refresh: EvidenceRefresh } } {
  const wire = (ctx.remote as unknown as { evidence: Wire }).evidence
  const versions = new Map<SessionId, number>()
  const tokens = new Map<SessionId, VersionTokens>()
  const listeners = new Map<SessionId, Set<() => void>>()
  const transport = (message: string): ServiceError => ({ code: 'transport', message })
  // §3.2: plugin-scoped lifecycle — the subscription follows this fiber's dispose and is
  // re-established cleanly on HMR reload (no listener accumulation across reloads).
  ctx.effect(() => ctx.remote.$on('evidence/updated', (payload: { sessionId: string; materialStateDigest: string; headRevision: number; issuesRevision: string }) => {
    const sessionId = payload.sessionId as SessionId
    const last = tokens.get(sessionId)
    // §5.3 dedup: equal three-token sets carry no new state for this client — regardless of
    // whether the baseline came from a query response or a previous event, the newest
    // observed token set is the baseline (otherwise consecutive identical events each wake
    // a redundant re-query).
    if (last !== undefined
      && last.materialStateDigest === payload.materialStateDigest
      && last.headRevision === payload.headRevision
      && last.issuesRevision === payload.issuesRevision) return
    tokens.set(sessionId, {
      materialStateDigest: payload.materialStateDigest,
      headRevision: payload.headRevision,
      issuesRevision: payload.issuesRevision,
    })
    versions.set(sessionId, (versions.get(sessionId) ?? 0) + 1)
    for (const listener of listeners.get(sessionId) ?? []) listener()
  }), 'ui-evidence: evidence/updated subscription')
  return { forSession(sessionId: SessionId) {
    const flat = async <T>(invoke: () => Promise<RemoteResult<T>>, fallback: T): Promise<T> => {
      const result = await invoke()
      return result.ok ? result.value : fallback
    }
    const api: EvidenceApi = {
      status: () => flat(() => wire.status(sessionId), { ok: false, error: transport('status call failed') }),
      snapshot: requestedDigest => flat(() => wire.snapshot(sessionId, { requestedDigest }), { ok: false, error: transport('snapshot call failed') }),
      candidates: (snapshotDigest, cursor, subtypes) => flat(() => wire.candidates(sessionId, {
        snapshotDigest, cursor, filter: subtypes.length === 0 ? null : { subtypes: [...subtypes] },
      }), { ok: false, error: transport('candidates call failed') }),
      path: (snapshotDigest, center) => flat(() => wire.path(sessionId, { snapshotDigest, center }), { ok: false, error: transport('path call failed') }),
      objectDetails: (snapshotDigest, ref) => flat(() => wire.objectDetails(sessionId, { snapshotDigest, ref }), { ok: false, error: transport('objectDetails call failed') }),
      receipt: submissionRef => flat(() => wire.receipt(sessionId, { submissionRef }), { ok: false, error: transport('receipt call failed') }),
      issues: includeResolved => flat(() => wire.issues(sessionId, { includeResolved }), { ok: false, error: transport('issues call failed') }),
      navigate: async (snapshotDigest, source) => {
        const result = await wire.navigate(sessionId, { snapshotDigest, source })
        if (!result.ok) return { result: 'error', error: result.error }
        return result.value.ok ? result.value.resolution : { result: 'error', error: result.value.error }
      },
      navigateCurrent: async (source) => {
        const status = await flat(() => wire.status(sessionId), { ok: false, error: transport('status call failed') })
        const digest = status.ok && status.status.kind === 'graph' ? status.status.currentSnapshotDigest : null
        if (digest === null) return { result: 'not_in_snapshot' }
        const nav = await api.navigate(digest, source)
        // §10.4: found resolutions carry the bound snapshot digest so the tool-card link
        // can construct the frozen {snapshotDigest, ref} focus payload.
        if (nav.result === 'found') return { ...nav, snapshotDigest: digest }
        return nav
      },
      preview: (snapshotDigest, artifactVersionId, sourceAnchorId) => flat(() => wire.preview(sessionId, {
        snapshotDigest, sourceAssertionId: null, artifactVersionId, sourceAnchorId,
      }), { ok: false, error: transport('preview call failed') }),
      openTarget: (snapshotDigest, artifactVersionId) => flat(() => wire.openTarget(sessionId, {
        snapshotDigest, artifactVersionId,
      }), { result: { ok: false, reason: 'transport' }, ok: false, error: transport('openTarget call failed') } as never),
      exportSnapshot: snapshotDigest => flat(() => wire.exportSnapshot(sessionId, { snapshotDigest }), { ok: false, error: transport('export call failed') }),
      markSeen: issueKeys => flat(() => wire.markSeen(sessionId, { issueKeys: [...issueKeys] }), { ok: false, error: transport('markSeen call failed') }),
      processBacklog: () => flat(() => wire.processBacklog(sessionId), { ok: false, error: transport('processBacklog call failed') }),
    }
    const refresh: EvidenceRefresh = {
      subscribe: (listener) => {
        const set = listeners.get(sessionId) ?? new Set()
        listeners.set(sessionId, set)
        set.add(listener)
        return () => { set.delete(listener) }
      },
      version: () => versions.get(sessionId) ?? 0,
      recordTokens: (next) => { tokens.set(sessionId, next) },
    }
    return { api, refresh }
  } }
}
