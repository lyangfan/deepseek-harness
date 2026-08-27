/** ContextEntity owner: immutable software/environment/parameter_set records (SPEC-02 §4.6). */

import { canonicalDigest } from './canonical-json.ts'
import { newContextEntityId } from './identity.ts'
import type { ContextEntityRecordV1 } from './types.ts'
import type { JsonValue } from '@deepseek-ai/dsh-session/types'
import type { EvidenceStore } from './store.ts'

/**
 * Private owner for the three v0.1 ContextEntity kinds. `agent`/`model` stay fail closed
 * until their owner spec activates them; `parameter_set` payloads must already carry the
 * stable secret placeholders produced by the runner (§9.6) before canonicalization here.
 */
export class ContextEntityOwner {
  constructor(private readonly store: EvidenceStore) {}

  /**
   * Register one entity; identical canonical bytes reuse the same identity (idempotent).
   * @param input Kind, name, version, and payload (secret placeholders already applied).
   * @returns The persisted or reused ContextEntity record.
   */
  async register(input: {
    readonly contextKind: 'software' | 'environment' | 'parameter_set'
    readonly name: string
    readonly version: string | null
    readonly payload: JsonValue
    readonly computeCanonicalDigest?: boolean
  }): Promise<ContextEntityRecordV1> {
    const canonical = input.computeCanonicalDigest === false ? null : canonicalDigest(input.payload)
    const existing = [...this.store.contextEntities.entries()].map(([, row]) => row).find(row =>
      row.contextKind === input.contextKind
      && row.identity.name === input.name
      && row.identity.version === input.version
      && row.canonicalDigest === canonical
      && JSON.stringify(row.payload) === JSON.stringify(input.payload))
    if (existing !== undefined) return existing
    const record: ContextEntityRecordV1 = {
      recordVersion: 'animalge.context-entity/v1',
      contextEntityId: newContextEntityId(),
      contextKind: input.contextKind,
      identity: { name: input.name, version: input.version },
      canonicalDigest: canonical,
      payload: input.payload,
    }
    await this.store.putMaterialRecord(this.store.contextEntities, record.contextEntityId, record)
    return record
  }
}
