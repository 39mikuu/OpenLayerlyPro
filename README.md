# OpenLayerlyPro

开源、自托管、单画师会员站系统。

OpenLayerlyPro helps independent illustrators and creators run their own membership site: publish posts, sell membership tiers through manual payment review, and deliver member-only files from a self-hosted deployment.

Current status: **v0.1 preview / alpha**. The project is suitable for technical self-hosters who can operate Docker Compose, PostgreSQL, SMTP, storage, and backups.


## 核心特性

- 开源自托管
- 单画师会员站
- 管理员邮箱 + 密码登录
- 粉丝邮箱验证码登录
- 人工审核收银台
- 收款码配置
- 付款截图上传
- 付款审核
- 自动开通会员
- 会员限定内容（public / login / member 三级权限）
- 高清图 / PSD / ZIP / 笔刷包下载
- 本地文件存储
- S3 / R2 对象存储（可选）
- 下载权限控制与下载记录
- zh / en / ja UI i18n
- 内容多语言与 AI 辅助翻译草稿（默认关闭，管理员手动触发）
- 自定义站点 logo / icon
- 管理员可信自定义页脚代码
- Docker Compose 一键部署
- Cloudflare Tunnel 支持，无公网 IP 家庭服务器友好

## 适合谁

- 想自托管单画师 / 单创作者会员站的个人创作者。
- 想用人工审核收款码、付款截图、手动审核开通会员的创作者。
- 能维护 Docker Compose、PostgreSQL、SMTP、反向代理和备份的自托管用户。

## 非目标

v0.1 不做：

- 多画师入驻平台
- 内容广场 / 推荐流
- 评论、点赞、收藏、关注
- 自动支付 provider、webhook、自动对账
- OAuth / 密码注册
- 插件 runtime 或主题市场
- 移动 App

## 快速启动

```bash
git clone https://github.com/3140702049/OpenLayerlyPro.git
cd OpenLayerlyPro
cp .env.example .env
# 编辑 .env：至少修改 SESSION_SECRET，配置 SMTP（粉丝验证码登录必需）
docker compose up -d
```

> 容器启动时由 entrypoint 显式执行数据库迁移，迁移失败则不会启动应用，可通过 `docker compose logs app` 排查。

访问：

```txt
http://localhost:3000
```

首次访问会自动进入 `/admin/setup` 初始化页面，填写站点名称、画师信息和管理员账号即可完成搭建。系统会自动创建三个默认会员等级（支持者 / 高清图会员 / 素材包会员），可在后台修改。

## 核心闭环

```txt
画师初始化站点 → 配置 SMTP → 配置收款码 → 创建会员等级 → 发布会员作品
粉丝邮箱验证码登录 → 选择会员等级 → 扫码付款并上传截图
画师审核付款 → 系统自动开通会员并发邮件 → 粉丝按权限下载内容
```

## Cloudflare Tunnel 部署（无公网 IP）

1. 在 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) 创建 Tunnel，获取 Token。
2. 在 Tunnel 的 Public Hostname 中将你的域名指向 `http://app:3000`。
3. 配置 `.env` 中的 `CLOUDFLARE_TUNNEL_TOKEN` 和 `APP_URL=https://你的域名`。
4. 启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```

详见 [docs/deploy-cloudflare-tunnel.md](docs/deploy-cloudflare-tunnel.md)。

## 公网 VPS + 反向代理部署

有公网 IP 时，用反向代理终止 TLS（自动 HTTPS）并转发到只监听 HTTP 的应用容器。仓库内置 Caddy 反代 overlay：

```bash
# .env 设置 APP_DOMAIN=你的域名、TRUSTED_PROXY_HOPS=1
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Caddy 自动签发并续期 Let's Encrypt 证书。Nginx / Traefik 示例、客户端 IP 解析（`TRUSTED_PROXY_HOPS`）与端口锁定见 [docs/deploy-vps.md](docs/deploy-vps.md)；再叠加 CDN 见 [docs/deploy-cdn.md](docs/deploy-cdn.md)。

## 环境变量

完整列表见 [.env.example](.env.example)。关键项：

