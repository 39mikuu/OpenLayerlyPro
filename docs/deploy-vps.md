# 公网 VPS + 反向代理部署指南

适用于有公网 IP 的 VPS。使用 Caddy、Nginx、Traefik 等反向代理提供 HTTPS，并将请求转发到应用容器。

## 获取项目

```bash
git clone https://github.com/39mikuu/OpenLayerlyPro.git
cd OpenLayerlyPro
cp .env.example .env
```

## 部署要点

1. 按 `.env.example` 配置站点地址、数据库、SMTP 与安全参数。
2. 使用强随机 `SESSION_SECRET`，并单独备份它与配置加密根密钥。
3. 只向公网开放 HTTPS 入口，不直接暴露 app:3000。
4. 单层反向代理通常使用 `TRUSTED_PROXY_HEADER=x-forwarded-for` 与 `TRUSTED_PROXY_HOPS=1`。
5. 只有源站不能被绕过时才信任 `x-real-ip`、`cf-connecting-ip` 等单值头。
6. 代理请求体上限是第二层保护；应用的实际字节上限仍是权威边界。
7. 代理必须转发视频 `Range` 请求，并保留应用返回的 200/206/416、`Content-Range` 与 `Accept-Ranges`。
8. 不要缓存 `/api/*`、`/admin/*`、登录、private/no-store 文件或私有视频代理响应。
9. 当前 v1.0 运行边界是单 app 实例；多副本没有共享 limiter。

## Caddy Overlay

仓库提供 Caddy 部署文件：

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

设置 `APP_DOMAIN`、正确可信 hop，并用防火墙限制 app 端口。Caddy 负责 TLS，应用仍只监听 HTTP。

## 验证

- 站点可通过 HTTPS 访问；
- `/api/health` 与 `/api/ready` 返回成功；
- app 端口无法从公网直接访问；
- 登录、上传、下载日志能解析正确客户端 IP；
- local/S3 视频 seek 返回正确 Range 响应；
- private 下载不被代理/CDN公开缓存；
- DB 配置的 Turnstile、Storage、Stripe 和 SMTP 状态与后台一致。

S6 #86 实现后，还必须在真实浏览器验证 nonce CSP、DB-enabled Turnstile、实际 signed storage origin、视频与 public integration；不得在代理层加入宽泛或与应用冲突的 CSP。

## 备份与升级

升级或迁移前必须保护：数据库、local uploads、配置加密根密钥、`SESSION_SECRET`，以及 S3/R2 的匹配恢复点。

不要用简单的 `git pull && docker compose up` 代替升级流程。当前升级需要停 app、报告/处理 duplicate pending payments、运行 one-off migrator 和 mandatory file-safety backfill。完整步骤：

- [备份与恢复](deployment/backup-restore.md)
- [升级指南](deployment/upgrade.md)
- [生产检查清单](deployment/production-checklist.md)
- [v1.0 最终验收](release-v1.0-checklist.md)
