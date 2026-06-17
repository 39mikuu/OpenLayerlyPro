# 公网 VPS + 反向代理部署指南

适用于有公网 IP 的云服务器（VPS），用反向代理终止 TLS（自动 HTTPS）并把流量转发到只监听 HTTP:3000 的应用容器。无公网 IP 请改用 [Cloudflare Tunnel](deploy-cloudflare-tunnel.md)。

## 前置条件

- 一台有公网 IP 的 VPS，已安装 Docker 与 Docker Compose
- 一个域名，且 A 记录已指向 VPS 的公网 IP
- 放行入站 `80` / `443` 端口

## 1. 获取项目并配置

```bash
git clone https://github.com/3140702049/OpenLayerlyPro.git
cd OpenLayerlyPro
cp .env.example .env
```

编辑 `.env`，至少修改：

```env
APP_URL=https://artist.example.com
APP_DOMAIN=artist.example.com           # 反代用，等于你的域名
SESSION_SECRET=用 openssl rand -base64 32 生成
# SMTP（粉丝验证码登录必需）
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_smtp_user
SMTP_PASSWORD=your_smtp_password
SMTP_FROM="Artist Site <no-reply@example.com>"
# 反向代理 / 真实客户端 IP（见下文「客户端 IP 解析」）
TRUSTED_PROXY_HOPS=1
```

建议同时修改 `docker-compose.yml` 中 PostgreSQL 默认密码并同步 `DATABASE_URL`。

## 2. 锁定应用端口（重要）

基础 `docker-compose.yml` 默认把应用发布到 `0.0.0.0:3000`，公网可直连。**用反向代理时必须让 3000 端口不可被公网直接访问**，否则攻击者可绕过代理直接发伪造的 `X-Forwarded-For`，使按 IP 的限流与审计失真。二选一：

- 改 `docker-compose.yml` 中 app 的端口为仅本机：`"127.0.0.1:3000:3000"`；或
- 用防火墙（ufw / 云安全组）只放行 `80` / `443`，拒绝公网访问 `3000`。

> 反代容器通过 compose 内部网络以 `app:3000` 访问应用，不依赖对外发布的端口。

## 3. 选择反向代理（自动 SSL）

三选一。**推荐 Caddy**，零额外工具即可自动签发并续期证书。

### 方案 A：Caddy（推荐）

仓库已内置 `docker-compose.caddy.yml` 与 `docker/Caddyfile`。直接叠加启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Caddy 会为 `${APP_DOMAIN}` 自动申请 Let's Encrypt 证书，并把 `X-Forwarded-For`（真实访客 IP 置于末位）等头追加后反代到 `app:3000`。证书数据持久化在 `caddy_data` volume。

### 方案 B：Nginx + certbot

```nginx
server {
    listen 443 ssl;
    server_name artist.example.com;

    ssl_certificate     /etc/letsencrypt/live/artist.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/artist.example.com/privkey.pem;

    client_max_body_size 600m;   # 与 MAX_UPLOAD_SIZE_MB 匹配

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

证书用 certbot 签发与续期：`certbot --nginx -d artist.example.com`。`$proxy_add_x_forwarded_for` 会在客户端已有 XFF 后追加 Nginx 看到的对端 IP——配合 `TRUSTED_PROXY_HOPS=1` 取末位即真实访客。

### 方案 C：Traefik

Traefik 通过 Docker label 自动发现服务并用 Let's Encrypt 签发证书（需配置好 certresolver，如 `myresolver`）。给 app 服务加 label：

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.http.routers.app.rule=Host(`artist.example.com`)"
  - "traefik.http.routers.app.entrypoints=websecure"
  - "traefik.http.routers.app.tls.certresolver=myresolver"
  - "traefik.http.services.app.loadbalancer.server.port=3000"
```

Traefik 默认会设置 `X-Forwarded-*` 头，同样配合 `TRUSTED_PROXY_HOPS=1`。

