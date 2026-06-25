# Core 单站系统架构

> ✅ 已实现｜🚧 计划中

## 定位

Core 是 OpenLayerlyPro 的不可拆卸核心：不依赖任何主题、集成或插件，独立完成「粉丝付费 → 审核 → 开通会员 → 权限下载」主闭环。

## Core 的职责边界

Core 负责且仅 Core 负责：

| 职责 | 说明 | 状态 |
|---|---|---|
| 会员 | 会员等级、有效期、审核通过自动开通 | ✅ |
| 内容 | 作品发布、public / login / member 三级可见性 | ✅ |
| 文件 | 上传、local / S3 双驱动、按文件记录的 storageDriver 读取与删除 | ✅ |
| 下载鉴权 | 所有下载经权限校验与日志记录，S3 走短时签名 URL | ✅ |
| 付款审核 | 收款码、付款截图、人工审核（原子化状态流转） | ✅ |
| Session | HMAC 会话令牌、Cookie 管理 | ✅ |
| 配置加密 | 根密钥生成 / 持久化 / 读取 ✅；加密 settings 表 🚧 | 部分 |
| 审计 | 应用事件记录（登录、审核等）✅；完整审计体系 🚧 | 部分 |

不属于 Core 的：表现层细节（Theme）、第三方服务对接的统一抽象（Integration）、第三方扩展（Plugin）、聚合发现（Hub，未来官方插件）。

## 代码结构（现状）

```txt
src/
├── app/                 # Next.js App Router：页面 + API route（route 只做解析/响应，不写业务）
│   └── api/             # /api/auth/*、/api/admin/*、/api/health、/api/ready 等
├── components/          # React 组件（当前内置极简主题的表现层）
├── modules/             # 业务模块（Core 业务逻辑所在地）
│   ├── auth/            # login-code（验证码）、admin-login、session
│   ├── content/         # 内容
│   ├── membership/      # 会员
│   ├── payment/         # 付款审核
│   ├── file/ storage/   # 文件与存储驱动（local / s3）
│   ├── download/        # 下载日志
│   ├── security/        # turnstile（人机验证）、config-key（配置加密根密钥）
│   ├── system/          # status、readiness、events
│   └── user/ site/      # 用户、站点配置
├── lib/                 # env（zod 校验）、api（统一响应/错误）、crypto、rate-limit、logger
└── db/                  # Drizzle schema、迁移、连接
```

## 关键约定

1. **route handler 不承载业务**：API route 只做请求解析、调用 modules、统一响应（`jsonOk` / `handleApiError`）。
2. **统一错误模型**：业务错误抛 `ApiError(status, message)`，响应格式 `{ ok, data | error }`。
3. **env 集中校验**：所有环境变量经 `src/lib/env.ts` 的 zod schema 进入应用；生产环境运行时强校验（如 SESSION_SECRET），`next build` 阶段跳过。
4. **存储驱动按文件记录**：切换 `STORAGE_DRIVER` 不迁移历史文件，读取与删除按 `files` 表记录的驱动执行。
5. **敏感信息不落日志**：密钥、token、验证码原文、raw email 不输出。
6. **限流**：当前底层实现是进程内滑动窗口。bucket 按自身窗口清理，并有最大 bucket 数保护。多实例部署仍需未来外置共享 limiter；v1.0 仅做告警、文档与策略接缝。

## 登录安全与真实 IP

### 当前已实现

- 邮箱验证码使用 HMAC 哈希入库，不保存明文验证码。
- 验证码成功后一次性使用；当前校验过程在数据库事务内完成。
- Turnstile 开启后，会在调用 Cloudflare Siteverify 前执行保护逻辑。
- 真实 IP 只来自已配置可信代理层。默认不信任 `X-Forwarded-For`；Cloudflare 推荐 `cf-connecting-ip`，常规反代使用 `x-forwarded-for` + 正确 hops。

### S4 目标语义（尚未实现）🚧

- **正确码优先**：任何失败计数或 wrong-attempt limiter 都不得在比较正确码前返回 429。
- **错误后限流**：verify 的 IP、email+IP、unresolved 桶只在核心确认错误后记账；正确码不消费也不受这些桶影响。
- **高熵验证码**：默认至少 9 位 uppercase Crockford base32；生成、规范化、API schema、UI、i18n 与测试同源。
- **request-code 无纯 email 阻断**：删除纯 email 小时 429 与 cooldown；保留 IP 主门禁、真实发送 email+IP 预算、非阻断并发安全 dedupe。
- **email identity**：先 `trim().toLowerCase()`，再使用 keyed HMAC-SHA-256 派生 limiter/dedupe key；`hashtext` 只可用于 advisory lock 槽位。
- **投递一致性**：同一 email 并发只允许一码一封；code 与 durable task/outbox 原子创建，或同步 SMTP 失败可靠补偿。

权威实施规范见 [../handoff/harden-s4-auth-rate-limiting.md](../handoff/harden-s4-auth-rate-limiting.md)。在实现 PR 合并前，上述 S4 条目不得标记为已实现。

## 配置加密（Phase 1 铺垫）

- 根密钥来源优先级：`CONFIG_ENCRYPTION_KEY` 环境变量 > `CONFIG_ENCRYPTION_KEY_FILE` 文件（Docker 首启自动生成，权限 600，持久化到 secrets volume）。✅
- 读取入口：`src/modules/security/config-key.ts`。✅
- 加密 settings 表与配置中心后台：Phase 2。🚧
- 运维红线：迁移服务器必须备份密钥文件 / volume；密钥丢失则未来加密配置无法解密。