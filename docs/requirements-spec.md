# OpenLayerlyPro 软件需求规格说明书（SRS）

> 本文档是从 `main` 分支实现代码反推得到的**完整需求基线**，目标是：仅凭本文档 + 技术选型，
> 即可重建一个行为等价的系统。
>
> - 定位与取舍背景见 [PRD](./PRD.md)；阶段顺序见 [roadmap](./roadmap.md)；设计权衡见 [ADR](./adr/README.md)。
> - 本文档只描述**需求**（做什么、必须满足什么约束），不描述实现细节；代码位置只作为追溯线索。
> - 需求编号规则：`FR-<域>-<序号>` 功能需求，`NFR-<类>-<序号>` 非功能需求，`CON-<序号>` 约束，`OUT-<序号>` 范围外。
> - 关键字含义：**必须**（MUST）、**不得**（MUST NOT）、**应当**（SHOULD）、**可以**（MAY）。
> - 基线版本：`1.1.0` 已发布，v1.2 工作包（Magic Link / OAuth / Membership Bundle / 债务包）已在 `main` 合并。

---

## 1. 范围与目标

### 1.1 产品定义

OpenLayerlyPro 是一套**开源、自托管、单创作者会员站系统**：一次部署服务一位画师/创作者（或一个创作团队），
数据与收款完全归创作者所有。创作者发布作品，粉丝付费成为会员，会员按等级浏览和下载内容。

### 1.2 业务目标

| 编号 | 目标 |
|---|---|
| G-1 | 创作者可在不依赖任何第三方平台抽成的前提下运营会员制内容站 |
| G-2 | 支持无信用卡地区：收款码 + 付款截图 + 人工审核可独立完成完整商业闭环 |
| G-3 | 支持有卡地区：Stripe 一次性付款与自动订阅续费，无需人工介入 |
| G-4 | 会员权限、文件下载与付款状态之间的一致性在任何失败路径下都不被破坏 |
| G-5 | 家庭服务器/NAS/无公网 IP 环境可部署（Cloudflare Tunnel） |
| G-6 | 技术型自托管者可独立完成部署、升级、备份与恢复 |

### 1.3 目标用户

| 角色 | 描述 |
|---|---|
| 创作者（运营者） | 独立画师/创作者，同时是系统管理员与运维者；能操作 Docker Compose、PostgreSQL、SMTP、对象存储 |
| 粉丝 / 会员 | 通过邮箱进入站点、付费、浏览与下载内容的终端用户 |
| 访客 | 未登录用户 |

### 1.4 范围外（明确不做）

| 编号 | 范围外项 | 理由 |
|---|---|---|
| OUT-1 | 多创作者入驻平台、内容广场、推荐流、跨站聚合发现（Hub） | 与单站定位冲突；如需另立产品方向 |
| OUT-2 | 评论、点赞、收藏、关注等社交互动 | 非核心闭环 |
| OUT-3 | 粉丝密码注册 | 认证入口限定为邮箱验证码 / Magic Link / OAuth |
| OUT-4 | 第三方插件 runtime、插件市场、主题市场、主题包上传 | 生命周期/权限/隔离/兼容性成本过高 |
| OUT-5 | 完整视频媒体处理（转码、HLS/DASH、自动封面、时长、缩略图、多段 Range） | 仅支持原文件内联播放与单段 Range |
| OUT-6 | 多实例共享限流、任务协调与高可用编排 | v1 运行边界为单实例 |
| OUT-7 | 移动 App | Web 响应式即可 |
| OUT-8 | 管理员 Magic Link / 管理员 OAuth / passkeys | 管理员认证边界固定为邮箱 + 密码 |
| OUT-9 | 通用 `EntitlementGrant` 并行授权系统 | 权益只挂在 tier 上、实时解析 |
| OUT-10 | AI 翻译本地强制用量预算 | `monthlyCharLimit` 仅记录展示，用 provider 侧硬限额 |

---

## 2. 角色、认证与权限

### 2.1 角色模型

系统只有两个持久化角色：`admin`、`member`（`users.role`）。访客是无 session 状态。

- **单管理员语义**：站点初始化创建唯一管理员；后续管理员账号维护通过后台或一次性脚本完成。
- 粉丝账号**按需创建**：首次通过任一登录入口验证邮箱成功即创建 `role='member'` 用户。

### 2.2 权限矩阵

| 能力 | 访客 | 会员/粉丝 | 管理员 |
|---|---|---|---|
| 浏览 `public` 内容 | ✅ | ✅ | ✅ |
| 浏览 `login` 内容 | ❌ | ✅ | ✅ |
| 浏览 `member` 内容 | ❌ | 等级达标才可 | ✅ |
| 下载内容附件 | 仅当授权来源作品为 public | 按作品权限 | ✅ 全部 |
| 提交付款申请 / 上传凭证 | ❌ | ✅ | ✅ |
| 查看自己的付款凭证 | ❌ | ✅（仅本人上传） | ✅ |
| 管理内容、会员、付款、文件、配置、任务 | ❌ | ❌ | ✅ |

**FR-AUTH-01** 管理员通道与粉丝通道必须相互隔离：管理员**必须**使用邮箱 + 密码登录；管理员邮箱**不得**通过 Magic Link 建立 session。

**FR-AUTH-02** 所有 `/admin/**` 页面与 `/api/admin/**` 接口必须要求 `role='admin'` 的有效 session；非管理员访问必须失败且不泄漏资源存在性差异。

### 2.3 会话（Session）

**FR-SESS-01** 会话必须以随机 token 建立，服务端**只存 token 的 keyed 摘要**（HMAC），不得存明文 token。

**FR-SESS-02** 会话 cookie 必须为 `HttpOnly`，生产环境 `Secure`，并带 `SameSite` 约束；有效期 **30 天**，服务端 `sessions.expires_at` 为权威判据。

**FR-SESS-03** 会话记录必须保存 `ip`、`user_agent`、`created_at`，供管理员在后台查看与吊销。

**FR-SESS-04** 管理员必须能够：列出自己的活跃 session、吊销指定 session、一键吊销除当前之外的全部 session。

**FR-SESS-05** 修改管理员邮箱或密码后，必须触发既有 session 的失效处理，并记录账号变更历史。

### 2.4 粉丝登录：邮箱验证码

**FR-CODE-01** 粉丝输入邮箱后，系统必须生成一次性登录码并通过邮件发送。

**FR-CODE-02** 登录码策略：默认 **16 位** **Crockford Base32**（大写、去易混字符，≈80 bit 熵），长度与字母表可配置；有效期 **10 分钟**；单次使用。

**FR-CODE-03** 服务端**只存登录码的 keyed 摘要**；明文码只出现在发出的邮件中，不得进入日志、任务 payload 明文、后台响应或审计负载。

**FR-CODE-04** 邮件投递必须走 durable task（`auth.login_code_email`，事务型队列，最高优先级）；在流转中的收件人信息必须加密保存，任务 payload 不得持久化明文收件人地址。

**FR-CODE-05** 相同邮箱在 `REQUEST_CODE_SEND_DEDUPE_SECONDS`（默认 60s）内的重复请求必须去重，不重复发信。

**FR-CODE-06** 请求响应必须抵抗账号枚举：邮箱是否存在、是否发送成功，对外表现一致。

**FR-CODE-07** 校验必须先消耗**与目标无关**的来源比较预算，再执行真实比较；仅在结果为错误/过期后才消耗**目标相关**（email+IP）失败预算。此设计目的是：远程攻击者无法通过持续错误尝试锁死指定受害者账号。

### 2.5 粉丝登录：邮件 Magic Link

**FR-ML-01** 粉丝可请求"登录链接"邮件，点击链接后**必须**落在一个**非消费**的确认页；只有用户显式 POST 确认才消费 token 并创建 session（防邮件客户端预取误登录）。

**FR-ML-02** token 服务端**只存 keyed HMAC 摘要**并记录 `key_id`；有效期 **15 分钟**；单次使用，消费必须为条件更新（CAS）——只有"摘要 + key_id + 未消费 + 未过期"的第一笔事务能建立 session。

**FR-ML-03** token 消费、用户创建/登录元数据更新、session 插入**必须在同一个数据库事务内**；session 插入失败必须整体回滚，使一次性链接仍可重试；session cookie 只在提交成功后写出。

**FR-ML-04** 管理员边界：对已存在的管理员邮箱的请求必须**静默抑制**（不生成 token、不入队投递）；角色提升前签发的链接在消费时必须被作废且不创建 session。

**FR-ML-05** 登录后跳转只允许**站内相对路径白名单**；必须拒绝 open redirect。确认完成后必须跳转到**不含 token 且已剥离 query** 的结果 URL。

