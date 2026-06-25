# OpenLayerlyPro

开源、自托管、单画师会员站系统。

OpenLayerlyPro helps independent illustrators and creators run their own membership site: publish posts, offer membership tiers through manual review or Stripe hosted one-time checkout, and deliver member-only files from a self-hosted deployment.

Current status: **v0.2.0 release candidate / final acceptance**. The code scope is complete; operators should finish the real-environment checks in [the v0.2.0 acceptance checklist](docs/release-v0.2-checklist.md) before creating a production release tag. The project is intended for technical self-hosters who can operate Docker Compose, PostgreSQL, SMTP, storage, payments, and backups.

## 核心特性

- 开源自托管
- 单画师 / 单创作者会员站
- 管理员邮箱 + 密码登录
- 粉丝邮箱验证码登录
- 人工审核收银台
- 收款码配置、付款截图上传与审核
- Stripe 托管一次性 Checkout（可选，卡支付）
- 签名 webhook 事务化确认付款、开通会员并写入 durable outbox
- 审核通过或自动支付确认后开通会员并发送邮件
- `public` / `login` / `member` 三级内容权限
- 首页限量与作品列表 keyset 游标分页
- 高清图、PSD、ZIP、笔刷包与 `mp4` / `webm` / `mov` / `m4v` 视频附件下载
- 内容附件 raw-body 流式上传、流式 SHA-256 与大小统计
- 本地文件存储（`.part` + 原子重命名）
- S3 / Cloudflare R2 对象存储与有界 multipart 上传（可选）
- 下载权限控制与下载记录
- zh / en / ja UI i18n
- 内容多语言与 AI 辅助翻译草稿（默认关闭，管理员手动触发）
- 自定义站点 logo / icon
- 管理员可信自定义页脚代码
- Docker Compose 部署
- Cloudflare Tunnel 支持，无公网 IP 家庭服务器友好

## 适合谁

- 想自托管单画师或单创作者会员站的个人创作者。
- 想采用收款码人工审核、Stripe 一次性付款，或同时保留两种方式的创作者。
- 能维护 Docker Compose、PostgreSQL、SMTP、反向代理、对象存储、支付 webhook 和备份的自托管用户。

## 非目标

当前版本不包含：

- 多画师入驻平台
- 内容广场或推荐流
- 评论、点赞、收藏、关注
- 自动续费或订阅
- 退款 / chargeback 自动联动与后台 reconciliation
- OAuth 或粉丝密码注册
- 插件 runtime 或主题市场
- local HTTP Range/206 与完整视频媒体处理（封面、时长、缩略图、转码）
- 移动 App

## 快速启动

```bash
git clone https://github.com/39mikuu/OpenLayerlyPro.git
cd OpenLayerlyPro
cp .env.example .env
# 编辑 .env：至少修改 SESSION_SECRET，并配置 SMTP

docker compose up -d
```

容器启动时会先执行数据库迁移；迁移失败时应用不会启动。可通过以下命令排查：

```bash
docker compose logs app
```

访问：

```txt
http://localhost:3000
```

首次访问会进入 `/admin/setup` 初始化页面，填写站点名称、创作者信息和管理员账号即可完成搭建。

## 核心闭环

```txt
创作者初始化站点 → 配置 SMTP / 存储 → 配置收款码和/或 Stripe → 创建会员等级 → 发布会员作品
粉丝邮箱验证码登录 → 选择会员等级 → 上传付款截图，或进入 Stripe 托管 Checkout
创作者人工审核，或签名 webhook 自动确认 → 系统事务化开通会员并入队邮件 → 粉丝按权限访问和下载内容
```

## Cloudflare Tunnel 部署

适用于无公网 IP 的家庭服务器、NAS、小主机或 PVE 虚拟机。

1. 在 Cloudflare Zero Trust 创建 Tunnel 并获取 Token。
2. 将 Public Hostname 指向 `http://app:3000`。
3. 在 `.env` 中配置：

```env
APP_URL=https://your-domain.example
CLOUDFLARE_TUNNEL_TOKEN=...
TRUSTED_PROXY_HEADER=cf-connecting-ip
TRUSTED_PROXY_HOPS=1
```

