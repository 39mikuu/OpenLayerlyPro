# 交接：S4 认证限流硬化（含 #66 verify-code 定向锁死）

> 自包含实现说明。前置依赖：当前 `main` 已含 #60 client identity helpers、`@/lib/rate-limit`、S1a/#70 请求体有界读取。属 v1.0 安全硬化 S4（epic #64，含 #66）。无需 ADR。
>
> 实现 PR 必须基于最新 `main`，保持 Draft，直到真实 PostgreSQL 集成测试与完整 CI 全绿。

## 0. 不可违反的安全不变量

1. **正确验证码必须始终能越过所有“错误尝试”限制并完成登录。**任何 IP、email+IP、`attempt_count` 或共享 emergency 桶都不得在比对正确码之前返回 429。
2. **错误提交不得使正确码失效。**失败计数只影响错误响应，不作废 code，不阻断正确码。
3. 移除全局 per-code 失败锁后，必须用足够验证码熵抵御分布式枚举。
4. request-code 不得存在纯 email 的阻断门禁；删除会返回 429 的纯 email cooldown / 小时硬上限。
5. 所有 email 状态统一先 `trim().toLowerCase()`，再查询、写库、限流、去重和锁。
6. email 派生的限流/去重 identity key 只允许 keyed HMAC-SHA-256；禁止 raw email、`hashtext`、普通 SHA 或短弱 hash。
7. `hashtext` 只可作为 PostgreSQL advisory lock 的内部锁槽；锁内必须重新按真实 normalizedEmail 查询。
8. request-code 保留 Turnstile；Turnstile/schema/dedupe 等未发送退出不得消费 email+IP 发送预算。
9. 同一 normalizedEmail 的 dedupe、code 创建与投递必须并发安全。
10. unresolved 客户端按操作使用独立 emergency 桶，不得双重计数；其共享残余风险必须如实记录。
11. 单进程内存限流不具备多实例一致性；v1.0 只做告警、文档和未来接缝。

## 1. 当前漏洞

- `verifyLoginCode` 当前先增加 `attempt_count`，达到上限后连正确码也拒绝，形成 #66。
- verify route 当前无路由纵深限制，但简单增加“比对前 429”会重新制造正确码锁死。
- request-code 当前存在纯 email `code-hour`、`code-cooldown`，并先插入 code 再同步发信。
- request-code 当前保留 Turnstile，本切片不得回退。
- admin-login 当前使用 `ip ?? "unknown"`，unresolved 用户共享全局桶。
- auth schema、UI 与文案当前绑定 6 位数字码。

## 2. 共享 identity 与 keyed email digest

将 #60 的 `ClientRateLimitIdentity`、`resolveClientRateLimitIdentity`、`warnUnresolvedClientRateLimitIdentity` 上移到中性模块，download 与 auth 共用。

email identity：

```ts
const normalizedEmail = normalizeEmail(rawEmail);
const emailDigest = hmacSha256WithPurpose(
  "auth-rate-limit-email",
  normalizedEmail,
);
```

要求：

- secret 来自现有受保护的服务端密钥体系，并做 purpose/domain separation。
- 默认使用完整 256-bit hex/base64url；若截断，至少 128 bit，并在 PR 写明碰撞预算。
- raw email 不得进入 limiter key、dedupe key、日志或 metrics。
- `hashtext(normalizedEmail)` 只允许生成 advisory-lock 槽位，不能作为 identity；取得锁后重新按 normalizedEmail 查询状态。

策略函数：

- admin-login：resolved IP 桶 / `admin-login-unresolved`。
- verify-code：**错误尝试后**才记账的 IP 桶、resolved emailDigest+IP 桶；unresolved 只记一次 `verify-unresolved`。
- request-code：解析前 IP 主桶；resolved emailDigest+IP 桶只表示真实发送/排队尝试预算；unresolved 只使用一次 `request-code-unresolved`。

## 3. 输入规范化与校验顺序

不得用 `z.string().email()` 在 normalize 前直接拒绝等价输入。两条 auth route 均采用以下之一：

```ts
z.preprocess(
  (value) => typeof value === "string" ? normalizeEmail(value) : value,
  z.string().email().max(MAX_EMAIL_LENGTH),
)
```

或先以有界 string 解析，再 normalize 后执行 email validation。

要求：

