import { describe, expect, it } from 'vitest'
import { canonicalDigest } from '../src/canonical-json.ts'
import { deriveEdgeId, deriveNodeId, deriveObservationId, deriveRunId, EvidenceGraphId, taggedSha256Digest } from '../src/identity.ts'
import { verifySnapshot } from '../src/integrity.ts'
import { evidenceSnapshotPayloadSchema, sha256DigestSchema } from '../src/schema.ts'
import { compiledFixture } from './helpers.ts'
import { registerSuiteSummary } from './summary.ts'

registerSuiteSummary({
  suiteId: 'schema-identity',
  acceptanceIds: ['S01-A01'],
  sessionPersistence: [],
  evidenceStorage: [],
})

describe('S01-A01 identity and strict schemas', () => {
  it('derives stable, domain-separated identities', () => {
    const material = { graphId: 'eg_fixture', seq: 3 }
    expect(deriveRunId(material)).toBe(deriveRunId({ seq: 3, graphId: 'eg_fixture' }))
    expect(deriveNodeId(material)).not.toBe(deriveEdgeId(material))
    expect(deriveObservationId(material)).not.toBe(deriveRunId(material))
    expect(taggedSha256Digest('one', material)).not.toBe(taggedSha256Digest('two', material))
  })

  it('rejects malformed branded ids and digests', () => {
    expect(() => EvidenceGraphId('er_wrong')).toThrow(/invalid Evidence identity/)
    expect(sha256DigestSchema.safeParse('sha256:ABC').success).toBe(false)
  })

  it('accepts the frozen snapshot shape and rejects unknown fields', () => {
    const { payload } = compiledFixture()
    expect(evidenceSnapshotPayloadSchema.parse(payload)).toEqual(payload)
    expect(() => evidenceSnapshotPayloadSchema.parse({ ...payload, invented: true })).toThrow()
    expect(canonicalDigest(payload as never)).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })

  it('rejects reserved node kinds under the coded unsupported_node_kind error', () => {
    const { payload } = compiledFixture()
    const reserved = {
      ...payload,
      nodes: payload.nodes.map(node => node.nodeKind === 'Run' ? { ...node, nodeKind: 'SourceAssertion' } : node),
    }
    expect(() => verifySnapshot(reserved)).toThrow(expect.objectContaining({ code: 'unsupported_node_kind' }))
  })
})