## 4. 客户端 IP 解析

应用只信任**已配置的代理层**传递的客户端 IP，由两个环境变量控制（详见架构文档 [deployment-network-edge.md](architecture/deployment-network-edge.md)）：

- `TRUSTED_PROXY_HOPS`：应用前**真正可信、且会追加/覆盖 `X-Forwarded-For`** 的代理层数。默认 `0` 表示不信任任何转发头（拿不到 IP，按 IP 的限流不生效）。
- `TRUSTED_PROXY_HEADER`：取 IP 的头，默认 `x-forwarded-for`；也可设为单值头 `x-real-ip` / `cf-connecting-ip` / `true-client-ip`。

登录验证码与 Turnstile 会使用这里解析出的真实 IP 做 per-IP 限流。未配置可信代理头时，应用不会信任客户端可伪造的 `X-Forwarded-For`；Turnstile 会退回较高阈值的全局上游保护，避免所有未知 IP 用户共享低阈值桶导致全站被误伤。

### X-Forwarded-For 取值示例

`X-Forwarded-For` 是逗号分隔列表，每经过一层代理在**末尾追加**它看到的对端 IP。应用取「右数第 `TRUSTED_PROXY_HOPS` 个」。

- **`TRUSTED_PROXY_HOPS=1`（单层反代，最常见）**
  - 正常：`X-Forwarded-For: 203.0.113.7` → 解析为 `203.0.113.7`。
  - 客户端伪造 `1.2.3.4`：反代追加真实访客后变 `1.2.3.4, 203.0.113.7` → 仍解析末位 `203.0.113.7`，伪造被丢弃。
- **`TRUSTED_PROXY_HOPS=2`（两层，如 CDN/负载均衡 + 反代）**
  - 正常：`X-Forwarded-For: 203.0.113.7, 10.0.0.2`（访客、第一层）→ 右数第 2 = `203.0.113.7`。
  - 伪造：`1.2.3.4, 203.0.113.7, 10.0.0.2` → 仍取 `203.0.113.7`。

> `TRUSTED_PROXY_HOPS` 必须严格等于应用前可信代理的层数。**设大了**会读到客户端可控的条目（可伪造）；设的层数超过实际条目数时应用返回空 IP（失败即安全）。

### 单值真实 IP 头的安全前提

`x-real-ip` / `cf-connecting-ip` / `true-client-ip` 这类**单值头只有在源站不直接对公网暴露、只接受来自可信边缘/反代的流量时才安全**。否则攻击者可绕过边缘直接给源站发送伪造的该头。务必先完成第 2 步（锁定 3000 端口），裸 VPS 用 Cloudflare 代理时还需用防火墙只放行 [Cloudflare IP 段](https://www.cloudflare.com/ips/)。

## 5. 启动与验证

```bash
# 以 Caddy 方案为例
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
docker compose logs -f app    # 查看迁移与启动日志
```

访问 `https://artist.example.com` 应进入站点初始化页面。反向代理与编排可用健康探针：

| 接口 | 用途 |
|---|---|
| `GET /api/health` | 存活探针，进程存活即 200 |
| `GET /api/ready` | 就绪探针，数据库 / 配置 / 加密密钥就绪才 200，否则 503 |

## 6. 大文件上传

反向代理需把请求体上限调到与 `MAX_UPLOAD_SIZE_MB` 匹配（Nginx 的 `client_max_body_size`，见上）。其余内存与对象存储建议见 [常见问题](faq.md) 的「上传大文件失败」。

## 7. 备份与升级

与家庭服务器一致，见 [家庭服务器部署](deploy-home-server.md) 的「数据备份 / 升级版本」。迁移服务器务必备份 `secrets` volume（配置加密密钥），否则已加密的后台配置无法解密。

升级版本前建议备份数据库。本版本包含核心查询性能索引 migration（sessions、login_codes、memberships、post_files、payment_requests、posts），会随现有迁移流程自动应用。
