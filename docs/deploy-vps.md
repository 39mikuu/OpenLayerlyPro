# 公网 VPS + 反向代理部署指南

适用于有公网 IP 的 VPS。使用 Caddy、Nginx、Traefik 等反向代理提供 HTTPS，并将请求转发到应用容器。

## 获取项目

```bash
git clone https://github.com/39mikuu/OpenLayerlyPro.git
cd OpenLayerlyPro
cp .env.example .env
```

## 部署要点

1. 按 `.env.example` 配置站点地址、数据库、邮件与安全参数。
2. 使用强随机会话密钥。
3. 只向公网开放 HTTPS 入口，不要直接暴露应用端口。
4. 单层反向代理通常使用 `TRUSTED_PROXY_HOPS=1`。
5. 只有在源站无法被绕过时，才信任单值真实 IP 头。
6. 将反向代理上传限制与应用上传限制保持一致。

## Caddy overlay

仓库提供 Caddy 部署文件：

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

## 验证

- 站点可通过 HTTPS 访问
- `/api/health` 返回成功
- `/api/ready` 返回成功
- 应用端口无法从公网直接访问
- 登录限流能够读取正确的客户端 IP

## 备份与升级

升级或迁移前，请备份数据库、上传文件和配置加密密钥。

更多说明：

- [家庭服务器部署](deploy-home-server.md)
- [备份与恢复](deployment/backup-restore.md)
- [升级指南](deployment/upgrade.md)
- [生产检查清单](deployment/production-checklist.md)
