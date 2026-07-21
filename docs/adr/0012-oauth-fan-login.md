# ADR 0012：粉丝 Google / GitHub OAuth 登录

- **Status**：Accepted ✅（2026-07-21）
- **相关**：`docs/release-v1.2-plan.md` WP2 / M2；前置 WP1 Magic Link（migration 0028）
- **依赖**：加密配置存储（`app_settings` + AES）、session cookie、Integration status registry

## Context

v1.2 需要在邮箱验证码与 Magic Link 之外，为粉丝/会员增加 Google 与 GitHub OAuth。管理员**主入口**仍是邮箱 + 密码；本决策明确 **OAuth 允许绑定到已有 admin 用户并建立 admin 会话**（与「控制邮箱即控制身份」一致），但不提供「管理员专用 OAuth 登录页」。

## Decision

### 1. 配置（对齐 Stripe）

- 每个 provider 独立加密配置组：`oauth_google`、`oauth_github`。
- 字段：`enabled`、`clientId`、`clientSecret`（secret 仅密文落库）。
- 解析与 Stripe 同构：`get*Config` / `get*AdminView`（`clientSecretSet`、`configured`、`hasDbOverride`）/ `save*` / `clear*`。
- Admin API 与后台设置页不返回 `clientSecret` 明文；Integration registry 使用 3-state（未配置 / 已配置未启用 / 已启用），source 在有 DB 覆盖时为 `database`，否则 `none`。
- **不**以环境变量作为运行时主配置源（与当前 Stripe 实现一致）。

### 2. 协议与状态

- 仅 Authorization Code + **PKCE S256** + 随机 `state`。
- Server 持久化 `oauth_states`：`state` 仅存 HMAC/hash；`code_verifier` 加密存储；TTL（默认 10 分钟）；**single-use** 消费；过期与消费后不可重放。
- Callback 错误只映射安全摘要码，不回显 provider raw error / token。

### 3. 身份与绑定

- 表 `oauth_identities`：唯一约束 `(provider, provider_account_id)`；`user_id` → `users`。
- **绑定优先级**：
  1. 已有 provider identity → 登录对应用户（**identity 优先**，即使 provider 返回的 verified email 已变更也不做 email silent rebind）。
  2. 否则要求 **verified email**（Google：`email_verified=true`；GitHub：`user/emails` 中 primary/verified 或任一 verified）。
  3. verified email 命中已有用户（**含 admin**）→ 绑定 identity 后登录。
  4. 否则创建 `role=member` 用户并绑定。
- 冲突 fail closed：identity 已绑定其他用户时不可改绑；缺 verified email 拒绝登录。

### 4. Redirect 与会话

- `next` / 登录后跳转复用 Magic Link 站内相对路径 allowlist；默认 `/me`（admin 用户可再进 `/admin`）。
- 成功后 `createSession` + session cookie，与验证码 / Magic Link 一致。

### 5. 非目标

- 管理员 OAuth 专用入口、组织/team 授权、账号合并 UI、OIDC 泛化框架、provider marketplace。
- 不替换邮箱验证码或 Magic Link；provider 故障不得阻断二者。

## Consequences

- 需 migration `0029`、auth 模块、admin 配置 API/UI、Integration 两项、三语文案与 PG 集成测试。
- Live Google/GitHub round-trip 证据可在里程碑 dogfood 收集，CI 以 mock/集成测为主。
