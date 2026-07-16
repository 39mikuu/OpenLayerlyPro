# v1.1 计划书：不只画师

> 状态：**WP1 实现与验收完成并已合并（PR #123，exact-head CI run #554 通过）；WP2 新内容邮件通知已按 M3 交付代码与文档同步，真实 SMTP / 部署 dogfood 仍保留为发布门槛；WP5 赞助者鸣谢墙已按 M4 交付代码、测试与文档同步（PR #163，合并前仍以 exact-head CI 和 review closure 为准）；WP6 已按 2026-07-13 决策纳入本版并继续推进**。本文档定义 v1.1 的目标、产品优先级、实施顺序与发布门槛。
> 前置条件：`v1.0.0` 正式发布（已于 2026-07-06 完成，tag/Release/#88/#64 均已关闭）。不再设置固定发布后等待窗口；真实使用者不希望长期停留在半成品状态，后续工作按需求明确度、实现风险和验收质量推进。
>
> **决策记录（2026-07-13）**：维护者决定 WP6 自托管访客统计集成纳入 v1.1 本版范围；M4 的“明确决定 WP6 纳入本版或顺延 v1.2”已完成，发布验收按已纳入 WP 执行。
>
> **决策记录（2026-07-12）**：维护者决定取消“发布后 4–6 周稳定窗口”前置条件及 WP2–WP6 的等待要求，后续 WP 按 §4 里程碑串行推进。理由：发布后审计硬化已完成，真实使用者不应长期停留在半成品状态。下方 2026-07-07/07-08 两条例外记录保留原文，作为窗口制度存续期间的历史。
>
> **例外记录（2026-07-08）**：维护者明确授权第三主题 `wordpress`（WordPress 经典）作为 WP1 follow-up 提前实现；该例外仅覆盖第三内置主题与配套文档/测试，不代表 WP2–WP6 获得提前启动授权。
>
> **例外记录（2026-07-07）**：维护者在发布次日明确决定提前启动 WP1（第二主题 + 后台主题选择器），不等待稳定窗口结束。按本文档自身规则，此决定在此正式记录为对 M0 前置条件的一次显式例外，仅适用于 WP1；WP2–WP6 仍需等待稳定窗口结束后按 §4 里程碑顺序启动，不因本次例外自动提前。WP1 合并前仍须满足 §3 WP1 的全部验收项与合并前置门禁（G4、G6），PR #123 的既有 review 阻塞项须先解决。

## 1. 版本主题与背景

**一句话主题：不只画师——写作者与赞助创作者也能用它拥有自己的会员站。**

决策依据：

1. **创作者本人成为第一个真实用户。** 维护者将以「博客 + 赞助」场景运营自己的正式实例。
2. **扩大适用人群而不改变定位。** 继续坚持单创作者、自托管、Core 掌握权限与商业规则。
3. **复用已有基座。** 六个工作包复用 Theme 契约、S5 邮件可靠性、durable outbox、S6 CSP、`site_settings` 配置中心与 i18n。

## 2. 产品优先级与实施顺序

工作包编号表示**产品优先级**：WP1 → WP2 → WP3 → WP4 → WP5 → WP6。WP6 原为溢出项，已按 2026-07-13 决策纳入本版。

实际施工按 §4 里程碑串行执行。施工顺序可以为了先铺门禁、降低风险或先交付小件而与产品优先级不同；两者不得再混写成同一个“顺序”。

## 3. 范围：六个工作包

### WP1 博客主题 + 后台主题选择器

- **用户故事**：创作者可把站点作为文字优先博客，并在后台安全切换主题。
- **范围内**
  - 第二个内置 Blog 主题：文章列表流、正文阅读排版、暗色模式与现有字体/颜色预设兼容。
  - WP1 follow-up：第三个内置 WordPress 经典主题（主栏 + 侧栏、文章摘要流、经典单篇阅读页），两套固定色彩预设。
  - 后台「外观」页站点级主题选择器，修改立即生效并写入 audit 事件。
  - 已落地主题共用 Core view-model；主题不得旁路取数、访问数据库、处理权限或读取 secret。
