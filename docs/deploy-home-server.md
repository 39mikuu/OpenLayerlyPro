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
NOTIFICATION_UNSUBSCRIBE_KEY_ID=current
NOTIFICATION_UNSUBSCRIBE_SECRET_FILE=/app/secrets/notification-unsubscribe-secret
NOTIFICATION_SUPPRESSION_DIGEST_KEY_ID=current
NOTIFICATION_SUPPRESSION_DIGEST_SECRET_FILE=/app/secrets/notification-suppression-digest-secret
MAGIC_LINK_KEY_ID=current
MAGIC_LINK_SECRET_FILE=/app/secrets/magic-link-secret
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_smtp_user
SMTP_PASSWORD=your_smtp_password
SMTP_FROM="Artist Site <no-reply@example.com>"
EMAIL_RETRY_RECHECK_MINUTES=15
EMAIL_DELIVERY_MAX_AGE_HOURS=24
TASK_TRANSACTIONAL_RESERVED_PER_BATCH=8
TASK_NOTIFICATION_MIN_PER_BATCH=2
TASK_NOTIFICATION_STALE_RECLAIM_MAX_PER_BATCH=2
TASK_MAINTENANCE_MAX_PER_BATCH=2
NOTIFICATION_EMAIL_DAILY_BUDGET=500
NOTIFICATION_EMAIL_PACING_PER_MINUTE=30
NOTIFICATION_CAMPAIGN_EXPANSION_BATCH_SIZE=500
NOTIFICATION_DELIVERY_MAX_AGE_HOURS=168
NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS=180
```

> SMTP 是粉丝验证码登录的必要条件。业务邮件遇到未配置或需运维修复的错误时，会按 `EMAIL_RETRY_RECHECK_MINUTES` 延迟重投且不消耗 attempts；超过 `EMAIL_DELIVERY_MAX_AGE_HOURS` 后进入 dead。登录码因 TTL 很短会直接进入 dead。建议同时修改 Compose 中 PostgreSQL 默认密码并同步 `DATABASE_URL`。
>
> Docker entrypoint 会在生产 Compose 模式下为文件型当前退订 key 与 suppression digest key 生成 `/app/secrets/notification-unsubscribe-secret` 和 `/app/secrets/notification-suppression-digest-secret`（`0600`），但不会自动生成 previous keys。key id 仍应在 `.env` 中稳定配置；直接设置非空 `NOTIFICATION_*_SECRET` 时会优先于对应 `*_SECRET_FILE`。退订 previous key 要保留到旧 token 过期；suppression previous key 要保留到有明确 rehash/migration 程序。

### 认证限流与可信 IP

- 当前 limiter 面向单 app 实例。多个副本会各自计数；v1.0 不提供共享 Redis/PG limiter。
- Cloudflare Tunnel/CDN 推荐 `TRUSTED_PROXY_HEADER=cf-connecting-ip`；自建反代使用 XFF 并设置准确 `TRUSTED_PROXY_HOPS`。
- 无法解析可信客户端 IP 时，`admin-login`、`request-code`、`verify-code` 会退回各操作专用的 unresolved emergency 桶；这不会把所有认证流量压进同一个低阈值全局桶，但 unresolved 客户端仍共享各自操作桶。生产应修复可信 IP 解析，而不是长期依赖降级路径。
- S4 使用高熵登录码、keyed email identity、正确码优先、错误后记账和 source-scoped pre-comparison budget。详见 [S4 handoff](handoff/harden-s4-auth-rate-limiting.md)。
- 登录码使用持久投递 fence；已有 active code 对应 pending/processing/retryable failed task 时，不创建替换码。
- claim/fence 在短事务内完成，SMTP 在事务/advisory lock 外执行；SMTP 接受后进程崩溃仍可能导致同一码 at-least-once 重发。
- S5 业务邮件使用失败分类、operator defer/dead、稳定 Message-ID、delivery ledger 与后台重试；业务 dedupeKey 只防重复入队，不能让 SMTP 本身 exactly-once。
- WP2 批量通知默认关闭，需要用户显式 opt-in；SMTP accepted 只表示服务商接收中继，不代表最终邮箱投递。通知投递为 at-least-once，不承诺不重复投递；归档/取消发布内容会在发送前跳过，同步 SMTP permanent rejection 才写入通知 suppression。这不是异步 DSN/provider 处理。
- `SESSION_SECRET` 也影响在途登录码 task 解密。轮换后旧任务会 permanent fail，用户需重新申请。

## 3. 启动

```bash
docker compose up -d
docker compose logs -f app
```

entrypoint 会准备目录与配置加密密钥、运行 forward migration，然后启动应用。迁移失败时应用不会服务。基础 Compose 会发布主机 3000 端口，访问 `http://服务器IP:3000` 完成初始化；只应在受信任局域网或有防火墙限制的环境使用该入口。

