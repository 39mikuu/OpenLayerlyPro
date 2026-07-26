# Issue #176：管理员账号 Magic Link 边界规格

- **状态**：Proposed
- **Issue**：[#176](https://github.com/39mikuu/OpenLayerlyPro/issues/176)
- **设计基线**：`origin/main` `2bb11b36dfed39de2b0f3ff4f69f6be5ebfd3907`
- **变更类型**：Auth / authorization boundary security fix

## 1. 背景与目标

`docs/release-v1.2-plan.md` 将 Magic Link 定义为粉丝/会员登录路径，并规定管理员继续使用邮箱与密码。当前基线没有强制该边界：

- `requestMagicLink()` 可为已属于管理员的邮箱生成 token 与投递任务；
- `consumeMagicLinkToken()` 会解析该管理员用户并在 #175 的原子事务中创建 session；
- session 随后可访问 `/admin`，形成公开 passwordless 管理员入口。

本 Issue 只关闭 **Magic Link** 的这一入口，不修改管理员密码登录、邮箱验证码或 OAuth 策略。

## 2. 权威来源与范围边界

### 2.1 权威来源

- `docs/release-v1.2-plan.md` §3 WP1：管理员入口不使用 Magic Link；管理员继续使用邮箱 + 密码。
- Issue #176 的 required invariants。
- `docs/handoff/issue-175-magic-link-session-atomicity.md`：token 消费、用户解析、登录元数据与 session 创建必须属于同一 PostgreSQL 事务。
- `AGENTS.md`：认证竞态必须明确事务与锁边界，并使用真实 PostgreSQL 验证。
- 当前基线代码与测试。

已关闭且未合并的 PR #169 仅作为历史输入，不是实现基线。它的消费期角色检查位于 #175 原子事务之外，因此不得直接复用。

### 2.2 本 Issue 保证

1. 请求已是管理员的邮箱时，返回与普通抑制路径相同的 `{ suppressed: true }`，不创建 token 或投递任务。
2. token 签发后用户被提升为管理员时，消费事务内重新读取并锁定当前角色，拒绝创建 session。
3. 管理员拒绝路径不创建/修改用户，不更新 locale 或 `last_login_at`，不产生 `user_login` 或 `magic_link_consumed`。
4. 拒绝使用通用对外状态，遥测只记录安全摘要。
5. 普通 member/fan、key rotation、重放、redirect、邮件投递与邮箱验证码 fallback 保持不变。

### 2.3 明确不声称的全局保证

本规格不声称“管理员不存在任何 passwordless 路径”：邮箱验证码和 OAuth 不在本 Issue 范围内；角色提升后既有 session 的吊销也不在范围内。若这些路径需要同样收紧，必须单独立项并处理其既有产品/ADR 语义。

## 3. 不变量

实现必须同时满足：

1. 管理员邮箱请求对外保持 accepted-shaped 响应，不暴露账号存在性或角色。
2. 请求时已是管理员的邮箱不生成 `magic_link_tokens`、不生成 `tasks`、不消耗共享 email+IP 发送预算。
3. 消费期角色检查必须位于 #175 的同一个 `getDb().transaction(tx)` 内，并使用该 `tx`，不得回退到全局 `getDb()`。
4. 若消费期当前角色为 admin，则不创建 session、不更新用户字段、不创建用户；token 进入终态。
5. 对普通 member/fan，#175 的 token CAS、用户解析、last-login 与 session 原子提交/回滚语义完全保持。
6. 原始 token、token hash、明文邮箱、redirect、IP、user-agent 不进入拒绝事件 payload。
7. GET 验证页继续只验证、不消费、不查询角色；真正的角色拒绝发生在显式 POST 消费。
8. 不新增 schema、migration、公开错误类型或 i18n 文案。

## 4. 设计

### 4.1 请求期守卫

请求流程保留现有 keyring 与 SMTP 配置检查。进入现有按规范化邮箱取得 advisory transaction lock 后，在读取活跃 token、消耗 email+IP 预算或生成 token 之前查询用户角色：

```text
normalize email / read env / validate keyring and SMTP
└─ transaction(tx)
   ├─ pg_advisory_xact_lock(hashtext(normalizedEmail))
   ├─ findUserByEmail(normalizedEmail, tx)
   ├─ role == admin → return { suppressed: true }
   └─ existing dedupe / rate limit / mint / enqueue path unchanged
```

守卫必须在 email+IP rate limiter 之前，避免通过“管理员邮箱更快耗尽专用桶并返回 429”形成角色枚举 oracle。Route 级 source/IP 限流仍保持现状，所有请求都受它约束。

请求期检查是降低无效 token/邮件产生的 best-effort 优化，不是最终授权边界。角色可能在检查后被提升，因此消费期守卫是强制安全边界。

请求期管理员抑制不写 `app_events`，避免在持久管理遥测中留下邮箱角色标记；允许使用既有 HMAC 邮箱摘要写一条不含角色/邮箱明文的 info 日志。

### 4.2 消费期角色锁

在 #175 原子事务中，token CAS 命中后、任何用户更新或 session 创建之前，对现有用户行执行事务内锁定读取：

```sql
select id, role
from users
where email = $normalizedEmail
limit 1
for no key update;
```

- 若命中 admin：返回通用 `invalid` 结果，并提交 token 的 `consumed_at`；不进入用户更新/session 分支。
- 若命中 member：继续既有 `findOrCreateUserByEmail(email, tx)`；该行锁阻止并发角色更新越过当前事务。
- 若未命中：继续 `findOrCreateUserByEmail(email, tx)`，随后必须再次检查返回用户的 `role`。这是无用户行时并发创建 admin 的必要兜底；PostgreSQL 不提供适合此处的邮箱 gap lock。

两处角色判定都是必需的。第一处提供现有用户的确定性锁语义，第二处覆盖“首次读取无行、并发创建 admin、冲突后返回 admin”的竞态。

`FOR NO KEY UPDATE` 足以与角色 UPDATE 冲突，同时不比需要的范围更强。流程继续依赖 PostgreSQL 默认 `READ COMMITTED`，不在本 Issue 引入 `40001` 重试协议。

### 4.3 token 终态

**管理员拒绝提交 `consumed_at`，链接永久烧毁，但不发放 session。**

不采用抛错回滚 token CAS：让已确认属于管理员边界的活 token 继续可重试，会延长攻击窗口并提供重复尝试 oracle。首次显式消费返回通用 `invalid`，后续尝试按既有状态返回 `replayed`。

`consumed_at` 是 token 生命周期状态，不属于“管理员用户零变更”约束。管理员路径必须保持：

- 0 session；
- 0 新用户；
- 原用户 `role`、`locale`、`last_login_at`、`updated_at` 不变；
- 不产生 `user_login` 或 `magic_link_consumed`。

### 4.4 可观测性

消费期复用 `magic_link_rejected`，并保持提交后 best-effort 记录：

```ts
{
  reason: "invalid",
  boundary: "admin",
  tokenId,
  keyId,
  userId,
}
```

`boundary` 仅存在于服务端事件 payload，不进入 HTTP 响应。payload 白名单仅允许上述字段；禁止原始 token、token hash、明文邮箱、redirectPath、IP 和 user-agent。

`AppEventType` 不新增成员。若 `recordEvent()` 失败，不回滚已经提交的 token 终态。

### 4.5 GET 确认页与公开契约

`verifyMagicLinkToken()` 和 GET 确认页保持不变。管理员链接在显式确认前仍可显示为可确认：

- GET 必须继续零状态变更，防止邮件客户端 prefetch 消费；
- GET 增加角色查询会形成不烧毁 token 的预消费 oracle；
- 授权决策应在真正执行状态变更的 POST 事务中完成。

`RequestMagicLinkResult`、`MagicLinkConsumption`、`MagicLinkRejectionReason`、Route 响应、cookie 与 zh/en/ja 文案均不变。

## 5. 竞态与失败语义

| 场景 | 要求行为 |
|---|---|
| 请求时已是 admin | `{ suppressed:true }`；0 token；0 task；不消耗 email+IP 预算 |
| member 签发后被提升，再消费 | `invalid`；token 终态；0 session；用户零变更 |
| 提升事务先持有用户行锁，消费随后开始 | 消费在角色锁读取处等待；提升提交后读取 admin 并拒绝 |
| 消费先锁定 member 并提交，提升随后发生 | 本次 member 登录成功，提升在事务后生效；既有 session 吊销不属于本 Issue |
| 请求检查与提升并发 | 可能生成 token；消费期守卫必须最终拒绝 |
| 无用户行时并发创建 admin | 冲突安全创建返回 admin 后，第二处检查拒绝；不得另建 member |
| 同一管理员 token 双并发消费 | 一个 `invalid`、一个 `replayed`；0 session |
| 管理员拒绝后的事件写入失败 | token 终态仍提交；仅日志记录事件失败 |
| #175 持锁者在 session 插入前回滚 | 普通 member 等待者接管语义保持不变 |

## 6. 文件范围

### Spec PR

- 新增 `docs/handoff/issue-176-admin-magic-link-boundary.md`

### Implementation PR

预计只修改：

- `src/modules/auth/magic-link.ts`
- `src/modules/auth/magic-link.integration.test.ts`
- 必要时 `CHANGELOG.md`

明确不修改：schema/migrations、管理员密码登录、邮箱验证码、OAuth、session helper、Magic Link routes/pages、i18n 文案、ADR。

## 7. TDD 与真实 PostgreSQL 验收

实现前先添加并实际观察以下测试在当前 main 上因缺失边界而失败，再写最小实现使其通过。

### 7.1 请求期

1. **管理员邮箱静默抑制**：大小写/空白规范化后返回 `{ suppressed:true }`；0 token、0 task、0 app event；管理员所有字段不变。增加普通 member/fan 对照，证明正常签发仍成功。
2. **管理员请求不消耗 email+IP 专用预算**：对同一 admin 邮箱调用超过 `REQUEST_CODE_EMAIL_IP_RATE_MAX` 次，均为 suppressed，不返回 429，且始终 0 token/task。
3. **并发管理员请求**：同一管理员邮箱两个请求在 advisory lock 上串行，均 suppressed，0 token/task。

### 7.2 消费期

4. **签发后晋升**：member + token → 更新为 admin → 消费返回 `invalid`；token `consumed_at` 非空；0 session；用户字段不变；恰好一条安全白名单 `magic_link_rejected`；再次消费为 `replayed`。
5. **提升事务先行的确定性锁测试**：保留 PostgreSQL 连接开启事务并更新 member 为 admin 但不提交；启动消费，通过 `pg_stat_activity` / `pg_blocking_pids()` 的有界轮询确认消费阻塞在 `FOR NO KEY UPDATE`，禁止固定 sleep；提交提升后消费必须 `invalid`。
6. **无用户行并发创建 admin**：控制事务插入 admin 但不提交；消费 CAS 后首次角色读无行，并在用户冲突插入处等待；提交后 `findOrCreateUserByEmail()` 返回 admin，第二处角色判定拒绝。最终恰好一个 admin、0 session、token 终态。
7. **双并发管理员确认**：恰好一个 `invalid`、一个 `replayed`；0 session；事件分别为 admin-boundary invalid 与 replayed。

### 7.3 必须保持的既有回归

- 正常 member Magic Link request/delivery/verify/consume；
- 双健康确认只一个成功；
- session 插入失败完整回滚；
- 持锁者回滚后等待者接管；
- previous/current key rotation；
- redirect allowlist；
- request/confirm Route 测试零改动并保持绿。

## 8. 必跑门禁

### Spec PR

- `pnpm format:check`
- 独立只读规格复核，确认文档与 exact base 代码一致

### Implementation PR

- focused Magic Link 真实 PostgreSQL integration tests
- focused Magic Link request/confirm Route tests
- `pnpm check:request-bodies`
- `pnpm check:auth-before-body`
- `pnpm format:check`
- `pnpm lint`
- `pnpm exec tsc --noEmit`
- `RUN_DB_INTEGRATION_TESTS=true pnpm test`
- `pnpm build`
- 浏览器验证：admin 邮箱请求与普通 member 有相同 accepted-shaped UI，不创建 session；签发后晋升的 token 显式确认后进入通用失败页且无法重放
- 完整 diff 的 Claude Code Opus 5 只读复核；处理 findings 后新鲜复核
- Draft PR 上请求 `@codex review`，处理所有 actionable findings

所有证据必须绑定 implementation exact head。未执行或因基础设施跳过的检查必须明确报告。

## 9. 非目标

- 修改管理员密码登录、邮箱验证码或 OAuth policy
- 重开/复用 PR #169
- 重新实现 Issue #175
- 角色提升时吊销既有 session
- 修改 token TTL、keyring、rotation、redirect、重发抑制或限流策略
- 将 `app_events` 事务化
- 修改 GET 确认页
- 自动合并、标记 Ready 或关闭 Issue

## 10. 回滚与风险

无 schema 或数据迁移。回滚只需撤销 `magic-link.ts` 的请求/消费守卫及对应测试。

主要风险：

- 角色锁读取误用全局数据库 client：由确定性并发测试和独立审阅约束；
- 漏掉无用户行并发创建后的第二次角色检查：由专用真实 PostgreSQL 测试约束；
- 守卫被移动到 email+IP 限流后产生角色枚举 oracle：由预算测试约束；
- 遥测字段泄漏：由精确 payload 白名单测试约束；
- 过度声称全局管理员认证边界：文档和 PR 必须明确邮箱验证码/OAuth/既有 session 均不在范围内。
