/** EvidenceRunReceipt family: Submission envelope, digest binding, and two-layer verification. */

import type { CallId } from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionId } from '@deepseek-ai/dsh-session/types'
import { canonicalDigest } from './canonical-json.ts'
import { newReceiptSubmissionId } from './identity.ts'
import type { EvidenceGraphId, EvidenceRunId, EvidenceRunReceiptSubmissionV1, ReceiptComponentsV1, ReceiptSubmissionId, RunnerInvocationBasisV1, RunnerOutcome, Sha256Digest } from './types.ts'
import type { ReceiptSubmission } from './schema.ts'
import type { EvidenceStore } from './store.ts'

/** The v0.1 Receipt family revision; professional extensions (SPEC-03) may not alter it. */
export const RECEIPT_SCHEMA_REVISION = 'animalge.evidence.receipt/v1'

/** Provider-version identity of the declarative Runner producer. */
export const RUNNER_PROVIDER_ID = 'animalge-declarative-runner'
/** Provider version bound into every v0.1 Runner Submission. */
export const RUNNER_PROVIDER_VERSION = 'spec02-runner/v1'

export type ComponentKey = keyof ReceiptComponentsV1

/** Helper for component literals (SPEC-02 §6.3). */
export function capturedComponent(ownerRefs: readonly string[]): { readonly state: 'captured'; readonly reason: null; readonly ownerRefs: readonly string[]; readonly captureBasis: 'provider_verified' } {
  return { state: 'captured', reason: null, ownerRefs, captureBasis: 'provider_verified' }
}

export function missingComponent(reason: string): { readonly state: 'missing'; readonly reason: string; readonly ownerRefs: readonly string[]; readonly captureBasis: null } {
  return { state: 'missing', reason, ownerRefs: [], captureBasis: null }
}

/**
 * Build and persist one immutable Submission (SPEC-02 §6.2).
 * @param store The private owner store.
 * @param input Basis, components, lifecycle, and identity fields of the delivery.
 * @returns The persisted Submission (digest recomputable from its stored bytes).
 */
export async function persistReceiptSubmission(store: EvidenceStore, input: {
  readonly evidenceGraphId: EvidenceGraphId
  readonly sessionId: SessionId
  readonly runId: EvidenceRunId
  readonly invocationBasis: RunnerInvocationBasisV1
  readonly expectedResultCallId: CallId
  readonly toolName: string
  readonly languageProfile: string
  readonly invocationDigest: Sha256Digest
  readonly lifecycle: { readonly startedAt: number | null; readonly endedAt: number }
  readonly outcome: RunnerOutcome
  readonly components: ReceiptComponentsV1
}): Promise<EvidenceRunReceiptSubmissionV1> {
  const {
    evidenceGraphId, sessionId, runId, invocationBasis, expectedResultCallId,
    toolName, languageProfile, invocationDigest, lifecycle, outcome, components,
  } = input
  const envelope = {
    recordVersion: 'animalge.receipt-submission/v1',
    receiptId: newReceiptSubmissionId(),
    receiptSchemaRevision: RECEIPT_SCHEMA_REVISION,
    submittedAt: Date.now(),
    providerId: RUNNER_PROVIDER_ID,
    providerVersion: RUNNER_PROVIDER_VERSION,
    captureProfileId: `runner:${languageProfile}`,
    captureProfileRevision: languageProfile,
    evidenceGraphId,
    sessionId,
    runId,
    invocationBasis,
    expectedResultLocator: { sessionId, callId: expectedResultCallId },
    operation: { toolName, languageProfile },
    invocationDigest,
    lifecycle,
    outcome,
    components,
    extensions: [],
  } as const
  // submissionDigest binds the stored envelope bytes (everything except the digest field
  // itself); the lane recomputes exactly this over the persisted record (§7.2-5).
  const submissionDigest = canonicalDigest(envelope as unknown as JsonValue)
  const submission: EvidenceRunReceiptSubmissionV1 = { ...envelope, submissionDigest }
  await store.putMaterialRecord(store.receiptSubmissions, submission.receiptId, submission)
  return submission
}

export type ReceiptIdentityFailure =
  | 'paired_events_missing'
  | 'run_id_mismatch'
  | 'claimed_start_ref_mismatch'
  | 'scope_mismatch'
  | 'producer_not_registered'
  | 'submission_digest_mismatch'
  | 'schema_invalid'

export type ComponentVerdict = 'verified' | 'failed' | 'not_applicable'

export interface ReceiptVerification {
  readonly identityOk: boolean
  readonly identityFailure: ReceiptIdentityFailure | null
  readonly componentVerdicts: Readonly<Record<ComponentKey, ComponentVerdict>>
  readonly extraVerifiedComponents: number
  readonly meetsReceiptBackedMinimum: boolean
}

/**
 * Component-level verification: every captured ownerRef must resolve to its owner record (§6.4).
 * @param store The private owner store.
 * @param submission The persisted Submission.
 * @returns Per-component verified/failed/not_applicable verdicts.
 */
export function verifyReceiptComponents(store: EvidenceStore, submission: ReceiptSubmission): Record<ComponentKey, ComponentVerdict> {
  const verdicts = {} as Record<ComponentKey, ComponentVerdict>
  for (const key of Object.keys(submission.components) as ComponentKey[]) {
    const component = submission.components[key]
    if (component.state === 'not_applicable') {
      verdicts[key] = 'not_applicable'
      continue
    }
    if (component.state === 'missing') {
      verdicts[key] = component.reason === null ? 'failed' : 'not_applicable'
      continue
    }
    const allResolve = component.ownerRefs.every((ref) => {
      if (ref.startsWith('av_')) return store.artifactVersions.get(ref) !== undefined
      if (ref.startsWith('ce_')) return store.contextEntities.get(ref) !== undefined
      return false
    })
    verdicts[key] = allResolve ? 'verified' : 'failed'
  }
  return verdicts
}

/**
 * The receipt-backed minimum (SPEC-02 §6.4-5): at least one component beyond what a plain
 * DSH call/result event already provides must be owner-verified as captured.
 */
/**
 * The receipt-backed minimum (SPEC-02 §6.4-5): at least one component beyond plain event facts verified.
 * @param verdicts Per-component verdicts from {@link verifyReceiptComponents}.
 * @returns Whether the delivery may gain receipt-backed status.
 */
export function meetsReceiptBackedMinimum(verdicts: Readonly<Record<ComponentKey, ComponentVerdict>>): boolean {
  const keys: ComponentKey[] = ['inputs', 'outputs', 'softwareAndCode', 'environment', 'parameters', 'logs']
  return keys.some(key => verdicts[key] === 'verified')
}

export function isSubmission(value: unknown): value is ReceiptSubmission {
  return typeof value === 'object' && value !== null && (value as { recordVersion?: string }).recordVersion === 'animalge.receipt-submission/v1'
}

export type { ReceiptSubmissionId }
