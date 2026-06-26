# 交接：S4 认证限流硬化（含 #66 verify-code 定向锁死）

> 自包含实现说明。前置依赖：当前 `main` 已含 #60 client identity helpers、`@/lib/rate-limit`、S1a/#70 请求体有界读取。属 v1.0 安全硬化 S4（epic #64，含 #66）。
>
> 2026-06-26 follow-up：原始 S4 实现只在验证码比较失败后计桶，因此已返回 429 的来源仍可继续触发真实比较，且在随后提交正确码时创建 session。本版锁定“双层预算”：目标无关的来源硬预算在比较前执行；email+IP 失败预算仍在比较后执行，避免重新引入定向锁死。
>
> 实现 PR 必须基于最新 `main`，保持 Draft，直到真实 PostgreSQL 集成测试与完整 CI 全绿。

## 0. 不可违反的安全不变量

1. **真实验证码比较必须有来源级硬预算。** `VERIFY_CODE_IP_RATE_MAX` 或 unresolved emergency 桶必须在 `verifyLoginCode()` 前消费；预算耗尽时立即返回 `429 codeAttemptsExceeded`，不得查询、比较、消费 code，也不得创建 session。
2. **来源硬预算的 key 不得包含 email。** resolved 使用可信客户端 IP，unresolved 使用独立共享 emergency 桶。远端来源不能通过提交某个邮箱来耗尽该邮箱所有其他来源的登录能力。
3. **email+IP 只做失败后的目标相关记账。** 仅核心返回 `codeIncorrect` 或 `codeExpired` 后消费；不得在比较前查询或消费，也不得单独使其他 IP 的正确码失败。
4. **错误提交不得使 code 失效。** `attempt_count` 不参与授权、限流或展示；错误请求不更新 `used_at`，不删除 code。
5. **正确 code 只在来源硬预算可用时成功。** 它不消费 email+IP 失败预算；同一来源硬预算已耗尽时，即使 code 正确也必须在比较前返回 429。不同可信 IP 的合法请求不受该来源计数影响。
6. **验证码熵仍不得依赖单实例 limiter。** 默认至少 80 bit；多实例独立桶、IP 轮换、代理配置错误等残余不能让验证码空间退回低熵。
7. request-code 不得存在纯 email 的 429 门禁；删除纯 email cooldown / 小时硬上限。
8. email 必须先 `trim().toLowerCase()`，再查询、写库、限流、去重和加锁。
9. email 派生的 identity 只允许 keyed HMAC-SHA-256；禁止 raw email、普通 SHA、短弱 hash 或 `hashtext` 作为公开 identity。
10. `hashtext` 只可用于 PostgreSQL advisory lock 槽位；取得锁后必须按真实 normalizedEmail 重新查询。
11. request-code 保留 Turnstile；Turnstile/schema/dedupe/SMTP 未配置等未发送退出不得消费 email+IP 发送预算。
12. 同一 normalizedEmail 的 dedupe、code 创建和 durable task 必须并发安全。
13. 登录码 task 每次发送/重试前必须确认 claim 有效且 code 仍是该 email 最新有效 code；stale task 成功 no-op。
14. task/outbox 中的验证码明文必须加密；不得进入 JSON、日志、错误、审计或后台任务详情。
15. unresolved 按操作使用独立 emergency 桶且不得双计；共享残余必须文档化。
16. v1.0 limiter 为单进程内存实现；多实例只做告警、部署约束和未来共享 limiter 接缝。

## 1. 问题与修复边界

### 1.1 #66 定向锁死

旧实现通过数据库 `attempt_count` 作废 code。第三方可持续提交某邮箱的错误码，使邮箱所有者手中的正确码失效。

S4 已移除该语义：错误提交不改变 code；目标相关的 email+IP 预算只影响当前来源的失败响应。

### 1.2 比较后限流的缺口

仅在 `verifyLoginCode()` 失败后调用 limiter 会产生两个问题：

- 429 之后仍继续执行数据库查询、行锁和 HMAC 比较；
- 同一来源在已超出显示限额后若提交正确 code，仍会创建 session。

不得用“把 email 桶搬到比较前”修复，因为那会重新制造 #66。正确修法是增加**不含 email 的来源硬预算**。

## 2. 共享 identity 与 keyed email digest

共用 `ClientRateLimitIdentity`：

- `ip`：由可信代理配置解析出的客户端 IP；
- `unresolved`：无法得到可信 IP 时的共享 emergency identity。

```ts
const emailDigest = hmacSha256WithPurpose(
  "auth-rate-limit-email",
  normalizedEmail,
);
```

要求：

- raw email 不进入 key、日志或 metrics；
- digest 使用服务端受保护密钥并做 purpose separation；
- 默认完整 256-bit 输出；若截断至少 128 bit；
- resolved verify source key：`verify-code-ip:<trusted-ip>`；
- resolved target failure key：`verify-code-email-ip:<digest>:<trusted-ip>`；
- unresolved verify source key：`verify-code-unresolved`，不再追加第二个失败桶。

