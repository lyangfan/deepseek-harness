/** Package-owned invariant companion for deterministic Evidence Core. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-evidence-core'

export const name = 'evidence-core-invariant'
export const inject = ['invariants']

/** No runtime invariant: the private owner validates every durable relation before publication. */
const install: InvariantInstaller = () => {}

/** Register package ownership with the invariant runtime. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
