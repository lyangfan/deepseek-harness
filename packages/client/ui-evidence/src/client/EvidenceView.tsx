/**
 * The Evidence view tab (SPEC-05 §9–§11): candidate-first homepage with the five-item
 * deterministic summary, fixed viewedSnapshotDigest reading (pinning, merged new-version
 * notice, explicit switch with precise-identity focus continuation), one-hop local path with
 * the frozen scale budgets, object-level technical details, the dual-channel pending layer
 * with the four first-empty states, the three strictly-separated actions, issues with
 * markSeen, canonical export, the bounded return stack, container-tier layout, and the
 * D-140 recovery triple. No toasts, no chat injection — every notice is inline text.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ViewNavigationFace } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  CandidateCard,
  EvidenceStatus,
  IssueView,
  ObjectDetails,
  OpenTargetResponse,
  PathView,
  PreviewFragment,
} from '@deepseek-ai/dsh-evidence-service/client'
import type { EvidenceApi, EvidenceRefresh } from './api.ts'
import type { NS } from './locales.ts'

/** The tab's inject face (apply closure verbs + the exact-navigation seam). */
export interface EvidenceInjected {
  readonly api: EvidenceApi
  readonly refresh: EvidenceRefresh
  readonly navigation: ViewNavigationFace | null
  /** §7.5 handoff verb: the apply closure gates on isLoopback && canOpenPath. */
  readonly openFile: (path: string) => void
}

export type EvidenceViewProps = ConvViewProps & InjectFace<EvidenceInjected> & PropsLocale<typeof NS>

/** Frozen constants (spec §13.1 — not Config). */
const VIEW_NODE_BUDGET = 100
const VIEW_EDGE_BUDGET = 200
const CARD_FOLD_LINES = 3
const RETURN_STACK_DEPTH = 10
const CONTAINER_WIDE = 960
const CONTAINER_MIN = 600

/** One return-stack entry (§10.3): the precise origin of a past navigation. */
interface ReturnEntry {
  readonly pane: 'list' | 'path' | 'details'
  readonly digest: string | null
  readonly ref: { kind: string; id: string } | null
  readonly pathCenter: { kind: string; id: string } | null
}

type LayoutTier = 'wide' | 'narrow' | 'minimal'

interface SelectionRef { kind: string; id: string }
interface PageState {
  items: readonly CandidateCard[]
  total: number
  from: number
  to: number
  nextCursor: string | null
  prevCursor: string | null
}

