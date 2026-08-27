/** Branded identity constructors and deterministic tagged-digest derivation. */

import { createHash, randomUUID } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { canonicalJson } from './canonical-json.ts'
import type { ArtifactId as ArtifactIdType, ArtifactVersionId as ArtifactVersionIdType, CompileAttemptId as CompileAttemptIdType, ContextEntityId as ContextEntityIdType, EvidenceEdgeId as EvidenceEdgeIdType, EvidenceGraphId as EvidenceGraphIdType, EvidenceNodeId as EvidenceNodeIdType, EvidenceRunId as EvidenceRunIdType, LocationObservationId as LocationObservationIdType, ObservationId as ObservationIdType, ReceiptAcceptanceId as ReceiptAcceptanceIdType, ReceiptSubmissionId as ReceiptSubmissionIdType, RecoveryId as RecoveryIdType, Sha256Digest, SourceAnchorId as SourceAnchorIdType, StagingId as StagingIdType } from './types.ts'

const ID_RE = /^(?:eg_|en_|ee_|er_|eo_|ca_|st_|rc_|art_|av_|lo_|ce_|sa_|rs_|ra_)[A-Za-z0-9_-]+$/u

function checked(value: string, prefix: string): string {
  if (!value.startsWith(prefix) || !ID_RE.test(value)) throw new TypeError(`invalid Evidence identity '${value}'`)
  return value
}

function tagged(prefix: string, tag: string, material: JsonValue): string {
  const digest = createHash('sha256').update(`${tag}\n${canonicalJson(material)}`).digest('base64url')
  return `${prefix}${digest}`
}

/**
 * Hash tagged canonical identity material without applying an object-id prefix.
 * @param tag Revisioned identity-domain tag.
 * @param material Strict JSON identity material.
 * @returns Lowercase tagged SHA-256 digest.
 */
export function taggedSha256Digest(tag: string, material: JsonValue): Sha256Digest {
  return `sha256:${createHash('sha256').update(`${tag}\n${canonicalJson(material)}`).digest('hex')}`
}

/**
 * Parse and brand an Evidence Graph identity.
 * @param value Candidate identity.
 * @returns Valid Graph identity.
 */
export const EvidenceGraphId = (value: string): EvidenceGraphIdType => checked(value, 'eg_') as EvidenceGraphIdType
/**
 * Parse and brand an Evidence Node identity.
 * @param value Candidate identity.
 * @returns Valid Node identity.
 */
export const EvidenceNodeId = (value: string): EvidenceNodeIdType => checked(value, 'en_') as EvidenceNodeIdType
/**
 * Parse and brand an Evidence Edge identity.
 * @param value Candidate identity.
 * @returns Valid Edge identity.
 */
export const EvidenceEdgeId = (value: string): EvidenceEdgeIdType => checked(value, 'ee_') as EvidenceEdgeIdType
/**
 * Parse and brand an Evidence Run identity.
 * @param value Candidate identity.
 * @returns Valid Run identity.
 */
export const EvidenceRunId = (value: string): EvidenceRunIdType => checked(value, 'er_') as EvidenceRunIdType
/**
 * Parse and brand an Observation identity.
 * @param value Candidate identity.
 * @returns Valid Observation identity.
 */
export const ObservationId = (value: string): ObservationIdType => checked(value, 'eo_') as ObservationIdType
export const CompileAttemptId = (value: string): CompileAttemptIdType => checked(value, 'ca_') as CompileAttemptIdType
export const StagingId = (value: string): StagingIdType => checked(value, 'st_') as StagingIdType
export const RecoveryId = (value: string): RecoveryIdType => checked(value, 'rc_') as RecoveryIdType
export const ArtifactId = (value: string): ArtifactIdType => checked(value, 'art_') as ArtifactIdType
export const ArtifactVersionId = (value: string): ArtifactVersionIdType => checked(value, 'av_') as ArtifactVersionIdType
export const LocationObservationId = (value: string): LocationObservationIdType => checked(value, 'lo_') as LocationObservationIdType
export const ContextEntityId = (value: string): ContextEntityIdType => checked(value, 'ce_') as ContextEntityIdType
export const SourceAnchorId = (value: string): SourceAnchorIdType => checked(value, 'sa_') as SourceAnchorIdType
export const ReceiptSubmissionId = (value: string): ReceiptSubmissionIdType => checked(value, 'rs_') as ReceiptSubmissionIdType
export const ReceiptAcceptanceId = (value: string): ReceiptAcceptanceIdType => checked(value, 'ra_') as ReceiptAcceptanceIdType

