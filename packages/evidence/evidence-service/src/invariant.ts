/** Package-owned durable invariants for the Evidence read service. @module @deepseek-ai/dsh-evidence-service/invariant */

import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Context } from '@deepseek-ai/cordis'

const PACKAGE_NAME = '@deepseek-ai/dsh-evidence-service'

/** Cordis companion plugin name. */
export const name = 'evidence-service-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Pure-consumer package: the v0.1 read service owns no durable stream to check. */
// No runtime invariant: the read service's queries are stateless projections over the owner
// store; every durable invariant lives in evidence-core's own installer.
const install: InvariantInstaller = () => {}

/** Register the (currently empty) installer under the package identity. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