| 变量 | 说明 |
|---|---|
| `APP_URL` | 站点对外地址 |
| `SESSION_SECRET` | 生产必须设置为强随机值，否则应用拒绝启动 |
| `DATABASE_URL` | PostgreSQL 连接串（compose 内已默认配置） |
| `SMTP_HOST` / `SMTP_FROM` 等 | SMTP 邮件配置，验证码登录必需 |
| `STORAGE_DRIVER` | `local`（默认）或 `s3` |
| `MAX_UPLOAD_SIZE_MB` | 内容附件上传上限，默认 500 |
| `TRUSTED_PROXY_HOPS` / `TRUSTED_PROXY_HEADER` | 可信代理层数与取 IP 的头，默认不信任任何转发头；反代部署需配置，见 VPS 指南 |
| `TURNSTILE_ENABLED` | 开启 Cloudflare Turnstile 人机验证保护验证码发送接口 |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | Turnstile 密钥对，开启时必填 |
| `CONFIG_ENCRYPTION_KEY` / `CONFIG_ENCRYPTION_KEY_FILE` | 配置加密根密钥，Docker 用户可留空自动生成 |

AI translation provider settings are configured in the admin settings UI and stored encrypted. Do not put provider API keys in `NEXT_PUBLIC_*` variables.

## 安全配置

### SESSION_SECRET

生产环境（`NODE_ENV=production`）必须将 `SESSION_SECRET` 设置为强随机值，使用默认值 `change-me`、留空或长度不足 32 时应用会**拒绝启动**。生成方式：

```bash
openssl rand -base64 32
```

`SESSION_SECRET` 用于签发/校验登录会话，当前不会自动生成。自动生成的是下面的配置加密根密钥（`CONFIG_ENCRYPTION_KEY_FILE`）；两者用途不同。

### Cloudflare Turnstile 人机验证（可选）

在 [Cloudflare Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile) 创建站点获取 Site Key 与 Secret Key，然后配置：

```env
TURNSTILE_ENABLED=true
NEXT_PUBLIC_TURNSTILE_SITE_KEY=你的SiteKey
TURNSTILE_SECRET_KEY=你的SecretKey
```

开启后，登录页发送邮箱验证码前需要先通过人机验证，服务端会调用 Cloudflare Siteverify 校验 token，验证失败不会发送邮件。Secret Key 只在服务端使用，不会下发给浏览器。关闭时（默认）登录流程不变。

验证码有尝试次数上限，且验证成功后会一次性使用。Turnstile 在调用 Siteverify 前会按真实客户端 IP 做轻量限流；如果部署未配置可信代理头，应用无法精确取得真实 IP，会使用较高阈值的全局保护而不是共享的低阈值 `unknown` 桶。生产环境建议按部署形态配置真实 IP：

- Cloudflare Tunnel / Cloudflare CDN：`TRUSTED_PROXY_HEADER=cf-connecting-ip`
- 常规 Caddy / Nginx / Traefik 反向代理：`TRUSTED_PROXY_HEADER=x-forwarded-for` + 正确的 `TRUSTED_PROXY_HOPS`

默认不信任任意 `X-Forwarded-For` 是安全设计，避免客户端直接伪造 IP。

### 配置加密根密钥

为后续后台配置中心的敏感配置加密预留。Docker 用户**无需手动配置**：首次启动时 entrypoint 会自动生成随机密钥并持久化到 `secrets` volume（`/app/secrets/config-encryption-key`，权限 600），重启不会改变。也可以通过 `CONFIG_ENCRYPTION_KEY` 直接提供。

> **重要：迁移服务器时必须备份 `/app/secrets/config-encryption-key` 文件或对应的 `secrets` volume。密钥丢失后，未来的加密配置将无法解密。**

升级版本前建议备份数据库。本版本包含核心查询性能索引 migration（sessions、login codes、memberships、post files、payment requests、posts），容器启动时会随现有迁移流程自动应用。

## 健康检查

为反向代理与未来负载均衡预留：

| 接口 | 说明 |
|---|---|
| `GET /api/health` | 存活检查，进程运行即返回 200 |
| `GET /api/ready` | 就绪检查：数据库可连接、配置可读取、配置加密密钥可用；异常返回 503 |

## 文件存储

默认使用本地存储（`STORAGE_DRIVER=local`），文件保存在 `uploads` volume 中，所有访问都经过鉴权 API，不会被静态目录直接暴露。

### S3 / Cloudflare R2（推荐生产分发）