- **范围外**：主题包上传/安装、主题市场、per-post 主题、第三方主题生命周期。
- **合并前置门禁**
  - known-gaps G4：zh/en/ja key 完整性 CI；
  - known-gaps G6：关键公开页 × 明暗模式 × 已落地主题的 Playwright 视觉回归基线；
  - 契约盘点：缺字段时先扩 Core 契约并同步内置主题。
- **实现要点**
  - 使用编译期静态注册表，无动态加载或上传面。
  - 主题及公开浏览器配置使用明文 `site_settings`；`app_settings` 已存在，专用于加密服务配置。
  - 主题配置按主题 id 分键，但修改单个主题不得使用无锁的整 JSON 读改写；使用数据库事务、行锁/版本检查或原子 `jsonb_set` 避免并发丢失更新。
  - 配色保存、活动主题切换与 audit 记录必须在同一事务边界内，失败时不能留下半更新。
  - 管理员写接口先认证，再读取和进行业务 schema 校验。
  - 主题 id 使用 own-property/显式枚举校验，不能用会接受原型属性的 `in`。
- **验收**
  - [x] PR #123 完成 `builtin`/`blog` 阶段视觉验证（G6）与组件身份断言；WordPress follow-up 在本 PR 中把 G6 扩展到 `builtin`/`blog`/`wordpress` 三主题，并额外覆盖 WordPress `layer-seal` 预设首页和 390px 移动端 Home/Posts/PostDetail。代表性权限 smoke 覆盖 Blog 与 WordPress 下公开、登录可见、会员可见和 admin API。完整权限决策继续由未变更的 Core 权限矩阵覆盖。
  - [x] 已落地主题的全部具名预设与自定义 hue 能力通过参数化功能测试（`component-identity.test.ts` 覆盖 builtin、blog 的 hue/none 预设与 WordPress 的 fixed vars 预设）；zh/en/ja 通过 G4 key 完整性门禁及逐语言浏览器 smoke；视觉回归集中覆盖默认预设下存在布局分歧的关键页面与明暗模式（G6）。
  - [x] 主题切换无需重启，且配置、活动主题和 audit 原子提交。`applyThemeUpdate` 真实 Postgres 集成测试直接验证。
  - [x] 并发修改不同主题配置不会丢失更新。真实 Postgres 并发测试直接验证（锁机制测试 + 业务结果测试）。
  - [x] G4/G6 门禁已进入 CI，空分类/标签等内容形态无可见渲染异常。两门禁均已在 `pnpm test:e2e`/`pnpm test` 中运行；空分类/标签有专项回归测试。当前 CI 通过/失败状态以 PR #123 为准，不在本文档重复断言。
  - [x] Theme 边界不变。独立 fresh-context review 确认：主题渲染仅消费 view-model，无运行时加载、无数据库访问。
- **预估**：大。

### WP2 新内容邮件通知

- **用户故事**：粉丝可显式订阅新内容邮件；创作者可在不影响事务邮件的前提下触达读者。
- **范围内**
  - 用户侧通知偏好，默认关闭、显式 opt-in。
  - 首次发布和定时发布到点触发；恢复为草稿后再次发布、重新编辑或重新发布不重复。
  - 收件人是发送时账号仍存在且显式 opt-in 的粉丝；管理员身份本身不构成收件资格，管理员账号只有同时满足普通粉丝资格时才接收。login 内容不要求发送时存在活跃 session 或在线登录状态；member 内容使用现有 effective active membership level 判断。
  - zh/en/ja 邮件，标题/摘要优先使用收件人 locale 的已发布译文。
  - 无需登录的一键退订，重新开启偏好后旧 token 失效。
  - 事务邮件与通知邮件分优先级；通知预算、限速和 defer 不得延迟登录码、付款或续费邮件。
  - 每日预算、pacing、campaign 游标分页展开与幂等；取消仅指取消定时发布（campaign 创建前），已创建 campaign 的撤回不在 v1.1 范围内。
- **收件人和隐私**
  - 通知任务 payload 只存 `userId`，发送时读取最新邮箱、偏好和抑制状态。
  - 本 WP 收敛 G1：terminal 历史任务可直接脱敏；仍可重试/发送的任务必须先迁移为 `userId` 或领域对象引用，并验证发送时可正确解引，再删除 payload 中的 `to`。