> 内容附件通过 raw-body 流式写入 local 或 S3/R2；图片用途有界缓冲并由 sharp 做格式检测、重编码和 metadata stripping。`MAX_UPLOAD_SIZE_MB` 是内容附件 env fallback；后台 DB 值可直接覆盖它。付款凭证/二维码上限则不能高于 `PAYMENT_PROOF_MAX_SIZE_MB` env ceiling。S3 multipart 使用 8 MiB × 2 路并发，并应配置中止未完成 multipart upload 的 bucket 生命周期规则。

## 4. 公网访问

无公网 IP 推荐 [Cloudflare Tunnel](deploy-cloudflare-tunnel.md)；有公网 IP 见 [公网 VPS + 反向代理部署](deploy-vps.md)。这两个生产 overlay 会用 `ports: !reset []` 移除基础 Compose 的 app host port；不要在其他 override 中重新发布 `3000:3000`。

使用自建反向代理时，应设置正确可信 hop，保留视频 Range 请求/响应，并确保应用端口不直接暴露公网。

## 5. 数据备份

至少备份：

- PostgreSQL 数据库；
- 所有仍被数据库引用的 local uploads；
- `/app/secrets/config-encryption-key` 或外部配置加密根密钥；
- `SESSION_SECRET`（需要无缝保留会话时）；
- `/app/secrets/notification-unsubscribe-secret`、`/app/secrets/notification-suppression-digest-secret` 及配置的 previous key，或匹配指纹的外部管理值；
- 所有仍被数据库引用的 S3/R2 对象的 version/snapshot。

当前 `scripts/backup.sh` 只读取 app 容器环境中的 `STORAGE_DRIVER` fallback，不读取后台 DB override，也不会为混合 local/S3 历史文件做完整 inventory。运行前必须对比后台有效 Storage 配置、env fallback 和 `files.storage_driver` 分布；env 选中之外的 local volume 或 S3/R2 recovery point 需要单独保护。WP2 起新归档为 `FORMAT_VERSION=4`，会纳入通知退订/suppression key 指纹和文件型 key。详见[备份与恢复](deployment/backup-restore.md)。

## 6. 安全升级

**不要使用简单的 `git pull && docker compose up -d` 代替升级流程。** 当前迁移链包含需要在 app 停止时完成的 pending-payment 冲突报告/修复、one-off migrator 与 mandatory file-safety backfill；直接启动新 app 可能让迁移失败，或在历史文件 remediation 完成前恢复流量。

升级前：

1. 阅读 `CHANGELOG.md` 与目标版本 release notes；
2. 生成并验证完整备份，确认磁盘空间；
3. 按[升级指南](deployment/upgrade.md) stage 新镜像；
4. 停止全部旧 app replica；
5. 运行 duplicate pending payment report/remediation；
6. 运行 one-off migrator；
7. 预览并执行 `files-backfill.mjs --apply`；
8. 只有所有步骤成功后才启动新 app，并验证 `/api/ready`、登录、付款和样本文件。

S7 #87 已把 archive 校验、旧 schema probe、恢复任务中和、DB-aware storage inventory 和 DB↔存储收敛纳入正式恢复流程（见[备份与恢复](deployment/backup-restore.md)）；真实环境的恢复演练属于 #88 发布验收，以 [v1.0 清单](release-v1.0-checklist.md)为准。
