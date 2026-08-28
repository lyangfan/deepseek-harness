/** Registration of the four professional adapter Tools (SPEC-03 §3.3, §10). */

import type { Context } from '@deepseek-ai/cordis'
import { defineProfessionalTool, type ProfessionalRuntimeOptions } from './factory.ts'
import { PLINK_TOOL_SPEC } from './adapters/plink.ts'
import { HIMVP_TOOL_SPEC } from './adapters/himvp.ts'
import { RSCRIPT_TOOL_SPEC } from './adapters/rscript.ts'
import { CMPLOT_TOOL_SPEC } from './adapters/cmplot.ts'

export const PROFESSIONAL_CAPTURE_PROFILE_IDS: ReadonlySet<string> = new Set(['sci-tool:plink_cli', 'sci-tool:himvp_cli', 'sci-tool:r_script', 'sci-tool:cmplot_call'])

/** Register the four first-party thin adapters as normal DSH Tools (§5.1, D-189). */
export function applyProfessionalTools(ctx: Context, options: ProfessionalRuntimeOptions): void {
  ctx.tools.register(defineProfessionalTool(ctx, options, PLINK_TOOL_SPEC))
  ctx.tools.register(defineProfessionalTool(ctx, options, HIMVP_TOOL_SPEC))
  ctx.tools.register(defineProfessionalTool(ctx, options, RSCRIPT_TOOL_SPEC))
  ctx.tools.register(defineProfessionalTool(ctx, options, CMPLOT_TOOL_SPEC))
}