- 长度限制同时覆盖 raw 输入与 normalized 值，避免超长空白输入绕过资源边界。
- `Fan@Example.com`、` fan@example.com `、`fan@example.com` 必须得到同一 normalizedEmail。
- code 同理：有界 raw string → `normalizeLoginCode` → 最终字母表/长度校验。

## 4. verify-code：正确码优先，错误后限流

### 4.1 核心函数返回结构化结果

重构 `verifyLoginCode`，在事务内锁定该 email 最新未使用、未过期 code：

1. 读取候选行并 `FOR UPDATE`。
2. 先比较 `hmac(normalizeLoginCode(submitted))` 与 `code_hash`。
3. **正确**：立即标记 `usedAt=now()` 并返回成功，完全不读取或判断 `attempt_count` 限制。
4. **错误**：增加 `attempt_count`，返回结构化错误结果，例如：

```ts
type VerifyLoginCodeResult =
  | { ok: true; user: User }
  | { ok: false; reason: "incorrect" | "attempts_exceeded" | "expired" };
```

`attempts_exceeded` 只描述错误尝试状态，不得阻止未来正确码。

### 4.2 路由顺序

```text
CL 预拒
→ 有界解析 raw email/code
→ normalize + validate email/code
→ verifyLoginCode 先完成正确性比较
→ 成功：直接登录，不查询、不消费、不受任何 verify 错误限流桶影响
→ 错误：再对 IP 或 unresolved 桶记账；resolved 再对 emailDigest+IP 桶记账
→ 错误桶未超限：返回核心错误（incorrect/attempts_exceeded/expired）
→ 错误桶超限：返回 429
```

关键要求：

- verify 的 IP/email+IP/emergency 桶是**wrong-attempt limiter**，不是请求前门禁。
- 正确提交永远不消费这些桶，也不因已耗尽的桶被拒。
- malformed body/code 可返回 400；不得将“同 IP 先前 malformed/错误请求”变成正确码的前置 429。
- 若需要基础设施级过载保护，只能使用不以受害者 email 为目标、且明确区别于认证错误限制的全局容量保护；不得宣称其保证 #66 语义，也不得在本切片用低阈值代替上述流程。

### 4.3 熵与前后端同源

威胁预算：TTL 10 分钟、每 IP 10 次错误、`K=10^6` IP，`B=10^7`；要求：

```text
B / codeSpace <= 2^-20
```

因此 code space 至少约 `2^43.3`：

- 合格：9 位 Crockford base32（45 bit）或 14 位数字。
- 不合格：8 位 base32、9–10 位数字。
- 默认：9 位 uppercase Crockford base32。

共享 `normalizeLoginCode` 至少执行 `trim()`，字母码统一 `toUpperCase()`。以下必须同源：

- `generateLoginCode`
- code HMAC 写入与验证
- verify schema
- login form 的 `maxLength`、`inputMode`、placeholder
- 提交按钮旧 `code.length !== 6` 条件
- i18n 与前后端测试

## 5. request-code：非阻断、并发安全、投递一致

### 5.1 顺序

```text
CL 预拒
→ client IP / unresolved emergency 主门禁
→ 有界解析 raw email/turnstileToken
→ normalizeEmail 后校验
→ Turnstile
→ 按 normalizedEmail 串行化并重新检查 dedupe
→ dedupe 命中：200；不写 code、不刷新窗口、不扣发送预算
→ 未命中：resolved 时扣 emailDigest+IP 真实发送预算
→ 同一事务创建 code + durable email task/outbox
→ commit 后 200
```

Turnstile、schema、dedupe 未发送退出不扣 email+IP 发送预算。解析前 IP 主桶仍限制端点压力。

### 5.2 去重与并发

- 删除纯 email `code-hour` 与 429 cooldown。
- dedupe 默认 60 秒，仅在成功建立可交付投递时推进。
- 抑制请求返回 200，不创建新 code，不刷新窗口。
- advisory lock/稳定锁行按 normalizedEmail 串行化；若锁槽 hash 碰撞，锁内仍按真实 email 查询，各 email 状态不得混用。
- 同 email 并发请求只允许一个创建 code/投递；另一个取得锁后重查并抑制。

### 5.3 投递失败

- 推荐 code 与 durable task/outbox 在同一事务创建，确保最新有效码具有可交付邮件。
- 若同步 SMTP：发送失败必须删除/作废新 code，且不得推进 dedupe；重试必须能够真正发送。

## 6. admin-login

```text
CL 预拒 → admin resolved-IP / unresolved 门禁 → readJson → adminLogin
```

