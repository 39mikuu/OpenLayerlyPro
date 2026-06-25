# 交接：S4 认证限流硬化（含 #66 verify-code 定向锁死）

> 自包含实现说明。前置依赖：当前 `main` 已含 #60 的 client identity helpers、`@/lib/rate-limit`、S1a/#70 的请求体预拒。属 v1.0 安全硬化 S4（epic #64，含 #66）。无需 ADR。
>
> 实现 PR 必须基于最新 `main`，保持 Draft，直到真实 PostgreSQL 集成测试与完整 CI 全绿。

## 0. 红线

1. **正确验证码必须始终优先校验**：第三方错误提交不得让正确码失效。失败计数只影响后续错误尝试，不得阻断正确码。
2. **移除全局 per-code 失败锁后必须提高验证码熵**，否则 6 位数字码会暴露于分布式在线枚举。
3. **request-code 不得存在纯 email 的阻断门禁**：删除会返回 429 的纯 email cooldown / 小时硬上限。
4. **所有 email 身份状态先规范化**：统一 `trim().toLowerCase()`，再用于查询、写库、限流、去重和锁。
5. **所有 email 派生的限流/去重 identity key 必须使用带密钥、抗碰撞摘要**：仅允许 HMAC-SHA-256 或同等级 keyed digest；禁止 `hashtext`、普通 SHA、截断短 hash 或原始 email。
6. **`hashtext` 仅可用于 PostgreSQL advisory lock 的内部锁键**，不得作为限流/去重 identity；进入锁后必须按真实 `normalizedEmail` 重新查询和校验，不能把 hash 相等视为 email 相等。
7. **request-code 必须保留 Turnstile**；Turnstile 失败不得创建 code、排队邮件或消费 email+IP 发送预算。
8. **未发送退出不得消费发送预算**：schema 失败、Turnstile 失败、dedupe 抑制都不扣 `REQUEST_CODE_EMAIL_IP_RATE_MAX`。
9. **同一 normalizedEmail 的 dedupe、code 创建与投递必须并发安全**：两个并发请求不得各自生成一码一封。
10. **unresolved client 只走一次该操作 emergency 桶**，不得双重计数；不同操作使用独立 emergency 桶。
11. **单进程内存限流不具备多实例一致性**；v1.0 只做告警、文档和接缝，不实现 Redis/PG 共享限流。

## 1. 现状

- `verifyLoginCode` 当前先增加 `attempt_count`，达到 `MAX_ATTEMPTS` 后连正确码也拒绝，形成 #66 定向锁死。
- `requestLoginCode` 当前存在纯 email `code-hour` 与 `code-cooldown` 阻断键，并在插入 code 后同步发信。
- `request-code` 路由当前保留 Turnstile；本切片不得回退。
- `admin-login` 当前使用 `ip ?? "unknown"`，会让 unresolved 客户端共享全局桶。
- verify route、login form 与文案当前均绑定 6 位数字码。

## 2. 共享 client identity 与 auth rate-limit policy

把 #60 的 `ClientRateLimitIdentity`、`resolveClientRateLimitIdentity`、`warnUnresolvedClientRateLimitIdentity` 上移到中性模块，download 与 auth 共用。

新增策略：

- `getAdminLoginRateLimit(identity)`：resolved `admin-login-ip:${ip}`；unresolved `admin-login-unresolved`。
- `getVerifyCodeIpRateLimit(identity)`：resolved `verify-ip:${ip}`；unresolved `verify-unresolved`。
- `getVerifyCodeEmailIpRateLimit(identity, emailDigest)`：仅 resolved 使用，key 为 `verify-email-ip:${emailDigest}:${ip}`。
- `getRequestCodeIpRateLimit(identity)`：resolved IP 桶；unresolved `request-code-unresolved`。
- `getRequestCodeEmailIpRateLimit(identity, emailDigest)`：仅 resolved 使用，表示**真实发送/排队尝试预算**。

`emailDigest` 必须来自：

```ts
const normalizedEmail = normalizeEmail(email);
const emailDigest = hmacSha256WithPurpose("auth-rate-limit-email", normalizedEmail);
```

要求：

