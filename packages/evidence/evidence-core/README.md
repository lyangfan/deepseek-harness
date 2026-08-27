# @deepseek-ai/dsh-evidence-core

English | [中文](README.zh.md)

Deterministic, host-plane Evidence projection for AnimalGE open mode. The function plugin observes eligible DSH Sessions, flushes and re-reads their authoritative persisted suffixes, folds selected terminal Tool invocations without an LLM, validates an immutable Snapshot, and publishes it through a digest-and-revision head CAS in Storage Domain `animalge_evidence` version `0`.

The package deliberately provides no `ctx.evidence` service, public registry, prompt, UI, or second Agent harness. Its Store, compiler queue, capture index, and recovery owner stay private. Consumers may import the frozen value schemas and validators, or export a committed Snapshot record that an owning integration has already resolved.

## SPEC-02 material layer

The same feature owner additionally provides the material protocol: a reference-only ArtifactVersion provider with four-layer state (immutable version core, append-only location observations, snapshot-frozen state, live re-observation), typed SourceAnchor profiles (`text` line ranges and `csv_table` slices) with owner re-verification, the two-phase `EvidenceRunReceipt` family (Submission before the tool result settles; deterministic AcceptanceRecord after the persisted event pair verifies), receipt-backed materialization through the deterministic compiler, and the `sci_run_code` declarative Runner Tool (v0.1 ships the `bash` profile) executing in a run-exclusive, never-reused output directory with pre-declared outputs. Identity failures reject a whole acceptance; a failed component only drops that component's lineage. Anchor kinds and ContextEntity kinds beyond the registered set fail closed.

## Composition

The plugin requires `ctx.storageDomain`, `ctx.sessionPersistence`, `ctx.sessions`, `ctx.fs`, `ctx.subprocess`, and `ctx.tools`. If `ctx.workspaceRegistry` exists, a unique stable membership is bound monotonically; cwd and path are never used as Workspace identity. Runner configuration adds `runnerEnabled` (default true), `runnerOutputRoot`, `runnerDefaultTimeoutMs`, `runnerMaxDeclaredOutputs`, `runnerLogCaptureMaxBytes`, and `materialHashCacheMaxEntries`.

```yaml
- id: evidence-core
  name: '@deepseek-ai/dsh-evidence-core'
  config:
    eligibleAgentPresetIds: [animalge-open]
    deterministicRunSelection:
      revision: animalge-open-selection/v1
      exactToolNames: [bash]
```

The remaining fields have bounded defaults: a 3-second idle merge window; 64 MiB/1,000-boundary outbox limits; 1 GiB soft and 2 GiB hard accounted-byte limits; one-day staging GC, seven-day orphan grace, one-day GC interval; and five total attempts with 1/2/4/8-second retry delays.

## Public API

- Package root: function-plugin `name`/`inject`/`Config`/`apply`; branded identity constructors; strict zod value schemas; canonical JSON, digest, and integrity validation; committed export helpers.
- `@deepseek-ai/dsh-evidence-core/types`: types-only Evidence vocabulary.
- `@deepseek-ai/dsh-evidence-core/export`: exact export builder, writer, verifier, and explicit digest validator.
- `@deepseek-ai/dsh-evidence-core/invariant`: package ownership companion.

The canonicalization contract is `animalge-c14n-json/v1`. It rejects non-JSON values, non-finite numbers, negative zero, sparse/exotic arrays, accessors, cycles, lone surrogates, and duplicate parsed object keys before hashing UTF-8 canonical bytes.

## Durability and recovery

The synchronous `session/event` listener only updates bounded in-memory sets/maps and schedules a hint. Flush, `readFrom`, canonicalization, hashing, compilation, Storage I/O, and GC run outside the listener. One owner queue serializes every durable mutation and one globally fair worker consumes persisted tickets.

Startup order is fixed: Graph bootstrap repair; current-head validation and missing-finalization repair; attempt/outbox reconciliation; then cold Session scanning. A corrupt current head can only move, through the same two-condition CAS, to the newest fully verified committed predecessor. With no valid history it publishes a null head, marks the Graph unavailable, and rebuilds from sequence zero after a real completion boundary; it never manufactures an empty successful Snapshot.

Exports name and verify the exact requested committed digest. Atomic rename is used, but the package does not claim filesystem `fsync` durability.

## Model Experience

### Deterministic Evidence projection

#### What the model sees

Nothing directly. This package registers no Tool, prompt section, Service, or `session/event` contribution. It reads Tool execution already recorded by DSH; downstream packages may later render verified Evidence through separately documented surfaces.

#### Token effect

Zero. Evidence capture and compilation add no model-request text.

#### KV Cache effect

Independent. The package does not modify model request prefixes or tool schemas.

## Known Limitations and Deferred Work

- Version `0` is local, single-user, and one-host-process-writer only.
- `accountedBytes` is canonical logical record usage, not physical disk consumption.
- SPEC-01 captures deterministic Run and terminal Observation provenance only. Artifact, Receipt, SourceAnchor, semantic channels, UI, domain Tools, Bundles, and a production `animalge-open` preset remain outside this package.
- Selection is exact Tool-name matching. Changing its revision or rule digest recompiles from authoritative captures; it never reruns the Tool.
