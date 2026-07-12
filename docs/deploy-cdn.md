# CDN 接入

在反向代理之前叠加 CDN（以 Cloudflare 为例）可提供边缘 TLS、防护和静态资源加速。CDN 是可选部署层，不能替代 Core 鉴权、应用请求体上限、S3 bucket 备份或 S6 响应头。

## DNS 与链路

```txt
浏览器 → CDN/TLS → 反向代理/TLS → app:3000 → postgres + volumes
                                      └────────→ S3/R2（按配置）
```

CDN 到源站应使用 HTTPS 且校验证书；源站必须限制只接受可信边缘/代理流量，不能让攻击者绕过 CDN 直连并伪造单值真实 IP 头。

## 缓存规则

站点包含认证、会员和短时能力 URL。默认只缓存带指纹的静态资源：

- 可缓存：`/_next/static/*` 等 immutable 静态资源；
- `/feed.xml` 是公开、动态但可 CDN 缓存的 Atom 输出；CDN 必须遵守应用返回的 `Cache-Control`（短 `s-maxage`），不要为其他动态或私有路由扩大 public 缓存范围；
- 绕过缓存：`/api/*`、`/admin/*`、登录/账号/订单/checkout，以及所有应用代理的文件与视频响应；
- `Cache-Control: private, no-store` 必须原样保留，不能被 CDN 改写为 public；
- 不要按 URL 外观假定 `/api/files/*/download` 都是公开 signed redirect：local、private video 和其他受保护路径可能由应用直接代理；
- public S3 signed redirect 的最终对象缓存行为由签名 TTL、对象响应头和部署策略共同决定，不得扩大授权时间或移除 disposition/content-type 约束。

CDN/代理必须透传应用的 CSP 和安全头。不要添加第二套宽泛 CSP、
`unsafe-inline`、wildcard script origin，或覆盖文件路由更严格的隔离头。
Report-Only 观察和 enforce 切换由 `SECURITY_CSP_MODE` 控制。

## HTTP Range 与视频

- 转发客户端 `Range`；
- 保留 200/206/416、`Content-Range`、`Content-Length`、`Accept-Ranges`；
- 不把 login/member/private S3 视频变成公开可缓存对象；
- public S3 playback 只有在 Core 确认可由已发布 public post 授权时才使用 signed redirect。

## 客户端 IP

经 CDN 和反代后，可选择：

- **按可信层数解析 XFF**：例如 CDN + 反代共两层时设置准确的 `TRUSTED_PROXY_HOPS`；
- **可信单值头**：Cloudflare 可使用 `TRUSTED_PROXY_HEADER=cf-connecting-ip`。

单值头只有在源站不能被绕过、边缘会覆盖该头时可信。用防火墙/安全组限制源站入口，并实际验证登录、上传和下载日志中的客户端 IP。

解析失败时应用会使用各操作独立的 unresolved emergency bucket并告警；这不是可以长期忽略的正常配置。

## 备份与可恢复性

CDN 缓存不是备份。使用 S3/R2 时仍需 bucket versioning、snapshot 或 provider backup，并在恢复时与数据库备份时点对齐。详见 [备份与恢复](deployment/backup-restore.md)和 S7 #87。