- HMAC secret 来自现有受保护的服务端密钥体系，带 purpose/domain separation；不得复用验证码明文 hash 语义而无 purpose。
- 输出可使用完整 hex/base64url，或至少 128 bit 的明确截断；若截断，PR 必须写明碰撞预算。默认推荐完整 256 bit。
- 日志、metrics、错误与限流 key 中不得出现 raw email。
- `hashtext(normalizedEmail)` 只允许用于 advisory lock；锁内仍按 normalizedEmail 查询最新状态。

## 3. verify-code

### 3.1 核心语义

在事务内锁定该 email 最新未使用、未过期 code：

1. 读取最新候选行并 `FOR UPDATE`。
2. 先比较 `hmac(normalizeLoginCode(submitted))` 与 `code_hash`。
3. 正确：标记 `usedAt=now()` 并成功，完全不看 `attempt_count`。
4. 错误：增加 `attempt_count`；达到阈值后仅对后续错误尝试返回 `429 codeAttemptsExceeded`。

失败计数绝不作废 code，也不承担总猜测次数边界。

### 3.2 路由顺序

```text
CL 预拒
→ client IP / unresolved emergency 门禁
→ 有界解析 body
→ normalizeEmail + normalizeLoginCode
→ resolved 时 emailDigest+IP 门禁
→ verifyLoginCode
```

unresolved 不执行第二层 email+IP 门禁，避免同一 emergency 桶每请求计两次。

### 3.3 验证码熵与同源

默认威胁预算：TTL 10 分钟、每 IP 10 次、`K=10^6` IP，`B=10^7`。要求：

```text
B / codeSpace <= 2^-20
```

因此 code space 至少约 `2^43.3`：

- 合格：9 位 Crockford base32（45 bit）或 14 位数字。
- 不合格：8 位 base32、9–10 位数字。
- 默认推荐：9 位 uppercase Crockford base32。

必须新增共享 `normalizeLoginCode`：至少 `trim()`，字母码统一 `toUpperCase()`。以下全部同源：

- `generateLoginCode`
- code HMAC 写入与验证
- verify route schema
- `login-form.tsx` 的 `maxLength`、`inputMode`、placeholder
- 提交按钮的 `code.length !== 6` 旧条件
- i18n 文案与前后端测试

## 4. request-code

### 4.1 顺序

```text
CL 预拒
→ client IP / unresolved emergency 门禁
→ 有界解析 { email, turnstileToken }
→ normalizeEmail
→ Turnstile
→ 按 normalizedEmail 串行化并重新检查 dedupe
→ 命中 dedupe：200，且不写 code、不刷新时间、不扣发送预算
→ 未命中：resolved 时扣 emailDigest+IP 发送预算
→ 同一事务创建 code + durable email task/outbox
→ commit 后 200
```

Turnstile 失败、schema 失败、dedupe 抑制均不得消费 email+IP 发送预算。IP 主桶仍在解析前消费，用于限制端点压力。

### 4.2 非阻断 dedupe

- 删除 `code-hour:${email}` 与会 429 的 `code-cooldown:${email}`。
- dedupe 窗口默认 60 秒，只在**成功建立可交付投递**时推进。
- 抑制请求返回 200，不发信，不刷新窗口，不创建新 code。
- 每个窗口至少允许一次真实发送，攻击者不能靠每 59 秒请求永久滑动窗口。

### 4.3 并发与投递一致性

- 推荐 PostgreSQL advisory lock 或稳定锁行，以 normalizedEmail 串行化。
- 若 advisory lock 使用 `hashtext`/哈希整数，只把它当锁槽；取得锁后必须重新按 normalizedEmail 查询 dedupe/code 状态。
- 同一 email 并发请求只能一个越过 dedupe；另一个取得锁后重新检查并 200 抑制。
- code 与 durable task/outbox 应在同一事务创建，保证“最新有效码”具有对应可交付邮件。
- 若坚持同步 SMTP：发送失败必须删除/作废新 code，且不得推进 dedupe；重试必须可以真正发送。

## 5. admin-login

将 `getClientIp(req) ?? "unknown"` 改为共享 identity policy：

