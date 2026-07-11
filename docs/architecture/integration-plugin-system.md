# Integration 集成系统架构

> ✅ 已实现｜🚧 后续计划

## 产品决策：不规划通用 Plugin runtime

OpenLayerlyPro 不再规划通用第三方 Plugin runtime。原因是插件加载、生命周期、权限边界、故障隔离、版本兼容和安全审计都会显著增加项目难度，不符合当前单创作者自托管产品主线。

后续扩展优先采用两类方式：

- **官方内置集成（Integration）**：邮件、存储、人机验证、支付、统计、翻译等外部服务 adapter 随 Core 发布，由项目维护。
- **官方内置功能**：主题、SEO、邮件通知、内容组织、运营分析、Core Auth 和会员权益等产品能力直接进入 Core / Theme / Integration 路线图，按普通功能验收。

Hub / 聚合发现能力暂不规划；未来只有在真实运营证明需要跨站发现时，再作为独立产品方向重新评估。

## Integration（官方内置集成）

当前官方集成：

- SMTP 邮件（nodemailer）✅
- local / S3 / Cloudflare R2 / MinIO 存储 ✅
- Cloudflare Turnstile 人机验证 ✅
- Cloudflare Tunnel（compose 部署层）✅
- Stripe 一次性付款与订阅 ✅
- OpenAI-compatible Translation provider ✅

### 统一抽象：注册表与状态 ✅

`src/modules/integration/` 提供 Core 内部契约：

- `Integration` 描述符包含稳定 id、类型、异步 `getStatus()` 和可选 `test()`。
- `IntegrationStatus` 只返回 `configured`、`enabled`、`source`、可选 driver/error 等结构化信号，不包含 secret 或展示文案。
- 注册表使用稳定顺序收敛状态；单项读取失败降级为 `error`，不让整个系统状态页失败。
- SMTP、Storage、Turnstile、Stripe、Translation 复用各自 config admin view，不复制密钥判断或启用逻辑。
- Tunnel 是 `deployment` 类型，只读 compose/env 状态，不在应用内启停。
- `/admin/system` 根据结构化信号组装名称、状态、来源和说明。

Integration 状态是信息性的，**不进入 `/api/ready` 的 200/503 门禁**。Core 必须在所有可选集成关闭或未配置时仍能用人工付款、本地存储和内置能力启动。

### 连接测试契约 ✅

- 描述符实现 `test(ctx)` 才表示可测试；失败抛统一错误，不实现则返回“该集成不支持连接测试”。
- 统一端点：`POST /api/admin/integrations/[id]/test`，要求管理员身份。
- 当前可测试 adapter 只有：SMTP（发送测试邮件）、S3/R2 Storage（随机对象 Put/Get/Delete）和 Stripe（服务端连接检查）。
- Translation 目前只提供配置/状态与由管理员显式触发的真实生成调用，没有独立连接测试；Turnstile、Tunnel 与 local storage 也不伪造无意义的网络测试。
- `testableIntegrationIds` 由描述符是否实现 `test()` 静态派生；UI 仍结合 `configured`、driver 和 enabled 决定按钮状态。

### 可选 readiness 探测 ✅

- `/api/ready?integrations=true` 附带 `{ id, enabled, healthy }` 粗粒度摘要，不包含 driver、source 或 secret。
- 默认 `/api/ready` 不查集成；摘要失败只会省略字段，不改变就绪结果。

### 启停语义

不强制所有 Integration 共享一个虚假的总开关：

- Turnstile、Stripe、Translation 有明确 `enabled` 配置；
- Storage 通过 active driver 选择；
- SMTP 由最终配置是否完整决定；
- Tunnel 由部署拓扑决定。

未来只有出现真实统一需求时才增加通用启停 UI；不得绕过各 adapter 的配置校验。

### 安全边界

- Integration 不能自行授予会员、公开文件或修改发布状态；必须调用 Core service。
- secret 只在服务端配置层解密，不进入状态 API、日志或前端。
- Stripe webhook 必须验签并持久化 provider event；Translation 必须 requireAdmin 且访客不可触发成本。
- 连接测试不得在失败后留下临时对象、付款或公开副作用。

该抽象是 Core 私有实现，不是第三方扩展点。不要把 Integration 注册表设计成插件 hook，也不要提前固化外部扩展 API。