- **退信抑制的明确边界**
  - Core 必须抑制**同步 SMTP 永久拒绝**：发送阶段返回明确 `5xx`/permanent failure 时，把地址加入“通知邮件抑制列表”。
  - SMTP 返回 accepted 只代表对方服务器接收，不代表最终投递成功。没有入站 DSN、provider webhook 或受控退信邮箱时，系统不得声称可以自动识别异步退信。
  - 异步 DSN/provider bounce ingestion 属后续可选 adapter；只有实现并完成真实 provider 验收后，才可扩大“硬退信自动抑制”的产品承诺。
  - 抑制列表只影响批量通知；验证码、付款等事务邮件不自动受该列表约束。
- **实现要点**
  - 在首次 `post.published` 状态变更的同一数据库事务内，以唯一 `postId` 创建 campaign；发布状态或 audit 提交失败时 campaign 一并回滚。恢复为草稿后再次发布不得创建第二个 campaign；取消或 stale schedule 不得创建 campaign。
  - campaign 使用 keyset 游标分页展开 per-recipient delivery；`(campaignId, userId)` 唯一约束保证 delivery 记录和任务不重复创建。
  - SMTP 投递语义为 at-least-once：不承诺不重复投递。唯一约束不等于 exactly-once；SMTP accepted 后、任务标记成功前进程崩溃仍可能造成邮箱重复。
  - WP2 新增明确的 per-recipient delivery 账本作为预算事实源；UTC 日预算统计“实际进入 SMTP handler 的发送尝试”，而不是排队任务数。每次尝试及其 accepted/permanent failure/defer 结果必须可审计，并为 UTC 日聚合与 campaign 游标查询提供匹配索引。
  - 先定义持久化通知偏好记录及原子递增的偏好版本。退订 token 包含用途、格式版本、`userId` 和偏好版本，采用 purpose-separated HMAC 与常量时间校验，不新增 token 表。
  - 退订密钥不得直接绑定到无过渡轮换的单一 session secret。实施前必须确定并文档化稳定专用密钥，或支持 current/previous keyring 的有界轮换窗口；备份恢复必须保留仍在有效期内 token 的校验能力，超过窗口的旧 token 明确失效。
  - 采用显式、可索引的优先级与事务邮件保留容量设计；claim 查询必须有匹配索引、固定批量和确定性顺序，不能通过全表排序破坏 #101 已记录的任务性能边界。通知任务需证明最终可推进，不能因保留容量而永久饥饿。
- **验收**
  - [ ] public/login/member 收件集合符合账号仍存在、显式 opt-in、管理员非旁路和 effective active membership level 规则；login 收件资格不依赖活跃 session 或在线状态。
  - [ ] 首次/定时发布与 campaign 创建同事务且每个 `postId` 最多一条；恢复草稿后再发布、取消定时和 stale schedule 均不新增 campaign。
  - [ ] SMTP 故障进入 S5 defer/dead，不阻塞发布事务。
  - [ ] 退订无需登录；偏好版本原子递增，重新开启后旧 token 失效；密钥轮换与备份恢复语义按已选方案验证。
  - [ ] campaign 分页有界；UTC 日预算基于 delivery 尝试账本，跨日后继续处理且不重复创建 delivery/任务。
  - [ ] 故障注入证明 accepted 后崩溃可能重投，系统按 at-least-once 恢复且不宣称 exactly-once。
  - [ ] 大量通知积压和持续事务邮件并存时，索引化 claim 仍保持有界；事务邮件保留容量可用，通知任务亦在规定窗口内持续推进而不饥饿。
  - [ ] 同步 SMTP permanent failure 进入通知抑制列表；accepted 邮件不会被误报为已完成最终投递。
- **预估**：中到大。
- **M3 交付状态（2026-07-12）**：WP2 Phase 1–6 已在 `feat/wp2-email-notifications` 分阶段提交，覆盖 schema/任务优先级、campaign 展开、delivery/quota/suppression、退订 UI/API、G1 payload 隐私迁移、restore/backup key continuity，以及本轮 docs/release-gate sync。代码侧验收不等于发布验收；需要真实部署或真实 SMTP 的项目不得在此处标记完成。
- **待 dogfood / 发布门槛**：真实 SMTP accepted send、同步 permanent rejection、operator defer、退订 headers 与 safe logging；带通知 key 的 backup/restore drill；`v1.0.0` 原地升级到 WP2 migration；创作者实例 dogfood 后确认退订率、重复投递残余与后台 observability 文案。

