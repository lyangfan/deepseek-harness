/** Branded identity constructors and deterministic tagged-digest derivation. */

import { createHash, randomUUID } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import { canonicalJson } from './canonical-json.ts'
import type { CompileAttemptId as CompileAttemptIdType, EvidenceEdgeId as EvidenceEdgeIdType, EvidenceGraphId as EvidenceGraphIdType, EvidenceNodeId as EvidenceNodeIdType, EvidenceRunId as EvidenceRunIdType, ObservationId as ObservationIdType, RecoveryId as RecoveryIdType, Sha256Digest, StagingId as StagingIdType } from './types.ts'

const ID_RE = /^(?:eg_|en_|ee_|er_|eo_|ca_|st_|rc_)[A-Za-z0-9_-]+$/u

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

export const newEvidenceGraphId = (): EvidenceGraphIdType => EvidenceGraphId(`eg_${randomUUID()}`)
export const newCompileAttemptId = (): CompileAttemptIdType => CompileAttemptId(`ca_${randomUUID()}`)
export const newStagingId = (): StagingIdType => StagingId(`st_${randomUUID()}`)
export const newRecoveryId = (): RecoveryIdType => RecoveryId(`rc_${randomUUID()}`)

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
