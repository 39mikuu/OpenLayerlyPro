# 交接：S4 认证限流硬化（含 #66 verify-code 定向锁死）

> 自包含实现说明。前置依赖：当前 `main` 已含 #60 client identity helpers、`@/lib/rate-limit`、S1a/#70 请求体有界读取。属 v1.0 安全硬化 S4（epic #64，含 #66）。
>
> 2026-06-26 follow-up：原始 S4 实现只在验证码比较失败后计桶，因此已返回 429 的来源仍可继续触发真实比较，且随后提交正确码仍会创建 session。本版锁定双层门禁：目标无关的来源硬预算在比较前消费；resolved email+IP 预算只在失败后消费，但一旦耗尽，后续同一 email+IP 会在比较前被**只读预检**拒绝。这样既阻止继续在线猜测，也不把其他可信 IP 锁死。
>
> 实现 PR 必须基于最新 `main`，保持 Draft，直到真实 PostgreSQL 集成测试与完整 CI 全绿。

## 0. 不可违反的安全不变量

1. **真实验证码比较必须有来源级硬预算。** `VERIFY_CODE_IP_RATE_MAX` 或 unresolved emergency 桶必须在 `verifyLoginCode()` 前消费；预算耗尽时立即返回 `429 codeAttemptsExceeded`，不得查询、比较、消费 code，也不得创建 session。
2. **来源硬预算的 key 不得包含 email。** resolved 使用可信客户端 IP，unresolved 使用独立共享 emergency 桶。远端来源不能通过提交某个邮箱来耗尽该邮箱所有其他来源的登录能力。
3. **resolved email+IP 预算只能由失败结果推进。** 仅核心返回 `codeIncorrect` 或 `codeExpired` 后新增时间戳；比较前只能用不新增时间戳的 `isRateLimited()` 检查它是否已经耗尽。禁止在比较前消费该桶。
4. **已耗尽的 resolved email+IP 必须阻止后续真实比较。** 同一 email+IP 在窗口内达到失败上限后，后续请求即使提交正确 code 也必须在核心查询前返回 429；换一个尚未耗尽的可信 IP 仍可登录。
5. **错误提交不得使 code 失效。** `attempt_count` 不参与授权、限流或展示；错误请求不更新 `used_at`，不删除 code。
6. **正确 code 只在两层前置门禁均允许时成功。** 它不新增 email+IP 失败计数，但必须通过该桶的只读耗尽检查和来源硬预算。
7. **验证码熵仍不得依赖单实例 limiter。** 默认至少 80 bit；多实例独立桶、IP 轮换、代理配置错误等残余不能让验证码空间退回低熵。
8. request-code 不得存在纯 email 的 429 门禁；删除纯 email cooldown / 小时硬上限。
9. email 必须先 `trim().toLowerCase()`，再查询、写库、限流、去重和加锁。
10. email 派生的 identity 只允许 keyed HMAC-SHA-256；禁止 raw email、普通 SHA、短弱 hash 或 `hashtext` 作为公开 identity。
11. `hashtext` 只可用于 PostgreSQL advisory lock 槽位；取得锁后必须按真实 normalizedEmail 重新查询。
12. request-code 保留 Turnstile；Turnstile/schema/dedupe/SMTP 未配置等未发送退出不得消费 email+IP 发送预算。
13. 同一 normalizedEmail 的 dedupe、code 创建和 durable task 必须并发安全。
14. 登录码 task 每次发送/重试前必须确认 claim 有效且 code 仍是该 email 最新有效 code；stale task 成功 no-op。
15. task/outbox 中的验证码明文必须加密；不得进入 JSON、日志、错误、审计或后台任务详情。
16. unresolved 按操作使用独立 emergency 桶且不得双计；共享残余必须文档化。
17. v1.0 limiter 为单进程内存实现；多实例只做告警、部署约束和未来共享 limiter 接缝。

## 1. 问题与修复边界

### 1.1 #66 定向锁死

旧实现通过数据库 `attempt_count` 作废 code。第三方可持续提交某邮箱的错误码，使邮箱所有者手中的正确码失效。

