# @deepseek-ai/dsh-evidence-core

[English](README.md) | 中文

这是 AnimalGE open mode 的确定性 host-plane Evidence 投影。function plugin 观察符合条件的 DSH Session，先 flush，再从权威持久层读取连续后缀；它不调用 LLM，而是折叠被确定性规则选中的终态 Tool 调用，校验不可变 Snapshot，并通过 Storage Domain `animalge_evidence` version `0` 中同时比较 digest 与 revision 的 head CAS 发布。

本包刻意不提供 `ctx.evidence` Service、公共 registry、Tool、prompt、UI 或第二套 Agent harness。Store、compiler queue、capture index 与 recovery owner 均保持私有。消费者只能导入冻结的值 schema 与校验器，或对 owner 已解析出的 committed Snapshot record 执行导出。

## 组合

plugin 必须获得 `ctx.storageDomain`、`ctx.sessionPersistence` 和 `ctx.sessions`。若存在 `ctx.workspaceRegistry`，则单调绑定唯一稳定 membership；cwd 和路径绝不充当 Workspace identity。

```yaml
- id: evidence-core
  name: '@deepseek-ai/dsh-evidence-core'
  config:
    eligibleAgentPresetIds: [animalge-open]
    deterministicRunSelection:
      revision: animalge-open-selection/v1
      exactToolNames: [bash]
```

其余字段采用有界默认值：3 秒 idle merge window；64 MiB／1,000 个边界的 outbox 限制；1 GiB soft 与 2 GiB hard accounted-byte 限制；1 天 staging GC、7 天 orphan grace、1 天 GC interval；最多 5 次总尝试，退避 1／2／4／8 秒。

## 公共 API

- 包根：function-plugin 的 `name`／`inject`／`Config`／`apply`；branded identity 构造器；严格 zod 值 schema；canonical JSON、digest 与完整性校验；committed export helper。
- `@deepseek-ai/dsh-evidence-core/types`：仅类型的 Evidence 词汇表。
- `@deepseek-ai/dsh-evidence-core/export`：精确导出 builder、writer、verifier 与显式 digest 校验器。
- `@deepseek-ai/dsh-evidence-core/invariant`：包所有权 companion。

规范化合同为 `animalge-c14n-json/v1`。它在计算 UTF-8 canonical bytes 的 hash 前，拒绝非 JSON 值、非有限数、负零、稀疏／exotic array、accessor、cycle、孤立 surrogate，以及解析输入中的重复对象键。

## 持久化与恢复

同步 `session/event` listener 只更新有界内存 set／map 并投递 hint。flush、`readFrom`、canonicalization、hash、compile、Storage I/O 和 GC 都在 listener 外运行。一个 owner queue 串行化全部 durable mutation，一个全局公平 worker 消费持久 ticket。

启动顺序固定为：Graph bootstrap 修复；current head 校验与缺失 finalization 修复；attempt／outbox reconciliation；最后 cold Session scan。损坏 current 只能通过同一个双条件 CAS 回到最近完整校验通过的 committed predecessor。没有合法历史时发布 null head、把 Graph 标为 unavailable，并在出现真实完成边界后从 seq 0 重建；绝不制造空的成功 Snapshot。

导出按请求的精确 committed digest 命名并复核。文件采用原子 rename，但本包不宣称文件系统 `fsync` durability。

## 模型体验

### 确定性 Evidence 投影

#### 模型看到什么

模型不会直接看到任何内容。本包不注册 Tool、prompt section、Service 或 `session/event` contribution。它读取 DSH 已记录的 Tool 执行；后续包可通过另行记录的 surface 呈现已验证 Evidence。

#### Token 影响

为零。Evidence 捕获与编译不向模型请求加入文本。

#### KV Cache 影响

相互独立。本包不修改模型请求前缀或 Tool schema。

## 已知限制与延后工作

- version `0` 只支持本地、单用户、单 host process writer。
- `accountedBytes` 是 canonical 逻辑记录用量，不是物理磁盘占用。
- SPEC-01 只捕获确定性 Run 与终态 Observation provenance。Artifact、Receipt、SourceAnchor、语义通道、UI、领域 Tool、Bundle 和正式 `animalge-open` preset 均不属于本包。
- 选择规则为精确 Tool 名匹配。revision 或 rule digest 变化时从权威 capture 重编译，绝不重跑 Tool。