```env
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=your-bucket
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true
```

下载时 App 完成鉴权和日志记录后，返回 5 分钟有效期的签名 URL，由对象存储直接分发大文件，家庭宽带无压力。

> **注意：切换 `STORAGE_DRIVER` 不会自动迁移历史文件。** 已上传的文件按其落盘时记录的驱动继续提供下载，local 与 s3 文件可以共存；如需整体迁移请手动搬运对象并更新 `files` 表的 `storage_driver` / `bucket` 字段。

### 大文件上传的内存注意事项

当前版本上传时会将**整个文件读入内存**后再写入存储（计算校验和与图片尺寸）。`MAX_UPLOAD_SIZE_MB`（默认 500）应与部署机器的可用内存相匹配——在 1~2GB 内存的 NAS / 小主机上建议调低到 100~200。发布大体积素材包推荐：

1. 使用 `STORAGE_DRIVER=s3`（R2/S3），下载走签名直链，App 与家庭宽带不承担分发流量；
2. 经 Cloudflare Tunnel 上传受约 100MB 单请求限制，超大文件建议在局域网内访问后台上传。

### MinIO 兼容说明

MinIO 可作为 S3-compatible Storage 使用：自行部署 MinIO 后，将 `S3_ENDPOINT` 指向 MinIO 地址即可。第一版不在基础 `docker-compose.yml` 中内置 MinIO。

## 本地开发

```bash
pnpm install
docker run -d --name ams-postgres -e POSTGRES_DB=artist_member \
  -e POSTGRES_USER=artist -e POSTGRES_PASSWORD=artist_password -p 5432:5432 postgres:16
cp .env.example .env   # DATABASE_URL 改为 localhost
pnpm db:migrate        # 执行数据库迁移
pnpm dev
```

开发模式未配置 SMTP 时，验证码会输出在服务端控制台日志中。

**迁移的统一约定**：开发和生产使用同一个脚本 `scripts/migrate.mjs`——开发执行 `pnpm db:migrate`；生产镜像在构建时将其打包为自包含的 `dist/migrate.mjs`，由 `docker/entrypoint.sh` 在启动应用前显式执行。应用本身不在运行时做迁移。

修改 `src/db/schema` 后执行 `pnpm drizzle-kit generate` 生成迁移文件，再 `pnpm db:migrate` 应用。

## 发布与安全

- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [v0.1 release checklist](docs/releases/v0.1-release-checklist.md)
- [v0.1 readiness audit](docs/releases/v0.1-readiness-audit.md)

## 技术栈

Next.js 15 (App Router) · TypeScript · PostgreSQL · Drizzle ORM · Tailwind CSS + shadcn/ui · nodemailer · sharp · Zod · Docker Compose

## 更多文档

- [产品需求文档（PRD）](docs/PRD.md)
- [路线图](docs/roadmap.md)
- [架构文档](docs/architecture/core-system.md)
- [开发工作流](docs/development/dev-workflow.md)
- [Docker Compose 部署](docs/deployment/docker-compose.md)
- [生产检查清单](docs/deployment/production-checklist.md)
- [备份与恢复](docs/deployment/backup-restore.md)
- [升级指南](docs/deployment/upgrade.md)
- [家庭服务器部署](docs/deploy-home-server.md)
- [Cloudflare Tunnel 部署](docs/deploy-cloudflare-tunnel.md)
- [公网 VPS + 反向代理部署](docs/deploy-vps.md)
- [CDN 接入](docs/deploy-cdn.md)
- [后台站点配置](docs/admin/site-settings.md)
- [品牌资源与自定义页脚代码](docs/admin/branding-and-custom-code.md)
- [付款审核](docs/admin/payment-review.md)
- [邮件配置](docs/admin/mail-settings.md)
- [存储配置](docs/admin/storage-settings.md)
- [翻译配置](docs/admin/translation-settings.md)
- [常见问题](docs/faq.md)

## 第一版范围说明

第一版定位为**单画师、自托管**的会员作品站，不包含：评论 / 点赞 / 收藏、自动支付（Stripe / 微信 / 支付宝官方接口）、多画师入驻、内容广场、水印、Redis / 消息队列。详见路线图。

## License

GPL-2.0-only. See [LICENSE](LICENSE).
