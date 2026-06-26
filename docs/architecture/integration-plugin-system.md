# Integration 集成系统与 Plugin 插件系统架构

> ✅ 已实现｜🚧 后续计划

## 两者的区别

| | Integration 集成 | Plugin 插件 |
|---|---|---|
| 维护方 | 官方，随 Core 发布 | 第三方 / 社区（官方也可发布插件） |
| 形态 | 内置 adapter，由各自配置契约启用 | 独立安装的扩展包 |
| 边界 | 对接邮件、存储、人机验证、支付、翻译等外部服务 | 扩展页面、能力或新业务 |
| 状态 | 统一注册表、状态、连接测试和 readiness 摘要 ✅ | Phase 8 尚未实现 🚧 |

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
- SMTP 发送测试邮件；S3/R2 执行随机对象 Put/Get/Delete；Stripe 校验当前服务端配置/连接；Translation 的可用性按其配置和 provider 行为暴露。
- `testableIntegrationIds` 只表示 adapter 具备测试能力；UI 仍按 `configured`、driver 和 enabled 决定按钮状态。
- local storage、Turnstile 和 Tunnel 不伪造无意义的网络测试。

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

该抽象是 Core 私有实现，不是 Plugin hook。第三方扩展点与权限模型留到 Phase 8，避免提前固化不安全 API。

## Plugin（后期扩展机制）🚧

Phase 8 设计原则：

1. 插件在不修改 Core 的前提下扩展功能，Core 只暴露稳定、最小的能力接口。
2. 插件声明权限，不能绕过下载鉴权、会员判定、审计、请求体上限或配置加密。
3. 插件故障可隔离、可禁用，不能阻塞登录、人工付款或内容读取主链路。
4. 安装、升级、回滚和数据迁移必须有明确生命周期。

## Hub 聚合发现平台 🚧

- Hub 不进入 Core，与单创作者自托管定位正交。
- 未来作为官方 Plugin 实现（Phase 9），由创作者自愿安装并决定公开信息。
