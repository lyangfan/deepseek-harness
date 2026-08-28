/** Deterministic materialization of accepted Receipts into Snapshot nodes, edges, and payloads (SPEC-02 §8). */

import { deriveArtifactNodeId, deriveContextNodeId, deriveEdgeId } from './identity.ts'
import type { CapturedInvocation, ContextEntityRecord, LocationObservation, ReceiptAcceptanceRecord, ReceiptSubmission } from './schema.ts'
import type { ArtifactVersionCoreV1, ArtifactVersionId, ContextEntityId, DeterministicCompilerProvenanceV1, EvidenceEdgeV1, EvidenceGraphId, EvidenceNodeId, EvidenceNodeV1, EvidenceRunId, InvocationEventBasisV1, OutputFinalizationRecordV1, OutputManifestV1, ReceiptBackedRunPayloadV1, ReceiptComponentsV1, SessionEventRefV1 } from './types.ts'
import type { EvidenceStore } from './store.ts'

/** Capture-profile family of the professional Runtime producer (SPEC-03 §9.1). */
export const PROFESSIONAL_CAPTURE_PROFILE_PREFIX = 'sci-tool:'

/** Frozen material-layer contract revision carried by every material Snapshot. */
export const MATERIAL_CONTRACT_REVISION = 'animalge-material/v1'

/** The store material state one compile attempt freezes as input (§8.1). */
export interface MaterialSnapshot {
  readonly accepted: ReadonlyMap<EvidenceRunId, { readonly submission: ReceiptSubmission; readonly acceptance: ReceiptAcceptanceRecord }>
  readonly versions: ReadonlyMap<ArtifactVersionId, ArtifactVersionCoreV1>
  readonly entities: ReadonlyMap<ContextEntityId, ContextEntityRecord>
  readonly observations: ReadonlyMap<ArtifactVersionId, LocationObservation>
  /** Finalized formal outputs per runId (SPEC-03 §8.4 compiler materialization gate). */
  readonly finalizations: ReadonlyMap<EvidenceRunId, {
    readonly finalization: OutputFinalizationRecordV1
    readonly manifest: OutputManifestV1
  }>
}

/** Freeze the store material state visible to one Graph at attempt time (§8.1). */
export function materialSnapshotFor(store: EvidenceStore, _graphId: EvidenceGraphId): MaterialSnapshot {
  const accepted = new Map<EvidenceRunId, { submission: ReceiptSubmission; acceptance: ReceiptAcceptanceRecord }>()
  for (const [, row] of store.receiptAcceptances.entries()) {
    if (row.verdict !== 'accepted') continue
    const submission = store.receiptSubmissions.get(row.receiptId)
    if (submission !== undefined) accepted.set(submission.runId, { submission, acceptance: row })
  }
  const versions = new Map<ArtifactVersionId, ArtifactVersionCoreV1>()
  const observations = new Map<ArtifactVersionId, LocationObservation>()
  const referenced = new Set<string>()
  for (const { submission } of accepted.values()) {
    for (const key of Object.keys(submission.components) as (keyof ReceiptComponentsV1)[]) {
      for (const ref of submission.components[key].ownerRefs) referenced.add(ref)
    }
  }
  for (const [id, version] of store.artifactVersions.entries()) {
    if (!referenced.has(id)) continue
    versions.set(version.artifactVersionId, version)
    const latest = store.latestObservation(version.artifactVersionId)
    if (latest !== undefined) observations.set(version.artifactVersionId, latest)
  }
  const entities = new Map<ContextEntityId, ContextEntityRecord>()
  for (const [id, entity] of store.contextEntities.entries()) {
    if (referenced.has(id)) entities.set(entity.contextEntityId, entity)
  }
  // SPEC-03 §8.4: the verified finalization marker is the only publication commit for
  // professional outputs; a run without one stays receipt-backed without output lineage.
  const finalizations = new Map<EvidenceRunId, { finalization: OutputFinalizationRecordV1; manifest: OutputManifestV1 }>()
  for (const [, finalization] of store.outputFinalizations.entries()) {
    const manifest = store.outputManifests.get(finalization.manifestId)
    if (manifest === undefined || manifest.manifestDigest !== finalization.manifestDigest) continue
    const current = finalizations.get(finalization.runId)
    if (current === undefined || finalization.finalizedAt > current.finalization.finalizedAt) {
      finalizations.set(finalization.runId, { finalization, manifest })
    }
  }
  return { accepted, versions, entities, observations, finalizations }
}