## 3. 输入规范化与顺序

两条 email auth route 使用两阶段校验：

```ts
const raw = rawSchema.parse(body);
const email = validateNormalizedEmail(normalizeEmail(raw.email));
const code = validateLoginCode(normalizeLoginCode(raw.code), env);
```

- raw email/code 在 normalize 前已有长度上限；
- normalize 后再校验最终格式、长度和字母表；
- invalid raw/normalized 输入返回 400，不消费 verify 来源预算；
- `Fan@Example.com`、` fan@example.com ` 和 `fan@example.com` 得到同一状态。

## 4. verify-code 双层预算

### 4.1 路由固定顺序

```text
Content-Length 预拒
→ 有界读取 raw email/code
→ normalize + validate
→ 解析可信 client identity
→ 消费目标无关的 source comparison budget
→ source 已耗尽：429，禁止调用 verifyLoginCode
→ resolve locale
→ verifyLoginCode 在事务内锁定并比较最新 active code
→ 正确：标记 usedAt，创建 session；不触达 email+IP failure budget
→ codeIncorrect/codeExpired：消费 resolved emailDigest+IP failure budget
→ failure budget 耗尽：429；否则返回核心 400
```

### 4.2 来源硬预算

`getVerifyCodeCompareRateLimit()`：

- resolved：`VERIFY_CODE_IP_RATE_MAX / VERIFY_CODE_RATE_WINDOW_MS`；
- unresolved：`VERIFY_CODE_UNRESOLVED_RATE_MAX / VERIFY_CODE_RATE_WINDOW_MS`。

该预算计入所有格式有效、将进入核心比较的请求，包括正确 code。它是阻止单一来源无限触发真实比较的授权门禁。

共享 NAT/同一可信 IP 内的用户会共享该预算，这是 source-only 方案的明确可用性取舍。默认值必须在安全与共享网络误伤之间平衡；不得通过加入 email 到 pre-check key 来规避该取舍。

### 4.3 目标失败预算

`getVerifyCodeWrongAttemptRateLimits()`：

- resolved：仅返回 emailDigest+IP；
- unresolved：返回空数组，因为 unresolved source emergency budget 已在比较前唯一计数。

该预算只在 `codeIncorrect`/`codeExpired` 后消费。它用于更紧的目标相关失败响应和观测，但不是比较次数上限，也不允许阻断另一 IP 的正确登录。

### 4.4 核心事务语义

`verifyLoginCode()` 在事务内：

1. 按 normalizedEmail 读取并锁定最新未使用、未过期 code；
2. 常量时间比较提交 code 的 HMAC；
3. 不匹配返回 `codeIncorrect`，无 active code/竞争返回 `codeExpired`；
4. 匹配时条件更新 `used_at=now()`，随后返回用户；
5. 不读写 `attempt_count`，不调用 route limiter。

## 5. 验证码熵

默认 **16 位 uppercase Crockford base32（80 bit）**。

- `LOGIN_CODE_LENGTH` 下限 16；
- 若以后增加字母表，最小熵仍不得低于 80 bit；
- generator、HMAC、normalize、schema、UI、邮件、i18n 与测试必须同源；
- 80 bit 是对多实例独立 limiter、IP 轮换和代理异常的防御纵深，不是取消来源硬预算的理由。

## 6. request-code

固定顺序：

```text
Content-Length 预拒
→ client IP / unresolved 主门禁
→ 有界读取 raw email/turnstileToken
→ normalize + validate
→ Turnstile
→ 事务外 SMTP 配置预检
→ 按 normalizedEmail 串行化
→ 检查 persistent delivery fence + dedupe
→ 未发送/被抑制路径不扣 email+IP 发送预算
→ resolved 时消费真实发送 emailDigest+IP 预算
→ 同一事务创建 code + encrypted durable task
→ commit 后统一返回 accepted
```

### 6.1 persistent delivery fence

- active code 对应 task 为 pending/processing/failed：统一 200 抑制，不创建更新 code；
- active code 缺 task：告警并保守抑制到过期；
- task 终态后才按 dedupe 窗口允许新 code；
- 同 email 并发只允许一个 code 和一个 task。

### 6.2 durable task

每次执行/重试：

1. 校验 `taskId/kind/status/lockedBy/leaseUntil`；
2. 取得 per-email advisory lock；
3. 再次校验 claim；
4. 确认 code 未使用、未过期、仍为该 email 最新 active code；
5. 仅在 fence 通过时解密；
6. 提交事务并释放锁；
7. 在事务外调用 SMTP；
8. dispatcher 继续用 lock token fencing 标记 success/fail/dead。