S4 已移除该语义：错误提交不改变 code；目标相关预算必须同时绑定 email 与可信 IP，因此来源 A 不能锁死来源 B。

### 1.2 比较后限流的缺口

仅在 `verifyLoginCode()` 失败后调用 limiter 会产生两个问题：

- 429 之后仍继续执行数据库查询、行锁和 HMAC 比较；
- 同一 email+IP 已达到失败上限后若提交正确 code，仍会创建 session。

不得用纯 email 的 pre-check 修复，因为那会重新制造 #66。批准方案由两部分组成：

1. 不含 email 的来源硬预算，限制每个客户端身份触发的全部真实比较；
2. emailDigest+IP 失败桶只在失败后推进，但在后续请求中只读检查其耗尽状态。

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
- unresolved verify source key：`verify-code-unresolved`，不追加第二个失败桶。

## 3. 输入规范化与顺序

两条 email auth route 使用两阶段校验：

```ts
const raw = rawSchema.parse(body);
const email = validateNormalizedEmail(normalizeEmail(raw.email));
const code = validateLoginCode(normalizeLoginCode(raw.code), env);
```

- raw email/code 在 normalize 前已有长度上限；
- normalize 后再校验最终格式、长度和字母表；
- invalid raw/normalized 输入返回 400，不消费或查询 verify 桶；
- `Fan@Example.com`、` fan@example.com ` 和 `fan@example.com` 得到同一状态。

## 4. verify-code 双层门禁

### 4.1 路由固定顺序

```text
Content-Length 预拒
→ 有界读取 raw email/code
→ normalize + validate
→ 解析可信 client identity
→ resolved：只读检查 emailDigest+IP failure bucket 是否已经耗尽
→ target 已耗尽：429，不消费任何新计数，不调用 verifyLoginCode
→ 消费目标无关的 source comparison budget
→ source 已耗尽：429，不调用 verifyLoginCode
→ resolve locale
→ verifyLoginCode 在事务内锁定并比较最新 active code
→ 正确：标记 usedAt，创建 session；不新增 email+IP failure 计数
→ codeIncorrect/codeExpired：消费 resolved emailDigest+IP failure budget
→ 本次消费发现已超限：429；否则返回核心 400
```

前置顺序必须先做 target 的只读检查，再消费 source；已经被 target 门禁拒绝的请求不能白白扣 source 容量。

### 4.2 来源硬预算

`getVerifyCodeCompareRateLimit()`：

- resolved：`VERIFY_CODE_IP_RATE_MAX / VERIFY_CODE_RATE_WINDOW_MS`；
- unresolved：`VERIFY_CODE_UNRESOLVED_RATE_MAX / VERIFY_CODE_RATE_WINDOW_MS`。

该预算计入所有格式有效、将进入核心比较的请求，包括正确 code。它是阻止单一来源无限触发真实比较的硬门禁。

共享 NAT/同一可信 IP 内的用户会共享该预算，这是 source-only key 的明确可用性取舍。默认值必须在安全与共享网络误伤之间平衡；不得通过加入 email 到 source key 来规避该取舍。

### 4.3 resolved email+IP 失败预算

`getVerifyCodeWrongAttemptRateLimits()`：

- resolved：仅返回 emailDigest+IP；
- unresolved：返回空数组，因为 unresolved source emergency budget 已在比较前唯一计数。

该桶有两种不同操作，必须严格区分：

1. **post-failure consume**：只有 `codeIncorrect`/`codeExpired` 后调用 `rateLimit()` 新增时间戳；
2. **pre-compare peek**：后续请求调用 `isRateLimited()` 清理过期时间戳并只读判断是否已满，不得新增时间戳。

因此第三方从来源 A 只能限制同一 email+来源 A；来源 B 的正确登录不受影响。该桶已经返回过 429 后，同一对在窗口恢复前也不能靠随后猜中正确 code 绕过限制。

### 4.4 limiter 原语

`isRateLimited(key, limit, windowMs)` 必须：