/** §8.3 ComponentStateV1: strip the producer-side captureBasis (§6.3) from each component. */
function stripComponentBasis(components: ReceiptComponentsV1): ReceiptBackedRunPayloadV1['components'] {
  const strip = (component: { state: 'captured' | 'missing' | 'not_applicable'; reason: string | null; ownerRefs: readonly string[] }) => ({
    state: component.state,
    reason: component.reason,
    ownerRefs: component.ownerRefs,
  })
  return {
    inputs: strip(components.inputs),
    outputs: strip(components.outputs),
    softwareAndCode: strip(components.softwareAndCode),
    environment: strip(components.environment),
    parameters: strip(components.parameters),
    randomness: strip(components.randomness),
    logs: strip(components.logs),
  }
}

/** Build the receipt-backed Run payload for one capture (§8.3): same runId, stronger basis. */
export function receiptBackedPayload(options: {
  readonly capture: CapturedInvocation
  readonly submission: ReceiptSubmission
  readonly acceptance: ReceiptAcceptanceRecord
}): ReceiptBackedRunPayloadV1 {
  const { capture, submission, acceptance } = options
  const basis: InvocationEventBasisV1 = capture.basis
  const start = basis.kind === 'top_level_tool' ? basis.callEvent.seq : basis.kind === 'top_level_not_started' ? basis.assistantEvent.seq : basis.startEvent.seq
  const primaryCallId = basis.kind === 'code_mode_dispatch' ? basis.subCallId : basis.callId
  return {
    runSchema: 'animalge.run.receipt-backed/v1',
    runId: capture.runId,
    runKind: 'tool',
    operation: {
      toolName: capture.toolName,
      ...(submission.operation.languageProfile === undefined ? {} : { languageProfile: submission.operation.languageProfile }),
      ...(submission.operation.operationProfile === undefined ? {} : { operationProfile: submission.operation.operationProfile }),
    },
    primaryCallId,
    invocationDigest: capture.invocationDigest,
    eventBasis: basis,
    captureBasis: 'receipt',
    receiptDigest: acceptance.acceptanceDigest,
    receiptId: submission.receiptId,
    captureContractRevision: 'animalge-capture/v1',
    materialContractRevision: MATERIAL_CONTRACT_REVISION,
    eventSeqRange: { startInclusive: start, endInclusive: basis.resultEvent.seq },
    actorRefs: [],
    selectionBasis: { kind: 'receipt_auto', receiptId: submission.receiptId, acceptanceDigest: acceptance.acceptanceDigest },
    startedAt: capture.startedAt,
    endedAt: capture.endedAt,
    outcome: submission.outcome,
    components: stripComponentBasis(submission.components),
  }
}

