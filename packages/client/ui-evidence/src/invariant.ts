/** Package-owned durable invariants for the Evidence view. @module @deepseek-ai/dsh-client-ui-evidence/invariant */

import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Context } from '@deepseek-ai/cordis'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-evidence'

/** Cordis companion plugin name. */
export const name = 'client-ui-evidence-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Pure-consumer package: the view owns no durable stream to check. */
// No runtime invariant: the view renders remote query results and owns no durable state;
// the conversation store and evidence-core own every invariant this UI reads.
const install: InvariantInstaller = () => {}

/** Register the (currently empty) installer under the package identity. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