移除 `?? "unknown"`。unresolved 使用 `admin-login-unresolved` 专用高阈桶并节流告警；不波及 resolved-IP 用户。unresolved 客户端之间仍共享计数，这是明确残余。

## 7. env 与多实例

```text
ADMIN_LOGIN_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
VERIFY_CODE_IP_RATE_MAX / VERIFY_CODE_EMAIL_IP_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
REQUEST_CODE_IP_RATE_MAX / REQUEST_CODE_EMAIL_IP_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
REQUEST_CODE_SEND_DEDUPE_SECONDS
LOGIN_CODE_LENGTH / LOGIN_CODE_ALPHABET
```

所有 env 有上下限，越界启动失败，`.env.example` 同步。

v1.0 不实现共享限流存储。readiness/启动日志与部署文档必须说明多实例独立计数可被绕过，并保留未来 Redis/PG 接缝。

## 8. 必测行为

- 同 IP 连续 10 次错误后，再提交正确码仍成功；正确码不消费 wrong-attempt 桶。
- 攻击者与受害者共享 NAT、且桶已耗尽时，受害者正确码仍成功。
- 跨多 IP 把 `attempt_count` 打满后，正确码仍成功；继续错误才得到 429/attempts_exceeded。
- wrong-attempt limiter 只在核心确认错误后记账；正确/expired/malformed 的具体记账策略必须与文档一致，不得阻断正确码。
- raw email 先有界读取，再 normalize 后校验；三种大小写/空白变体命中同一 user、digest、limiter、dedupe。
- 超长 raw email（即使 trim 后很短）仍被有界 schema 拒绝。
- 9 位 uppercase base32 在生成、normalize、schema、UI、提交和 HMAC 验证中同源；lowercase/空白可规范化，非法字符 400。
- raw email 不出现在 key/log/metrics；不同 email 不共享 HMAC identity。
- 模拟 advisory-lock hash 碰撞时，锁内真实 email 状态仍严格隔离。
- Turnstile 失败不写 code、不排队、不扣发送预算。
- 5 次 dedupe 抑制不耗尽 5/hr；真正第 6 次发送尝试才 429。
- 同 email 并发真实 PG 测试：只新增一码、只排队/发送一封，另一个 200 抑制。
- outbox 失败回滚；同步 SMTP 失败不留未送达最新码、不推进 dedupe。
- unresolved request-code 每请求 emergency 桶只 +1；verify 只在确认错误后 +1。
- download/#60、proof 上传、正常登录、管理员登录、Turnstile 无回退。

## 9. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm check:request-bodies
pnpm exec drizzle-kit generate
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

若新增持久 dedupe 字段/表必须提交迁移；若复用 durable task/outbox + advisory lock，说明为何无 schema 变更。

## 10. 验收 checklist

- [ ] 正确码先比较并绕过所有 verify wrong-attempt 限制
- [ ] 错误提交不能作废或阻断正确码
- [ ] verify 限流仅在确认错误后记账/阻断
- [ ] 验证码空间满足预算，默认 9 位 uppercase base32
- [ ] generate/normalize/schema/UI/submit/i18n/tests 同源
- [ ] raw email 有界后 normalize，再执行 email validation
- [ ] email 使用 keyed HMAC-SHA-256 identity；禁止 hashtext/普通 hash
- [ ] advisory lock hash 只作锁槽，锁内重查 normalizedEmail
- [ ] request-code 保留 Turnstile，未发送退出不扣预算
- [ ] 删除纯 email 阻断键
- [ ] dedupe 不滑动、不创建未发送新码
- [ ] 同 email 并发只一码一封
- [ ] code 与 durable 投递原子，或同步失败可靠补偿
- [ ] admin-login 去全局 unknown
- [ ] unresolved 不双计并如实记录共享残余
- [ ] 多实例边界已告警和文档化
- [ ] 真实 PostgreSQL 测试与完整 CI 全绿

## 已锁定决策（owner 确认 2026-06-26）

- 多实例共享限流存储不纳入 v1.0。
- verify-code：wrong-attempt IP `30/10min`，wrong-attempt email+IP `10/10min`；正确码不受其影响。
- request-code：IP `20/hr`，真实发送 email+IP `5/hr`，dedupe `60s`。
- admin-login：`10/10min`。
- email identity：keyed HMAC-SHA-256；`hashtext` 仅限 advisory lock 槽位。