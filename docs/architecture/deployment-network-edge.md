# Deployment & Network Edge 部署与网络边缘架构

> ✅ 已实现｜🚧 计划中

## TLS 边界原则

**App 本身不直接处理 TLS。** 应用容器只监听 HTTP（3000 端口），TLS 终止交给前置层：

- Cloudflare Tunnel（无公网 IP 可用）✅
- Caddy / Traefik / Nginx 反向代理（自动 SSL）✅（见 [deploy-vps.md](../deploy-vps.md)）
- CDN（Cloudflare 等）✅（见 [deploy-cdn.md](../deploy-cdn.md)）

这样应用无需管理证书，更换边缘方案不影响 Core。

## 当前部署形态 ✅

```txt
浏览器 → Cloudflare（TLS）→ Tunnel → app 容器(:3000) → postgres 容器
                                         └── uploads / secrets volume
```

- `docker-compose.yml`：app + postgres，volume：`postgres_data`、`uploads`、`secrets`
- `docker-compose.tunnel.yml`：叠加 cloudflared
- entrypoint 顺序：准备 uploads / 配置加密密钥文件 → 数据库迁移（失败不启动）→ 启动应用

## 健康检查 ✅

| 接口 | 用途 | 行为 |
|---|---|---|
| `GET /api/health` | 存活探针（liveness） | 进程存活即 200，不依赖外部服务 |
| `GET /api/ready` | 就绪探针（readiness） | 检查数据库连接、配置可读、配置加密密钥可用；任一失败返回 503，不暴露 secret。可选 `?integrations=true` 附带集成粗粒度探测（信息性，不影响 200/503） |

供反向代理、容器编排与未来负载均衡探活使用。

## 配置加密密钥的运维 ✅

- 首次启动自动生成 `/app/secrets/config-encryption-key`（权限 600），持久化到 `secrets` volume，重启不变。
- **迁移服务器必须备份该文件或 volume；丢失后未来加密配置无法解密。**

## 反向代理与 CDN ✅

```txt
浏览器 →（可选 CDN/TLS）→ 反向代理(Caddy/Nginx/Traefik, TLS) → app 容器(:3000) → postgres
                                                                  └── uploads / secrets volume
```

- 公网 VPS + 反代（自动 SSL）：[deploy-vps.md](../deploy-vps.md)；内置 `docker-compose.caddy.yml` + `docker/Caddyfile`（Caddy 自动签发 Let's Encrypt 证书）。
- CDN 接入：[deploy-cdn.md](../deploy-cdn.md)。

## 真实客户端 IP 解析 ✅

`getClientIp`（`src/lib/api.ts`）**只信任已配置的代理层**，由两个环境变量驱动：

- `TRUSTED_PROXY_HOPS`（默认 `0`）：应用前可信、且会追加/覆盖 `X-Forwarded-For` 的代理层数。
- `TRUSTED_PROXY_HEADER`（白名单 enum，默认 `x-forwarded-for`）：可选 `x-real-ip` / `cf-connecting-ip` / `true-client-ip`。

规则：
- `x-forwarded-for` 模式：取列表「右数第 HOPS 个」（标准 trust-N-hops）。`HOPS=0` 或列表长度不足时返回 `null`（默认不信任、失败即安全，绝不退回客户端可控的最左条目）。
- 单值头模式：直接返回该头的值；**仅当源站不直接暴露、只接受可信边缘流量时才安全**。

真实 IP 会被登录验证码、Turnstile、下载和上传等限流/审计路径使用。Cloudflare Tunnel / Cloudflare CDN 推荐 `TRUSTED_PROXY_HEADER=cf-connecting-ip`；常规反向代理使用 `TRUSTED_PROXY_HEADER=x-forwarded-for` 并设置准确的 `TRUSTED_PROXY_HOPS`。未配置可信代理头时，应用无法做精确 per-IP 限流；Turnstile 会避免所有未知 IP 共享低阈值桶，退回较高阈值的全局 Siteverify 保护。
- 解析出的 IP 用于按 IP 限流与审计记录（`sessions` / `loginCodes` / `downloadLogs` 已落 IP）。默认 `HOPS=0` 时 IP 不可用，按 IP 限流自动跳过（按邮箱 / 用户的限流不受影响）。

## Phase 10 及以后 🚧

- 多实例负载均衡与高可用（进程内限流 / 会话等状态外置为前提）。
