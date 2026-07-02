# Cloudflare Tunnel 部署

适合无公网 IP、不想做路由器端口转发的家庭服务器、NAS 或 PVE 虚拟机用户。

## 架构

```txt
浏览器 → Cloudflare DNS/TLS → Cloudflare Tunnel → app:3000 → PostgreSQL
                                                   └──────→ local / S3 storage
```

## 前置条件

- 一个托管在 Cloudflare 的域名；
- 已安装 Docker Engine 与 Docker Compose 的服务器；
- 可用 SMTP，以及持久化 secrets volume；多节点部署需外部托管 `SESSION_SECRET`。

## 1. 创建 Tunnel

在 Cloudflare Zero Trust 中进入 **Networks → Tunnels → Create a tunnel**，选择 cloudflared，创建后复制 Tunnel token。把 token 当作 secret，不要提交仓库或粘贴到公开 issue。

## 2. 配置 Public Hostname

| 项 | 值 |
|---|---|
| Subdomain | 如 `artist` |
| Domain | 你的域名 |
| Service Type | HTTP |
| URL | `app:3000` |

`app` 是 Compose service 名；cloudflared 与 app 在同一 Docker network 中。

## 3. 配置环境变量

```env
APP_URL=https://artist.example.com
CLOUDFLARE_TUNNEL_TOKEN=...
# 单机 Compose 可省略 SESSION_SECRET，默认使用 SESSION_SECRET_FILE
TRUSTED_PROXY_HEADER=cf-connecting-ip
```

在标准 Tunnel 拓扑中，源站不直接暴露公网且 Cloudflare 会覆盖 `CF-Connecting-IP`，因此该单值头可以作为可信客户端身份。若 app 仍通过其他入口暴露，必须关闭该入口或改用符合真实拓扑的 XFF/hops 配置。

无法解析可信 IP 时，当前运行时不会落入低阈值全局 `unknown` 桶，而会使用 admin/login/file 等各操作独立的高阈值 unresolved emergency bucket 并记录告警。生产应修复代理配置，不应长期依赖降级路径。

生成随机 secret：

```bash
openssl rand -base64 32
```

## 4. 启动

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml config
```

`docker-compose.tunnel.yml` 使用 Compose `!reset` 清除基础文件中的 app 端口映射。合并后的配置不应发布 host `3000` 端口；cloudflared 只通过 Compose 内部网络访问 `app:3000`。若 Compose 不能解析 `!reset`，请先升级 Compose，不要移除安全覆盖后继续部署。

## 5. 验证

- HTTPS 域名可访问并进入初始化/站点页面；
- `/api/health` 与 `/api/ready` 返回成功；
- 合并配置和容器状态均确认 app 没有 host-published 3000 端口；
- 应用日志能解析真实访客 IP；
- request-code、verify-code 和 Turnstile 正常；
- 上传上限按应用实际字节执行；
- 视频 seek 的 Range 请求能返回 206/416；
- private 文件/视频没有被 Cloudflare 缓存为 public。

应用负责设置 nonce CSP 与全局安全响应头。先用 `SECURITY_CSP_MODE=auto`
或 `report-only` 验证 Cloudflare 下的 DB-enabled Turnstile、S3 signed origin
与公开视频/integration，再强制执行。不要在 Cloudflare Transform Rules 中覆盖
应用的 CSP 或文件隔离头。仅在 HTTPS 和所有子域边界确认后启用 HSTS。

## 上传与存储

Cloudflare plan、代理和产品路径可能有各自请求上限，部署前应以当前 Cloudflare 控制台/文档为准。应用层仍会按实际传输字节 enforce 自己的上限。

大附件可使用 S3/R2 流式 multipart；图片用途仍会有界缓冲并重编码。S3/R2 bucket 需要 abort-incomplete-multipart lifecycle，以及独立 versioning/snapshot 备份。

## 备份与升级

升级前保护 PostgreSQL、local uploads、配置加密根密钥、file-backed 或外部
`SESSION_SECRET` 和匹配的 S3/R2 recovery point。不要无备份执行
`docker compose down -v`。

不要只执行 `git pull && docker compose up`。按[升级指南](deployment/upgrade.md)停止 app、处理 duplicate pending payment、运行 one-off migrator 与 mandatory file-safety backfill 后再启动。当前 `backup.sh` 只依据容器环境变量 fallback 判断 active storage，不能识别后台 DB override；混合 local/S3 历史文件和 S7 #87 尚未落地的差异见[备份与恢复](deployment/backup-restore.md)。

## 端口暴露

Tunnel overlay 已移除 app 的 host 端口映射。不要在其他 override 中重新发布 `3000:3000`；如需临时局域网调试，请使用单独的受控 override，并限制监听地址和防火墙来源，调试结束后删除该入口。