### WP3 RSS / Atom 输出

- **范围内**
  - `/feed.xml` Atom，只包含 public 内容；标题、摘要、发布时间、规范链接与稳定 GUID。
  - 最多 100 条；`ETag`/`Last-Modified` 条件请求和短 `s-maxage`。
  - `/feed.xml` 不因 cookie 或 `Accept-Language` 改变：固定使用应用 `DEFAULT_LOCALE`；存在该 locale 的 `status=published` 译文时使用译文，否则回退到文章原始已发布内容。
  - GUID 使用基于 post id 的不透明永久标识，slug 修改不改变；绝对链接统一以 `APP_URL` 生成。
  - 当前公开路由没有独立、稳定、可抓取的 locale URL，因此 v1.1 feed 不输出翻译 alternate link；未来只有先建立该 URL 契约后才可加入。
- **范围外**：私有 token feed、podcast 扩展、JSON Feed。
- **验收**
  - [ ] Miniflux/Feedly 与 W3C validator 通过。
  - [ ] login/member 内容及其图片 URL 不进入 feed。
  - [ ] 输出使用与页面一致的安全转义/渲染规则。
  - [ ] 相同内容状态下，cookie/header 不改变 feed、ETag 或缓存身份；只有已发布译文可进入固定 locale 投影。
  - [ ] feed 严格限制 100 条，使用 `(publishedAt, id)` 确定性 keyset 顺序及匹配的 public-content 索引；集成测试或基准证明无 offset、无无界全量排序。
  - [ ] `ETag`/`Last-Modified` 条件请求返回 304；GUID 在 slug 修改后保持不变，绝对链接均以 `APP_URL` 生成。
- **预估**：小。

### WP4 内容 SEO：sitemap + 分享卡片

- **范围内**
  - `sitemap.xml`：public 内容和公开列表页；每个 sitemap 最多 50,000 个 URL，超限使用 sitemap index。
  - 文章 `og:*`、`twitter:card`、canonical。
  - 显式 `robots.txt`。
  - login/member 内容 `noindex` 且不进 sitemap。
- **范围外**
  - v1.1 不承诺 `hreflang`：当前 locale 由 cookie/header 在同一 URL 上选择，不能形成互异、稳定、可抓取的 alternate URL。未来须先定义 locale URL、canonical 与迁移契约，再单独立项。
- **实现要点**
  - 非-public 文章只返回站点级通用 metadata 与 `noindex,nofollow`；不得输出文章标题、摘要、封面、分类、翻译或 tier 信息。
  - sitemap 只消费集中式 public projection，不复用会解析受限文章 metadata 的页面路径。
  - sitemap 分片严格限制 50,000 个 URL，使用 `(publishedAt, id)` 确定性 keyset 分页及匹配的 public-content 索引；不得使用 offset 或无界全量排序。
- **验收**
  - [ ] Google/Bing 校验工具通过。
  - [ ] 非-public 内容不可被 sitemap/meta 发现，响应 metadata 不泄露文章标题、摘要、封面、分类、翻译或 tier 信息。
  - [ ] public 内容 canonical 与真实分享抓取正常；站点级通用 metadata 不包含受限文章字段。
  - [ ] 超限时生成 sitemap index；集成测试或基准证明 keyset 查询命中匹配索引、无 offset、无无界全量排序。
- **预估**：小到中。

### WP5 赞助者鸣谢墙

- **前置**：粉丝账号页新增显示名编辑；未设置显示名时任何路径不得回落到邮箱。
- **范围内**
  - 默认关闭、用户显式 opt-in 的支持者页。
  - 每个用户最多展示一行；资格使用现有 effective active membership 模型：`status=active` 且 `startsAt <= now < endsAt`，重叠会员取最高 level。tier 停售不撤销既有资格；到期是时间条件，不是 membership status。
  - 展示显示名和 effective 等级，不展示金额或邮箱。
  - 一次性纯文本献词，长度上限、URL 不自动链接、先审后展示、无回复/楼层。
  - 创作者可关闭功能、限制等级、批准/隐藏内容。
  - 会员不再满足 effective active 条件、被暂停/撤销或付款反转时，下一次公开查询立即下墙。
