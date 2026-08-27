# Evidence

[English](evidence.md) | 中文

Evidence 子系统是对权威 DSH Session 日志的确定性投影。SPEC-01 在 [`@deepseek-ai/dsh-evidence-core`](../../packages/evidence/evidence-core/README.zh.md) 中实现第一段 host-plane 能力；它不是替代日志、科学正确性裁判或公共 Cordis Service。

## 权威与数据流

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

Session persistence 始终是执行事实权威。Evidence Store 是 Storage Domain `animalge_evidence` version `0` 中的派生状态。表固定为 `graphs`、`session_graphs`、`captures`、`snapshots`、`heads`、`head_commits`、`attempts`、`outbox`、`staging`、`quarantine`、`queue_clock` 与 `usage`；任何表都不作为 `ctx.evidence` 暴露。

## 确定性对象

每个 eligible Session 只有一个稳定 `EvidenceGraphId`，由 `sessionId + sessionCreatedAt` 防止错误复用。唯一稳定的 Workspace membership 可在后续单调补绑，但不可替换。终态顶层 Tool 调用、DSH not-started／outcome-unknown 修复记录和 Code Mode dispatch 对会生成稳定 Run 与 Observation identity。compiler 产生 `generated_by`，并在被选中的 parent 存在时产生 `part_of` edge。

Snapshot payload 排除编译 wall-clock、attempt、随机 staging ID 与 retry。因此相同 base Snapshot、持久前缀、revision 和精确 selection rule 会重放出相同 identity 与 digest。SPEC-01 中 `semanticWatermark` 固定为零。

## 提交与恢复

发布通过同时比较预期 Snapshot digest 和 head revision 的双条件 CAS 完成。未成功 CAS 的 Snapshot row 是未发布 orphan，不是历史。CAS 成功即为权威事实；即使进程在写 `head_commits`、staging、attempt 或 outbox finalization 前死亡，startup 也会先补齐该后缀，再 reconcile attempt。

损坏的 current Snapshot 会进入 quarantine，head 单调回退到最近完整验证通过的 committed predecessor。若一个都没有，null head 与 unavailable Graph 会显式暴露损坏，直到真实持久完成边界允许从 seq 0 重建。

## 公共边界

包根导出严格 schema、canonicalization／digest helper、branded identity 构造器、完整性校验器和精确 committed-export helper；`./types` 仅包含类型。Store、capture owner、queue、compiler、recovery 与 GC 均保持实现私有，UI 或领域 Provider 不能绕过正式 owner 建立第二套权威。

## 兼容边界

实现绑定 DSH commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，使用现有 Session event、`sessions.flush()`、`sessionPersistence.readFrom()`、Storage Domain、可选 Workspace Registry membership 与正常 Loader function-plugin composition；未修改这些 owner。
