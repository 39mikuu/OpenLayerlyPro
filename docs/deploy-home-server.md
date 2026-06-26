# 家庭服务器部署指南

适用于 NAS、小主机、PVE 虚拟机、闲置电脑等环境。

## 1. 安装 Docker

请按照 [Docker 官方安装文档](https://docs.docker.com/engine/install/) 完成 Docker Engine 与 Docker Compose 安装。

## 2. 获取项目并配置

```bash
git clone https://github.com/39mikuu/OpenLayerlyPro.git
cd OpenLayerlyPro
cp .env.example .env
```

编辑 `.env`，至少配置强随机 `SESSION_SECRET` 与可用 SMTP：

```env
SESSION_SECRET=replace-with-a-strong-random-value
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_smtp_user
SMTP_PASSWORD=your_smtp_password
SMTP_FROM="Artist Site <no-reply@example.com>"
```

> SMTP 是粉丝验证码登录的必要条件。建议同时修改 `docker-compose.yml` 中 PostgreSQL 的默认密码，并同步更新 `DATABASE_URL`。

### 认证限流与可信 IP

- 应用默认只适合**单实例**运行进程内限流。多个 app 副本会各自计数，v1.0 尚未提供共享 Redis/PG limiter。
- 使用 Cloudflare Tunnel/CDN 时，推荐 `TRUSTED_PROXY_HEADER=cf-connecting-ip`；自建反代使用 `x-forwarded-for` 并设置准确的 `TRUSTED_PROXY_HOPS`。
- 若应用无法解析可信客户端 IP，`admin-login`、`request-code`、`verify-code` 会退回各操作专用的 unresolved emergency 桶；这不会影响 resolved-IP 用户，但 unresolved 用户之间仍共享计数。生产环境应优先修复可信 IP 解析。
- 请检查 auth rate-limit、验证码长度/字母表与 dedupe env；所有值都有边界，越界会启动失败。S4 认证限流语义见 [S4 handoff](handoff/harden-s4-auth-rate-limiting.md)。
- 登录码采用持久投递 fence：已有 active code 的任务处于 `pending` / `processing` / `failed` 时，同邮箱的新请求仍统一返回受理但不会创建新 code，最长抑制到 10 分钟 TTL；任务为 `succeeded` / `dead` 后才按 60 秒 dedupe 决定是否创建更新 code。
- 登录码 SMTP 调用发生在数据库短事务和 per-email advisory lock 释放后。应用保证 stale claim 在发信前 no-op、SMTP 开始时 code 仍为最新有效 code；worker 在 SMTP 成功后、任务标记 succeeded 前崩溃，可能造成同一码 at-least-once 重复投递。外部邮箱最终到达/展示顺序不受应用控制。
- `SESSION_SECRET` 也用于派生在途登录码 task 的加密密钥。轮换后，尚未投递的旧任务会解密失败并进入永久失败，用户需重新请求；code TTL 仅 10 分钟。未来 S5 email reliability 设计必须继承该轮换语义。

## 3. 启动

```bash
docker compose up -d
docker compose logs -f app
```

容器启动时由 entrypoint 执行数据库迁移。迁移失败时应用不会启动，日志会显示原因。访问 `http://服务器IP:3000` 完成站点初始化。

> 内容附件通过 raw-body 接口流式写入 local 或 S3/R2；图片与付款截图仍会缓冲以校验尺寸。`MAX_UPLOAD_SIZE_MB` 是流式实测上限。S3 multipart 每次上传采用 8 MiB × 2 路并发，并应在 bucket 上配置中止未完成 multipart upload 的生命周期规则。S3/R2 可在后台系统配置中设置，环境变量继续作为回退来源。

## 4. 公网访问

无公网 IP 推荐使用 [Cloudflare Tunnel](deploy-cloudflare-tunnel.md)；有公网 IP 见 [公网 VPS + 反向代理部署](deploy-vps.md)。

使用自建反向代理时，应设置正确的 `TRUSTED_PROXY_HOPS`，并确保应用端口不直接暴露到公网。

## 5. 数据备份

至少备份：

- PostgreSQL 数据库
- local 存储模式下的 uploads volume
- `/app/secrets/config-encryption-key` 或对应 secrets volume

使用 S3/R2 存储时，文件位于对象存储中，但数据库和配置加密密钥仍需备份。

## 6. 升级版本

```bash
git pull
docker compose build app
docker compose up -d
```

升级前应先备份数据库、上传文件和配置加密密钥。升级后重新检查 `/api/ready`、可信 IP 解析、Turnstile、验证码发送和登录流程。