4. 启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```

详见 [Cloudflare Tunnel 部署指南](docs/deploy-cloudflare-tunnel.md)。

## 公网 VPS + 反向代理

使用 Caddy、Nginx 或 Traefik 终止 TLS，并将流量转发到应用容器。

仓库提供 Caddy overlay：

```bash
# .env 设置 APP_DOMAIN=你的域名、TRUSTED_PROXY_HOPS=1
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

详见：

- [公网 VPS + 反向代理部署](docs/deploy-vps.md)
- [CDN 接入](docs/deploy-cdn.md)
- [生产检查清单](docs/deployment/production-checklist.md)

## 关键环境变量

完整列表见 [.env.example](.env.example)。

| 变量 | 说明 |
|---|---|
| `APP_URL` | 站点对外地址 |
| `SESSION_SECRET` | 生产必须设置为强随机值，否则应用拒绝启动 |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `SMTP_HOST` / `SMTP_FROM` 等 | SMTP 邮件配置，粉丝验证码登录必需 |
| `STORAGE_DRIVER` | `local`（默认）或 `s3` |
| `REQUEST_JSON_MAX_BYTES` | JSON 请求体传输上限（默认 64 KiB） |
| `STRIPE_WEBHOOK_MAX_BYTES` | Stripe webhook 原始请求体上限（默认 256 KiB） |
| `MAX_UPLOAD_SIZE_MB` | 内容附件上传上限 |
| `PAYMENT_PROOF_MAX_SIZE_MB` | 付款截图/收款码文件上限（1–100 MiB） |
| `TRUSTED_PROXY_HOPS` / `TRUSTED_PROXY_HEADER` | 可信代理和真实客户端 IP 配置 |
| `TURNSTILE_ENABLED` | 是否开启 Cloudflare Turnstile |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Turnstile 密钥对 |
| `CONFIG_ENCRYPTION_KEY` / `CONFIG_ENCRYPTION_KEY_FILE` | 后台敏感配置加密根密钥 |

Stripe and AI translation provider settings are configured in the admin settings UI and stored encrypted. Do not place provider API keys or webhook secrets in `NEXT_PUBLIC_*` variables.

## 安全配置

### SESSION_SECRET

生产环境必须设置长度足够的随机值：

```bash
openssl rand -base64 32
```

`SESSION_SECRET` 不会自动生成。Docker 自动生成的是配置加密根密钥，两者用途不同。

### Turnstile 与真实 IP

验证码有尝试次数上限，成功后一次性失效。开启 Turnstile 后，服务端会在发送验证码前校验 token。

推荐配置：

- Cloudflare Tunnel / Cloudflare CDN：`TRUSTED_PROXY_HEADER=cf-connecting-ip`
- Caddy / Nginx / Traefik：`TRUSTED_PROXY_HEADER=x-forwarded-for`，并设置正确的 `TRUSTED_PROXY_HOPS`

默认不信任任意 `X-Forwarded-For` 是安全设计，避免客户端伪造 IP。

### 配置加密根密钥

Docker 用户可以留空 `CONFIG_ENCRYPTION_KEY`。首次启动时 entrypoint 会生成随机密钥并持久化到 `/app/secrets/config-encryption-key`。

> 迁移服务器或恢复备份时，必须同时备份 PostgreSQL 数据库和配置加密密钥。密钥丢失后，加密配置可能无法恢复。

标准 Docker Compose 部署可用单个归档同时备份数据库、密钥和本地上传文件：

```bash
./scripts/backup.sh
./scripts/restore.sh ./backups/openlayerly-backup-<timestamp>.tar.gz
```

使用 S3 / R2 时脚本会跳过本地 uploads；对象存储 bucket 仍需单独启用版本控制或 provider 备份。升级前必须先运行备份脚本，完整步骤与已验证恢复演练见[备份与恢复](docs/deployment/backup-restore.md)和[升级指南](docs/deployment/upgrade.md)。

## 文件存储

