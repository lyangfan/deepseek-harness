/** ProfessionalToolSpec: the static typed adapter description and its five hook slots (SPEC-03 §5). */

import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type { BundleHandle } from './bundles.ts'
import type { ResolvedParameter } from './parameters.ts'
import type { BaselineCheckPlan, PreflightCheckItem } from './preflight.ts'
import type { OutputIntent } from './output-boundary.ts'
import type { OutputPlanV1 } from '../types.ts'

/**
 * The bounded inspector hooks receive instead of a bare Context (§5.3—§5.4): typed
 * parameters, normalized references, and bounded reads of declared outputs only.
 */
export interface HookServices {
  /** Bounded byte read of one locator inside the reserved boundary or declared inputs. */
  readonly readBytes: (locator: string, maxBytes: number) => Promise<Uint8Array>
  /** Bounded text read of one locator (same scope rule as {@link readBytes}). */
  readonly readText: (locator: string) => Promise<string>
  /** Normalized locator of one already-captured bundle component, if declared (§5.3). */
  readonly locatorOf: (role: string) => string | undefined
}

/** What the adapter's strict argument parser hands to the factory (§5.2 parse step). */
export interface ProfessionalParsedArgs<P> {
  readonly params: P
  readonly resolvedParameters: readonly ResolvedParameter[]
  readonly env: readonly { readonly name: string; readonly value: string; readonly secret?: boolean }[]
  readonly outputIntent: OutputIntent
  /** Unmodelled native flags passed through verbatim (D-169: never silently dropped). */
  readonly nativeArgs: readonly string[]
}

/** One supported operation whose full compatibility profile yields operation_profile (§6.2). */
export interface ProfessionalOperationContractV1<P> {
  readonly contractId: string
  readonly applies: (params: P) => boolean
  readonly baselinePlan: (params: P) => BaselineCheckPlan
  readonly softwareChecks: (params: P, services: HookServices) => readonly PreflightCheckItem[]
  readonly coverageGaps?: (params: P) => readonly string[]
}

/** Provenance facts the factory can honestly derive about one bundle component (§10.3). */
export interface CodeOriginFacts {
  /** When this locator was first captured by the owner; null when this call is the first. */
  readonly firstObservedAt: number | null
  /** Session creation time — separates in-session prior captures from older external files. */
  readonly sessionCreatedAt: number
}

/** The five restricted hook slots (§5.3); no bare Context, no subprocess, no LLM, no store. */
export interface ProfessionalToolHooksV1<P> {
  /**
   * Optional software-specific codeOrigin derivation (§10.3): derives a label from
   * provenance facts instead of persisting a self-reported field. Never a bare Context.
   */
  readonly codeOrigin?: (params: P, facts: CodeOriginFacts) => { readonly label: string; readonly basis: string }
  /** Slot 1: typed params → explicit argv (after the executable); never a shell string. */
  readonly toInvocation: (params: P, services: HookServices) => readonly string[]
  /** Slot 2: parse a bounded software `--version` output into an identity candidate. */
  readonly resolveVersion: (component: string, output: string) => string | null
  /** Slot 4: output plan for supported calls against the reserved boundary; null = no plan. */
  readonly buildOutputPlan: (params: P, rootDir: string) => { readonly roles: OutputPlanV1['roles']; readonly bundles: OutputPlanV1['bundles'] } | null
  /** Slot 5: validate one declared output's bundle completeness and basic format. */
  readonly validateOutput: (role: string, locator: string, bytes: Uint8Array) => { readonly passed: boolean }
}

/** The static, compiled-with-the-plugin adapter description (§5.1; D-189). */
export interface ProfessionalToolSpecV1<P> {
  readonly toolName: string
  readonly softwareIdentity: { readonly name: string; readonly kind: 'cli' | 'r_package_entry' }
  readonly specRevision: string
  readonly modelDescription: string
  /** JSON-schema-ish model-visible parameters (same literal style as the runner Tool). */
  readonly modelParameters: Record<string, unknown>
  readonly parseArgs: (raw: Record<string, unknown>) => ProfessionalParsedArgs<P>
  readonly inputBundle: {
    readonly bundleKind: string
    readonly schemaRevision: string
    readonly requiredRoles: readonly string[]
    readonly handlesOf: (params: P) => readonly BundleHandle[]
  }
  readonly executableBinding: {
    /** TestedEnvironmentRevision component names this tool binds (executable + packages). */
    readonly components: readonly string[]
    readonly argvMode: 'cli_argv' | 'r_script_entry'
    readonly defaultEnvAllowlist: readonly string[]
    readonly extraEnvAllowlist: readonly string[]
    readonly acceptedExitCodes: readonly number[]
  }
  readonly guideRef: { readonly path: string; readonly revision: string; readonly appliesToVersionRange: string }
  readonly operations: readonly ProfessionalOperationContractV1<P>[]
  readonly hooks: ProfessionalToolHooksV1<P>
  readonly extension: {
    readonly namespace: string
    readonly schemaId: string
    readonly payloadOf: (params: P, argv: readonly string[]) => JsonValue
    readonly validate: (payload: JsonValue) => boolean
  }
}

export type { OutputIntent, OutputPlanV1 }
