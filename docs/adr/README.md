# 架构决策记录（ADR）

> Architecture Decision Records。记录「难以回退、影响多个模块」的决策**为什么**这么定，而不是「怎么实现」。

## 什么时候写 ADR

满足任一条才写，避免形式主义：

- 决策影响多个 issue / 模块，且选错后回退成本高（迁移、权限、数据模型）。
- 决策有多个可行替代方案，未来有人会问「当初为什么不选另一个」。
- 决策约束了后续接口或扩展边界（Core 契约、插件/主题边界）。

纯实现细节（字段类型、索引命名、函数拆分）不写 ADR，放设计稿或代码即可。

## 格式

每条 ADR 一个文件，命名 `NNNN-kebab-title.md`，采用精简 MADR：

- **Status**：Proposed ▶ / Accepted ✅ / Superseded 🔁 / Deprecated 🗑
- **Context**：背景与约束。
- **Decision**：选定方案。
- **Alternatives**：被否决的替代方案与否决理由。
- **Consequences**：后果，含正面、负面与后续工作。

ADR 一旦 Accepted 不在原地大改语义；要推翻就新写一条并把旧条标记 Superseded。

## 索引

| ADR | 标题 | 状态 | 相关 issue |
|---|---|---|---|
| [0001](0001-membership-lifecycle-model.md) | 会员生命周期模型：叠加时间窗 + 存储状态态 | Accepted ✅ | #4 #5 #6 |
| [0002](0002-audit-and-event-strategy.md) | 审计与事件策略：统一审计表 + 因果引用 | Accepted ✅ | #4 #6 #8 |
| [0003](0003-durable-task-and-outbox-boundary.md) | 持久化任务与 outbox 边界 | Accepted ✅ | #7 #9 |
| [0004](0004-publishing-workflow.md) | 文章发布工作流：派生调度态 + token fencing | Accepted ✅ | #9 |
| [0005](0005-auto-payments.md) | 自动收付款 + 可插拔支付服务商 | Accepted ✅ | v0.2 |
| [0006](0006-markdown-editor.md) | Markdown 内容编辑器 + 正文内联插图 | Accepted ✅ | v0.3 |
| [0007](0007-inline-video-playback.md) | 浏览器内视频播放：HTTP Range/206 + 内联播放器 | Accepted ✅ | v0.3 |
| [0008](0008-public-video-embeds.md) | 公开视频嵌入：provider 白名单 iframe | Accepted ✅ | v0.3 |
| [0009](0009-recurring-subscriptions.md) | 周期性会员：Stripe 自动续费 + 手动周期提醒 | Accepted ✅ | v1.0 |
| [0010](0010-grant-payment-concurrency.md) | 付款/会员授予并发：userId 串行 + pending 唯一 | Accepted ✅ | v1.0 |
| [0011](0011-upload-file-safety.md) | 上传文件安全：服务端权威 MIME + 强制重编码 + 文件响应隔离 | Proposed ▶ | v1.0 |
