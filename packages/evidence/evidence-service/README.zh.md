# @deepseek-ai/dsh-evidence-service

只读 Evidence 查询 Remote 服务（SPEC-05），构建在私有 evidence-core owner 存储之上：浏览器可读通道，覆盖 current/历史 Snapshot、候选列表、局部路径、对象详情、Receipt 状态、含 markSeen 的 issue 通道、精确导航、PreviewFragment 与 canonical 导出。

[English](README.md) | 中文

## 模型体验

None, as this package registers no model-visible surface; every model dispatch is owned by the evidence-core semantic lane (or the browser shell for the view plugin).

#### KV Cache 影响

Zero — no model prompts are generated, so no cache entries are created.

## 已知限制与暂缓事项

- **仅浏览器消费者**：`evidence` namespace 仅经浏览器 api-remotes 装配挂载；headless 宿主直接经 `ctx.evidenceStore` 读存储。
- **Preview 锚点仅限 text/csv_table**：SPEC-02 注册的 anchor kind；document/web 锚点在验证器存在前返回诚实的 `metadata` fragment。
- **无逐查询订阅失效**：`evidence/updated` 事件携带三个版本 token（materialStateDigest、headRevision、issuesRevision）；客户端去重并重查，但无服务端查询结果推送。
