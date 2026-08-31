/**
 * Evidence view plugin, browser half (SPEC-05 §9.1): the candidate-first `conversation.view`
 * tab (id `evidence`, order 20), the Session-header status entry (id `evidence-status`),
 * and "view in Evidence" links on the four professional tool cards. All data flows through
 * `ctx.remote.evidence` — the view never touches the owner store — and refresh rides the
 * `evidence/updated` forwarded event with three-token dedup (§5.3).
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ViewNavigationFace } from '@deepseek-ai/dsh-client-runtime/client'
import { en, NS, zh } from './locales.ts'
import type { EvidenceKey } from './locales.ts'
import { createEvidenceViewStore } from './stores.ts'
import { EvidenceView } from './EvidenceView.tsx'
import type { EvidenceInjected } from './EvidenceView.tsx'
import { createEvidenceBridge } from './api.ts'
import { HeaderStatus } from './HeaderStatus.tsx'
import type { HeaderStatusInjected } from './HeaderStatus.tsx'
import { ToolviewEvidenceLink } from './ToolviewEvidenceLink.tsx'
import type { ToolviewEvidenceLinkInjected } from './ToolviewEvidenceLink.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Evidence view copy (SPEC-05). */
    'evidence': EvidenceKey
  }
}

/** Required services: the conversation slots, ordinary Session kit, locale, and the evidence namespace. */
export const inject = ['slots', 'sessions', 'locale', 'remote', 'remote.evidence', 'workspaces', 'connection']

/** The per-session preference store handle (declared once; scoped by the tab registration). */
const evidenceViewStore = createEvidenceViewStore()

/** Browser plugin body: dictionaries, the view tab, the header entry, the tool-card links. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-evidence: dictionaries')
  const t = ctx.locale.bind(NS)
  const bridge = createEvidenceBridge(ctx)
  const navigation: ViewNavigationFace | null = ctx.get('viewNavigation') ?? null
  // §7.5: the full-file handoff runs only on a loopback connection whose host declares the
  // native open capability (the ProducedFiles precedent).
  const connection = ctx.get('connection') as { isLoopback: boolean; hostDescription: { getSnapshot(): { canOpenPath: boolean } | undefined } } | undefined
  const canOpen = connection !== undefined && connection.isLoopback && (connection.hostDescription.getSnapshot()?.canOpenPath ?? false)
  const openFile = (path: string): void => {
    if (canOpen) void ctx.workspaces.openPath(path)
  }

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'evidence',
    order: 20,
    locale: NS,
    label: () => t('view.evidence'),
    store: evidenceViewStore,
    inject: (sessionId: SessionId): EvidenceInjected => {
      const { api, refresh } = bridge.forSession(sessionId)
      return { api, refresh, navigation, openFile }
    },
  }, EvidenceView))

  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'evidence-status',
    // After the job list: session lineage/process state reads before evidence status.
    order: 30,
    locale: NS,
    inject: (sessionId: SessionId): HeaderStatusInjected => {
      const { api, refresh } = bridge.forSession(sessionId)
      return { api, refresh }
    },
  }, HeaderStatus))

  for (const toolName of ['r_script', 'plink_cli', 'himvp_cli', 'cmplot_call']) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key: toolName,
      locale: NS,
      inject: (sessionId: SessionId): ToolviewEvidenceLinkInjected => {
        const { api } = bridge.forSession(sessionId)
        return {
          openInEvidence: (callId: string) => api.navigateCurrent({ kind: 'tool_call', callId }),
          navigation,
        }
      },
    }, ToolviewEvidenceLink))
  }
}