```text
CL 预拒 → admin IP/unresolved 门禁 → readJson → adminLogin
```

unresolved 使用 `admin-login-unresolved` 专用高阈桶并触发节流告警，不波及 resolved-IP 用户；unresolved 客户端之间仍共享，这是明确记录的残余风险。

## 6. env 与多实例边界

```text
ADMIN_LOGIN_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
VERIFY_CODE_IP_RATE_MAX / VERIFY_CODE_EMAIL_IP_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
REQUEST_CODE_IP_RATE_MAX / REQUEST_CODE_EMAIL_IP_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
REQUEST_CODE_SEND_DEDUPE_SECONDS
LOGIN_CODE_LENGTH / LOGIN_CODE_ALPHABET
```

所有 env 有合理上下限，越界启动失败，`.env.example` 同步。

v1.0 不实现共享限流存储；readiness/启动日志和部署文档必须说明多实例会各自计数、可被绕过。策略模块集中 key/阈，作为未来 Redis/PG 接缝。

## 7. 必测行为

- 跨多个 IP 把失败计数打满后，正确码仍成功。
- 继续错误尝试才返回 `codeAttemptsExceeded`。
- 9 位 uppercase base32 生成、schema、UI 输入、提交、HMAC 验证全部同源；lowercase/首尾空白按规范化成功，非法字符 400。
- `Fan@Example.com`、` fan@example.com `、`fan@example.com` 落同一 HMAC emailDigest、同一限流桶、同一 dedupe 与同一 login code/user。
- 两个不同 normalizedEmail 不得因 digest 冲突共享限流或 dedupe 状态；测试 helper 应允许注入/模拟碰撞，确认真实 email 状态不会被 `hashtext` 等锁键碰撞混淆。
- raw email 不出现在 limiter key、日志与 metrics。
- Turnstile 失败不写 code、不排队邮件、不扣 email+IP 发送预算。
- 连续 5 次 dedupe 抑制不耗尽 `5/hr`；真正第 6 次发送尝试才 429。
- 同 email 并发真实 PG 测试：只新增 1 个 code，只排队/发送 1 封邮件，另一个请求 200 抑制。
- outbox 入队失败事务回滚；同步 SMTP 失败不留未送达最新码、不推进 dedupe。
- unresolved verify/request 每个请求 emergency 桶只 +1，达到第 N 次才 429。
- download/#60、proof 上传、正常登录、管理员登录、Turnstile 均无回退。

## 8. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm check:request-bodies
pnpm exec drizzle-kit generate
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

若新增持久 dedupe 字段或表，必须提交迁移；若只复用 durable task/outbox + advisory lock，说明为何无 schema 变更。

## 9. 验收 checklist

- [ ] 正确码优先，错误提交不能作废正确码
- [ ] 验证码空间满足预算，默认 9 位 uppercase base32
- [ ] generate/normalize/schema/UI/submit/i18n/tests 同源
- [ ] email 先规范化，再用 keyed HMAC-SHA-256 派生 identity key
- [ ] 禁止 `hashtext`/普通 hash 作为限流或 dedupe identity
- [ ] advisory lock hash 只作锁槽，锁内重新按 normalizedEmail 校验
- [ ] verify unresolved 不双计
- [ ] request-code 保留 Turnstile
- [ ] 未发送退出不扣 email+IP 发送预算
- [ ] 删除纯 email 阻断键
- [ ] dedupe 不刷新滑动窗口、不创建未发送新码
- [ ] 同 email 并发只一码一封
- [ ] code 与 durable 投递原子，或同步失败可靠补偿
- [ ] admin-login 去全局 `unknown`
- [ ] 多实例内存限流边界已告警和文档化
- [ ] 真实 PostgreSQL 测试与完整 CI 全绿

## 已锁定决策（owner 确认 2026-06-26）

- 多实例共享限流存储不纳入 v1.0。
- verify-code：IP `30/10min`，email+IP `10/10min`。
- request-code：IP `20/hr`，真实发送 email+IP `5/hr`，dedupe `60s`。
- admin-login：`10/10min`。
- email identity digest：keyed HMAC-SHA-256；`hashtext` 仅限 advisory lock 内部锁键。