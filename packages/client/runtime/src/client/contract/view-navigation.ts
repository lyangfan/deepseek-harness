/**
 * The D-136-authorized minimal exact-navigation seam (SPEC-05 §10.4): a neutral client service
 * that activates one `conversation.view` entry and carries a typed focus to the target view.
 * The service stores the latest activation per session and notifies subscribers; driving the
 * active-view store and the inspect-style owner-props stays with the conversation skeleton, so
 * DSH core view/slot semantics are untouched.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Typed record focus. `tool_call` reuses the chat view's existing callId targeting; `plugin`
 * payloads are opaque to DSH and owned jointly by the activating plugin and the target view. */
export type ViewFocus =
  | { readonly kind: 'tool_call'; readonly callId: string }
  | { readonly kind: 'plugin'; readonly payload: unknown }

/** One activation request minus the session identity. */
export interface ViewActivation {
  readonly viewId: string
  readonly focus: ViewFocus | null
}

/** The neutral cross-view activation face (`ctx.viewNavigation`). */
export interface ViewNavigationFace {
  /** Record the latest activation for one session and wake subscribers. */
  activate(sessionId: SessionId, activation: ViewActivation): void
  /** The latest activation for one session (null when none was recorded). */
  activationFor(sessionId: SessionId): ViewActivation | null
  /** Subscribe to activation changes; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}