默认使用本地存储，文件保存在 `uploads` volume，并通过鉴权接口访问。

生产大文件分发推荐使用 S3 / R2：

```env
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=your-bucket
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true
```

切换 `STORAGE_DRIVER` 不会自动迁移历史文件。local 与 S3 文件可以并存。

### 上传内存与清理

内容附件（含 `mp4` / `webm` / `mov` / `m4v` 视频）通过独立 raw-body 接口流式写入存储，并在流中计算 SHA-256 与实际字节数；图片和付款截图仍会缓冲，以便用 sharp 校验尺寸。

local 上传先写入同目录 `.part` 文件，成功后原子重命名；可捕获失败会删除临时文件，超过 24 小时的遗留 `.part` 会定期清理。S3 multipart 固定使用 8 MiB 分片、2 路并发，因此单次上传的 SDK 分片缓冲约为 16 MiB 加运行时开销。S3 / R2 bucket 还应配置「中止未完成 multipart upload」生命周期规则，作为进程崩溃时的兜底。

`MAX_UPLOAD_SIZE_MB` 是服务端流式实测上限，不再要求小于应用可用内存；同时仍需确认反向代理、隧道或对象存储的请求限制。

JSON、Stripe webhook 和 multipart 图片上传会先按实际传输字节执行应用层有界读取，再进行解析、验签、图片处理或业务访问。付款图片 multipart 总传输上限为文件限制加 256 KiB 协议开销。反向代理的 body limit 只是第二道保护，不能替代应用层限制。

## 健康检查

| 接口 | 说明 |
|---|---|
| `GET /api/health` | 存活检查 |
| `GET /api/ready` | 数据库、配置与加密密钥就绪检查 |

## 本地开发

```bash
pnpm install

docker run -d --name ams-postgres \
  -e POSTGRES_DB=artist_member \
  -e POSTGRES_USER=artist \
  -e POSTGRES_PASSWORD=artist_password \
  -p 5432:5432 postgres:16

cp .env.example .env
pnpm db:migrate
pnpm dev
```

开发环境未配置 SMTP 时，验证码可能输出在服务端控制台；生产环境必须使用真实 SMTP。

提交前运行：

```bash
pnpm test
pnpm lint
pnpm format:check
pnpm exec tsc --noEmit
pnpm build:migrator
pnpm build
```

## 文档

### 项目与开发

- [产品需求文档](docs/PRD.md)
- [路线图](docs/roadmap.md)
- [架构文档](docs/architecture/core-system.md)
- [架构决策记录（ADR）](docs/adr/README.md)
- [会员生命周期设计稿（#4）](docs/architecture/membership-lifecycle.md)
- [开发工作流](docs/development/dev-workflow.md)
- [贡献指南](CONTRIBUTING.md)

### 部署与运维

- [Docker Compose 部署](docs/deployment/docker-compose.md)
- [家庭服务器部署](docs/deploy-home-server.md)
- [Cloudflare Tunnel 部署](docs/deploy-cloudflare-tunnel.md)
- [公网 VPS + 反向代理部署](docs/deploy-vps.md)
- [生产检查清单](docs/deployment/production-checklist.md)
- [备份与恢复](docs/deployment/backup-restore.md)
- [升级指南](docs/deployment/upgrade.md)

### 后台管理

- [站点配置](docs/admin/site-settings.md)
- [品牌资源与自定义页脚代码](docs/admin/branding-and-custom-code.md)
- [付款审核](docs/admin/payment-review.md)
- [邮件配置](docs/admin/mail-settings.md)
- [存储配置](docs/admin/storage-settings.md)
- [翻译配置](docs/admin/translation-settings.md)

### 发布与安全

- [Security Policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [v0.2.0 最终验收清单](docs/release-v0.2-checklist.md)
- [v0.1 readiness audit](docs/releases/v0.1-readiness-audit.md)
- [v0.1 release checklist](docs/releases/v0.1-release-checklist.md)

## License

OpenLayerlyPro is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`). See [LICENSE](LICENSE).

Modified versions made available to users over a network must provide the corresponding source code as required by the AGPL.