SMTP/provider 原始异常可能包含收件人、envelope 或正文，必须在 mail 边界转换为无敏感信息的分类错误。`tasks.last_error`、日志和管理页不得保存原始异常对象。

轮换 `SESSION_SECRET` 会使在途 auth task 解密失败并进入 `PermanentTaskError`；用户重新请求即可。worker 在 SMTP 成功后、标记成功前崩溃，允许同一码 at-least-once 重复投递。

## 7. admin-login

```text
Content-Length 预拒
→ admin resolved-IP / unresolved 门禁
→ bounded readJson
→ adminLogin
```

禁止 `ip ?? "unknown"`；unresolved 使用独立高阈 emergency 桶并节流告警。

## 8. env 与多实例

```text
ADMIN_LOGIN_RATE_MAX
ADMIN_LOGIN_UNRESOLVED_RATE_MAX
ADMIN_LOGIN_RATE_WINDOW_MS
VERIFY_CODE_IP_RATE_MAX
VERIFY_CODE_EMAIL_IP_RATE_MAX
VERIFY_CODE_UNRESOLVED_RATE_MAX
VERIFY_CODE_RATE_WINDOW_MS
REQUEST_CODE_IP_RATE_MAX
REQUEST_CODE_EMAIL_IP_RATE_MAX
REQUEST_CODE_UNRESOLVED_RATE_MAX
REQUEST_CODE_RATE_WINDOW_MS
REQUEST_CODE_SEND_DEDUPE_SECONDS
LOGIN_CODE_LENGTH
LOGIN_CODE_ALPHABET
```

语义：

- `VERIFY_CODE_IP_RATE_MAX`：resolved 来源在窗口内允许的真实比较次数；比较前硬门禁；
- `VERIFY_CODE_UNRESOLVED_RATE_MAX`：unresolved 共享真实比较次数；比较前硬门禁；
- `VERIFY_CODE_EMAIL_IP_RATE_MAX`：resolved email+IP 的失败后软预算；
- 默认：source IP `30/10min`、email+IP failure `10/10min`、unresolved source `300/10min`；
- 单进程计数，多实例可按实例放大；启动/readiness/部署文档必须提示。

## 9. 必测行为

- source budget 可用时正确 code 成功，且只消费 source 桶；
- source budget 耗尽时，正确 code 在 `verifyLoginCode()` 前返回 429，code 保持未使用，不创建 session；
- 同一邮箱在来源 A 耗尽后，来源 B 仍可用正确 code 登录；
- incorrect/expired：source 在比较前计一次，resolved email+IP 在比较后计一次；
- unresolved 每请求只计一次 source emergency 桶；
- invalid raw/normalized 输入不计 verify budget；
- 并发边界不允许超过进程内 source budget 后继续进入核心；
- `attempt_count` 不读写，错误请求不使 code 失效；
- 80-bit code 全链路同源；
- raw email 不出现在 key/log/metrics；
- request-code Turnstile、dedupe、persistent task fence、加密 payload 和 SMTP 事务边界无回退；
- 真实 PostgreSQL 覆盖：来源预算耗尽后正确 code 不能建 session，另一可信 IP 仍能成功；
- download/#60、proof 上传、admin login 与正常 session 行为无回退。

## 10. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm check:request-bodies
pnpm exec drizzle-kit generate
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

本 follow-up 不需要 schema 迁移。

## 11. 验收 checklist

- [ ] source comparison budget 在 `verifyLoginCode()` 前执行，key 不含 email
- [ ] source 耗尽时禁止核心比较、code 消费和 session 创建
- [ ] email+IP 仅在 incorrect/expired 后计数
- [ ] 一来源耗尽不阻断另一可信 IP 的正确登录
- [ ] unresolved 只计一次共享 source emergency 桶
- [ ] invalid 输入不扣 verify budget
- [ ] `attempt_count` 不再参与逻辑，错误不作废 code
- [ ] code 至少 80 bit，且全链路同源
- [ ] request-code Turnstile、并发、dedupe 和 durable task 不回退
- [ ] SMTP 在事务/锁外，敏感异常不泄露
- [ ] 多实例边界已告警和文档化
- [ ] 真实 PostgreSQL测试与完整 CI 全绿

## 已锁定决策（owner follow-up 2026-06-26）

- verify-code 使用两层预算：source-only pre-compare hard gate + resolved emailDigest+IP post-failure accounting。
- source IP 默认 `30/10min`；unresolved source 默认 `300/10min`；email+IP failure 默认 `10/10min`。
- 正确 code 不消费 email+IP failure 桶，但必须通过 source hard gate。
- 不把 email 加入 pre-compare key；共享 NAT 风险作为明确取舍。
- login code 保持至少 80 bit，不能因新增硬预算降低熵。
- 多实例共享 limiter 不纳入 v1.0。
- request-code、encrypted durable task、persistent delivery fence、SMTP 边界和 SESSION_SECRET 轮换语义保持原 S4/S5 约束。
