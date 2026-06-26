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
EMAIL_RETRY_RECHECK_MINUTES=15
EMAIL_DELIVERY_MAX_AGE_HOURS=24
```

> SMTP 是粉丝验证码登录的必要条件。业务邮件遇到未配置或需运维修复的错误时，会按 `EMAIL_RETRY_RECHECK_MINUTES` 延迟重投且不消耗 attempts；超过 `EMAIL_DELIVERY_MAX_AGE_HOURS` 后进入 dead。登录码因 TTL 很短会直接进入 dead。建议同时修改 Compose 中 PostgreSQL 默认密码并同步 `DATABASE_URL`。

### 认证限流与可信 IP

- 当前 limiter 面向单 app 实例。多个副本会各自计数；v1.0 不提供共享 Redis/PG limiter。
- Cloudflare Tunnel/CDN 推荐 `TRUSTED_PROXY_HEADER=cf-connecting-ip`；自建反代使用 XFF 并设置准确 `TRUSTED_PROXY_HOPS`。
- 无法解析可信 IP 时，各公开入口使用各操作独立的高阈值 unresolved emergency bucket；生产应修复真实 IP，而不是长期依赖降级桶。
- S4 使用高熵登录码、keyed email identity、正确码优先、错误后记账和 source-scoped pre-comparison budget。详见 [S4 handoff](handoff/harden-s4-auth-rate-limiting.md)。
- 登录码使用持久投递 fence；已有 active code 对应 pending/processing/retryable failed task 时，不创建替换码。
- claim/fence 在短事务内完成，SMTP 在事务/advisory lock 外执行；SMTP 接受后进程崩溃仍可能导致同一码 at-least-once 重发。
- S5 业务邮件使用失败分类、operator defer/dead、稳定 Message-ID、delivery ledger 与后台重试；业务 dedupeKey 只防重复入队，不能让 SMTP 本身 exactly-once。
- `SESSION_SECRET` 也影响在途登录码 task 解密。轮换后旧任务会 permanent fail，用户需重新申请。

## 3. 启动

```bash
docker compose up -d
docker compose logs -f app
```

entrypoint 会准备目录与配置加密密钥、运行 forward migration，然后启动应用。迁移失败时应用不会服务。访问 `http://服务器IP:3000` 完成初始化。

> 内容附件通过 raw-body 流式写入 local 或 S3/R2；图片用途有界缓冲并由 sharp 做格式检测、重编码和 metadata stripping。`MAX_UPLOAD_SIZE_MB` 是内容附件实际字节上限。S3 multipart 使用 8 MiB × 2 路并发，并应配置中止未完成 multipart upload 的 bucket 生命周期规则。

## 4. 公网访问

无公网 IP 推荐 [Cloudflare Tunnel](deploy-cloudflare-tunnel.md)；有公网 IP 见 [公网 VPS + 反向代理部署](deploy-vps.md)。

使用自建反向代理时，应设置正确可信 hop，保留视频 Range 请求/响应，并确保应用端口不直接暴露公网。

## 5. 数据备份

至少备份：

- PostgreSQL 数据库；
- local 模式的 uploads volume；
- `/app/secrets/config-encryption-key` 或外部配置加密根密钥；
- `SESSION_SECRET`（需要无缝保留会话时）；
- S3/R2 bucket version/snapshot（使用对象存储时）。

运行 `scripts/backup.sh` 只覆盖标准归档中的 DB、file-backed config key 和 local uploads；S3 对象与外部 secret 仍需单独保护。详见 [备份与恢复](deployment/backup-restore.md)。

## 6. 安全升级

**不要使用简单的 `git pull && docker compose up -d` 代替升级流程。** 当前迁移链包含需要在 app 停止时完成的 pending-payment 冲突报告/修复、one-off migrator 与 mandatory file-safety backfill；直接启动新 app 可能让迁移失败，或在历史文件 remediation 完成前恢复流量。

升级前：

1. 阅读 `CHANGELOG.md` 与目标版本 release notes；
2. 生成并验证完整备份，确认磁盘空间；
3. 按 [升级指南](deployment/upgrade.md) stage 新镜像；
4. 停止全部旧 app replica；
5. 运行 duplicate pending payment report/remediation；
6. 运行 one-off migrator；
7. 预览并执行 `files-backfill.mjs --apply`；
8. 只有所有步骤成功后才启动新 app，并验证 `/api/ready`、登录、付款和样本文件。

v1.0 的 S7 #87 还会把 archive 校验、旧 schema probe、恢复任务中和和 DB↔存储收敛加入正式恢复流程；发布验收以 [v1.0 清单](release-v1.0-checklist.md)为准。