- 与 `rateLimit()` 使用同一 store 和滑动窗口清理规则；
- 不创建空 bucket，不新增 timestamp；
- 窗口过期后删除空 bucket 并返回 false；
- 有独立单测证明多次 peek 不消耗容量。

### 4.5 核心事务语义

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
- 80 bit 是对多实例独立 limiter、IP 轮换和代理异常的防御纵深，不是取消双层门禁的理由。

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

- `VERIFY_CODE_IP_RATE_MAX`：resolved 来源在窗口内允许的真实比较次数；比较前消费；
- `VERIFY_CODE_UNRESOLVED_RATE_MAX`：unresolved 共享真实比较次数；比较前消费；
- `VERIFY_CODE_EMAIL_IP_RATE_MAX`：resolved email+IP 失败后消费上限；达到上限后在后续比较前只读阻断；
- 默认：source IP `30/10min`、email+IP failure `10/10min`、unresolved source `300/10min`；
- 单进程计数，多实例可按实例放大；启动/readiness/部署文档必须提示。

## 9. 必测行为

- 两个门禁都可用时，正确 code 成功；只消费 source，不新增 target failure timestamp；
- source budget 耗尽时，正确 code 在 `verifyLoginCode()` 前返回 429，code 保持未使用，不创建 session；
- source 仍有余量、但同 email+IP target 已耗尽时，正确 code 也在核心前返回 429；
- 同一邮箱在来源 A 的 target/source 耗尽后，来源 B 仍可用正确 code 登录；
- incorrect/expired：target peek 不消费，source 在比较前计一次，resolved target 在比较后计一次；
- target peek 被拒绝的请求不消费 source；
- unresolved 每请求只计一次 source emergency 桶；
- invalid raw/normalized 输入不查询或消费 verify budget；
- `isRateLimited()` 多次调用不消耗容量，窗口过期后恢复并清理 bucket；
- `attempt_count` 不读写，错误请求不使 code 失效；
- 80-bit code 全链路同源；
- raw email 不出现在 key/log/metrics；
- request-code Turnstile、dedupe、persistent task fence、加密 payload 和 SMTP 事务边界无回退；
- 真实 PostgreSQL 覆盖：source max 高于 target max，先耗尽 target 后提交正确 code仍被拒绝，另一可信 IP 成功；
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

- [ ] source comparison budget 在 `verifyLoginCode()` 前消费，key 不含 email
- [ ] resolved email+IP 只在失败后推进，但已耗尽状态在后续比较前只读检查
- [ ] 任一前置门禁拒绝时禁止核心比较、code 消费和 session 创建
- [ ] target peek 拒绝不消费 source budget
- [ ] 一来源耗尽不阻断另一可信 IP 的正确登录
- [ ] unresolved 只计一次共享 source emergency 桶
- [ ] invalid 输入不查询或扣 verify budget
- [ ] `isRateLimited()` 不消费容量并与滑动窗口清理一致
- [ ] `attempt_count` 不再参与逻辑，错误不作废 code
- [ ] code 至少 80 bit，且全链路同源
- [ ] request-code Turnstile、并发、dedupe 和 durable task 不回退
- [ ] SMTP 在事务/锁外，敏感异常不泄露
- [ ] 多实例边界已告警和文档化
- [ ] 真实 PostgreSQL 测试与完整 CI 全绿

## 已锁定决策（owner follow-up 2026-06-26）

- verify-code 使用两层门禁：source-only pre-compare consuming hard gate；resolved emailDigest+IP post-failure consuming budget + pre-compare read-only exhausted-state gate。
- source IP 默认 `30/10min`；unresolved source 默认 `300/10min`；email+IP failure 默认 `10/10min`。
- 正确 code 不新增 target failure 计数，但必须通过 target peek 和 source hard gate。
- 不使用纯 email pre-check；email+IP 只影响同一可信来源，共享 NAT 风险作为明确取舍。
- login code 保持至少 80 bit，不能因新增门禁降低熵。
- 多实例共享 limiter 不纳入 v1.0。
- request-code、encrypted durable task、persistent delivery fence、SMTP 边界和 SESSION_SECRET 轮换语义保持原 S4/S5 约束。
