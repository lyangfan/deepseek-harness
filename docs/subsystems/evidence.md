# Evidence

English | [中文](evidence.zh.md)

The Evidence subsystem is a deterministic projection over the authoritative DSH Session log. SPEC-01 implements the first host-plane slice in [`@deepseek-ai/dsh-evidence-core`](../../packages/evidence/evidence-core/README.md); it is not a replacement log, scientific correctness oracle, or public Cordis Service.

## Authority and flow

```text
Session event
  -> bounded in-memory hint/fold (no I/O)
  -> sessions.flush() + sessionPersistence.readFrom()
  -> contiguous persisted suffix validation
  -> persistent outbox and globally fair worker
  -> deterministic capture/fold/integrity validation
  -> immutable Snapshot
  -> digest + head-revision CAS
  -> finalization, recovery, GC, exact export
```

Session persistence remains the execution authority. The Evidence Store is derived state in Storage Domain `animalge_evidence` version `0`. Store tables are `graphs`, `session_graphs`, `captures`, `snapshots`, `heads`, `head_commits`, `attempts`, `outbox`, `staging`, `quarantine`, `queue_clock`, and `usage`; none is exposed as `ctx.evidence`.

## Deterministic objects

One eligible Session owns one stable `EvidenceGraphId`, guarded by `sessionId + sessionCreatedAt`. A unique stable Workspace membership may be bound later but never replaced. Terminal top-level Tool calls, DSH not-started/outcome-unknown repair records, and Code Mode dispatch pairs produce stable Run and Observation identities. The compiler emits `generated_by` and, when the parent is selected and present, `part_of` edges.

Snapshot payloads exclude wall-clock compile time, attempts, random staging IDs, and retries. The same base Snapshot, persisted prefix, revisions, and exact selection rule therefore reproduce the same identities and digest. `semanticWatermark` stays zero in SPEC-01.

## Commit and recovery

Publication is a two-condition CAS over both the expected Snapshot digest and head revision. Snapshot rows written without a successful CAS are unpublished orphans, not history. A CAS success is authoritative even if the process dies before `head_commits`, staging, attempt, or outbox finalization; startup repairs that suffix before reconciling attempts.

A corrupt current Snapshot is quarantined and the head moves monotonically to the newest fully verified committed predecessor. If none exists, a null head and unavailable Graph make the loss explicit until a real persisted completion boundary can rebuild from sequence zero.

## Public boundary

The package root exports strict schemas, canonicalization/digest helpers, branded identity constructors, integrity validators, and exact committed-export helpers. `./types` is types-only. Store, capture owner, queue, compiler, recovery, and GC remain implementation-private, so UI or domain Providers cannot bypass the formal owner and create a second authority.

## Compatibility boundary

The implementation is pinned to DSH commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` and uses existing Session events, `sessions.flush()`, `sessionPersistence.readFrom()`, Storage Domain, optional Workspace Registry membership, and normal Loader function-plugin composition. It modifies none of those owners.