/** The Evidence tab component (registered as `conversation.view` id `evidence`). */
export function EvidenceView({ sessionId, t, api, refresh, navigation, openFile }: EvidenceViewProps) {
  const refreshSubscribe = refresh.subscribe.bind(refresh)
  const refreshVersionOf = refresh.version.bind(refresh)
  const refreshVersion = useSyncExternalStore(refreshSubscribe, refreshVersionOf)
  // §11.4-1: the manual refresh action re-runs the view's queries and nothing else.
  const [queryTick, setQueryTick] = useState(0)

  const [status, setStatus] = useState<EvidenceStatus | null>(null)
  const [viewed, setViewed] = useState<string | null>(null)
  const [selection, setSelection] = useState<SelectionRef | null>(null)
  const [page, setPage] = useState<PageState | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [prevCursors, setPrevCursors] = useState<readonly string[]>([])
  const [path, setPath] = useState<PathView | null>(null)
  const [details, setDetails] = useState<ObjectDetails | null>(null)
  const [issues, setIssues] = useState<readonly IssueView[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [preview, setPreview] = useState<PreviewFragment | null>(null)
  const [returnStack, setReturnStack] = useState<readonly ReturnEntry[]>([])
  const [width, setWidth] = useState<number>(CONTAINER_WIDE)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const restoredRef = useRef(false)

  const tier: LayoutTier = width >= CONTAINER_WIDE ? 'wide' : width >= CONTAINER_MIN ? 'narrow' : 'minimal'

  // Container-tier observation (§9.4): the Evidence view's own content width decides.
  useEffect(() => {
    const element = containerRef.current
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  // Status load + token recording + refresh wake (§5.3): the query response is authoritative.
  useEffect(() => {
    void (async () => {
      const response = await api.status()
      if (response.ok) {
        setStatus(response.status)
        if (response.status.kind === 'graph') {
          refresh.recordTokens(response.status.versions)
        }
      }
    })()
  }, [api, refresh, refreshVersion, queryTick])

  const graphStatus = status !== null && status.kind === 'graph' ? status : null
  const currentDigest = graphStatus?.currentSnapshotDigest ?? null

  // §10.1 pinning: a normal first entry fixes the then-current digest and selects nothing.
  useEffect(() => {
    if (viewed !== null || currentDigest === null) return
    setViewed(currentDigest)
  }, [viewed, currentDigest])

  // §9.5 recovery: the persisted focus triple restores only when its digest is still current
  // and the object still resolves; otherwise one neutral inline notice (never a toast).
  const persistedFocus = useSyncExternalStore(subscribePersistedFocus, () => readPersistedFocus(sessionId))
  const persistedSubtypes = useSyncExternalStore(subscribePersistedFocus, () => readPersistedSubtypes(sessionId))
  useEffect(() => {
    if (restoredRef.current || viewed === null || currentDigest === null) return
    restoredRef.current = true
    if (persistedFocus !== null && persistedFocus.snapshotDigest === currentDigest) {
      void (async () => {
        const response = await api.objectDetails(currentDigest, { kind: persistedFocus.objectType, id: persistedFocus.objectId })
        if (response.ok) setSelection({ kind: persistedFocus.objectType, id: persistedFocus.objectId })
        else setNotice(t('notice.recoverySkipped'))
      })()
    } else if (persistedFocus !== null) {
      setNotice(t('notice.recoverySkipped'))
    }
  }, [persistedFocus, viewed, currentDigest, api, t])

  // §10.1 entry activation: tool-card links activate this tab with a precise plugin focus.
  // uSES needs a referentially stable subscribe: binding during the render would hand it a
  // fresh function every render and force unsubscribe/resubscribe churn (and the snapshot
  // must be a stable value per underlying state), so both are memoized per seam/session.
  const navigationSubscribe = useMemo(
    () => navigation === null ? constantUnsubscribe : navigation.subscribe.bind(navigation),
    [navigation],
  )
  const navigationSnapshot = useCallback(
    () => navigation === null ? null : navigation.activationFor(sessionId),
    [navigation, sessionId],
  )
  const activation = useSyncExternalStore(navigationSubscribe, navigationSnapshot)
  useEffect(() => {
    if (activation === null || activation.viewId !== 'evidence') return
    const focus = activation.focus
    if (focus !== null && focus.kind === 'plugin') {
      const payload = focus.payload as { snapshotDigest?: string; ref?: { kind: string; id: string } } | null
      if (payload?.snapshotDigest !== undefined && payload.ref !== undefined) {
        setViewed(payload.snapshotDigest)
        setSelection(payload.ref)
      }
    }
  }, [activation])

  // Candidate page (§4.4): reload whenever the viewed digest, cursor or refresh wake changes.
  useEffect(() => {
    if (viewed === null) return
    void (async () => {
      const response = await api.candidates(viewed, cursor, persistedSubtypes)
      if (response.ok) {
        setPage({
          items: response.page.items,
          total: response.page.total,
          from: response.page.from,
          to: response.page.to,
          nextCursor: response.page.nextCursor,
          prevCursor: prevCursors.length === 0 ? null : prevCursors[prevCursors.length - 1] ?? null,
        })
      }
    })()
  }, [api, viewed, cursor, prevCursors, persistedSubtypes, refreshVersion, queryTick])

  // One-hop path (§4.5): loaded for the current selection only.
  useEffect(() => {
    if (viewed === null || selection === null) { setPath(null); return }
    void (async () => {
      const response = await api.path(viewed, selection)
      if (response.ok) setPath(response.view)
    })()
  }, [api, viewed, selection, refreshVersion, queryTick])

  // Issues list (§6.4).
  useEffect(() => {
    void (async () => {
      const response = await api.issues(false)
      if (response.ok) setIssues(response.view.items)
    })()
  }, [api, refreshVersion, queryTick])

  const pushReturn = useCallback((entry: ReturnEntry): void => {
    // §10.3 cap: keep the newest RETURN_STACK_DEPTH-1 entries plus the new one — a negative
    // slice, NOT slice(DEPTH-1) (a positive index empties every stack shorter than the cap,
    // silently resetting the return history on each navigation).
    setReturnStack(stack => [...stack.slice(-(RETURN_STACK_DEPTH - 1)), entry])
  }, [])
  // §10.3 restore is effect work, not updater work: React requires state updaters to be
  // pure — side effects inside an updater make the whole pending update queue droppable
  // when a re-render replays it — so the pop reads the committed stack and restores views
  // through plain setState calls beside the pop itself.
  const popReturn = useCallback((): void => {
    const last = returnStack[returnStack.length - 1]
    if (last === undefined) return
    setReturnStack(stack => stack.slice(0, -1))
    setViewed(last.digest)
    setSelection(last.ref)
    if (last.pathCenter !== null) setSelection(last.pathCenter)
  }, [returnStack])

  const switchToCurrent = useCallback(async (): Promise<void> => {
    if (currentDigest === null) return
    const previousViewed = viewed
    const previousSelection = selection
    pushReturn({ pane: 'list', digest: previousViewed, ref: previousSelection, pathCenter: null })
    // §10.1 explicit switch: focus continues only by precise identity, else unselected home.
    if (previousSelection !== null) {
      const response = await api.objectDetails(currentDigest, previousSelection)
      if (response.ok) {
        setViewed(currentDigest)
        return
      }
      setNotice(t('notice.focusMissing'))
    }
    if (previousViewed !== null && previousViewed !== currentDigest) {
      const header = await api.snapshot(currentDigest)
      if (!header.ok) {
        setNotice(t('notice.switchFailed'))
        return
      }
    }
    setViewed(currentDigest)
    setSelection(null)
  }, [api, currentDigest, viewed, selection, pushReturn, t])

  const selectCandidate = useCallback((card: CandidateCard): void => {
    pushReturn({ pane: 'list', digest: viewed, ref: selection, pathCenter: null })
    setSelection({ kind: 'CandidateStatement', id: card.candidateId })
    setDetails(null)
  }, [pushReturn, viewed, selection])

  const openDetails = useCallback((ref: { kind: string; id: string }): void => {
    if (viewed === null) return
    pushReturn({ pane: 'path', digest: viewed, ref: selection, pathCenter: path?.center.ref ?? null })
    void (async () => {
      const response = await api.objectDetails(viewed, ref)
      if (response.ok) setDetails(response.details)
      writePersistedFocus(sessionId, { snapshotDigest: viewed, objectType: ref.kind, objectId: ref.id })
    })()
  }, [api, viewed, pushReturn, selection, path])

  const recenter = useCallback((ref: { kind: string; id: string }): void => {
    pushReturn({ pane: 'path', digest: viewed, ref: selection, pathCenter: path?.center.ref ?? null })
    setSelection(ref)
  }, [pushReturn, viewed, selection, path])

  const doExport = useCallback(async (): Promise<void> => {
    if (viewed === null) return // narrowed non-null below the render gate; kept for the callback closure
    const response = await api.exportSnapshot(viewed)
    if (!response.ok) return
    // §8: browser delivery via Blob + anchor download; bytes are the exact canonical JSON.
    const blob = new Blob([response.export.canonicalJson], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = response.export.filename
    anchor.click()
    URL.revokeObjectURL(url)
  }, [api, viewed])

  const doMarkSeen = useCallback(async (issueKeys: readonly string[]): Promise<void> => {
    await api.markSeen(issueKeys)
    const response = await api.issues(false)
    if (response.ok) setIssues(response.view.items)
  }, [api])

  // §11.4-2: the process action tends only the persisted backlog — no re-query chained here
  // (§11.4-1 separation) and never a research tool run; a `triggered` outcome surfaces through
  // the next 'evidence/updated' tokens as the compile loop commits.
  const doProcess = useCallback(async (): Promise<void> => {
    const response = await api.processBacklog()
    if (response.ok && response.outcome !== 'triggered') setNotice(t('notice.processNoop'))
  }, [api, t])

  const showPath = tier === 'wide' || selection !== null
  const newVersionAvailable = viewed !== null && currentDigest !== null && viewed !== currentDigest

  // --- render ---
  const emptyState = renderEmptyState({ status, t })
  return (
    <div ref={containerRef} className="evidence-view" data-evidence-tier={tier} data-evidence-session={sessionId}>
      <section className="evidence-summary" aria-label="evidence summary">
        {graphStatus !== null && viewed !== null
          ? (
            <ul>
              <li>{viewed === currentDigest ? t('summary.viewing.current') : t('summary.viewing.historical')}</li>
              <li>{t('summary.freshness', { freshness: graphStatus.freshness })}</li>
              <li>{t('summary.candidates', { count: page?.total ?? graphStatus.counts.candidates })}</li>
              <li>{t('summary.issues', { count: graphStatus.counts.openIssues })}</li>
              <li>{t(`summary.semantic.${graphStatus.semanticChannel}`)}</li>
            </ul>
          )
          : <p>{emptyState}</p>}
        {newVersionAvailable && (
          <p className="evidence-notice" data-evidence-notice="new-version">
            {t('notice.newVersion')}
            <button type="button" onClick={() => { void switchToCurrent() }}>{t('notice.switch')}</button>
          </p>
        )}
        {notice !== null && <p className="evidence-notice" data-evidence-notice="recovery">{notice}</p>}
      </section>

      {graphStatus !== null && viewed !== null && (
        <>
          <PendingLayer status={graphStatus} t={t} />
          <div className={`evidence-body evidence-body-${tier}`}>
            {showPath && selection !== null
              ? (
                <PathPane
                  path={path}
                  t={t}
                  onBack={() => { pushReturn({ pane: 'path', digest: viewed, ref: selection, pathCenter: path?.center.ref ?? null }); setSelection(null) }}
                  onOpenDetails={openDetails}
                  onRecenter={recenter}
                  onDetailsClose={() =>{  setDetails(null) }}
                />
              )
              : (
                <CandidatePane
                  page={page}
                  t={t}
                  onPrev={page !== null && page.prevCursor !== null
                    ? () => { setCursor(page.prevCursor); setPrevCursors(cursors => cursors.slice(0, -1)) }
                    : null}
                  onNext={page !== null && page.nextCursor !== null
                    ? () => { setPrevCursors(cursors => [...cursors, cursor ?? '']); setCursor(page.nextCursor) }
                    : null}
                  onSelect={selectCandidate}
                />
              )}
            {details !== null && (
              <DetailsPane
                details={details}
                t={t}
                api={api}
                currentViewed={viewed}
                onPreviewFragment={(fragment) =>{  setPreview(fragment) }}
                onClose={() => { setDetails(null); setPreview(null) }}
                onOpenSource={(sourceRef) => {
                  if (navigation !== null && sourceRef.callId !== '') {
                    navigation.activate(sessionId, { viewId: 'chat', focus: { kind: 'tool_call', callId: sourceRef.callId } })
                  }
                }}
                onOpenFile={async (artifactVersionId) => {
                  // viewed is non-null under this render gate (the const closure keeps it narrowed).
                  const response: OpenTargetResponse = await api.openTarget(viewed, artifactVersionId)
                  if ('result' in response && response.result.ok) openFile(response.result.path)
                }}
              />
            )}
          </div>
          <section className="evidence-issues">
            <h4>{t('issues.title')}</h4>
            <ul>
              {(issues ?? []).map(issue => (
                <li key={issue.issueKey} data-evidence-issue={issue.conditionCode}>
                  <span>{issue.conditionCode}</span>
                  <span>{issue.resolvedAt !== null ? t('issues.resolved') : t('issues.occurrences', { count: issue.occurrenceCount })}</span>
                  {issue.seenAt === null && issue.resolvedAt === null && (
                    <button type="button" onClick={() => { void doMarkSeen([issue.issueKey]) }}>{t('issues.markSeen')}</button>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section className="evidence-actions">
            <button type="button" data-evidence-action="refresh" onClick={() => { setQueryTick(tick => tick + 1) }}>{t('action.refresh')}</button>
            {/* §11.4-2 disabled condition: nothing queued (`none`) or a same-target attempt
                already active (`compiling` — idempotent dedup); a failed/retrying/merge-window
                backlog stays actionable, including the unavailable state's resume entry. */}
            <button type="button" data-evidence-action="process" disabled={graphStatus.pending === 'none' || graphStatus.pending === 'compiling'} onClick={() => { void doProcess() }}>{t('action.process')}</button>
            <span>{t('action.rerunHint')}</span>
            <button type="button" data-evidence-action="export" onClick={() => { void doExport() }}>{t('action.export')}</button>
            {returnStack.length > 0 && <button type="button" onClick={popReturn}>{t('return.back')}</button>}
          </section>
          {preview !== null && (
            <PreviewPane fragment={preview} t={t} />
          )}
        </>
      )}
    </div>
  )
}

/** The independent pending layer (§11.3): it never replaces the committed body. */
function PendingLayer({ status, t }: { status: Extract<EvidenceStatus, { kind: 'graph' }>; t: EvidenceViewProps['t'] }) {
  if (status.pending === 'none') return null
  return <p className="evidence-pending" data-evidence-pending={status.pending}>{t(`pending.${status.pending}`)}</p>
}

/** The four first-empty states (D-138) — mutually distinct, never a disguised empty graph. */
function renderEmptyState({ status, t }: { status: EvidenceStatus | null; t: EvidenceViewProps['t'] }): string {
  if (status === null) return ''
  if (status.kind === 'no_graph') return t('empty.noGraph')
  if (status.currentSnapshotDigest === null) {
    if (status.pending === 'failed') return t('empty.unavailable')
    if (status.pending !== 'none') return t('empty.firstBuild')
    return t('empty.noMaterials')
  }
  return ''
}

/** The candidate master list (§4.4/§9.2): five-field cards, 3-line fold, exact range. */
function CandidatePane({ page, t, onSelect, onPrev, onNext }: {
  page: { items: readonly CandidateCard[]; total: number; from: number; to: number } | null
  t: EvidenceViewProps['t']
  onSelect: (card: CandidateCard) => void
  onPrev: (() => void) | null
  onNext: (() => void) | null
}) {
  return (
    <section className="evidence-candidates" aria-label={t('candidates.title')}>
      <h4>{t('candidates.title')}</h4>
      {page !== null && page.total === 0 && <p data-evidence-empty="zero-candidates">{page.total}</p>}
      <ul>
        {(page?.items ?? []).map(card => (
          <li key={card.candidateId} data-evidence-candidate={card.subtype}>
            <button type="button" className="evidence-card" onClick={() => { onSelect(card) }}>
              <span className="evidence-card-fold">
                {(() => { const lines = card.text.split('\n').slice(0, CARD_FOLD_LINES).join('\n'); return `候选·${card.subtype}：${lines.length < card.text.length ? `${lines}…` : lines}` })()}
              </span>
              <span>{`${card.relationSummary.summary} 支持 ${String(card.relationSummary.activeSupports)} 限定 ${String(card.relationSummary.activeQualifies)} 反驳 ${String(card.relationSummary.activeContradicts)}`}</span>
              <span>{card.sourceLabel}</span>
              <span>{card.topBreakpoint === null ? t('candidates.none') : t('card.breakpoint', { code: card.topBreakpoint })}</span>
            </button>
          </li>
        ))}
      </ul>
      {page !== null && page.total > 0 && (
        <p className="evidence-range" data-evidence-range={`${String(page.from)}—${String(page.to)} / ${String(page.total)}`}>
          {t('candidates.range', { from: page.from, to: page.to, total: page.total })}
          {onPrev !== null && <button type="button" onClick={onPrev}>{t('candidates.prev')}</button>}
          {onNext !== null && <button type="button" onClick={onNext}>{t('candidates.next')}</button>}
        </p>
      )}
    </section>
  )
}

/** The one-hop path pane (§4.5/§9.3): per-group first 20, counts + continuation, recenter. */
function PathPane({ path, t, onBack, onOpenDetails, onRecenter }: {
  path: PathView | null
  t: EvidenceViewProps['t']
  onBack: () => void
  onOpenDetails: (ref: { kind: string; id: string }) => void
  onRecenter: (ref: { kind: string; id: string }) => void
  onDetailsClose: () => void
}) {
  return (
    <section className="evidence-path" aria-label={t('path.title')}>
      <button type="button" onClick={onBack} data-evidence-back="list">{t('path.backToList')}</button>
      <h4>{t('path.title')}</h4>
      {path !== null && (
        <>
          <p data-evidence-center={`${path.center.ref.kind}/${path.center.ref.id}`}>{path.center.label}</p>
          {(() => {
            // §9.3: single-view 100-node/200-edge budget — cap rendered items across all
            // groups; recenter offers continuation (B1A2-05).
            let nodeBudget = VIEW_NODE_BUDGET - 1
            let edgeBudget = VIEW_EDGE_BUDGET
            return path.groups.map((group) => {
              const budgeted = group.items.filter(() => {
                if (nodeBudget <= 0 || edgeBudget <= 0) return false
                nodeBudget--
                edgeBudget--
                return true
              })
              return { ...group, budgeted, budgetHit: budgeted.length < group.items.length || nodeBudget <= 0 }
            })
          })().map(group => (
            <div key={`${group.direction}-${group.edgeType}`} data-evidence-group={`${group.direction}-${group.edgeType}`}>
              <span>{group.edgeType}</span>
              <ul>
                {group.budgeted.map(item => (
                  <li key={`${item.ref.kind}/${item.ref.id}`}>
                    <button type="button" onClick={() => { onOpenDetails(item.ref) }}>{item.label}</button>
                    <button type="button" aria-label={t('path.expand')} onClick={() => { onRecenter(item.ref) }}>⤢</button>
                  </li>
                ))}
              </ul>
              <span>{t('path.groupMore', { shown: group.budgeted.length, total: group.total })}</span>
              {group.budgetHit && <span data-evidence-budget-hit="true">{t('path.expand')}</span>}
            </div>
          ))}
        </>
      )}
    </section>
  )
}

/** The object-level technical details inspector (§4.6/§7/§11.5) — the only place technical
 * fields appear (D-137); Run cards show the D-187 fields with the split unknown lines. */
function DetailsPane({ details, t, api, currentViewed, onPreviewFragment, onClose, onOpenSource, onOpenFile }: {
  details: ObjectDetails
  t: EvidenceViewProps['t']
  api: EvidenceApi
  currentViewed: string
  onPreviewFragment: (fragment: PreviewFragment) => void
  onClose: () => void
  onOpenSource: (ref: { callId: string }) => void
  onOpenFile: (artifactVersionId: string) => Promise<void>
}) {
  const [receiptState, setReceiptState] = useState<string | null>(null)
  useEffect(() => {
    if (details.kind === 'Run' && details.receiptSubmissionRef !== null) {
      void (async () => {
        const response = await api.receipt(details.receiptSubmissionRef === null ? '' : details.receiptSubmissionRef)
        if (response.ok) setReceiptState(response.receipt.state)
      })()
    } else {
      setReceiptState(null)
    }
  }, [api, details])
  return (
    <aside className="evidence-details" data-evidence-details={details.kind} aria-label={t('details.title')}>
      <button type="button" onClick={onClose}>{t('details.close')}</button>
      {details.kind === 'Run' && (
        <dl>
          <dt>tool</dt><dd>{details.toolName}</dd>
          <dt>outcome</dt><dd data-evidence-run-outcome={details.outcome}>{details.outcome}</dd>
          {receiptState !== null && <dt>receipt</dt>}
          {receiptState !== null && <dd data-evidence-receipt={receiptState}>{receiptState === 'pending' ? t('receipt.pending') : receiptState === 'accepted' ? t('receipt.accepted') : t('receipt.rejected')}</dd>}
          {details.outputManifestRef === null && (
            <div data-evidence-split="unknown">
              <div>{t('receipt.split.running')}</div>
              <div>{t('receipt.split.unknown')}</div>
              <div>{t('receipt.split.zero')}</div>
            </div>
          )}
          <dt>outputs</dt>
          <dd>
            <ul>
              {details.outputs.map(output => (
                <li key={output.role}>
                  <span>{`${output.role} → ${output.artifactVersionRef}`}</span>
                  <button type="button" onClick={() => { void onOpenFile(output.artifactVersionRef) }}>{t('details.openFile')}</button>
                </li>
              ))}
            </ul>
          </dd>
          <button type="button" onClick={() => { onOpenSource({ callId: details.callId }) }}>{t('details.openSource')}</button>
        </dl>
      )}
      {details.kind === 'ArtifactVersion' && (
        <dl>
          <dt>digest</dt><dd>{details.contentDigest}</dd>
          <dt>bytes</dt><dd>{String(details.byteLength)}</dd>
          <dt>media</dt><dd>{details.mediaType}</dd>
          <dt>locator</dt><dd>{details.frozenLocator ?? t('candidates.none')}</dd>
          <dt>anchors</dt>
          <dd>
            <ul>
              {details.anchors.map(anchor => (
                <li key={anchor.sourceAnchorId}>
                  <span>{anchor.sourceKind}</span>
                  <button type="button" onClick={() => { void (async () => {
                    const response = await api.preview(currentViewed, details.artifactVersionId, anchor.sourceAnchorId)
                    if (response.ok) onPreviewFragment(response.preview.fragment)
                  })() }}>{t('details.preview')}</button>
                </li>
              ))}
              {details.anchors.length === 0 && <li>{t('candidates.none')}</li>}
            </ul>
          </dd>
          <button type="button" onClick={() => { void onOpenFile(details.artifactVersionId) }}>{t('details.openFile')}</button>
        </dl>
      )}
      {details.kind === 'CandidateStatement' && (
        <dl>
          <dt>subtype</dt><dd>{details.subtype}</dd>
          <dt>text</dt><dd>{details.text}</dd>
          <dt>sourceBinding</dt><dd>{details.sourceBinding}</dd>
          <dt>generationProvenance</dt><dd>{details.generationProvenance}</dd>
        </dl>
      )}
      {(details.kind === 'Observation' || details.kind === 'ContextEntity') && (
        <dl>
          {details.kind === 'Observation' && (<><dt>kind</dt><dd>{details.observationKind}</dd><dt>outcome</dt><dd>{details.outcome ?? t('candidates.none')}</dd></>)}
          {details.kind === 'ContextEntity' && (<><dt>entity</dt><dd>{`${details.contextKind}:${details.name}`}</dd><dt>version</dt><dd>{details.version ?? t('candidates.none')}</dd></>)}
        </dl>
      )}
    </aside>
  )
}

/** The bounded preview pane (§7): fragments only, with explicit truncation state. */
function PreviewPane({ fragment, t }: { fragment: PreviewFragment; t: EvidenceViewProps['t'] }) {
  return (
    <div className="evidence-preview" data-evidence-preview={fragment.kind}>
      {fragment.kind === 'text' && (
        <ol start={fragment.startLine}>
          {fragment.lines.map(line => <li key={line.lineNo} data-line-no={line.lineNo}>{line.text}</li>)}
        </ol>
      )}
      {fragment.kind === 'table' && (
        <table>
          <thead><tr>{fragment.columns.map(column => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>
            {fragment.rows.map((row, index) => <tr key={index}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>)}
          </tbody>
        </table>
      )}
      {fragment.kind === 'metadata' && <p>{`${fragment.mediaType} ${String(fragment.byteLength)}`}</p>}
      {fragment.kind === 'unavailable' && <p>{fragment.reason}</p>}
      {(fragment.kind === 'text' || fragment.kind === 'table') && fragment.truncated && <button type="button">{t('details.previewMore')}</button>}
    </div>
  )
}

// --- persisted focus plumbing (§9.5) ---

/** The parsed §9.5 preference triple (stable per underlying localStorage state). */
interface PersistedFocus { snapshotDigest: string; objectType: string; objectId: string }
interface PersistedSnapshot { raw: string | null; focus: PersistedFocus | null; subtypes: readonly string[] }

const focusListeners = new Set<() => void>()
function subscribePersistedFocus(listener: () => void): () => void {
  focusListeners.add(listener)
  return () => { focusListeners.delete(listener) }
}
/** Stable no-op unsubscribe when the navigation seam is absent (bare test compositions). */
const constantUnsubscribe = (): (() => void) => () => {}
const EMPTY_SUBTYPES: readonly string[] = []

/** useSyncExternalStore requires a referentially stable snapshot per underlying state: the
 * raw localStorage string is cached and parsed once per change, so a persisted focus or
 * filter set never loops the renderer (a fresh object per getSnapshot would). */
const persistedCache = new Map<string, PersistedSnapshot>()

function persistedSnapshot(sessionId: string): PersistedSnapshot {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(`dsh.evidence.view.v1.${sessionId}`)
  } catch {
    raw = null
  }
  const cached = persistedCache.get(sessionId)
  if (cached !== undefined && cached.raw === raw) return cached
  let focus: PersistedFocus | null = null
  let subtypes: readonly string[] = EMPTY_SUBTYPES
  try {
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { subtypes?: readonly string[]; focus?: Partial<PersistedFocus> | null }
      if (Array.isArray(parsed.subtypes)) subtypes = parsed.subtypes
      const candidate = parsed.focus
      if (candidate !== null && candidate !== undefined && typeof candidate.snapshotDigest === 'string' && typeof candidate.objectType === 'string' && typeof candidate.objectId === 'string') {
        focus = { snapshotDigest: candidate.snapshotDigest, objectType: candidate.objectType, objectId: candidate.objectId }
      }
    }
  } catch {
    // Corrupt or unavailable persistence degrades to no recovery (§9.5).
  }
  const entry = { raw, focus, subtypes }
  persistedCache.set(sessionId, entry)
  return entry
}

function readPersistedSubtypes(sessionId: string): readonly string[] {
  return persistedSnapshot(sessionId).subtypes
}

function readPersistedFocus(sessionId: string): PersistedFocus | null {
  return persistedSnapshot(sessionId).focus
}
function writePersistedFocus(sessionId: string, focus: PersistedFocus | null): void {
  try {
    const key = `dsh.evidence.view.v1.${sessionId}`
    const raw = window.localStorage.getItem(key)
    const parsed = raw === null ? {} : JSON.parse(raw) as Record<string, unknown>
    parsed.focus = focus
    window.localStorage.setItem(key, JSON.stringify(parsed))
    for (const listener of focusListeners) listener()
  } catch {
    // Corrupt or unavailable persistence degrades to no recovery (§9.5).
  }
}

export { VIEW_NODE_BUDGET, VIEW_EDGE_BUDGET, CARD_FOLD_LINES, RETURN_STACK_DEPTH, CONTAINER_WIDE, CONTAINER_MIN }
