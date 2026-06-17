# CDN 接入

在反向代理（见 [公网 VPS 部署](deploy-vps.md)）之前再叠加 CDN（以 Cloudflare 为例）可获得缓存、防护与就近加速。CDN 是可选项，应用不内置 CDN 逻辑。

## DNS 与链路

把域名的 DNS 解析切到 CDN，并开启「代理 / Proxied」（橙色云）。链路变为：

```txt
浏览器 → Cloudflare（TLS + 缓存）→ 你的反向代理（TLS）→ app:3000 → postgres + volumes
```

源站仍由反向代理终止一次 TLS，CDN 到源站走 HTTPS（Cloudflare SSL 模式选 Full / Full(strict)）。

## 缓存规则

应用是动态站点，**不要缓存动态与鉴权路径**，只缓存静态资源：

- 绕过缓存：`/api/*`、`/admin/*`、`/login`、文件下载（`/api/files/*/download`，已是带签名/鉴权的短时直链）。
- 可缓存：`/_next/static/*` 等带指纹的静态资源。

按需在 CDN 配置 Cache Rules / Page Rules 实现以上。

## 客户端 IP

经 CDN 后，反向代理看到的对端是 CDN 节点。两种取真实访客 IP 的方式（详见 [VPS 指南的「客户端 IP 解析」](deploy-vps.md#4-客户端-ip-解析)）：

- **按层数**：CDN + 反代共两层 → `TRUSTED_PROXY_HOPS=2`，从 `X-Forwarded-For` 取右数第 2。
- **用单值头**：Cloudflare 会写入 `CF-Connecting-IP` 为真实访客 IP → `TRUSTED_PROXY_HEADER=cf-connecting-ip`（此时 `TRUSTED_PROXY_HOPS` 忽略）。

> **单值头安全前提**：`cf-connecting-ip` 等单值头只有在源站不直接暴露、只接受可信边缘流量时才可信。裸 VPS 用 Cloudflare 时，务必用防火墙只放行 [Cloudflare IP 段](https://www.cloudflare.com/ips/)，并按 VPS 指南第 2 步锁定 3000 端口，否则攻击者可绕过 CDN 直接伪造该头。
