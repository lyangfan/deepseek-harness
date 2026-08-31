/**
 * The "view in Evidence" link on professional tool cards (SPEC-05 §9.1/§4.8): the chat-side
 * navigation entry resolves the tool callId against the current Snapshot through the read
 * service, then activates the Evidence tab with a precise plugin focus. Non-found outcomes
 * stay on the page and surface the reason as the link's title (D-162).
 */

import { useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the toolview SlotMap declaration into this compile face.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type { NavigationOutcome } from './api.ts'
import type { NS } from './locales.ts'

/** The toolview entry's inject face. */
export interface ToolviewEvidenceLinkInjected {
  readonly openInEvidence: (callId: string) => Promise<NavigationOutcome>
  readonly navigation: {
    activate(sessionId: string, activation: { viewId: string; focus: { kind: 'tool_call'; callId: string } | { kind: 'plugin'; payload: unknown } | null }): void
  } | null
}

export type ToolviewEvidenceLinkProps = PropsRuntime<'tool.call.toolview'> & PropsLocale<typeof NS> & ToolviewEvidenceLinkInjected

/** One keyed entry per professional tool name (r_script / plink_cli / himvp_cli / cmplot_call). */
export function ToolviewEvidenceLink({ sessionId, callId, t, openInEvidence, navigation }: ToolviewEvidenceLinkProps) {
  const [resolution, setResolution] = useState<NavigationOutcome | null>(null)
  const title = resolution === null
    ? t('toolview.openInEvidence')
    : resolution.result === 'not_in_snapshot'
      ? t('toolview.notInSnapshot')
      : resolution.result === 'unavailable'
        ? t('toolview.unavailable')
        : resolution.result === 'multiple'
          ? t('toolview.multiple')
          : t('toolview.openInEvidence')
  return (
    <button
      type="button"
      className="evidence-toolview-link"
      data-evidence-toolview={callId}
      title={title}
      onClick={() => {
        void (async () => {
          const outcome = await openInEvidence(callId)
          setResolution(outcome)
          if (outcome.result === 'found' && navigation !== null) {
            // §10.4 frozen focus payload: {snapshotDigest, ref} — the navigateCurrent
            // result carries the bound digest so the view can pin the snapshot.
            const digest = 'snapshotDigest' in outcome ? outcome.snapshotDigest : null
            const target = 'target' in outcome ? outcome.target : null
            if (digest !== null && target !== null) {
              navigation.activate(sessionId, {
                viewId: 'evidence',
                focus: { kind: 'plugin', payload: { snapshotDigest: digest, ref: target } },
              })
            }
          }
        })()
      }}
    >
      {t('toolview.openInEvidence')}
    </button>
  )
}
