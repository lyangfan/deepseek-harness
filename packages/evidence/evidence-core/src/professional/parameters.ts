/** ResolvedParameterSet: every effective parameter explicit, sourced, and persisted (SPEC-03 §6.3). */

import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { createHash } from 'node:crypto'
import type { ContextEntityRecordV1 } from '../types.ts'
import type { ContextEntityOwner } from '../context-entity.ts'

/** The five frozen parameter-source categories (D-177). */
export type ParameterSource =
  | 'user_supplied'
  | 'approved_profile'
  | 'deterministic_derived'
  | 'agent_selected'
  | 'software_default_materialized'

export interface ResolvedParameter {
  readonly name: string
  readonly value: JsonValue
  /** Defaults to the tool's own operation identity when omitted. */
  readonly operation?: string
  readonly source: ParameterSource
  readonly reason: string
}

function secretPlaceholder(value: string): string {
  return `secret:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

function placeholderValue(value: JsonValue): JsonValue {
  if (typeof value === 'string' && value.startsWith('secret:')) return value
  return value
}

/**
 * Persist the complete ResolvedParameterSet as one canonical `parameter_set` ContextEntity
 * (§6.3). Nothing may be completed inside execute() afterwards; secrets use placeholders.
 */
export async function persistResolvedParameterSet(options: {
  readonly entities: ContextEntityOwner
  readonly toolName: string
  readonly parameters: readonly ResolvedParameter[]
  readonly secretNames?: ReadonlySet<string>
}): Promise<ContextEntityRecordV1> {
  const { entities, toolName, parameters } = options
  const secretNames = options.secretNames ?? new Set<string>()
  const payload: JsonValue = parameters
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(parameter => ({
      name: parameter.name,
      value: secretNames.has(parameter.name) && typeof(parameter.value) === 'string'
        ? secretPlaceholder(parameter.value)
        : placeholderValue(parameter.value),
      operation: parameter.operation ?? `${toolName}-operation`,
      source: parameter.source,
      reason: parameter.reason,
    }))
  return entities.register({
    contextKind: 'parameter_set',
    name: `${toolName}-resolved-parameters`,
    version: null,
    payload,
  })
}