**FR-ML-06** 携带 token 的页面与接口响应必须设置 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`、`X-Robots-Tag: noindex`。

**FR-ML-07** Magic Link 必须使用独立的 `current + previous` 双密钥环（与会话密钥、通知密钥分离），支持轮换；未配置时登录页必须隐藏该入口；配置不完整必须在启动时 fail-closed。

**FR-ML-08** 必须记录 request / send / consume / replay / expired / rejected 安全事件，但只保留安全摘要，不含明文 token。

### 2.6 粉丝登录：Google / GitHub OAuth

**FR-OAUTH-01** 必须支持 Google 与 GitHub 作为**粉丝/会员**登录入口；管理员不使用 OAuth。两者均在后台加密配置，默认关闭。

**FR-OAUTH-02** 授权流必须使用 **PKCE(S256)** 与一次性 `state`：`state` 只存摘要、`code_verifier` 加密存储、绑定浏览器 cookie、带过期与单次消费。

**FR-OAUTH-03** 账号解析规则（身份优先）：
1. 若 `(provider, provider_account_id)` 已绑定 → 直接登录该用户；**不得**因 provider 侧邮箱变化而重绑本地邮箱。
2. 未绑定时，provider 必须返回**已验证**邮箱，否则拒绝登录。
3. 邮箱已存在 → 绑定到该用户；不存在 → 创建 `member` 用户。
4. 用户创建与身份绑定必须在**同一事务**内；并发首次绑定竞争必须整体回滚，不得留下孤儿用户；失败方必须幂等地解析到胜出者并完成登录。

**FR-OAUTH-04** 未认证的 OAuth start 接口必须限流，以约束 `oauth_states` 行的创建速率。

**FR-OAUTH-05** 登录被拒时必须记录结构化安全事件（`identity_user_missing` / `email_unverified` / `identity_insert_race` 等），不向前端泄漏内部原因细节。

### 2.7 人机验证与限流

**FR-RL-01** 开启 Cloudflare Turnstile 时，服务端必须在**发送验证码/链接之前**校验 token；`TURNSTILE_SECRET_KEY` 仅服务端使用，不得进入 `NEXT_PUBLIC_*`。

**FR-RL-02** 真实客户端 IP 必须**只信任显式配置的代理层**（`TRUSTED_PROXY_HEADER` + `TRUSTED_PROXY_HOPS`）；默认 `hops=0` 表示不信任任何转发头。对 `x-forwarded-for`，客户端 IP 为从右数第 HOPS 个条目。

**FR-RL-03** 无法解析可信 IP 时，**不得**跳过限流，也**不得**并入正常低阈值 per-IP 桶；必须落入**按操作独立的高阈值 unresolved 应急桶**，并输出限频告警日志。

**FR-RL-04** 必须实现以下独立限流域（默认值见 §11 配置清单）：管理员登录、验证码请求（IP / email+IP）、验证码比较（来源硬预算 / unresolved）、验证码错误计数（email+IP）、OAuth start、文件预授权、视频 Range、匿名下载。

---

## 3. 站点初始化与配置中心

### 3.1 初始化

**FR-INIT-01** 首次访问必须进入 `/admin/setup`；提交站点名称、创作者名、简介、管理员邮箱与密码后完成初始化。

**FR-INIT-02** 初始化必须在单个事务内：创建/提升管理员账号、写入默认会员等级、写入站点设置（`initialized`、`site_name`、`artist_name`、`artist_bio`、`social_links`）。

**FR-INIT-03** 已初始化站点必须拒绝再次初始化（403）；并发初始化请求必须只有一个生效。

**FR-INIT-04** 初始化必须记录运维事件（`site_initialized`）。

### 3.2 配置分层语义

**FR-CFG-01** 系统必须提供两类配置存储：
- `site_settings`：**明文** JSON，公开或非敏感站点设置。
- `app_settings`：整组配置 JSON 的 **AES-256-GCM 密文**，用于含密钥的集成配置。

两者必须分表存储，不得混存。

**FR-CFG-02** 最终配置语义按组固定：

| 配置组 | 语义 |
|---|---|
| SMTP、Turnstile、Storage、Upload | **DB > env > default**；删除 DB 组可回落到环境变量 |
| Stripe、Translation、OAuth(Google/GitHub) | 后台加密配置，默认关闭；敏感 key 不回传前端 |
| `UPLOAD_DIR`、代理/网络/限流/队列/通知预算 | 仅部署层（环境变量），不在后台可编辑 |

**FR-CFG-03** 内容附件上限直接采用 `DB > env`；付款凭证/收款码上限**不得高于** env 上限（env 为天花板）。

**FR-CFG-04** 配置修改必须立即生效、无需重启。若未来引入缓存，必须同时设计跨进程 revision/失效策略。

**FR-CFG-05** 配置加密根密钥（`CONFIG_ENCRYPTION_KEY` / `_FILE`）与 `SESSION_SECRET`、通知密钥、Magic Link 密钥必须是**互相独立的**秘密，各自有独立的备份/恢复语义。生产环境缺失可用根密钥时，就绪检查必须失败。

**FR-CFG-06** 后台必须能对每个配置组执行读取（脱敏）、保存、删除（回落）、以及连接测试（若该集成可测）。

### 3.3 站点信息与品牌

**FR-SITE-01** 管理员必须能配置：站点名称、创作者名、简介、社交链接列表、头像、站点 logo、站点 icon。

**FR-SITE-02** 管理员必须能配置**自定义页脚代码**（用于统计/第三方脚本）。该能力必须与 CSP 协同：存在尚未迁移的可执行 legacy 页脚时，CSP 走 Report-Only；迁移完成后 enforce（见 FR-SEC-03）。

**FR-SITE-03** 公开站点信息接口必须只返回公开字段，不得泄漏管理员邮箱或任何配置密钥。

---

## 4. 会员与等级

### 4.1 会员等级（Tier）

**FR-TIER-01** 等级字段必须包含：名称、slug（唯一）、描述、价格文案、`level`（整数，权限比较依据）、`duration_days`（默认 31）、`purchase_enabled`、`is_active`、排序、可选金额/币种、可选 `stripe_price_id`、`entitlements`。

**FR-TIER-02** `level` 是**唯一的内容/文件权限比较维度**：用户有效等级 `level >= 作品要求 tier.level` 即可访问。

**FR-TIER-03** 停售（`purchase_enabled=false`）或停用（`is_active=false`）**不得**影响已发放的会员权益。

**FR-TIER-04** 创建/更新等级必须携带**非空审计 reason**（长度上限 500 字符），并在同一事务内写入 before/after 审计快照。

**FR-TIER-05 权益包（Membership Bundle）** `entitlements` 必须是 **Core 白名单**（当前：`early_access`、`behind_the_scenes`、`supporter_recognition`），未知 key 必须 fail-closed 拒绝；迁移默认值为非空约束的空数组。权益必须**仅从当前有效会员的实时 tier 行解析**，不得引入并行授权来源；第一版权益为**信息性展示**（公开等级卡与会员中心显示三语权益说明），不改变内容/文件鉴权边界。

### 4.2 有效会员与访问派生

**FR-MEM-01** "当前有效会员"定义：`status='active'` 且 `starts_at <= now < ends_at`。多条重叠时取 `tier.level` 最高者（同级取 `ends_at` 更晚者）。

**FR-MEM-02** 内容与文件鉴权必须共用**同一个** Core 会员边界派生函数，输出 `{ 有效会员, level, entitlements }`。不得在主题层或其他模块重复实现权限判断。

### 4.3 生命周期

**FR-MEM-03** 会员状态机为 `active | suspended | revoked`，允许的转换：

| 动作 | 前置条件 | 结果 |
|---|---|---|
| suspend | `active` | `suspended`；已是 `suspended` 返回"已处于该状态" |
| resume | `suspended` | `active`；已是 `active` 返回"已处于该状态" |
| revoke | 非 `revoked` | `revoked` |
| extend | 非 `revoked` 且 `ends_at > now` | 延长 N 天 |

非法转换必须返回明确错误码，不得静默成功。

**FR-MEM-04** 每条状态变更必须携带 `expectedVersion` 做**乐观并发控制**，版本不匹配必须失败。

**FR-MEM-05** 每条状态变更必须记录 reason 与审计事件（含 actor 类型 admin/system、correlation/causation）。

### 4.4 授予（Grant）

**FR-MEM-06** 同一用户的全部会员授予必须在**事务级 advisory lock** 下串行化，防止并发付款确认导致时间窗重复或错乱。

**FR-MEM-07** 按笔授予（`grantMembership`）必须以"该用户同等级或更高等级的最晚 `ends_at`"为锚点续期：锚点在未来则从锚点接续，否则从当前时间开始。授予来源必须记录为 `manual | payment_review | payment_auto | gift | external`。

**FR-MEM-08** 订阅续费授予（`grantMembershipForPeriod`）必须使用 **provider 返回的真实计费周期** 作为 `starts_at/ends_at`，不得用本地 `duration_days` 推算。

**FR-MEM-09** 会员开通成功后必须在同一事务内入队会员激活邮件（durable outbox），邮件发送失败不得回滚会员授予，但必须可观测、可重试。

### 4.5 管理与查询

**FR-MEM-10** 管理员必须能：手工授予会员、分页浏览会员列表（keyset 游标）、查看会员详情与历史（变更审计链）、执行 suspend/resume/revoke/extend。

**FR-MEM-11** 会员必须能查看自己的当前会员状态、到期时间与权益说明。

---

## 5. 支付与订阅

系统必须支持三条互不依赖的收款路径，且**在所有可选集成关闭时，人工审核路径仍能独立完成完整闭环**。

### 5.1 收款方式配置（人工路径）

**FR-PAY-01** 管理员必须能配置多个收款方式（名称、说明、收款码图片、启用状态、排序）。收款码文件被引用时**不得**被删除（引用约束 `restrict`）。

### 5.2 人工审核流程

**FR-PAY-02** 会员选择等级后可创建付款申请，上传付款截图，状态进入 `pending_review`。

**FR-PAY-03** **同一用户 + 同一等级**在 `pending_review`/`pending_payment` 状态下**最多一条**申请（数据库部分唯一索引强制）；创建时必须在用户级锁下检查。

**FR-PAY-04** 付款截图上传必须有配额：按用户统计"24 小时内成功 + 未过期的预留"，超过 `PAYMENT_PROOF_MAX_PER_DAY`（默认 20）必须返回 429。配额必须通过**预留表 + 用户级 advisory lock** 实现，防止并发绕过。

**FR-PAY-05** 会员必须能对未通过的申请**重新上传凭证**，以及**取消**自己的待审申请。

**FR-PAY-06** 管理员审核必须支持**通过**与**拒绝**（拒绝必须可填写拒绝说明，并对会员可见）。

**FR-PAY-07 审核通过的事务边界** 必须在单个事务内、按**固定锁序**（付款申请行锁 → 会员授予 advisory lock）完成：
1. 校验状态仍为 `pending_review`，否则失败（防重复审核）；
2. 更新为 `approved` 并记录审核人/时间；
3. 入队付款凭证清理任务；
4. 写入审批审计事件；
5. 授予会员并回写 `granted_membership_id`（该字段全局唯一，一条会员只能由一笔付款产生）；
6. 入队会员激活邮件。

**FR-PAY-08** 管理员必须能对**已通过**的人工付款执行**反转**（`reversed`），反转必须回滚对应付款期的会员权益并全程审计。

### 5.3 Stripe 一次性 Checkout

**FR-PAY-09** 配置 Stripe 后，会员必须能对启用了价格的等级发起托管一次性 Checkout，系统创建 `flow='auto'`、`status='pending_payment'` 的付款申请。

**FR-PAY-10** Checkout 会话必须带**claim 租约**（约 2 分钟），防止并发重复创建会话。

**FR-PAY-11** 支付确认必须由**签名 webhook 事件**驱动，不得信任前端回调结果。金额与币种必须与预期一致，不一致必须拒绝（409 金额不匹配）。

**FR-PAY-12** 未完成的 `pending_payment` 申请必须能过期失效，并释放"同用户同等级唯一待处理"名额。

### 5.4 Stripe 自动订阅

**FR-SUB-01** 会员必须能创建 Stripe 订阅（`subscriptions` 表），并能在会员中心**取消**（`cancel_at_period_end` 或立即取消，按 provider 语义）。

**FR-SUB-02** 每个身份**最多一条非终态订阅**（数据库唯一索引，含 `NULLS NOT DISTINCT` 语义）；`(provider, provider_subscription_ref)` 必须唯一。

**FR-SUB-03** 每期发票支付成功必须生成一条 `approved` 的 `flow='auto'` 付款申请，并以 **provider 真实周期**授予会员。幂等键为 `(provider, provider_invoice_ref)` 唯一索引：重复事件必须命中冲突并返回既有结果，不得重复授予。

**FR-SUB-04** 已被反转（`reversed`）的发票记录再次收到事件时**不得**重新授予。

**FR-SUB-05** 系统必须周期性 reconcile 订阅状态（默认 60 分钟），用于补齐丢失的 webhook。reconcile 必须有**时钟围栏**：不得用 reconcile 观测覆盖更新的 webhook 观测结果（`status_event_at` 单调性）。

**FR-SUB-06** 订阅状态集合：`pending | active | past_due | canceled | expired`，必须记录当前周期结束时间、取消标记、取消时间、provider 客户/价格引用、预期金额与币种、数量。

### 5.5 Provider 事件 inbox 与 dispatcher

**FR-EVT-01** 所有 Stripe webhook 必须先**验签**，再以原始 payload **持久化**到 `payment_provider_events`（`(provider, provider_event_id)` 唯一），然后立即返回。业务处理**不得**在 webhook 请求内同步完成。

**FR-EVT-02** webhook 原始请求体必须先按**实际传输字节**执行应用层有界读取（`STRIPE_WEBHOOK_MAX_BYTES`，默认 256 KiB），再验签与解析。

**FR-EVT-03** 事件处理必须由内部 dispatcher 以 `received → processing → processed | failed | dead` 状态机推进，带 `locked_by` + `lease_until` 租约与 fencing、`attempts/max_attempts`（默认 5）有界重试。

**FR-EVT-04** 事件处理失败或达到上限进入 `dead` 时，必须在后台可见（错误摘要 + 归属），不得静默丢弃。

### 5.6 退款、拒付与反转

**FR-REV-01** 全额退款与 chargeback 必须自动反转**对应付款期**的会员权益，且只反转该期，不影响其他期。

**FR-REV-02** 必须实现 **reversal-first 保护**：若反转事件先于授予事件到达，系统必须写入 tombstone，使后续的授予不再生效（避免"先退款后开通"）。

**FR-REV-03** 反转幂等键为 `(provider, reversal_event_id)` 唯一索引。

**FR-REV-04** 反转必须全程审计，并可在后台看到付款申请状态从 `approved` 变为 `reversed` 的因果链。

### 5.7 手动周期续费提醒（无卡地区）

**FR-REM-01** 会员必须能开关"续费提醒"偏好。

**FR-REM-02** 系统必须在会员到期前 `SUBSCRIPTION_REMINDER_LEAD_DAYS`（默认 7 天，可配 1–90）通过事务型队列发送提醒邮件；提醒邮件属于业务邮件，**不受**新内容通知预算限制。

### 5.8 凭证生命周期

**FR-PAY-13** 付款凭证必须有保留期（`PAYMENT_PROOF_RETENTION_DAYS`，默认 30 天；通过后另有独立保留期设置）。到期必须由 durable task 清理文件对象与引用。

**FR-PAY-14** 付款凭证的可见性必须限定为**上传者本人与管理员**；其他任何登录用户都必须被拒绝。

---

## 6. 内容管理

### 6.1 作品模型

**FR-CNT-01** 作品字段必须包含：标题、slug（唯一）、摘要、正文（Markdown）、原文语言、封面文件、可见性、要求等级、状态、发布时间、定时发布时间与 schedule token、内容更新时间。

**FR-CNT-02** 状态为 `draft | published | archived`；派生展示状态为 `draft | scheduled | published | archived`。数据库必须强制以下不变式：
- `scheduled_at` 与 `schedule_token` 必须同时为空或同时非空；
- 定时发布只允许在 `draft` 状态；
- `published` 状态必须有 `published_at`。

### 6.2 可见性与访问

**FR-CNT-03** 可见性三级：
- `public`：任何人可读；
- `login`：任何已登录用户可读；
- `member`：必须有效会员且 `level >= required_tier.level`。

**FR-CNT-04** `member` 作品未设置 `required_tier_id`，或所引用等级不存在时，必须**拒绝访问**（fail-closed）。

**FR-CNT-05** 管理员必须直通全部内容（含草稿与归档）。

**FR-CNT-06** 无权访问的 `member` 作品必须仍可展示"锁定态"元信息（标题、摘要、封面、所需等级名），但**不得**返回正文、图片或附件下载地址。

### 6.3 发布工作流

**FR-CNT-07** 必须支持：立即发布、定时发布、修改定时、取消定时、归档、从归档恢复。

**FR-CNT-08** 定时时间必须晚于数据库当前时间（以数据库时钟为权威，不用应用时钟）。

**FR-CNT-09** 定时发布必须由 durable task（`publish_post`）执行，并以 `schedule_token` 做**围栏**：token 变化（改期/取消/手工发布）后，旧任务必须成为 no-op。

**FR-CNT-10** 所有发布态变更必须行锁 + 审计；并发编辑冲突必须返回 stale 错误而非静默覆盖。

**FR-CNT-11** 已发布作品的正文必须可单独保存（`PUT /api/admin/posts/{id}/content`），并在保存时同步内联图片引用关系与 `content_updated_at`。

### 6.4 正文渲染安全

**FR-CNT-12** 正文使用 Markdown 编写，服务端渲染为 HTML 后必须经过**白名单清洗**（sanitize），不得允许任意 HTML/脚本注入。

**FR-CNT-13** 内联图片必须以站内文件引用形式表达，并与 `post_files`（`kind='inline'`）保持一致的引用关系。

**FR-CNT-14** 未被保存的正文内联上传图片必须在宽限期（`INLINE_UPLOAD_GRACE_PERIOD_HOURS`，默认 24 小时）后由 durable task 回收。

**FR-CNT-15 公开视频嵌入** 必须只允许固定 host 白名单：`www.youtube-nocookie.com`、`player.vimeo.com`、`player.bilibili.com`；ID 必须按 provider 正则严格校验（YouTube 11 位、Vimeo 纯数字、Bilibili `BV` + 10 位）；iframe 必须带受限 `allow` 与 `strict-origin-when-cross-origin` referrer policy；嵌入源必须同步进入 CSP `frame-src`。

### 6.5 分类与标签

**FR-CNT-16** 必须支持分类（含排序）与标签的 CRUD，以及作品与分类/标签的多对多关联维护。分类/标签 slug 必须唯一。

### 6.6 列表与分页

**FR-CNT-17** 公开作品列表必须使用 **keyset 游标分页**（按 `published_at desc, id desc`），页大小 12。游标必须不可伪造成越权查询手段（只影响顺序位置）。

**FR-CNT-18** 首页必须展示限量最新作品与等级卡（最多 4 个等级）。

**FR-CNT-19** 后台列表（作品、会员、付款、文件、任务、赞助墙、通知）必须使用 keyset 游标分页，默认页大小 50，上限 100。

### 6.7 内容多语言与 AI 翻译

**FR-I18N-01** 作品必须支持版本化译文（`post_translations`）：locale、标题、摘要、正文、状态（`draft|published|archived`）、来源（`manual|machine`）、源更新时间、发布时间。**每个 (post, locale) 最多一条 `published`**（数据库部分唯一索引强制）。

**FR-I18N-02** 前台必须按当前 locale 取已发布译文，缺失时**回落到原文**，并可标注"机器翻译"（是否标注由配置控制）。

**FR-I18N-03** 后台必须支持译文的手工 CRUD、预览、发布、撤回、删除，以及**源文已更新（stale-source）提示**。

**FR-I18N-04** AI 翻译必须使用 OpenAI 兼容 provider，**默认关闭**，且**只能由管理员显式触发**；访客/会员的任何操作都不得触发 provider 调用与费用。

**FR-I18N-05** AI 翻译默认必须保存为 `machine` **草稿**；"直接发布"必须由创作者显式开启才可用。

**FR-I18N-06** 翻译时必须保护 Markdown 结构（代码块、链接、图片引用等不得被破坏）。

### 6.8 UI 语言

**FR-I18N-07** UI、后台、初始化页、API 错误信息与系统邮件必须支持 `zh / en / ja` 三语；语言协商顺序为 **cookie → `Accept-Language` → 默认 `zh`**。

**FR-I18N-08** 登录用户的语言偏好必须持久化到 `users.locale`，异步邮件必须按**收件人偏好**渲染。

**FR-I18N-09** 三语文案的 key 集合必须完全一致（CI 必须以显式测试检出缺失/多余 key）。

### 6.9 SEO / Feed / Sitemap

**FR-SEO-01** 必须提供 `robots.txt`，并对后台、下载、token 页等路径 disallow。

**FR-SEO-02** 必须提供 sitemap 索引 + 分片（每片 5000 条 URL，最多 100 片）与静态页 sitemap（`/`、`/posts`、`/tiers`，赞助墙开启时含 `/supporters`）。sitemap 只允许包含**公开可见**内容。

**FR-SEO-03** 必须提供 `feed.xml`（公开已发布作品），并有对应的数据库部分索引支撑。

**FR-SEO-04** 必须输出页面元数据（title/description/OG 等）；锁定内容不得在元数据中泄漏正文。

---

## 7. 文件、存储与下载

### 7.1 文件模型

**FR-FILE-01** 文件记录必须包含：存储驱动（`local|s3`）、bucket、object key、原始名、**服务端权威 MIME**、字节数、SHA-256、宽高（图片）、用途、创建者、隔离状态（`quarantined_at` / 原因）、修复版本。

**FR-FILE-02** 文件用途枚举：`artist_avatar | payment_qr | payment_proof | content_image | content_attachment | cover | thumbnail`。

### 7.2 上传约束

**FR-FILE-03** 每种用途必须有独立的扩展名白名单与大小上限：

| 用途 | 允许扩展名 | 上限 |
|---|---|---|
| `artist_avatar` | jpg/jpeg/png/webp | 10 MiB |
| `payment_qr` / `payment_proof` | jpg/jpeg/png/webp | `PAYMENT_PROOF_MAX_SIZE_MB`（默认 10，范围 1–100） |
| `content_image` | jpg/jpeg/png/webp/gif | 50 MiB |
| `cover` / `thumbnail` | jpg/jpeg/png/webp | 20 MiB |
| `content_attachment` | 高清图 / PSD / ZIP / 笔刷包 / mp4 / webm / mov / m4v 等 | `MAX_UPLOAD_SIZE_MB`（默认 500） |

**FR-FILE-04** MIME 必须由服务端按内容/扩展名权威判定，**不得**信任客户端声明的 `Content-Type`。

**FR-FILE-05** 光栅图片（含头像、封面、内联图、付款截图）必须**强制重编码**并移除元数据（EXIF 等），并受帧数（`IMAGE_MAX_FRAMES`，默认 300）与总像素（`IMAGE_MAX_TOTAL_PIXELS`，默认 3 亿）上限约束。处理失败的文件必须进入 **quarantine**，不得直接对外提供。

**FR-FILE-06** 内容附件（含视频）必须通过**独立 raw-body 流式接口**写入存储，并在流中计算 SHA-256 与实际字节数；**不得**将整个附件缓冲进内存。`MAX_UPLOAD_SIZE_MB` 是服务端流式实测上限。

**FR-FILE-07** 文件名处理必须安全：原始名长度上限 255、文件名头长度上限 1024、拒绝控制字符；下载响应必须使用**服务端派生的权威名**（扩展名按权威 MIME 修正）。

**FR-FILE-08** 所有请求体（JSON、webhook、multipart 图片、raw-body 流）必须在解析/验签/图片处理**之前**执行应用层有界读取。JSON 上限 `REQUEST_JSON_MAX_BYTES`（默认 64 KiB）。付款图片 multipart 总传输上限为文件上限 + 256 KiB 协议开销。

**FR-FILE-09** 鉴权必须在读取请求体**之前**完成（须有静态检查门禁保证，见 NFR-ENG-02）。

### 7.3 存储驱动

**FR-STOR-01** 必须支持 `local` 与 `s3`（含 Cloudflare R2、MinIO）两种驱动；两者的历史文件必须能**并存**，切换驱动**不得**自动迁移历史文件。

**FR-STOR-02** local 写入必须先写同目录 `.part` 临时文件，成功后**原子重命名**；可捕获失败必须删除临时文件；超过 24 小时的遗留 `.part` 必须被定期清理。

**FR-STOR-03** S3 上传必须使用**有界 multipart**（固定 8 MiB 分片、2 路并发，SDK 缓冲约 16 MiB）；文档必须要求 bucket 配置"中止未完成 multipart upload"生命周期规则作为进程崩溃兜底。

**FR-STOR-04** 必须支持**单段 HTTP Range**，正确返回 `200 / 206 / 416`，用于内联视频播放。

### 7.4 下载鉴权

**FR-DL-01** 所有私有文件访问必须**逐请求**鉴权，不得依赖任何长期有效的可猜测 URL。

**FR-DL-02** 按用途的鉴权规则必须为：

| 用途 | 规则 |
|---|---|
| `artist_avatar` / `payment_qr` / `cover` / `thumbnail` | 公开可读 |
| `payment_proof` | 仅上传者本人或管理员 |
| `content_attachment` | 必须存在关联作品；在**已发布**关联作品中寻找一个当前用户有权访问的"授权作品"，找不到则拒绝（未登录返回需登录，已登录返回权限不足） |
| `content_image` | 同上；`inline` 引用还必须额外校验该图片确实被某个**已发布作品的正文**引用 |
| 未列出用途 | 拒绝 |

**FR-DL-03** 未关联任何作品的内容文件必须返回"未关联"错误，不得可下载。

**FR-DL-04** 授权作品选择必须优先 `public`，再考虑受限作品，且必须能返回实际授权来源（作品 id 与可见性）用于日志与缓存决策。

**FR-DL-05** 每次首个文件请求必须写下载日志（用户、作品、文件、IP、UA、驱动）；Range 续传的后续分段不得重复计数。

**FR-DL-06** `login` / `member` 视频必须**始终由应用代理**并逐请求重新鉴权；**只有真实公开授权路径**才可以使用短时/有界签名 URL（私有签名 URL TTL 5 分钟；公开内联视频 `PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS`，默认 6 小时）。

**FR-DL-07** 管理员必须能查看下载记录。

### 7.5 文件生命周期与删除

**FR-FILE-10** 删除文件必须执行**完整引用检查**：作品封面、`post_files` 全部 kind、付款凭证、收款码、站点品牌资源等。存在引用必须拒绝删除（数据库层 `restrict` 兜底）。

**FR-FILE-11** 删除必须为**两阶段**：先删除数据库记录（事务内），再由 durable task（`storage.delete_object`）删除对象字节。存储删除失败不得导致数据库不一致。

**FR-FILE-12** 孤儿文件与过期凭证必须由 durable task（`file.cleanup_orphan`、`payment_proof.cleanup`）定期回收。

**FR-FILE-13** 管理员必须能分页浏览文件、单独浏览**被隔离**文件，并查看隔离原因。

**FR-FILE-14** 必须提供 pre-v1.0 历史文件的**强制安全 backfill** 工具（重新判定 MIME、重编码、补 SHA-256、必要时隔离）。

---

## 8. 新内容邮件通知

**FR-NOTI-01** 新内容邮件通知必须**默认关闭**，且必须由粉丝**显式 opt-in**（`notification_preferences.new_post_email_enabled` 默认 false）。

**FR-NOTI-02** 作品发布（手工或定时）必须最多创建**一个** campaign（`(post_id)` 唯一），状态机 `pending → expanding → expanded → sending → completed | dead`。

**FR-NOTI-03** 收件人展开必须**分批**（`NOTIFICATION_CAMPAIGN_EXPANSION_BATCH_SIZE`，默认 500）并以游标推进，可中断可续跑；每个 `(campaign, user)` 最多一条投递记录（唯一索引）。

**FR-NOTI-04** 每条投递必须绑定一个 durable task（`task_id` 唯一），投递状态为 `queued | sending | accepted | suppressed | skipped | deferred | failed | dead`。

**FR-NOTI-05** 发送前必须**重新校验**，并按结果记录明确 outcome，包含至少：`accepted`、`permanent_failure`、`transient_failure`、`needs_operator_defer`、`lease_expired`、`budget_defer`、`pacing_defer`、`suppressed_skip`、`stale_skip`、`post_not_published_skip`、`access_lost_skip`、`preference_disabled_skip`、`user_missing_skip`。即：作品已撤下、用户已失去访问权、用户已关闭偏好、用户已删除等情况必须 skip 而不是发信。

**FR-NOTI-06** 必须实现**通知预算与节流**：按 UTC 日预算（`NOTIFICATION_EMAIL_DAILY_BUDGET`，默认 500）与每分钟节流（`NOTIFICATION_EMAIL_PACING_PER_MINUTE`，默认 30），使用配额窗口表计数。超限必须 defer 而非丢弃。

**FR-NOTI-07** 通知预算**只适用于通知队列**，**不得**影响登录码、Magic Link、付款邮件、会员邮件与续费提醒。

**FR-NOTI-08** 同步 SMTP **永久性拒收（5xx）**必须写入抑制名单（按 keyed 邮箱摘要），后续通知必须直接 `suppressed`。抑制表**不得**存明文邮箱。

**FR-NOTI-09** 每封通知邮件必须包含**一键退订**链接。退订 token 必须为 keyed HMAC、带 `key_id`、支持 `current + previous` 轮换、有最大有效期（`NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS`，默认 180 天）。退订页必须 `no-store` / `no-referrer` / `noindex`。

**FR-NOTI-10** 邮件必须按**收件人 locale** 渲染。

**FR-NOTI-11** 投递必须为 **at-least-once**：系统不承诺绝不重复投递，但必须保证不因单次失败而永久丢失（有界重试 + 最大存活时间 `NOTIFICATION_DELIVERY_MAX_AGE_HOURS`，默认 168 小时）。

**FR-NOTI-12** 必须提供**尝试级账本**（`notification_delivery_attempts`）记录每次尝试的编号、UTC 日/分钟归属、是否真的触达 SMTP、outcome、收件人 locale、收件人**摘要**（非明文）、消息快照、错误种类、运维复查计数。

**FR-NOTI-13** 后台必须提供**安全聚合观测**：campaign 列表与详情、投递状态分布、失败原因分布，**不得**展示明文收件人清单。

---

## 9. 赞助者鸣谢墙（Supporter Wall）

**FR-WALL-01** 赞助墙必须**默认关闭**，由创作者开启，并可设置**最低等级门槛**（`minLevel`，`null` 表示不限）。

**FR-WALL-02** 上墙必须由粉丝**显式 opt-in**；每用户**最多一条** entry（数据库唯一约束强制）。

**FR-WALL-03** 展示资格必须**每次请求实时派生**于"当前有效会员"：不缓存、不使用定时下墙任务。重叠会员取**最高等级**。

**FR-WALL-04** 公开墙必须只展示**显示名与等级**，**不得**展示金额、邮箱或任何可反推付款额的信息。

**FR-WALL-05** 一次性**纯文本献词**（≤200 字符，数据库 check 约束强制）必须**先审后展示**；URL **不得**被链接化。

**FR-WALL-06** entry 状态为 `pending | approved | hidden`；创作者必须能批准与隐藏，并可整体关闭赞助墙。

**FR-WALL-07** 粉丝修改显示名必须触发上墙内容的重新审核（显示名重置回待审语义）。

**FR-WALL-08** 全部状态转换与审核动作必须入审计；entry 变更必须带版本做乐观并发控制。

**FR-WALL-09** 赞助墙开关必须影响 sitemap 静态页集合，且开关值必须参与 sitemap 索引的 ETag 身份（同毫秒内的两次设置变更也必须被区分）。

**FR-WALL-10** 赞助墙设置存储值非法时必须 **fail-closed**（视为关闭），不得因脏数据而公开展示。

---

## 10. 平台机制

### 10.1 主题系统（Theme）

**FR-THEME-01** 主题**只负责表现层**：不得包含业务逻辑、不得直接访问数据库、不得接触服务端 secret。

**FR-THEME-02** 所有公开页面必须通过 **Core view-model 契约**渲染。Core 负责业务决策（是否 allowed、所需等级名、下载 URL、机器翻译标注）；主题只负责布局与格式化。

**FR-THEME-03** 必须内置三个主题：`builtin`、`blog`（文字优先阅读形态）、`wordpress`（经典风格）。管理员必须能在后台切换活动主题。

**FR-THEME-04** 必须支持明/暗模式、字体、颜色预设与**受约束的自由取色（hue）**；各主题配色必须**按主题分键独立保存**。

**FR-THEME-05** 主题契约必须包含必选 `SupporterWall` 组件槽，三个内置主题必须全部实现。

**FR-THEME-06** 主题模式初始化脚本必须与 CSP nonce 机制兼容，且不得产生明暗切换闪烁。

### 10.2 Integration（第一方集成）

**FR-INTG-01** Integration 是**官方内置、随 Core 发布**的第三方服务对接，必须统一注册表管理。当前集成：`smtp`、`storage`、`stripe`、`turnstile`、`translation`、`plausible`、`umami`、`oauth_google`、`oauth_github`、`tunnel`。

**FR-INTG-02** 每个集成必须报告结构化状态：`configured`（配置完整可用）、`enabled`（当前生效）、`source`（`database|environment|none`）、可选 `driver`、以及**读取失败**与"未配置"的区分（`error` 标记）。

**FR-INTG-03** 可测试的集成必须提供统一的连接测试契约（SMTP 测试信必须发往触发测试的管理员邮箱）。

**FR-INTG-04** **Core 边界原则**（不可违反）：
1. 全部可选集成关闭时，人工付款与本地 Core 必须仍能完整运行；
2. 权限、付款、会员与文件生命周期规则**只**存在于 Core；
3. 第三方失败**不得**绕过审计、事务、幂等或下载鉴权。

**FR-INTG-05** 统计集成（Plausible / Umami）必须关闭默认自动 pageview，改由 nonce inline tracker 按共享公开路径边界处理首次加载与 SPA history 导航。

### 10.3 审计与运维事件

**FR-AUD-01** 必须提供统一审计表 `audit_events`：实体类型/ID、动作、actor（`admin|user|system` + id）、reason、before/after JSON、**`correlation_id`（必填）**、`causation_id`（因果父事件）。

**FR-AUD-02** 一次业务操作跨越的全部审计事件必须共享同一 `correlation_id`，并通过 `causation_id` 形成**因果链**（如：审批 → 会员授予 → 邮件入队）。

**FR-AUD-03** 审计写入必须与业务变更在**同一事务**内；不得出现"业务成功但审计缺失"。

**FR-AUD-04** 必须提供运维事件表 `app_events` 记录安全与运维信号（初始化、登录拒绝原因、限流告警等），且**不得**包含明文 token、明文验证码或明文收件人地址。

### 10.4 Durable Task 队列与 Outbox

**FR-TASK-01** 必须提供数据库支撑的 durable task 队列：`kind`、去重键（唯一）、payload、`run_after`、状态（`pending|processing|succeeded|failed|dead`）、`attempts/max_attempts`（默认 5）、`locked_at/locked_by/lease_until`、`last_error`、`priority`、`queue_class`。

**FR-TASK-02** 所有"业务提交后必须发生的副作用"（邮件、清理、发布、事件分发）必须以 **transactional outbox** 方式在业务事务内入队，不得在事务外 fire-and-forget。

**FR-TASK-03** 必须实现租约 + fencing：领取任务写入 `lease_until`（60 秒），过期任务可被回收；完成/失败/延迟必须校验 lock token，防止陈旧 worker 覆盖新状态。

**FR-TASK-04** 必须实现**队列分级与配额**，防止批量通知饿死事务型邮件：

| 队列类 | 用途 | 每批配额 |
|---|---|---|
| `transactional` | 登录码、Magic Link、业务邮件、续费提醒 | 预留 `TASK_TRANSACTIONAL_RESERVED_PER_BATCH`（默认 8） |
| `notification` | 通知展开/投递/收尾 | 最小 `TASK_NOTIFICATION_MIN_PER_BATCH`（默认 2）；陈旧回收上限 2 |
| `maintenance` | 文件清理、对象删除、凭证清理 | 上限 `TASK_MAINTENANCE_MAX_PER_BATCH`（默认 2） |
| `default` | 发布、provider 事件分发、reconcile | 余量 |

批大小 `TASK_BATCH_SIZE=20`，轮询间隔 10 秒。

**FR-TASK-05** 任务种类与默认队列/优先级必须至少覆盖：`auth.login_code_email`(t/0)、`auth.magic_link_email`(t/0)、`email`(t/10)、`subscription.renewal_reminder`(t/10)、`publish_post`(d/20)、`payment_provider_event.dispatch`(d/20)、`subscription.reconcile`(d/30)、`notification.campaign_expand`(n/80)、`notification.deliver`(n/90)、`notification.campaign_finalize`(n/95)、`file.cleanup_orphan`(m/120)、`storage.delete_object`(m/120)、`payment_proof.cleanup`(m/120)。

**FR-TASK-06** 重试必须为**指数退避且有界**；达到上限进入 `dead`，必须在后台可见并可手工重试。

**FR-TASK-07** 业务邮件任务 payload 必须为 **v2 domain-reference 格式**（只存业务实体引用），worker 在**发送时**重新解析最新邮箱与 locale；**不得**在 payload 中持久化明文收件人地址。

**FR-TASK-08** SMTP 不可用时，业务邮件必须进入可观测的 defer/dead/retry 状态，**不得**假成功。运维修复期间的重投间隔为 `EMAIL_RETRY_RECHECK_MINUTES`（默认 15 分钟，1–1440），最长待命 `EMAIL_DELIVERY_MAX_AGE_HOURS`（默认 24 小时，1–168）。

**FR-TASK-09** 邮件必须使用**稳定 Message-ID**，并维护投递账本；管理员必须能在后台查看任务、失败原因并手工重发。

**FR-TASK-10** 必须清扫"已达最终尝试但已过期"的任务，转入 dead-letter 并可见。

### 10.5 后台管理与运维视图

**FR-ADMIN-01** 后台必须提供以下页面：站点设置、主题、会员等级、会员、付款（方式/审核）、内容（列表/编辑/新建/分类标签/译文）、文件、下载记录、通知、赞助墙、任务、系统状态、账号与恢复。

**FR-ADMIN-02** 系统状态页必须展示就绪检查结果、集成状态、队列健康与邮件失败计数等运维摘要，且**不得**泄漏任何 secret 或明文错误细节。

**FR-ADMIN-03** 必须提供管理员账号恢复的一次性运维脚本（`admin:reset`），用于密码/邮箱丢失场景。

---

## 11. 非功能需求

### 11.1 安全

| 编号 | 需求 |
|---|---|
| NFR-SEC-01 | 生产环境**必须**拒绝启动于默认/弱/空 `SESSION_SECRET`（长度 ≥32；`change-me` 等占位值必须被拒绝） |
| NFR-SEC-02 | 全部生产 Route Handler 必须对请求体执行**有界读取**，且鉴权先于读体 |
| NFR-SEC-03 | 必须实现 **per-request nonce CSP** 与全局安全响应头。CSP 模式 `auto`（默认）在存在未迁移的可执行 legacy 页脚时降级为 Report-Only，迁移后 enforce；`report-only` / `enforce` 为显式模式。图片/媒体源必须按**实际配置的存储域**动态派生；派生失败必须 fail-closed 到同源 |
| NFR-SEC-04 | HSTS 默认关闭（需确认全站 HTTPS 后开启），不包含 preload |
| NFR-SEC-05 | 敏感配置必须以 AES-256-GCM 加密存储；密钥不得回传前端；provider key 不得出现在 `NEXT_PUBLIC_*` |
| NFR-SEC-06 | 一切一次性凭据（登录码、Magic Link token、退订 token、session token、OAuth state）服务端只存 keyed 摘要 |
| NFR-SEC-07 | 邮箱在通知抑制与限流键中必须以 keyed 摘要形式出现，不得明文 |
| NFR-SEC-08 | 携带 token 的响应必须 `no-store` / `no-referrer` / `noindex` |
| NFR-SEC-09 | 上传必须服务端权威 MIME + 强制光栅重编码 + 隔离机制 + 响应隔离（不得让上传内容以可执行/可内联脚本形式返回） |
| NFR-SEC-10 | 不得存在可绕过鉴权的静态私有文件 URL；签名 URL 只用于真实公开路径且 TTL 有界 |
| NFR-SEC-11 | 默认不信任任意 `X-Forwarded-For`；限流不可因 IP 不可解析而失效 |
| NFR-SEC-12 | 账号枚举防护：验证码/Magic Link 请求响应必须统一。**已知残余风险**：共享 email+IP 限流在高频重复请求下仍可能间接区分非管理员邮箱 |

### 11.2 可靠性与一致性

| 编号 | 需求 |
|---|---|
| NFR-REL-01 | 会员授予、付款状态流转、订阅授予必须是**事务化**的，并具备明确幂等键 |
| NFR-REL-02 | 所有对外部 provider 的观测必须幂等：重复 webhook / reconcile 不得产生重复授权 |
| NFR-REL-03 | 并发同类操作必须串行化（用户级 advisory lock）或以唯一索引 fail-closed |
| NFR-REL-04 | 副作用必须 outbox 化，且失败可观测、可重试、有界 |
| NFR-REL-05 | 迁移必须在应用启动前执行；迁移失败时应用**不得**启动 |
| NFR-REL-06 | 数据库层必须承担最终不变式（唯一索引、check 约束、外键 restrict/cascade），不得只依赖应用层校验 |
| NFR-REL-07 | 定时/延迟执行必须以数据库时钟为权威 |

### 11.3 性能与容量

| 编号 | 需求 |
|---|---|
| NFR-PERF-01 | 所有长列表必须 keyset 游标分页，并有覆盖排序的索引（禁止 OFFSET 深分页） |
| NFR-PERF-02 | 大文件上传/下载必须流式，内存占用与文件大小解耦；`MAX_UPLOAD_SIZE_MB` 不受"必须小于可用内存"约束 |
| NFR-PERF-03 | S3 multipart 单次上传 SDK 分片缓冲约 16 MiB + 运行时开销 |
| NFR-PERF-04 | 图片处理仍需为输入缓冲与解码预留内存，必须有帧数/像素上限保护 |
| NFR-PERF-05 | 文件删除的引用检查必须使用**有界存在性探测**（部分索引支撑），不得全表扫描 |
| NFR-PERF-06 | dispatcher 领取查询必须有对应的部分索引（按队列类 + 到期 + 优先级 + id），并保持基准回归 |

### 11.4 可观测性

| 编号 | 需求 |
|---|---|
| NFR-OBS-01 | 必须提供 `GET /api/health`（存活）与 `GET /api/ready`（数据库 + 配置 + 加密密钥就绪） |
| NFR-OBS-02 | `GET /api/ready?integrations=true` 必须返回**信息性**集成健康摘要，且**绝不**改变 200/503 门禁——Core 必须在所有可选集成关闭时仍就绪 |
| NFR-OBS-03 | 就绪检查只返回粗粒度布尔值，不得暴露 secret 或错误细节 |
| NFR-OBS-04 | `APP_INSTANCE_COUNT > 1` 必须输出启动日志与就绪告警（限流为进程本地，跨副本不一致） |
| NFR-OBS-05 | 限流触发、IP 不可解析、集成失败、任务 dead-letter 必须有结构化可观测信号 |

### 11.5 国际化与可访问性

| 编号 | 需求 |
|---|---|
| NFR-I18N-01 | zh/en/ja 三语覆盖 UI、后台、初始化、API 错误与系统邮件；key 集合必须完全一致 |
| NFR-I18N-02 | 异步邮件必须按收件人偏好语言渲染 |
| NFR-A11Y-01 | 页面必须响应式；明暗主题切换不得闪烁；表单错误必须有可读文案 |

### 11.6 工程与可维护性

| 编号 | 需求 |
|---|---|
| NFR-ENG-01 | 提交前门禁必须包含：单测、lint、格式检查、类型检查（`tsc --noEmit`）、生产构建、迁移器构建 |
| NFR-ENG-02 | 必须有**静态检查门禁**保证：请求体有界读取（`check:request-bodies`）、鉴权先于读体（`check:auth-before-body`） |
| NFR-ENG-03 | 关键不变式必须有**真实 PostgreSQL** 集成测试覆盖（并发授予、幂等、迁移、分页、恢复收敛等） |
| NFR-ENG-04 | 必须有浏览器 E2E 覆盖：主题视觉基线（页面 × 明暗 × 主题）、权限 smoke、逐语言 smoke、iOS IME 冻结回归 |
| NFR-ENG-05 | 必须有恢复演练 E2E（含 S3 变体）在 CI 中运行 |
| NFR-ENG-06 | 模块边界必须清晰（`src/modules/*`），主题与 Core 之间只通过 view-model 契约通信 |
| NFR-ENG-07 | 提交信息必须符合 conventional commits（commitlint 强制） |
| NFR-ENG-08 | 第三方 GitHub Actions 必须钉到完整 immutable commit SHA 并带准确版本注释 |

### 11.7 许可与合规

| 编号 | 需求 |
|---|---|
| NFR-LIC-01 | 项目必须以 **AGPL-3.0-only** 发布；通过网络提供修改版必须按 AGPL 提供对应源码 |
| NFR-LIC-02 | 必须提供安全策略（`SECURITY.md`）与变更日志（`CHANGELOG.md`） |

---

## 12. 部署与运维需求

### 12.1 部署形态

**FR-DEP-01** 必须提供 Docker Compose 一键部署（app + PostgreSQL + 持久化 volume：uploads、secrets）。

**FR-DEP-02** 应用**只监听 HTTP**；TLS 必须由 Cloudflare Tunnel、Caddy、Nginx、Traefik 或 CDN 终止。必须提供 overlay：
- `docker-compose.tunnel.yml`（Cloudflare Tunnel，无公网 IP 家庭服务器/NAS/PVE）
- `docker-compose.caddy.yml`（公网 VPS + 自动 TLS）

Tunnel/Caddy overlay 必须移除 app 的主机 3000 端口暴露。

**FR-DEP-03** 容器启动必须先执行数据库迁移（`MIGRATE_MAX_ATTEMPTS` 默认 30 次重试），迁移失败必须阻止应用启动。

**FR-DEP-04** 首次启动必须自动生成并以 `0600` 持久化以下 file-backed secret，且在重启与容器重建后复用：`session-secret`、`config-encryption-key`、`notification-unsubscribe-secret`、`notification-suppression-digest-secret`、`magic-link-secret`。直接环境变量必须优先于 `*_FILE`。

**FR-DEP-05** 多主机或不共享 volume 的部署必须通过 secret manager 提供同一份值；本地 named volume 不能跨主机共享。文档必须明确警告 `docker compose down -v` 的破坏性。

**FR-DEP-06** 必须提供部署文档：Docker Compose、家庭服务器、Cloudflare Tunnel、公网 VPS + 反向代理、CDN 接入、生产检查清单、备份恢复、升级指南。

### 12.2 备份与恢复

**FR-BAK-01** 标准 Compose 部署必须提供单命令备份/恢复脚本（`scripts/backup.sh` / `scripts/restore.sh`）。

**FR-BAK-02** 归档必须包含：数据库、file-backed secrets、以及（`STORAGE_DRIVER=local` 时）本地上传文件；`s3` 时必须写入 skip marker。

**FR-BAK-03** 归档必须带 **manifest（v3）+ checksum**，恢复前必须校验完整性；外部 `SESSION_SECRET` 只记录不可逆指纹，明文必须由运维单独托管。

**FR-BAK-04** 恢复流程必须包含以下阶段，且必须在 app 启动前完成：
1. **pre-scan**：归档完整性与内容预检；
2. **schema check / compatibility**：schema 兼容性探测（含 legacy v1 归档探测与显式 `--allow-legacy-v1-unknown-schema` 开关）；
3. **neutralize**：中和恢复后不应重放的任务与支付事件（避免恢复即重复发信/重复授权）；
4. **converge**：按数据库引用执行 local/S3 存储收敛与存储探测（含身份校验）。

**FR-BAK-05** 文档必须明确：S3/R2 的**对象字节**必须由 provider 侧 snapshot/versioning 单独恢复；备份脚本按 app 容器的 `STORAGE_DRIVER` 决定行为，**不会**把后台 Storage DB override 或混合 local/S3 历史对象合并成单一归档。

**FR-BAK-06** 迁移服务器或恢复备份时，必须同时保护数据库、配置加密密钥、session secret 与通知/Magic Link 密钥；任一密钥丢失的后果必须在文档中明确说明。

### 12.3 升级

**FR-UPG-01** 必须提供升级指南，包含迁移前备份、镜像更新、迁移执行与回滚边界。

**FR-UPG-02** 兼容路径（v1 archive restore、legacy footer 迁移、pre-v1.0 文件 backfill）的移除必须提前公告，且更旧实例必须先经中间版本升级/恢复。

---

## 13. 配置项清单（部署层）

> 完整清单见 [.env.example](../.env.example)。下表为需求层面的关键项与约束。

### 13.1 应用与安全

| 变量 | 默认 | 约束 |
|---|---|---|
| `APP_URL` | — | 站点对外地址，必填 |
| `APP_NAME` | — | 站点名 |
| `APP_INSTANCE_COUNT` | 1 | >1 仅告警；v1 限流为进程本地 |
| `SECURITY_CSP_MODE` | `auto` | `auto` / `report-only` / `enforce` |
| `SECURITY_HSTS_ENABLED` | false | 确认全站 HTTPS 后再开 |
| `SESSION_SECRET` / `_FILE` | file-backed | 生产环境弱值必须拒绝启动 |
| `CONFIG_ENCRYPTION_KEY` / `_FILE` | file-backed | 丢失则加密配置不可解密 |
| `TURNSTILE_ENABLED` / `NEXT_PUBLIC_TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | false | secret 仅服务端 |
| `TRUSTED_PROXY_HOPS` / `TRUSTED_PROXY_HEADER` | 0 / `x-forwarded-for` | 0 = 不信任转发头 |

### 13.2 数据库与迁移

`DATABASE_URL`（必填）、`MIGRATE_MAX_ATTEMPTS`（30）、`MIGRATIONS_FOLDER`（可选）。

### 13.3 邮件与队列

`SMTP_HOST/PORT/SECURE/USER/PASSWORD/FROM`（env 为 DB 的 fallback）、
`EMAIL_RETRY_RECHECK_MINUTES`（15，1–1440）、`EMAIL_DELIVERY_MAX_AGE_HOURS`（24，1–168）、
`TASK_TRANSACTIONAL_RESERVED_PER_BATCH`（8）、`TASK_NOTIFICATION_MIN_PER_BATCH`（2）、
`TASK_NOTIFICATION_STALE_RECLAIM_MAX_PER_BATCH`（2）、`TASK_MAINTENANCE_MAX_PER_BATCH`（2）。全部为 0–20 整数。

### 13.4 通知

`NOTIFICATION_EMAIL_DAILY_BUDGET`（500，1–100000）、`NOTIFICATION_EMAIL_PACING_PER_MINUTE`（30，1–10000）、
`NOTIFICATION_CAMPAIGN_EXPANSION_BATCH_SIZE`（500，1–5000）、`NOTIFICATION_DELIVERY_MAX_AGE_HOURS`（168，1–720）、
`NOTIFICATION_UNSUBSCRIBE_TOKEN_MAX_AGE_DAYS`（180，1–3650）、
`NOTIFICATION_UNSUBSCRIBE_*` 与 `NOTIFICATION_SUPPRESSION_DIGEST_*`（`KEY_ID` + `SECRET`/`SECRET_FILE`，含 `PREVIOUS_*` 轮换位）。

### 13.5 认证

`MAGIC_LINK_KEY_ID` / `MAGIC_LINK_SECRET(_FILE)` / `MAGIC_LINK_PREVIOUS_*`（未配置则隐藏入口；部分配置必须启动失败）、
`LOGIN_CODE_LENGTH`（16）、`LOGIN_CODE_ALPHABET`（`crockford-base32`）、
`ADMIN_LOGIN_RATE_MAX`（10）/ `ADMIN_LOGIN_UNRESOLVED_RATE_MAX`（100）/ `ADMIN_LOGIN_RATE_WINDOW_MS`（600000）、
`VERIFY_CODE_IP_RATE_MAX`（30）/ `VERIFY_CODE_UNRESOLVED_RATE_MAX`（300）/ `VERIFY_CODE_EMAIL_IP_RATE_MAX`（10）/ `VERIFY_CODE_RATE_WINDOW_MS`（600000）、
`REQUEST_CODE_IP_RATE_MAX`（20）/ `REQUEST_CODE_EMAIL_IP_RATE_MAX`（5）/ `REQUEST_CODE_UNRESOLVED_RATE_MAX`（100）/ `REQUEST_CODE_RATE_WINDOW_MS`（3600000）/ `REQUEST_CODE_SEND_DEDUPE_SECONDS`（60）、
`OAUTH_START_IP_RATE_MAX`（20）/ `OAUTH_START_UNRESOLVED_RATE_MAX`（100）/ `OAUTH_START_RATE_WINDOW_MS`（600000）。

### 13.6 存储、上传与文件请求

`STORAGE_DRIVER`（`local`）、`UPLOAD_DIR`（仅部署层）、
`S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY/FORCE_PATH_STYLE`、
`REQUEST_JSON_MAX_BYTES`（65536，1 KiB–1 MiB）、`STRIPE_WEBHOOK_MAX_BYTES`（262144，1 KiB–1 MiB）、
`MAX_UPLOAD_SIZE_MB`（500）、`IMAGE_MAX_FRAMES`（300）、`IMAGE_MAX_TOTAL_PIXELS`（3e8）、
`PAYMENT_PROOF_MAX_SIZE_MB`（10，1–100）、`PAYMENT_PROOF_RETENTION_DAYS`（30）、`PAYMENT_PROOF_MAX_PER_DAY`（20）、
`PROOF_UPLOAD_RESERVATION_TTL_MINUTES`（5）、`INLINE_UPLOAD_GRACE_PERIOD_HOURS`（24）、
`PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS`（21600）、
`FILE_PREAUTH_RATE_LIMIT_MAX`（1200）/ `FILE_PREAUTH_UNRESOLVED_RATE_LIMIT_MAX`（20000）/ `FILE_PREAUTH_RATE_LIMIT_WINDOW_MS`（600000）、
`VIDEO_RANGE_RATE_LIMIT_MAX`（600）/ `VIDEO_UNRESOLVED_RATE_LIMIT_MAX`（10000）/ `VIDEO_RANGE_RATE_LIMIT_WINDOW_MS`（600000）、
`DOWNLOAD_UNRESOLVED_RATE_LIMIT_MAX`（2000）。

### 13.7 订阅与边缘

`SUBSCRIPTION_RECONCILE_INTERVAL_MINUTES`（60）、`SUBSCRIPTION_REMINDER_LEAD_DAYS`（7，1–90）、
`APP_DOMAIN`（Caddy overlay）、`CLOUDFLARE_TUNNEL_TOKEN`（Tunnel overlay）。

**CON-1** Stripe 与 AI 翻译 provider 配置**只能**在后台设置并加密存储，不提供部署层环境变量入口。

---

## 14. 数据模型需求

系统必须维护 **34 张表**，按域分组如下。表级不变式（唯一索引、check、外键行为）是需求的一部分，不得只在应用层实现。

### 14.1 身份与会话

| 表 | 关键不变式 |
|---|---|
| `users` | `email` 唯一；`role ∈ {admin, member}`；`locale ∈ {zh,en,ja}`；粉丝可无 `password_hash` |
| `sessions` | token 只存摘要；`expires_at` 索引；用户删除 cascade |
| `login_codes` | 只存 code 摘要；带 `attempt_count`、`used_at`；按 email + 时间/活跃状态索引 |
| `magic_link_tokens` | `(token_hash, key_id)` 唯一；`consumed_at` 单次消费 |
| `oauth_identities` | `(provider, provider_account_id)` 唯一；记录 `email_at_link` |
| `oauth_states` | `state_hash` 唯一；`code_verifier_encrypted` 加密；带浏览器绑定摘要与过期 |

### 14.2 配置

| 表 | 关键不变式 |
|---|---|
| `site_settings` | `key` 唯一；`value_json` 明文 |
| `app_settings` | `key` 主键；`value_encrypted` 为整组 JSON 的 AES-256-GCM 密文 |

### 14.3 会员

| 表 | 关键不变式 |
|---|---|
| `membership_tiers` | `slug` 唯一；`level` 必填；`entitlements` 非空默认 `[]` |
| `memberships` | `status ∈ {active,suspended,revoked}`；`version` 乐观锁；按 (user, 时间窗) 索引 |
| `supporter_wall_entries` | `user_id` 唯一；`dedication` ≤200（check）；status 三态；`version` 乐观锁 |

### 14.4 支付与订阅

| 表 | 关键不变式 |
|---|---|
| `payment_methods` | `qr_file_id` 外键 `restrict` |
| `payment_requests` | 同 (user,tier) 待处理唯一（部分索引）；`granted_membership_id` 唯一；`provider_event_id` 唯一；`(provider,provider_payment_ref)` 唯一；`(provider,provider_invoice_ref)` 唯一；`(provider,reversal_event_id)` 唯一；`proof_file_id` 外键 `restrict` |
| `payment_proof_upload_reservations` | 按 (user,status,created_at) 索引，支撑日配额 |
| `payment_provider_events` | `(provider, provider_event_id)` 唯一；状态机 + 租约 + 有界重试 |
| `subscriptions` | `(provider, provider_subscription_ref)` 唯一（非空时）；每身份最多一条非终态（手写迁移的 `NULLS NOT DISTINCT` 唯一索引）；`version` 乐观锁 |

### 14.5 内容

| 表 | 关键不变式 |
|---|---|
| `posts` | `slug` 唯一；三条 check（schedule 成对、定时仅 draft、published 必有 published_at）；公开 feed 部分索引 |
| `categories` / `tags` | `slug` 唯一 |
| `post_categories` / `post_tags` | 复合主键 + 反向索引 |
| `post_translations` | 每 (post, locale) 最多一条 `published`（部分唯一索引） |

### 14.6 文件

| 表 | 关键不变式 |
|---|---|
| `files` | 权威 MIME 与 `size_bytes` 必填；隔离状态分区索引；`remediation_version` |
| `post_files` | `file_id` 外键 `restrict`；`kind ∈ {cover,image,attachment,preview,thumbnail,inline}` |
| `download_logs` | 每次首个请求一条记录 |

### 14.7 审计与任务

| 表 | 关键不变式 |
|---|---|
| `audit_events` | `correlation_id` 必填；`causation_id` 形成因果链；按实体/关联索引 |
| `app_events` | 运维事件，禁明文敏感值 |
| `tasks` | `dedupe_key` 唯一；`queue_class` check；领取/陈旧回收部分索引 |

### 14.8 通知

| 表 | 关键不变式 |
|---|---|
| `notification_preferences` | 每用户唯一；默认 false；opt-in 部分索引；`version ≥ 0`（check） |
| `notification_campaigns` | 每 post 唯一；状态机 + 游标 |
| `notification_deliveries` | `(campaign,user)` 唯一；`task_id` 唯一且外键 `restrict` |
| `notification_delivery_attempts` | `(delivery, attempt_number)` 唯一；`attempt_number > 0`（check）；按 UTC 日/分钟的预算索引（仅统计真实触达 SMTP 的尝试） |
| `notification_quota_windows` | `(window_kind, window_start)` 主键；计数 ≥0（check） |
| `notification_suppressions` | `(email_digest_key_id, email_digest)` 唯一；只存摘要 |

**FR-DATA-01** 所有 schema 变更必须以**按序号编号的迁移**交付（当前 31 个迁移），且必须可在旧数据上安全前滚。

**FR-DATA-02** 涉及数据回填/去重的迁移必须有真实 PostgreSQL 集成测试（如文件引用完整性、付款并发、发布工作流、通知隐私 G1 迁移）。

---

## 15. 接口需求（对外契约清单）

系统必须提供以下 HTTP 接口。所有接口必须：JSON 错误码稳定且本地化、鉴权先于读体、请求体有界。

### 15.1 公开

| 方法与路径 | 说明 |
|---|---|
| `GET /api/health` | 存活 |
| `GET /api/ready[?integrations=true]` | 就绪（集成摘要不入门禁） |
| `GET /api/site` | 公开站点信息 |
| `GET /api/tiers` | 公开等级列表 |
| `GET /api/posts` | 公开作品列表（keyset 游标） |
| `GET /api/posts/{slug}` | 作品详情（按权限投影，锁定态不含正文/附件） |
| `GET /api/payment-methods` | 公开收款方式 |
| `GET /download/{fileId}`、`GET /api/files/{id}/download` | 逐请求鉴权的文件下载 / Range 播放 |
| `GET /feed.xml`、`/robots.txt`、`/sitemap.xml`、`/sitemaps/static.xml`、`/sitemaps/posts/{shard}` | 公开投影 |

### 15.2 认证

| 方法与路径 | 说明 |
|---|---|
| `POST /api/auth/admin/login` | 管理员邮箱 + 密码 |
| `POST /api/auth/request-code`、`POST /api/auth/verify-code` | 粉丝验证码 |
| `POST /api/auth/magic-link/request`、`POST /api/auth/magic-link/confirm` | Magic Link（confirm 为显式消费） |
| `GET /api/auth/oauth/{google\|github}/start`、`/callback` | OAuth（PKCE + state） |
| `GET /api/auth/me`、`POST /api/auth/logout` | 当前身份 / 登出 |

### 15.3 会员自助（`/api/me/**`）

`GET membership`、`PATCH profile`、`PUT locale`、`GET/PUT notification-preferences`、`PUT renewal-reminder`、
`GET payment-requests`、`POST payment-requests/{id}/cancel`、`POST payment-requests/{id}/resubmit`、
`POST subscription/cancel`、`GET/PUT/DELETE supporter-wall`。

### 15.4 交易

`POST /api/payment-requests`（人工申请）、`POST /api/files/upload-payment-proof`（配额 + 图片安全）、
`POST /api/checkout/auto`（Stripe 一次性）、`POST /api/payments/subscribe`（订阅）、
`POST /api/payments/webhook/stripe`（验签 + 持久化 inbox，必须快速返回）。

### 15.5 通知退订

`POST /api/notifications/unsubscribe`、`POST /api/notifications/unsubscribe/{token}`（token 响应必须 no-store/no-referrer/noindex）。

### 15.6 管理（`/api/admin/**`，全部要求 admin session）

- **初始化与站点**：`POST setup`、`GET/PUT site`、`GET/PUT theme`、`GET system`
- **账号**：`POST account/email`、`POST account/password`、`GET account/history`、`GET account/sessions`、`DELETE account/sessions/{id}`、`POST account/sessions/revoke-others`
- **配置**：`GET/PUT/DELETE config/{smtp|turnstile|storage|upload|stripe|translation|oauth/google|oauth/github}`
- **集成**：`POST integrations/{id}/test`
- **等级**：`GET/POST tiers`、`PUT/DELETE tiers/{id}`（必须带 reason）
- **会员**：`GET/POST memberships`、`GET memberships/{id}`、`POST memberships/{id}/{suspend|resume|revoke|extend}`
- **付款**：`GET/POST payment-methods`、`PUT/DELETE payment-methods/{id}`、`GET payment-requests`、`POST payment-requests/{id}/{approve|reject|reverse}`
- **内容**：`GET/POST posts`、`GET/PUT/DELETE posts/{id}`、`PUT posts/{id}/content`、`POST posts/{id}/{publish|archive}`、`PUT posts/{id}/taxonomy`、`POST/GET/DELETE posts/{id}/files`、`POST posts/preview`
- **译文**：`GET/PUT posts/{id}/translations`、`DELETE posts/{id}/translations/{locale}`、`POST .../{publish|unpublish|ai-draft}`
- **分类标签**：`GET/POST categories|tags`、`PUT/DELETE categories/{id}|tags/{id}`
- **文件**：`GET files`、`DELETE files/{id}`、`POST files/upload`（multipart 图片）、`POST files/upload/stream`（raw-body 流式附件）
- **通知**：`GET notification-campaigns`、`GET notification-campaigns/{id}`
- **赞助墙**：`GET supporter-wall`、`PUT supporter-wall/settings`、`POST supporter-wall/{id}/{approve|hide}`
- **任务**：`GET tasks`、`POST tasks/{id}/retry`

---

## 16. 验收标准

### 16.1 通用发布门禁

**AC-1** handoff 或代码合并**不等于**发布完成。

**AC-2** 完整 CI（单测、集成测试、lint、格式、类型、构建）、浏览器 E2E、恢复演练 E2E 与安全告警检查必须全绿，才可创建版本 tag。

**AC-3** 必须在真实浏览器中验证：nonce CSP、Turnstile、S3 资源、内联视频、集成状态与 legacy footer rollout。

**AC-4** 必须在**独立 Compose 项目**中验证：归档完整性、旧 schema 探测、强制文件安全 backfill、任务/支付事件中和、local/S3 收敛。

**AC-5** 必须完成真实环境抽样：Stripe Test Mode（一次性 + 订阅 + 退款/拒付）、人工付款全流程、并发授予、SMTP 失败矩阵、文件权限矩阵、升级路径。

### 16.2 关键场景验收

| 编号 | 场景 | 判定 |
|---|---|---|
| AC-6 | 关闭所有可选集成（无 Stripe/S3/Turnstile/翻译/OAuth/Magic Link） | 人工付款闭环与 local Core 必须完整可用，`/api/ready` 必须 200 |
| AC-7 | 同一 webhook 事件重复投递 N 次 | 只授予一期会员，审计可见幂等命中 |
| AC-8 | 退款事件先于授予事件到达 | 写入 tombstone，后续授予不生效 |
| AC-9 | 并发审批同一付款申请 | 只有一次成功，另一次返回"非待审"错误 |
| AC-10 | 并发点击同一 Magic Link | 只创建一个 session；session 插入失败时链接仍可重试 |
| AC-11 | 管理员邮箱请求 Magic Link | 无 token、无投递任务、响应与普通邮箱一致 |
| AC-12 | 作品从 published 撤下后通知任务执行 | 记录 `post_not_published_skip`，不发信 |
| AC-13 | 会员到期后访问 member 作品与附件 | 页面锁定态，附件下载被拒 |
| AC-14 | 赞助墙开启后会员到期 | 该用户当次请求即不再出现在公开墙（无需定时任务） |
| AC-15 | 上传伪装扩展名/恶意图片 | 服务端权威 MIME 判定 + 重编码；失败进入 quarantine，不可对外 |
| AC-16 | 删除被作品引用的文件 | 拒绝，且数据库层兜底 |
| AC-17 | SMTP 全量失败 | 业务邮件进入可观测 defer/dead，登录不假成功，后台可重发 |
| AC-18 | 通知日预算耗尽 | 剩余投递 `budget_defer` 而非丢弃；事务型邮件不受影响 |
| AC-19 | 恢复备份后启动 | 不重放历史邮件与支付事件；DB↔存储引用收敛 |
| AC-20 | 未配置可信代理时的暴力尝试 | 落入 unresolved 高阈值应急桶并告警，不并入 per-IP 桶、不跳过限流 |

---

## 17. 约束、已知风险与后续

### 17.1 运行边界

**CON-2** v1 运行边界为**单实例**：认证与文件限流为进程本地，跨副本不一致。`APP_INSTANCE_COUNT > 1` 只告警，不提供全局一致限流。

**CON-3** 配置读取当前按需查库；若引入缓存，必须同时设计跨进程 revision/失效策略。

**CON-4** 切换 `STORAGE_DRIVER` 不迁移历史文件；local 与 S3 对象可长期并存，备份/恢复语义必须按此设计。

**CON-5** 通知投递为 **at-least-once**，不承诺绝不重复。

### 17.2 已知风险与缺口

| 编号 | 内容 |
|---|---|
| GAP-1 | Magic Link 请求响应虽统一，但共享 email+IP 限流在高频重复请求下仍可能间接区分非管理员邮箱 |
| GAP-2 | 管理员的邮箱验证码与 OAuth 行为、角色提升前已入队的投递、既有 session 吊销，不在 Magic Link 管理员边界范围内 |
| GAP-3 | AI 翻译 `monthlyCharLimit` 仅记录展示，不做本地强制预算，需依赖 provider 侧硬限额/告警 |
| GAP-4 | SEO/hreflang、posts 之外内容的翻译、archived 译文历史恢复尚未实现 |
| GAP-5 | 视频能力仅覆盖内联播放与单段 Range；无封面/时长/缩略图/转码/HLS-DASH |
| GAP-6 | Legacy 兼容路径（v1 archive restore、legacy footer 迁移、pre-v1.0 文件 backfill）待移除，计划不早于 2026-10-14 |
| GAP-7 | 主题视觉基线覆盖三个存在布局分歧的页面 × 明暗 × 三主题的默认预设，不是"全页面 × 权限 × 预设 × 语言"的组合矩阵 |

### 17.3 后续方向（不属当前需求基线）

- 多实例共享限流、任务协调、配置失效、滚动发布与高可用（Phase 10）。
- 官方内置运营能力扩展（主题、Integration adapter、邮件、SEO、统计、内容组织）随 Core 版本交付，**不引入第三方插件 runtime**。
- Tips、PPV 等新支付型商业能力保留为产品定义与运营验证项。

---

## 18. 追溯索引

| 需求域 | 主要实现位置 | 补充文档 |
|---|---|---|
| 认证 / 会话 / 限流 | `src/modules/auth/**`、`src/lib/client-rate-limit.ts` | `docs/adr/0012-oauth-fan-login.md`、`docs/handoff/harden-s4-auth-rate-limiting.md` |
| 会员 / 权益 | `src/modules/membership/**` | `docs/adr/0001`、`docs/adr/0010`、`docs/architecture/membership-lifecycle.md`、`docs/admin/membership-tiers.md` |
| 支付 / 订阅 | `src/modules/payment/**` | `docs/adr/0005`、`docs/adr/0009`、`docs/admin/payment-review.md` |
| 内容 / 发布 / 翻译 | `src/modules/content/**`、`src/modules/translation/**` | `docs/adr/0004`、`docs/adr/0006`、`docs/adr/0007`、`docs/adr/0008`、`docs/architecture/i18n-ai-translation.md` |
| 文件 / 存储 / 下载 | `src/modules/file/**`、`src/modules/storage/**`、`src/modules/download/**` | `docs/adr/0011`、`docs/handoff/harden-s1a`、`harden-s1b`、`docs/admin/storage-settings.md` |
| 通知 | `src/modules/notifications/**` | `docs/handoff/harden-s5-email-reliability.md` |
| 赞助墙 | `src/modules/supporter-wall/**` | `docs/releases/v1.1.0-release-notes.md` |
| 主题 | `src/modules/theme/**`、`src/themes/**` | `docs/architecture/theme-system.md`、`docs/developer/theme-development.md` |
| 集成 | `src/modules/integration/**` | `docs/architecture/integration-plugin-system.md` |
| 配置中心 | `src/modules/config/**`、`src/modules/site/**` | `docs/architecture/config-center.md`、`docs/admin/site-settings.md` |
| 审计 / 任务 | `src/modules/audit/**`、`src/modules/tasks/**` | `docs/adr/0002`、`docs/adr/0003` |
| 安全响应头 / CSP | `src/middleware.ts`、`src/modules/security/**`、`src/modules/site/public-security.ts` | `docs/handoff/harden-s6-security-response-headers.md` |
| 备份 / 恢复 | `src/modules/restore/**`、`scripts/backup.sh`、`scripts/restore.sh` | `docs/deployment/backup-restore.md`、`docs/handoff/harden-s7-backup-consistency.md` |
| 部署 / 边缘 | `Dockerfile`、`docker-compose*.yml`、`docker/` | `docs/architecture/deployment-network-edge.md`、`docs/deployment/**` |
