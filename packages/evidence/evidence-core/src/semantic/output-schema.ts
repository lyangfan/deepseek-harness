/** Strict runtime schema for the model's structured extraction output (SPEC-04 §7.3). */

import { z } from 'zod'

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Endpoint reference union: an in-graph stable id or a same-batch localId handle (§7.3). */
export const proposalEndpointRefSchema = z.union([
  z.object({ kind: z.enum(['Observation', 'CandidateStatement']), id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('BatchCandidate'), localId: z.string().min(1) }).strict(),
])

/** Strict SemanticExtractionOutputV1: unknown fields reject, the whole output dies (§7.3). */
export const semanticExtractionOutputSchema = z.object({
  schemaVersion: z.literal('animalge.semantic-extraction/v1'),
  candidates: z.array(z.object({
    localId: z.string().min(1),
    sourceEventSeq: safeInteger,
    spanStart: safeInteger,
    spanEnd: safeInteger,
    subtype: z.enum(['hypothesis', 'interpretation', 'conclusion', 'limitation', 'statement']),
    text: z.string().min(1),
  }).strict()),
  relations: z.array(z.object({
    type: z.enum(['supports', 'qualifies', 'contradicts']),
    fromRef: proposalEndpointRefSchema,
    toRef: proposalEndpointRefSchema,
    sourceEventSeqs: z.array(safeInteger),
  }).strict()),
  sameAsProposals: z.array(z.object({
    aRef: proposalEndpointRefSchema,
    bRef: proposalEndpointRefSchema,
  }).strict()),
  runSelections: z.array(z.object({
    runId: z.string().min(1),
    reason: z.string(),
    sourceEventSeqs: z.array(safeInteger),
  }).strict()),
}).strict()

export type SemanticExtractionOutput = z.infer<typeof semanticExtractionOutputSchema>
export type ProposalEndpointRef = z.infer<typeof proposalEndpointRefSchema>

/**
 * Validate one parsed output against the strict schema and the batch-internal invariants
 * (unique localIds, §7.3). Returns null on any violation — an invalid output is one
 * retryable model failure, never a per-proposal rejection.
 */
export function validateExtractionOutput(value: unknown): SemanticExtractionOutput | null {
  let parsed: SemanticExtractionOutput
  try {
    parsed = semanticExtractionOutputSchema.parse(value)
  } catch {
    return null
  }
  const localIds = new Set<string>()
  for (const candidate of parsed.candidates) {
    if (localIds.has(candidate.localId)) return null
    localIds.add(candidate.localId)
  }
  return parsed
}