export const newEvidenceGraphId = (): EvidenceGraphIdType => EvidenceGraphId(`eg_${randomUUID()}`)
export const newCompileAttemptId = (): CompileAttemptIdType => CompileAttemptId(`ca_${randomUUID()}`)
export const newStagingId = (): StagingIdType => StagingId(`st_${randomUUID()}`)
export const newRecoveryId = (): RecoveryIdType => RecoveryId(`rc_${randomUUID()}`)
export const newArtifactId = (): ArtifactIdType => ArtifactId(`art_${randomUUID()}`)
export const newArtifactVersionId = (): ArtifactVersionIdType => ArtifactVersionId(`av_${randomUUID()}`)
export const newLocationObservationId = (): LocationObservationIdType => LocationObservationId(`lo_${randomUUID()}`)
export const newContextEntityId = (): ContextEntityIdType => ContextEntityId(`ce_${randomUUID()}`)
export const newSourceAnchorId = (): SourceAnchorIdType => SourceAnchorId(`sa_${randomUUID()}`)
export const newReceiptSubmissionId = (): ReceiptSubmissionIdType => ReceiptSubmissionId(`rs_${randomUUID()}`)
export const newReceiptAcceptanceId = (): ReceiptAcceptanceIdType => ReceiptAcceptanceId(`ra_${randomUUID()}`)

/**
 * Derive a stable Run identity.
 * @param material Strict identity material.
 * @returns Deterministic Run identity.
 */
export const deriveRunId = (material: JsonValue): EvidenceRunIdType => EvidenceRunId(tagged('er_', 'animalge:run-id:v1', material))
/**
 * Derive a stable Observation identity.
 * @param material Strict identity material.
 * @returns Deterministic Observation identity.
 */
export const deriveObservationId = (material: JsonValue): ObservationIdType => ObservationId(tagged('eo_', 'animalge:observation-id:v1', material))
/**
 * Derive a stable Node identity.
 * @param material Strict identity material.
 * @returns Deterministic Node identity.
 */
export const deriveNodeId = (material: JsonValue): EvidenceNodeIdType => EvidenceNodeId(tagged('en_', 'animalge:node-id:v1', material))
/**
 * Derive a stable Edge identity.
 * @param material Strict identity material.
 * @returns Deterministic Edge identity.
 */
export const deriveEdgeId = (material: JsonValue): EvidenceEdgeIdType => EvidenceEdgeId(tagged('ee_', 'animalge:edge-id:v1', material))
/**
 * Derive a stable ArtifactVersion Node identity (SPEC-02 §4.1).
 * @param material `{graphId, nodeKind:'ArtifactVersion', artifactVersionId}`.
 * @returns Deterministic Node identity.
 */
export const deriveArtifactNodeId = (material: { readonly graphId: EvidenceGraphIdType; readonly nodeKind: 'ArtifactVersion'; readonly artifactVersionId: ArtifactVersionIdType }): EvidenceNodeIdType => EvidenceNodeId(tagged('en_', 'animalge:artifact-node-id:v1', material))
/**
 * Derive a stable ContextEntity Node identity (SPEC-02 §4.1).
 * @param material `{graphId, nodeKind:'ContextEntity', contextEntityId}`.
 * @returns Deterministic Node identity.
 */
export const deriveContextNodeId = (material: { readonly graphId: EvidenceGraphIdType; readonly nodeKind: 'ContextEntity'; readonly contextEntityId: ContextEntityIdType }): EvidenceNodeIdType => EvidenceNodeId(tagged('en_', 'animalge:context-node-id:v1', material))
