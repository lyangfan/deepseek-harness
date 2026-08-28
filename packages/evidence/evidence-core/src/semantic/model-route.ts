/** Explicit evidenceModel route: pair-validated config, no implicit inheritance, no fallback (SPEC-04 §4.1). */

export interface EvidenceModelRouteV1 {
  readonly provider: string
  readonly model: string
  /** DSH ReasoningEffortId: an adapter-owned opaque stable string, passed through verbatim. */
  readonly reasoningEffort?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
  readonly timeoutMs: number
}

/** Bounding configuration for the model-visible projection (SPEC-04 §5.2/§11.1; no quotas, D-145). */
export interface SemanticProjectionConfig {
  readonly perItemTruncationChars: number
  readonly toolResultSummaryChars: number
  readonly runSummaryChars: number
}

export class ModelRouteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ModelRouteError'
  }
}

const DEFAULT_TIMEOUT_MS = 120_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Resolve the optional evidenceModel route slot (SPEC-04 §4.1). `provider` and `model` must
 * be supplied together or not at all; anything else fails fast and the semantic channel
 * stays unconfigured rather than guessing half a route.
 */
export function resolveEvidenceModelRoute(input: unknown): EvidenceModelRouteV1 | undefined {
  if (input === undefined || input === null) return undefined
  if (!isRecord(input)) throw new ModelRouteError('route_invalid', 'evidenceModel must be an object')
  const provider = input.provider
  const model = input.model
  if (provider === undefined && model === undefined) return undefined
  if (typeof provider !== 'string' || provider.trim() === '') throw new ModelRouteError('route_pair_required', 'evidenceModel.provider and evidenceModel.model must be supplied together')
  if (typeof model !== 'string' || model.trim() === '') throw new ModelRouteError('route_pair_required', 'evidenceModel.provider and evidenceModel.model must be supplied together')
  const route: EvidenceModelRouteV1 & { reasoningEffort?: string; temperature?: number; maxTokens?: number; stop?: readonly string[] } = {
    provider,
    model,
    timeoutMs: typeof input.timeoutMs === 'number' && Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS,
  }
  if (input.reasoningEffort !== undefined) {
    if (typeof input.reasoningEffort !== 'string' || input.reasoningEffort.trim() === '') throw new ModelRouteError('route_invalid', 'evidenceModel.reasoningEffort must be a non-empty opaque string')
    route.reasoningEffort = input.reasoningEffort
  }
  if (input.temperature !== undefined) {
    if (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature)) throw new ModelRouteError('route_invalid', 'evidenceModel.temperature must be a finite number')
    route.temperature = input.temperature
  }
  if (input.maxTokens !== undefined) {
    if (typeof input.maxTokens !== 'number' || !Number.isSafeInteger(input.maxTokens) || input.maxTokens <= 0) throw new ModelRouteError('route_invalid', 'evidenceModel.maxTokens must be a positive integer')
    route.maxTokens = input.maxTokens
  }
  if (input.stop !== undefined) {
    if (!Array.isArray(input.stop) || input.stop.some(value => typeof value !== 'string')) throw new ModelRouteError('route_invalid', 'evidenceModel.stop must be an array of strings')
    route.stop = input.stop
  }
  return route
}

/** Resolve the projection bounding config with frozen defaults (SPEC-04 §11.1). */
export function resolveSemanticProjectionConfig(input: unknown): SemanticProjectionConfig {
  const source = isRecord(input) ? input : {}
  const config: SemanticProjectionConfig = {
    perItemTruncationChars: readPositive(source.perItemTruncationChars, 16_384),
    toolResultSummaryChars: readPositive(source.toolResultSummaryChars, 2_048),
    runSummaryChars: readPositive(source.runSummaryChars, 1_024),
  }
  return config
}

function readPositive(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new ModelRouteError('projection_config_invalid', 'semantic projection bounds must be positive integers')
  return value
}