- **实现要点**
  - 可见性查询时派生，不创建定时“下墙”任务。
  - `supporter_wall_entries` 以 user id 唯一约束保证每个用户最多一条 entry；状态机及审核动作写 audit。
  - 公开查询不缓存会员资格或最终可见名单；每次请求按当前会员、opt-in、显示名、等级限制和审核状态派生，避免 TTL 与“立即下墙”冲突。
  - 鸣谢墙作为共享 Core 页面，三个内置主题消费同一受权限保护的 view-model；不在主题中旁路取数。若实现需要新增 Theme component slot，必须先扩展静态主题契约并同步三主题。
  - 显示名修改走独立粉丝账号写接口，必须先认证、再有界读取/校验 body；未设置显示名时任何页面、日志或 API 均不得回落到邮箱。
- **验收**
  - [x] 默认不泄露身份；未设置显示名不展示。
  - [x] user id 唯一约束和真实 PostgreSQL 并发测试证明每个用户最多一条 entry；待审核、已批准、已隐藏状态及转换有测试，未批准内容在页面和任何页面缓存中均不可见。
  - [x] 输入纯文本安全、URL 不可点击、无 HTML 注入。
  - [x] effective membership 重叠取最高 level；tier 停售不下墙；到期、暂停、撤销和付款反转后下一次公开查询立即下墙。
  - [x] 显示名写接口通过 auth-before-body 与有界 body 门禁，且无邮箱 fallback。
  - [x] 创作者关闭功能后页面不可见；等级限制生效时低于门槛的会员不出现在墙上。
  - [x] `builtin`/`blog`/`wordpress` 三主题及 zh/en/ja 通过 G4 key 完整性；静态契约新增必选 `SupporterWall` 槽并同步三主题，G6 覆盖代表性桌面/移动端鸣谢墙基线与共享 Core 页面渲染/权限 smoke。
- **预估**：中。

### WP6 自托管访客统计集成（已纳入 v1.1）

- **范围内**
  - 基于现有 `site_settings.public_integrations` 与 S6 adapter/revision 机制补充可选 Umami adapter、配置校验、公开页注入、集成状态和部署文档。
  - 现有 Plausible adapter 只做回归、兼容性和文档验收，不重复实现。
- **范围外**：自建统计、内嵌仪表盘、默认遥测。
- **验收**
  - [ ] 未配置时零注入、零请求。
  - [ ] Umami 配置后通过现有 public integration 路径在强制 CSP 下工作，仅现有公开页集合注入；revision 变更可刷新派生 CSP，配置不完整回显且变更有 audit。
  - [ ] Plausible 现有行为、公开页边界和部署文档保持回归通过。
  - [ ] 后台集成状态正确反映 Umami 配置；Umami 部署文档（含 CSP 说明）随本 WP 交付。
- **预估**：小；已按 2026-07-13 决策纳入本版，若需顺延须另行记录维护者决策。

## 4. 实施里程碑

```text
M0  v1.0.0 发布 + 发布后审计硬化完成
M1  [已完成] G4 i18n 完整性门禁 + G6 视觉基线 + WP1
M2  WP3 RSS + WP4 SEO
M3  [已交付] WP2 邮件通知（真实 SMTP / 部署 dogfood 仍是 M5 发布门槛）
M4  [已交付] WP5 鸣谢墙；[决策完成] WP6 已于 2026-07-13 纳入本版
M5  v1.1 验收与发布（验收 M4 结束时已明确纳入的 WP；WP6 已纳入本版）
```

M1 已完成，M4 的 WP5 已交付；M2–M5 目标总体量为 6–8 周。WP6 不再按默认溢出项自动顺延；若后续需顺延，须另行记录维护者决策。WP1–WP5 已进入 v1.1 验收范围。

每个里程碑合并后由创作者实例 dogfood。发现回归时，在下一个里程碑前优先修复。

## 5. v1.1 范围外与后续候选