/** Project the material owner records of one accepted receipt as nodes and lineage edges (§8.4). */
export function materialProjection(options: {
  readonly graphId: EvidenceGraphId
  readonly runNodeId: EvidenceNodeId
  readonly refs: readonly SessionEventRefV1[]
  readonly compiler: DeterministicCompilerProvenanceV1
  readonly submission: ReceiptSubmission
  readonly material: MaterialSnapshot
}): { readonly nodes: EvidenceNodeV1[]; readonly edges: EvidenceEdgeV1[] } {
  const { graphId, runNodeId, refs, compiler, submission, material } = options
  const nodes: EvidenceNodeV1[] = []
  const edges: EvidenceEdgeV1[] = []
  const versionNode = new Map<string, EvidenceNodeId>()
  const contextNode = new Map<string, EvidenceNodeId>()

  const artifactNode = (versionId: ArtifactVersionId): EvidenceNodeId | undefined => {
    const existing = versionNode.get(versionId)
    if (existing !== undefined) return existing
    const version = material.versions.get(versionId)
    const observation = material.observations.get(versionId)
    if (version === undefined || observation === undefined) return undefined
    const nodeId = deriveArtifactNodeId({ graphId, nodeKind: 'ArtifactVersion', artifactVersionId: versionId })
    nodes.push({
      schemaVersion: 'animalge.evidence.node/v1', nodeId, graphId, nodeKind: 'ArtifactVersion',
      payloadSchema: 'animalge.artifact.version-node/v1', projectionState: 'active',
      identityRevision: 'animalge-identity/v1', sourceEventRefs: refs, compiler,
      payload: {
        nodeSchema: 'animalge.artifact.version-node/v1',
        artifactId: version.artifactId, artifactVersionId: version.artifactVersionId,
        contentDigest: version.contentDigest, byteLength: version.byteLength, mediaType: version.mediaType,
        retention: 'reference', frozenLocationObservationId: observation.locationObservationId,
      },
    })
    versionNode.set(versionId, nodeId)
    return nodeId
  }

  const entityNode = (entityId: ContextEntityId): EvidenceNodeId | undefined => {
    const existing = contextNode.get(entityId)
    if (existing !== undefined) return existing
    const entity = material.entities.get(entityId)
    if (entity === undefined) return undefined
    const nodeId = deriveContextNodeId({ graphId, nodeKind: 'ContextEntity', contextEntityId: entityId })
    nodes.push({
      schemaVersion: 'animalge.evidence.node/v1', nodeId, graphId, nodeKind: 'ContextEntity',
      payloadSchema: 'animalge.context.entity-node/v1', projectionState: 'active',
      identityRevision: 'animalge-identity/v1', sourceEventRefs: refs, compiler,
      payload: {
        nodeSchema: 'animalge.context.entity-node/v1',
        contextEntityId: entity.contextEntityId, contextKind: entity.contextKind,
        identity: entity.identity, canonicalDigest: entity.canonicalDigest, payload: entity.payload,
      },
    })
    contextNode.set(entityId, nodeId)
    return nodeId
  }

  const emittedEdges = new Set<string>()
  const pushEdge = (edgeType: 'generated_by' | 'used', from: EvidenceNodeId, to: EvidenceNodeId): void => {
    const edgeId = deriveEdgeId({ graphId, edgeType, from, to })
    if (emittedEdges.has(edgeId)) return // one owner ref shared by two components yields one edge
    emittedEdges.add(edgeId)
    edges.push({
      schemaVersion: 'animalge.evidence.edge/v1', edgeId,
      graphId, edgeType, family: 'deterministic_provenance',
      from, to, projectionState: 'active', sourceEventRefs: refs, compiler,
    })
  }
  const componentKeys = Object.keys(submission.components) as (keyof ReceiptComponentsV1)[]
  // SPEC-03 §8.4 materialization gate: professional outputs only gain generated_by when a
  // verified OutputFinalizationRecord publishes them; the runner keeps its frozen rule.
  const professional = submission.captureProfileId.startsWith(PROFESSIONAL_CAPTURE_PROFILE_PREFIX)
  const finalizedRefs = professional
    ? new Set(material.finalizations.get(submission.runId)?.manifest.formalOutputs.map(output => output.artifactVersionId) ?? [])
    : undefined
  for (const key of componentKeys) {
    const component = submission.components[key]
    if (component.state !== 'captured') continue
    const failed = component.ownerRefs.some((ref) => {
      if (ref.startsWith('av_')) return material.versions.get(ref as ArtifactVersionId) === undefined
      if (ref.startsWith('ce_')) return material.entities.get(ref as ContextEntityId) === undefined
      return true
    })
    if (failed) continue // component-level failure: no lineage for this component (§6.4)
    for (const ref of component.ownerRefs) {
      const target = ref.startsWith('av_') ? artifactNode(ref as ArtifactVersionId) : entityNode(ref as ContextEntityId)
      if (target === undefined) continue
      if (key === 'outputs') {
        if (finalizedRefs !== undefined && !finalizedRefs.has(ref as ArtifactVersionId)) continue
        pushEdge('generated_by', target, runNodeId)
      } else {
        pushEdge('used', runNodeId, target)
      }
    }
  }

  // Immutable-history edges between projected versions of the same Artifact (§8.4).
  for (const version of material.versions.values()) {
    if (version.parentVersionId === null) continue
    const childId = versionNode.get(version.artifactVersionId)
    const parentId = versionNode.get(version.parentVersionId)
    if (childId === undefined || parentId === undefined) continue
    const edgeType = version.supersedesReason === 'restore_as_new' ? 'restored_from' : 'supersedes'
    edges.push({
      schemaVersion: 'animalge.evidence.edge/v1',
      edgeId: deriveEdgeId({ graphId, edgeType, from: childId, to: parentId }),
      graphId, edgeType, family: 'deterministic_provenance',
      from: childId, to: parentId, projectionState: 'active', sourceEventRefs: refs, compiler,
    })
  }
  return { nodes, edges }
}
