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

升级前应先备份数据库、上传文件和配置加密密钥。
