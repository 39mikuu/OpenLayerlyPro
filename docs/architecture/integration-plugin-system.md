# Integration 集成系统与 Plugin 插件系统架构

> ✅ 已实现｜🚧 计划中

## 两者的区别

| | Integration 集成 | Plugin 插件 |
|---|---|---|
| 维护方 | 官方，随 Core 发布 | 第三方 / 社区（官方也可发布插件） |
| 形态 | 内置代码，配置开关启用 | 独立安装的扩展包 |
| 边界 | 对接外部服务（邮件、存储、人机验证等） | 扩展功能（页面、能力、对接） |
| 状态 | 统一状态抽象 + 连接测试 ✅，启停 🚧 | 完全未实现 🚧 |

## Integration（官方内置集成）

当前官方集成：

- SMTP 邮件（nodemailer）✅
- S3 / R2 对象存储 ✅
- Cloudflare Turnstile 人机验证 ✅
- Cloudflare Tunnel（compose 层）✅

### 统一抽象（第一步：注册表 + 状态检测）✅

`src/modules/integration/` 提供 Core 内部使用的统一契约：

- `Integration`：官方集成描述符，包含稳定 id、类型与异步 `getStatus()`。
- `IntegrationStatus`：只返回 `configured`、`enabled`、`source`、可选 driver / error 等结构化信号，不包含展示文案。
- 注册表按 SMTP → Storage → Turnstile → Tunnel 的稳定顺序收敛状态；单项读取失败会降级为 `error`，不会让整个系统状态页失败。
- SMTP、Storage、Turnstile 复用 Phase 2 配置中心的 admin view，不复制配置优先级或密钥判断逻辑。
- Tunnel 没有应用内配置行为，作为 `deployment` 类型只读检查 `CLOUDFLARE_TUNNEL_TOKEN`，继续由 `docker-compose.tunnel.yml` 管理。
- 后台 `/admin/system` 根据结构化信号统一组装名称、状态、来源和详细说明。

Integration 状态是信息性状态，**绝不进入 `/api/ready` 门禁**——readiness 的 200/503 只取决于 database、基础 config 与 encryption key，因为 Core 必须在所有可选集成关闭或未配置时仍能运行。

### 连接测试契约（第二步）✅

- `Integration` 描述符新增可选 `test(ctx)`：解析成功即通过，失败抛错（`ApiError`/`Error`，交由 `handleApiError`）；不实现该方法即「不可测试」。
- SMTP 复用 `sendTestEmail`（发到触发测试的管理员邮箱），Storage 复用 `testS3Connection`（S3/R2 Put/Get/Delete 闭环）；不重写底层测试逻辑、不改 mail/storage 行为。
- 统一端点 `POST /api/admin/integrations/[id]/test`（`requireAdmin`）：未知 id、Turnstile、Tunnel（均无 `test()`）一律返回 `400「该集成不支持连接测试」`。
- `testableIntegrationIds` 由描述符是否实现 `test()` 派生，**仅表示「类型具备测试能力」**；UI（系统状态页、SMTP/存储配置页的通用 `IntegrationTestButton`）仍结合 `configured` / `driver` 决定是否显示或启用。Storage 的 `test()` 当前仅覆盖 S3/R2，local 可写性仍由 `getStatus()` 表达，不新增 local 测试入口。

### 可选 readiness 探测（第三步）✅

- `/api/ready?integrations=true` 附带各集成的粗粒度探测 `{ id, enabled, healthy }`（`healthy = 未启用或已配置且无 error`），不含 driver / source / secret，与现有 `checks` 同级、供监控观测。
- 默认 `/api/ready` 行为零变化（不查集成、不新增字段）；集成健康**不参与** 200/503 判定，探测失败也只是静默省略字段。

### 后续步骤 🚧

- 统一启停开关（当前仅 Turnstile 有真正可切换开关且已实现，降级为按需）。

该抽象是 Core 私有实现，不是 Plugin hook。第三方扩展点与权限模型留到 Phase 8 设计，避免提前固化插件 API。

## Plugin（后期扩展机制）🚧

设计原则（Phase 8 细化）：

1. 插件在不修改 Core 的前提下扩展功能；Core 提供稳定的扩展点（hook / API），不向插件暴露内部实现细节。
2. 插件有明确权限边界：声明所需能力，不能绕过 Core 的下载鉴权、会员判定与审计。
3. 插件故障不得破坏主闭环：加载失败应可隔离、可禁用。

## Hub 聚合发现平台 🚧

- **Hub 不进入 Core**。它是跨站点的聚合发现能力，与"单创作者自托管"的 Core 定位正交。
- 未来作为**官方插件**实现（Phase 9），由创作者自愿安装、自愿决定向 Hub 公开哪些信息。
