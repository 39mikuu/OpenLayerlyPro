# 家庭服务器部署指南

适用于 NAS、小主机、PVE 虚拟机、闲置电脑等环境。

## 1. 安装 Docker

参考 [Docker 官方文档](https://docs.docker.com/engine/install/)。Debian/Ubuntu 一键脚本：

```bash
curl -fsSL https://get.docker.com | sh
```

## 2. 获取项目并配置

```bash
git clone https://github.com/3140702049/OpenLayerlyPro.git
cd OpenLayerlyPro
cp .env.example .env
```

编辑 `.env`，必须修改：

```env
SESSION_SECRET=用 openssl rand -base64 32 生成
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_smtp_user
SMTP_PASSWORD=your_smtp_password
SMTP_FROM="Artist Site <no-reply@example.com>"
```

> SMTP 是粉丝验证码登录的必要条件。可以使用任何支持 SMTP 的邮箱服务（如企业邮箱、QQ 邮箱、Gmail、SendGrid、Resend 等）。

建议同时修改 `docker-compose.yml` 中 PostgreSQL 的默认密码，并同步更新 `DATABASE_URL`。

## 3. 启动

```bash
docker compose up -d
docker compose logs -f app   # 查看启动与迁移日志
```

容器启动时由 entrypoint 显式执行数据库迁移（迁移失败应用不会启动，日志中可见原因）。访问 `http://服务器IP:3000` 完成站点初始化。

> 内存提示：上传文件会完整载入内存后再写入存储，`MAX_UPLOAD_SIZE_MB`（默认 500）请按机器内存调整；小内存设备建议 100~200。S3/R2 可在后台「系统配置」中配置，环境变量继续作为回退来源。

## 4. 公网访问

无公网 IP 推荐使用 [Cloudflare Tunnel](deploy-cloudflare-tunnel.md)；有公网 IP 见 [公网 VPS + 反向代理部署](deploy-vps.md)（Caddy / Nginx / Traefik 自动 SSL 示例）。

> 用自建反向代理时，记得设置 `TRUSTED_PROXY_HOPS=1` 让限流与审计拿到真实客户端 IP，并确保 `3000` 端口不直接对公网开放（详见 VPS 指南）。

## 5. 数据备份

需要备份两部分：

```bash
# 数据库
docker compose exec postgres pg_dump -U artist artist_member > backup-$(date +%F).sql

# 上传文件（local 存储模式）
docker run --rm -v $(basename $PWD)_uploads:/uploads -v $PWD:/backup debian \
  tar czf /backup/uploads-$(date +%F).tar.gz -C /uploads .
```

使用 S3/R2 存储时文件在对象存储中，只需备份数据库。

## 6. 升级版本

```bash
git pull
docker compose build app
docker compose up -d
```

迁移在启动时自动执行，升级前建议先备份数据库。
