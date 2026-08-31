/**
 * Cordis service behind the exact-navigation seam (SPEC-05 §10.4, §12.2 item 8): per-session
 * latest-activation storage plus change notification. Pure state — view switching and focus
 * delivery happen in the conversation skeleton through the existing store/owner-props path.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ViewActivation, ViewNavigationFace } from './contract/view-navigation.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** SPEC-05 §10.4: the neutral exact-navigation activation face. */
    viewNavigation: ViewNavigationFace
  }
}

export class ViewNavigationService extends Service implements ViewNavigationFace {
  private readonly activations = new Map<SessionId, ViewActivation>()
  private readonly listeners = new Set<() => void>()

  constructor(ctx: Context) {
    super(ctx, 'viewNavigation')
    ctx.effect(() => () => {
      this.activations.clear()
      this.listeners.clear()
    }, 'view-navigation: activation state')
  }

  /** @inheritdoc */
  activate(sessionId: SessionId, activation: ViewActivation): void {
    this.activations.set(sessionId, activation)
    for (const listener of this.listeners) listener()
  }

  /** @inheritdoc */
  activationFor(sessionId: SessionId): ViewActivation | null {
    return this.activations.get(sessionId) ?? null
  }

  /** @inheritdoc */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
