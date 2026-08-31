# @deepseek-ai/dsh-evidence-core

[English](README.md) | 中文

这是 AnimalGE open mode 的确定性 host-plane Evidence 投影。function plugin 观察符合条件的 DSH Session，先 flush，再从权威持久层读取连续后缀；它不调用 LLM，而是折叠被确定性规则选中的终态 Tool 调用，校验不可变 Snapshot，并通过 Storage Domain `animalge_evidence` version `0` 中同时比较 digest 与 revision 的 head CAS 发布。

本包刻意不提供 `ctx.evidence` Service、公共 registry、prompt、UI 或第二套 Agent harness。Store、compiler queue、capture index 与 recovery owner 均保持私有。消费者只能导入冻结的值 schema 与校验器，或对 owner 已解析出的 committed Snapshot record 执行导出。

## SPEC-02 材料层

同一 feature owner 另外交付材料协议：reference-only 的 ArtifactVersion provider 与四层状态（不可变版本 core、append-only 位置观察、Snapshot 冻结状态、实时重观察）、类型化 SourceAnchor profile（`text` 行范围与 `csv_table` 切片）与 owner 重校验、两阶段 `EvidenceRunReceipt` family（Submission 在 Tool result 结算前持久化；真实事件对验证后由确定性 lane 写入 AcceptanceRecord）、确定性 compiler 的 receipt-backed 物化，以及 `sci_run_code` 声明式 Runner Tool（v0.1 交付 `bash` profile）在按 run 独占、永不复用的输出目录中按预声明输出执行。身份失败拒绝整份 acceptance；单个组件失败只放弃该组件的 lineage。未注册的 Anchor kind 与 ContextEntity kind 一律 fail closed。

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

### 候选语义通道（SPEC-04）

#### 模型看到什么

当显式配置 `evidenceModel` 后，后台语义通道对每个完整持久 turn 发送一个额外模型请求：公开用户/Agent 文本的有界投影（仅文本 block——reasoning block 硬排除）、紧凑 Tool 结果摘要、待选 Run 摘要和既有候选最小摘要。完整 canonical 请求字节在派发前作为 log-only `evidence/model-request` Session 事件持久化，因此"模型看到了什么"始终可从 Session 日志重建。聊天 Agent 本身永远看不到这些请求。

#### Token 影响

每次语义 attempt 一个辅助请求，大小由 turn 内容与声明的逐项截断限定（无额度）。Session 级"AI 候选提取"开关关闭或路由未配置时零请求；确定性通道不受影响继续推进。

#### KV Cache 影响

经 `ctx.llm` 以显式 `evidenceModel` 路由的独立辅助调用；永不共享聊天 Agent 的请求前缀。

### 专业 Tool 运行时（SPEC-03）

#### 模型看到什么

经共享 `defineProfessionalTool()` 工厂注册的四个正常 DSH Tool：`plink_cli`、`himvp_cli`、`r_script` 和 `cmplot_call`。每个暴露一个类型化输入 bundle、一组有界结构化参数、逐字原生 flag 透传（`native_args`）和一个最小引用型结果：`runId`、`outcome`、`outputCompleteness`（+原因）、`outputManifestRef`、正式 `outputs[]` 和 `receiptSubmissionRef`。引导使用位于各 adapter spec 引用的版本化指南文件中，不在 Tool schema 内。

#### Token 影响

有界：仅结果 JSON（不含表格、日志、报告正文或图片字节）。Agent 经正常文件读取按精确 ArtifactVersion 引用读取 Artifact 内容。

#### KV Cache 影响

Tool schema 跨调用稳定；结果卡仅从持久内容和有界展示元数据重放。

## 已知限制与延后工作

- version `0` 只支持本地、单用户、单 host process writer。
- `accountedBytes` 是 canonical 逻辑记录用量，不是物理磁盘占用。
- SPEC-01 只捕获确定性 Run 与终态 Observation provenance。Artifact、Receipt、SourceAnchor、语义通道、UI、领域 Tool、Bundle 和正式 `animalge-open` preset 均不属于本包。
- 选择规则为精确 Tool 名匹配。revision 或 rule digest 变化时从权威 capture 重编译，绝不重跑 Tool。
- 专业 adapter 仅通过 fake executable/R package 验证（SPEC-03 §13.3）；真实软件证据、Genetics Bundle、`animalge-open` Preset、路由强制和 `tested_on_exact_revision` 归 SPEC-07。
- TestedEnvironmentRevision identity 覆盖冻结时探测的组件 digest；provisioning 本身是 SPEC-07 范围。
- `ctx.jobs` 投影是进程内的；非正常退出后，活动输出 reservation 保守保持 `abandoned`，永不重新打开（SPEC-03 §8.1）。
