# 个人博客模式

在应用环境中设置 `PERSONAL_BLOG_MODE=true`，设置 `APP_URL` 为正式 HTTPS 地址，
按需设置 `BLOG_LOCALE=zh|en|ja`，完成数据库迁移后启动。Compose 读取项目的 `.env`。
已有 Pro 部署可以启用模式，文章与订单继续使用原来的 PostgreSQL 数据。

- 首次初始化从 `/admin/setup` 创建管理员。之后从 `/admin` 登录。
- 公开首页和 `/posts` 只列出公开文章，支持标题和摘要搜索。公开文章继续使用
  canonical、Open Graph、Atom 与 sitemap；后台配置的 Umami/Plausible 只加载在公开博客。
- `/admin/invitations` 可生成绑定邮箱的链接，或通过已配置的 SMTP 同时发信。
  邀请七天内可领取一次。读者用对应邮箱通过验证码、Magic Link、Google 或 GitHub 登录，
  回到邀请页确认领取。撤销已领取的邀请会撤销对应的里站授权。
- `/inside` 列出邀请可读和订阅文章。里站内的订阅等级、收银台、账号和订单沿用 Pro。
  已有读者账号可登录，进入里站需先领取邀请。已有付费权益由 Pro 继续维护。撤销阅读资格后，读者仍可登录处理自己的订单和取消已有订阅。
- 文章编辑器的「公开」对应公开博客，「仅受邀」对应原有登录可见权限，
  「订阅可读」还需达到档位要求。编辑器内可按访客、受邀读者或具体档位模拟阅读。分享公开文章使用 `/posts/<slug>`；
  其余文章使用 `/inside/posts/<slug>`。
- CDN 设置见 [CDN 接入](../deploy-cdn.md#个人博客模式)。

停用模式可回到通用会员站界面。再次启用时，原有邀请及撤销记录继续有效。
