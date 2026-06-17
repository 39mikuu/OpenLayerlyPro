# 常见问题

## 初始化与登录

**Q: 首次访问没有跳转到初始化页面？**
检查 `docker compose logs app` 中数据库迁移是否成功。entrypoint 会在启动应用前执行迁移，数据库未就绪时自动重试约 60 秒，迁移失败则应用不会启动。

**Q: 粉丝收不到验证码邮件？**
1. 后台 → 系统状态 → 发送测试邮件，确认 SMTP 配置正确；
2. 检查垃圾箱；
3. 同一邮箱 60 秒内只能发送一次，每小时最多 5 次。

**Q: 管理员密码忘了怎么办？**
进入数据库手动重置：

```bash
docker compose exec postgres psql -U artist artist_member
-- 生成新密码哈希需要 bcrypt，简单做法是重置 initialized 后重新初始化：
UPDATE site_settings SET value_json='false' WHERE key='initialized';
```

然后访问 `/admin/setup` 重新设置管理员账号（会保留原有数据，管理员账号按邮箱覆盖更新）。

## 文件与下载

**Q: 上传大文件失败？**
- 默认单文件上限 500MB，可调 `MAX_UPLOAD_SIZE_MB`；
- 当前版本上传时会将整个文件读入内存，`MAX_UPLOAD_SIZE_MB` 必须小于机器可用内存，小内存设备（1~2GB）建议调到 100~200，否则可能 OOM；
- 经 Cloudflare Tunnel 上传受 Cloudflare 单请求约 100MB 限制，大文件建议在局域网内操作后台，或使用 S3/R2 存储；
- 反向代理（Nginx 等）需同步调大 `client_max_body_size`。

**Q: 会员过期后还能下载吗？**
不能。第一版策略为会员过期后不可访问历史会员内容（PRD 设计）。

**Q: 本地存储的文件会被直接访问到吗？**
不会。文件不在任何静态目录中，所有访问都经过 `/api/files/:id/download` 鉴权。

## 部署与网络

**Q: 为什么限流 / 日志里看到的是代理 IP，或者拿不到客户端 IP？**
应用默认**不信任**任何转发头（`TRUSTED_PROXY_HOPS=0`），以防伪造。需要按部署形态显式配置可信代理层：

- 单层反向代理（Caddy / Nginx / Traefik）：`TRUSTED_PROXY_HOPS=1`；
- CDN + 反代两层：`TRUSTED_PROXY_HOPS=2`；
- Cloudflare Tunnel：`TRUSTED_PROXY_HEADER=cf-connecting-ip`。

并确保应用 `3000` 端口不直接对公网暴露，否则 IP 仍可被伪造。详见 [公网 VPS 部署](deploy-vps.md) 与 [CDN 接入](deploy-cdn.md)。

## 存储

**Q: 怎么切换到 R2 / S3？**
在后台「系统配置 → 文件存储」选择 S3，填写连接参数，保存后执行连接测试；新上传无需重启即可进入对象存储。也可继续通过 `STORAGE_DRIVER=s3` 与 `S3_*` 环境变量提供回退配置。

**切换不会自动迁移历史文件**：已上传到本地的旧文件继续从本地提供下载，新上传的文件才会进入对象存储，两种驱动的文件可以共存（读取与删除按 `files.storage_driver` 处理）。如需整体迁移，请手动搬运对象并更新对应记录。

当前版本只支持一个 S3 profile。切换到完全不同的 endpoint、账号或服务后，旧 S3 文件不保证可访问；未来需要通过 `storageProfileId` 让文件绑定上传时使用的存储配置。

**Q: 支持 MinIO 吗？**
支持，MinIO 是 S3 兼容存储。填写 MinIO Endpoint，并开启 Force Path Style 即可。

## 收银台

**Q: 为什么不接微信/支付宝/Stripe 自动支付？**
第一版刻意选择人工审核收银台，避免支付资质、回调、退款等复杂度，让个人画师零门槛部署。自动支付在后续路线图中。

**Q: 粉丝重复提交了申请怎么办？**
同一等级同时只允许一笔待审核申请；驳回后粉丝可重新提交截图，原驳回原因会保留记录。
