# evidence/ — 确定性科学 Evidence 系列

[English](README.md) | 中文

该系列把权威 DSH 运行记录转换为经校验、不可变的科学 Evidence 投影。它不替代 Session 日志、Tool runtime 或 Storage Domain owner。

| 包 | 职责 | `ctx` 键 |
|---|---|---|
| [`evidence-core/`](evidence-core/README.zh.md) | 确定性 Session 事件捕获、不可变 Snapshot 发布、恢复、GC 与精确导出 | 无（私有 function plugin） |

数据流与权威边界见 [Evidence 子系统参考](../../docs/subsystems/evidence.zh.md)。
