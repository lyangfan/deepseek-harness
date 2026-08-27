# Agent Note: deterministic Evidence Core for AnimalGE open mode

Status: implemented

English | [中文](2026-08-27-deterministic-evidence-core.zh.md)

## Problem

AnimalGE open mode needs a reproducible Evidence graph derived from what DSH actually persisted, without asking an LLM to reconstruct execution or creating a parallel Agent harness. The first slice must survive partial writes and restarts while keeping its synchronous Session listener free of I/O and compilation.

## Decision

`@deepseek-ai/dsh-evidence-core@0.1.1-rc.2` is a function plugin over DSH commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. It injects Storage Domain, Session persistence, and Session Store; reads Workspace Registry only when available; registers no Service or model-facing surface.

The listener performs only bounded in-memory bookkeeping and hint scheduling. A background capture lane flushes live Sessions, re-reads continuous persisted suffixes, pairs top-level and Code Mode Tool terminal records including DSH repair semantics, and admits only real completion boundaries to a persistent fair outbox. One worker compiles selected captures without an LLM, validates the complete graph, writes an immutable Snapshot, and publishes with a digest-and-revision head CAS.

The Storage Domain is `animalge_evidence` version `0`. A single private owner queue serializes all mutation. Startup repairs Graph bootstrap prefixes, validates current heads and missing CAS finalization, reconciles attempts/outbox, then scans cold Sessions. Recovery never invents a successful empty Snapshot.

## Verification

The fixed suites cover canonical/schema/identity, DSH capture and repair pairing, Store/CAS/fair queue/retry, deterministic compiler and integrity recovery, GC/budget/export, the JSONL-or-SQLite persistence by JSON-or-SQLite Storage 2×2 matrix, real Loader/Agent/bash composition, SIGKILL and two cold restarts, and synchronous listener percentiles with zero persistence calls.

## Alternatives considered

- A public Evidence Service or registry was rejected because SPEC-01 has no consumer that requires one, and it would let callers bypass the single mutation owner.
- Folding the live Session object was rejected because only the flushed persistence suffix is authoritative across repair and restart.
- Modifying the Agent loop was rejected because existing Session events, persistence, Storage Domain, and Loader composition supply the required integration points.

## Consequences

Evidence is now reproducible derived state, not scientific truth. Version `0` remains local, single-user, and single-writer. Artifact/Receipt/SourceAnchor, semantic Evidence, UI, domain Tools, Bundles, and the production preset remain later SPECs. `accountedBytes` is logical canonical usage, and atomic export does not promise `fsync` durability.
