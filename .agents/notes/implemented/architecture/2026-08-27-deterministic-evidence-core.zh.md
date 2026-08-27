# Agent Note：AnimalGE open mode 的确定性 Evidence Core

状态：已实现

[English](2026-08-27-deterministic-evidence-core.md) | 中文

## 问题

AnimalGE open mode 需要从 DSH 实际持久化的事实生成可复现 Evidence graph，不能要求 LLM 重构执行，也不能另建一套 Agent harness。第一段能力必须承受部分写入与重启，同时保证同步 Session listener 不执行 I/O 和 compile。

## 决定

`@deepseek-ai/dsh-evidence-core@0.1.1-rc.2` 是基于 DSH commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` 的 function plugin。它注入 Storage Domain、Session persistence 与 Session Store；仅在可用时读取 Workspace Registry；不注册 Service 或模型可见 surface。

listener 只执行有界内存记账与 hint 调度。后台 capture lane flush live Session，重新读取连续持久后缀，配对顶层与 Code Mode Tool 终态记录（包括 DSH repair 语义），并且只把真实完成边界准入持久公平 outbox。单 worker 不调用 LLM，而是编译被选中的 capture、校验完整 graph、写不可变 Snapshot，并通过 digest 与 revision 双条件 head CAS 发布。

Storage Domain 为 `animalge_evidence` version `0`。单一私有 owner queue 串行化全部 mutation。startup 依次修复 Graph bootstrap 前缀、校验 current head 与缺失 CAS finalization、reconcile attempt／outbox，最后扫描 cold Session。恢复绝不制造空的成功 Snapshot。

## 验证

固定 suite 覆盖 canonical／schema／identity、DSH capture 与 repair 配对、Store／CAS／公平队列／retry、确定性 compiler 与完整性恢复、GC／预算／export、JSONL 或 SQLite persistence × JSON 或 SQLite Storage 的 2×2 matrix、真实 Loader／Agent／bash composition、SIGKILL 后两次 cold restart，以及同步 listener percentile 与零 persistence 调用。

## 考虑过的替代方案

- 未采用公共 Evidence Service 或 registry，因为 SPEC-01 没有需要它的 consumer，而且这会允许 caller 绕过单一 mutation owner。
- 未采用 live Session object 直接 fold，因为只有 flush 后的 persistence suffix 才能在 repair 与 restart 之间保持权威。
- 未修改 Agent loop，因为现有 Session event、persistence、Storage Domain 与 Loader composition 已提供所需接入点。

## 后果

Evidence 现在是可复现派生状态，而不是科学真理。version `0` 仍只支持本地、单用户、单 writer。Artifact／Receipt／SourceAnchor、语义 Evidence、UI、领域 Tool、Bundle 与正式 preset 留给后续 SPEC。`accountedBytes` 是逻辑 canonical 用量，atomic export 不承诺 `fsync` durability。
