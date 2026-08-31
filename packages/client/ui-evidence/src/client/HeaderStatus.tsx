/**
 * The Session-header Evidence status entry (SPEC-05 §9.1): compact freshness dot + unread
 * count, hidden entirely for graph-less sessions; the popover lists the current issue rows
 * with markSeen. Normal success stays silent — no toast, no modal, no chat message (D-130).
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EvidenceStatus, IssueView } from '@deepseek-ai/dsh-evidence-service/client'
import type { EvidenceApi, EvidenceRefresh } from './api.ts'
import { StateDot as Dot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { NS } from './locales.ts'

/** The header entry's inject face. */
export interface HeaderStatusInjected {
  readonly api: EvidenceApi
  readonly refresh: EvidenceRefresh
}

export type HeaderStatusProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS> & HeaderStatusInjected

/** The compact header entry (registered id `evidence-status`, order 30). */
export function HeaderStatus({ sessionId, t, api, refresh }: HeaderStatusProps) {
  const refreshSubscribe = refresh.subscribe.bind(refresh)
  const refreshVersionOf = refresh.version.bind(refresh)
  const refreshVersion = useSyncExternalStore(refreshSubscribe, refreshVersionOf)
  const [status, setStatus] = useState<EvidenceStatus | null>(null)
  const [unread, setUnread] = useState(0)
  const [issues, setIssues] = useState<readonly IssueView[]>([])
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void (async () => {
      const response = await api.status()
      if (response.ok) setStatus(response.status)
      const issueResponse = await api.issues(false)
      if (issueResponse.ok) {
        setUnread(issueResponse.view.unread)
        setIssues(issueResponse.view.items)
      }
    })()
  }, [api, refreshVersion])

  // §6.6/§9.1: no Graph (not eligible / nothing captured) hides the entry entirely.
  if (status === null || status.kind === 'no_graph') return null
  const dotState = status.freshness === 'current' ? 'done' : status.freshness === 'updating' ? 'ongoing' : 'warning'

  return (
    <div ref={rootRef} className="evidence-header" data-evidence-header={status.freshness}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
        title={t('view.evidence')}
      >
        <Dot state={dotState} />
        {unread > 0 && <span className="evidence-unread" data-evidence-unread={String(unread)}>{t('issues.unread', { count: unread })}</span>}
      </button>
      {open && (
        <ul className="evidence-header-menu" role="menu">
          {issues.length === 0 && <li>{t('candidates.none')}</li>}
          {issues.map(issue => (
            <li key={issue.issueKey} role="menuitem">
              <span>{issue.conditionCode}</span>
              {issue.seenAt === null && issue.resolvedAt === null && (
                <button
                  type="button"
                  onClick={() => {
                    void (async () => {
                      await api.markSeen([issue.issueKey])
                      const next = await api.issues(false)
                      if (next.ok) {
                        setUnread(next.view.unread)
                        setIssues(next.view.items)
                      }
                    })()
                  }}
                >
                  {t('issues.markSeen')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <span className="evidence-header-session">{sessionId}</span>
    </div>
  )
}
