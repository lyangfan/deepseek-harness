# @deepseek-ai/dsh-client-ui-evidence

Evidence 读取视图（SPEC-05）：候选优先的 `conversation.view` 页签、Session header 状态入口和工具卡导航链接。全部数据经 `ctx.remote.evidence` 流动；视图永不触碰 owner 存储。

[English](README.md) | 中文

## 模型体验

None, as this package registers no model-visible surface; every model dispatch is owned by the evidence-core semantic lane (or the browser shell for the view plugin).

#### KV Cache 影响

Zero — no model prompts are generated, so no cache entries are created.

## 已知限制与暂缓事项

- **无虚拟化或无限滚动**：固定 cursor 每页 50 + 精确总数（spec §9.3，D-141 排除项）。
- **Chat 内联节点未使用**：视图不注册任何 `conversation.chat.node` 条目（SPEC-05 §1.3 术语校正）。
- **无障碍后置**：无 Evidence 专项 WCAG 门槛；所有科学状态保留文字语义（D-143）。
