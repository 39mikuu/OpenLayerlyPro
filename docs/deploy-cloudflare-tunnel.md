# Cloudflare Tunnel 部署

适合无公网 IP、不想做路由器端口转发的家庭服务器 / NAS / PVE 虚拟机用户。

## 架构

```txt
浏览器
  ↓
Cloudflare DNS
  ↓
Cloudflare Tunnel
  ↓
家庭服务器（docker compose）
  ↓
Next.js App → PostgreSQL → 本地 / S3 存储
```

## 前置条件

- 一个托管在 Cloudflare 的域名
- 已安装 Docker 和 Docker Compose 的服务器

## 步骤

### 1. 创建 Tunnel

1. 打开 [Cloudflare Zero Trust 控制台](https://one.dash.cloudflare.com/)。
2. 进入 Networks → Tunnels → Create a tunnel，选择 Cloudflared。
3. 命名（如 `artist-site`），创建后复制 Token（`eyJ...` 开头的长字符串）。

### 2. 配置 Public Hostname

在 Tunnel 详情页添加 Public Hostname：

| 项 | 值 |
|---|---|
| Subdomain | 如 `artist` |
| Domain | 你的域名 |
| Service Type | HTTP |
| URL | `app:3000` |

> `app` 是 docker-compose 中应用服务的名称，cloudflared 容器与它在同一网络中。

### 3. 配置环境变量

编辑 `.env`：

```env
APP_URL=https://artist.example.com
CLOUDFLARE_TUNNEL_TOKEN=eyJ...
SESSION_SECRET=请生成随机字符串
# 让限流与审计日志记录真实访客 IP（Cloudflare 会写入 CF-Connecting-IP）
TRUSTED_PROXY_HEADER=cf-connecting-ip
```

> Tunnel 路径下应用不对外暴露端口，`cf-connecting-ip` 单值头是可信的；裸机直连场景请改用 `TRUSTED_PROXY_HOPS`，详见 [公网 VPS 部署](deploy-vps.md)。

Turnstile 与登录验证码限流依赖真实访客 IP 才能做到精确 per-IP 保护。Cloudflare Tunnel 推荐保留上面的 `TRUSTED_PROXY_HEADER=cf-connecting-ip`；未配置可信代理头时，应用会失败即安全，不信任客户端伪造的 `X-Forwarded-For`，并退回较高阈值的全局 Turnstile 上游保护。

生成随机 SECRET：

```bash
openssl rand -base64 32
```

### 4. 启动

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d
```

### 5. 验证

访问 `https://artist.example.com`，应进入站点初始化页面。

## 注意事项

- 升级版本前建议备份数据库与 `secrets` volume。本版本包含 sessions、login_codes、memberships、post_files、payment_requests、posts 的性能索引 migration，启动时会自动执行。

- Cloudflare 免费版代理上传单请求上限约 100MB。大文件（素材包、PSD）建议在后台「系统配置」中启用 R2/S3（环境变量仍可作为回退），下载走签名直链不受影响；上传超大附件可临时通过局域网地址操作后台。
- 使用 Tunnel 后无需在 compose 中暴露 `3000` 端口到公网，如需彻底关闭可删除 `ports` 配置，仅保留局域网调试用途。