| 项 | 状态 | 理由 / 触发条件 |
|---|---|---|
| 邮件 Magic Link | Phase 8 Core Auth 候选 | 可复用现有 SMTP、验证码登录、Turnstile、限流与 session 基座；需要一次性 token、短有效期、重放保护、redirect allowlist 与邮件客户端预取防误登录 |
| Google / GitHub OAuth | Phase 8 Core Auth 候选 | 作为粉丝登录补充入口；管理员登录第一版继续邮箱 + 密码；后台加密配置 client secret，保留邮箱验证码 fallback |
| Membership Bundle | Phase 8 Membership 候选 | 作为会员等级权益表达增强，可先在 `membership_tiers` 配置白名单 entitlements；第一版不引入通用 `EntitlementGrant`，不与 PPV/Tips 绑定 |
| 评论系统 | 不做 | 反垃圾、审核、法务和对话状态不进入 Core |
| 一次性无等级打赏 / PPV | 观察 | 当前人工收款流程可覆盖；需先验证真实运营需求，并明确授权语义、退款/撤销和文件鉴权后再立项 |
| 视频封面/缩略图/时长 | v1.2 候选 | 与写作者主题不同线，避免版本失焦 |
| 主题包上传 / 主题市场 | 维持 ⏸ | 不规划第三方主题生命周期；如需要，作为官方内置主题能力单独评估 |
| Plugin runtime / Hub / HA | Plugin/Hub 暂不规划；HA 维持 roadmap 触发条件 | 不进入 v1.1 Core；Hub 未来只有在真实运营证明需要跨站发现时再作为独立产品方向重新评估 |

## 6. 发布门槛

- [ ] 全部纳入范围的 WP 验收通过；实际 CI 门禁以 `.github/workflows/ci.yml` 与 `.github/workflows/restore-drills.yml` 为事实源。`ci.yml` 当前覆盖 lint / format / request-body 与 auth-before-body 检查、TypeScript、真实 PostgreSQL 集成测试、restore 工具构建与脚本静态/边界检查、构建与 e2e；`restore-drills.yml` 覆盖 nested-upload、legacy v1 与 S3/MinIO restore E2E drills。
- [ ] G4 i18n key 完整性和 G6 已落地主题视觉回归持续为绿；G6 已扩展覆盖 WP5 新公开表面，并须在最终发布验收持续为绿。
- [ ] feed、sitemap、通知路径及 WP5 鸣谢墙纳入跨切面权限测试和有界性检查。
- [ ] 邮件通知在真实 SMTP 完成发送、同步 permanent rejection、defer/retry、预算、退订 headers/safe logging 与事务优先级验证。
- [ ] WP2 campaign 事务围栏、唯一约束、优先级/保留容量和并发恢复使用真实 PostgreSQL 测试；任何新增文件引用继续遵守现有锁顺序、事务和触发器完整性约束。
- [ ] zh/en/ja UI、邮件和公开页完整。
- [ ] 从 v1.0.0 原地升级与备份恢复演练通过。
- [ ] CHANGELOG、PRD、roadmap、admin/deployment 文档和三语官网同步。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| WP2 挤占事务邮件或通知饥饿 | 索引化优先级、事务邮件保留容量、每日预算、pacing、defer；负载验收同时证明事务邮件及时且通知持续推进 |
| SMTP accepted 被误当作最终投递 | Core 只承诺同步 permanent failure；异步 DSN/webhook 另行设计和验收 |
| SMTP at-least-once 造成重复邮箱 | 文档明确不承诺不重复投递；delivery/任务创建幂等，accepted 后崩溃故障注入验证恢复行为 |
| 批量邮件损害信誉 | 严格 opt-in、退订、pacing、同步永久失败抑制、SPF/DKIM/DMARC 文档；RSS 分流 |
| 单人维护并行过多 | 按 M2→M5 串行；WP6 预设可砍 |

已解决历史（不再作为 v1.1 未决风险）：

- WP1 已完成主题契约盘点并同步 `builtin`/`blog`/`wordpress`；WP5 已扩展必选 `SupporterWall` 槽并补齐三主题、G4/G6 与权限覆盖。后续要求这些门禁持续为绿。
- 主题配置并发与半更新风险已由数据库原子更新/锁、配置/活动主题/audit 同事务及真实 PostgreSQL 并发测试关闭。

## 8. 成功信号

- 创作者自己的实例以博客主题日常运营并愿意继续使用。
- 出现至少一个非画师身份的真实部署者。
- 通知邮件有真实发送和退订数据且退订率不异常。
- showcase / Discussions 出现主题或分发相关反馈。

发布后 4 周复盘，并据真实使用确定 v1.2 主题。
