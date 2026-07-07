# Deployment & Network Edge 部署与网络边缘架构

> ✅ 已实现｜▶ v1.0 当前硬化｜🚧 后续计划

## TLS 边界原则

**App 本身不直接处理 TLS。** 应用容器只监听 HTTP（3000 端口），TLS 终止交给前置层：

- Cloudflare Tunnel（无公网 IP）✅
- Caddy / Traefik / Nginx 反向代理（见 [deploy-vps.md](../deploy-vps.md)）✅
- CDN（见 [deploy-cdn.md](../deploy-cdn.md)）✅

应用不管理证书；更换边缘方案不改变 Core 权限与支付语义。

## 支持的部署形态 ✅

```txt
浏览器 → Cloudflare/CDN/TLS → Tunnel 或反向代理 → app(:3000) → postgres
                                                       └── uploads / secrets
```

- `docker-compose.yml`：app + postgres，使用 `postgres_data`、`uploads`、`secrets` volume。
- `docker-compose.tunnel.yml`：叠加 cloudflared。
- `docker-compose.caddy.yml` + `docker/Caddyfile`：Caddy 自动 TLS。
- entrypoint：准备目录/配置加密密钥 → forward migration → 启动 Next.js；迁移失败不服务。

## 健康检查 ✅

| 接口 | 用途 | 行为 |
|---|---|---|
| `GET /api/health` | liveness | 进程存活即 200，不依赖外部集成 |
| `GET /api/ready` | readiness | 检查数据库、基础配置和配置加密密钥；失败 503，不暴露 secret |
| `GET /api/ready?integrations=true` | 信息性集成摘要 | 附带 `{id,enabled,healthy}`；不改变 200/503 门禁，探测失败可省略 |

## 配置与秘密的运维 ✅

- 首次启动可生成 `/app/secrets/config-encryption-key`（权限 600），持久化到 `secrets` volume。
- 迁移/恢复服务器必须保留配置加密根密钥；丢失后 `app_settings` 密文不可解密。
- `SESSION_SECRET` 是独立秘密：轮换会使会话失效，并使部分在途加密登录码任务不可解密。
- S3/R2、SMTP、Stripe、Turnstile、Translation 等 secret 不应经过代理头、浏览器变量或日志传播。

## 反向代理与 CDN ✅

- 公网 VPS + 反代：[deploy-vps.md](../deploy-vps.md)。
- CDN 接入：[deploy-cdn.md](../deploy-cdn.md)。
- 代理必须保留视频 `Range` 请求以及应用的 206/416、`Content-Range`、`Accept-Ranges`。
- 不得把 private/no-store 下载响应改写为公开缓存。
- 信任单值真实 IP 头时，源站端口不能绕过边缘直接暴露。

## 真实客户端 IP 解析 ✅

`getClientIp` 只信任显式配置的代理层：

- `TRUSTED_PROXY_HOPS`（默认 `0`）：应用前可信且会追加/覆盖 XFF 的代理层数。
- `TRUSTED_PROXY_HEADER`：`x-forwarded-for`、`x-real-ip`、`cf-connecting-ip` 或 `true-client-ip`。

规则：

- XFF 模式取右数第 N 个可信条目；`HOPS=0` 或条目不足返回 `null`，绝不退回客户端可控最左值。
- 单值头只有在源站不直接暴露、且边缘会覆盖该头时安全。
- Cloudflare Tunnel/CDN 推荐 `cf-connecting-ip`；常规反代使用 XFF + 准确 hops。

无法解析可信 IP 时：

- 不落到低阈值全局 `unknown` 桶；
- admin login、request code、verify code、上传/下载等使用各操作独立的 unresolved emergency bucket；
- unresolved 客户端之间仍共享对应操作桶，这是代理配置错误时的降级风险；
- S4 verify 只在核心确认错误后记账，正确码不受 wrong-attempt 桶阻断；
- 生产记录限频告警，提示运维修复代理配置。

S4 已由当前运行时实现，权威语义见 [../handoff/harden-s4-auth-rate-limiting.md](../handoff/harden-s4-auth-rate-limiting.md)。

## 进程内限流与多实例边界

当前 limiter 是单进程内存状态：

- 单 app 实例可按既定策略使用；
- 多个副本各自计数，攻击者可在副本间分散请求；
- v1.0 不实现 Redis/PG 共享 limiter；部署与 readiness 应提示多实例风险；
- key/阈值集中定义，保留未来 adapter 接缝。

## v1.0 网络安全状态

### S6 #86 ✅

- HTML 文档 per-request nonce CSP 与全局安全响应头；
- Turnstile、实际 S3 signed URL origin、视频和 public integration 来源单一派生；
- HSTS 仅显式 HTTPS 部署开启；
- legacy custom footer 迁移，不能通过 `unsafe-inline` 或 wildcard 保活。
- Next.js 客户端导航存在无法携带 nonce 的 style 属性，因此仅
  `style-src` 使用 `'self' 'unsafe-inline'` 兼容退路；`script-src`
  仍强制 per-request nonce，生产环境无 `unsafe-inline` / `unsafe-eval`。

### S7 #87 ✅

- 恢复前兼容检查、one-off migrator/file-safety backfill/neutralization/convergence 均已实现；
- 正常 app/dispatcher 在恢复一致性完成前保持停止；
- #88 在隔离的 local/S3 Compose 演练中验证已实现的 S7 流程。

## Phase 10 及以后 🚧

- 多实例负载均衡与滚动发布。
- 共享限流、任务协调、会话/缓存一致性和无单点数据库/对象存储策略。
