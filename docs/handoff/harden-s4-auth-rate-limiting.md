# 交接：S4 认证限流硬化（含 #66 verify-code 定向锁死）

> 自包含实现说明。前置依赖：当前 `main` 已含 #60 client identity helpers、`@/lib/rate-limit`、S1a/#70 请求体有界读取。属 v1.0 安全硬化 S4（epic #64，含 #66）。无需 ADR。
>
> 实现 PR 必须基于最新 `main`，保持 Draft，直到真实 PostgreSQL 集成测试与完整 CI 全绿。

## 0. 不可违反的安全不变量

1. **正确验证码必须始终能越过所有错误尝试限制并完成登录。**任何 IP、email+IP 或 unresolved 桶都不得在比较正确码前返回 429；遗留 `attempt_count` 列不再参与授权、限流或展示。
2. **错误提交不得使正确码失效。**失败计数只影响错误响应，不作废 code，不阻断正确码。
3. 因 verify 必须先比较正确性，错误请求即使最终返回 429 也已经消耗一次比较；因此验证码熵不得再依赖 limiter 阈值推导，必须足以承受服务在 TTL 内可处理的全部比较请求。
4. request-code 不得存在纯 email 的阻断门禁；删除会返回 429 的纯 email cooldown / 小时硬上限。
5. 所有 email 状态统一先 `trim().toLowerCase()`，再查询、写库、限流、去重和锁。
6. email 派生的限流/去重 identity key 只允许 keyed HMAC-SHA-256；禁止 raw email、`hashtext`、普通 SHA 或短弱 hash。
7. `hashtext` 只可作为 PostgreSQL advisory lock 的内部锁槽；锁内必须重新按真实 normalizedEmail 查询。
8. request-code 保留 Turnstile；Turnstile/schema/dedupe 等未发送退出不得消费 email+IP 发送预算。
9. 同一 normalizedEmail 的 dedupe、code 创建与投递必须并发安全。
10. durable 邮件任务在每次发送/重试前必须确认其 code 仍是该 email 的最新有效 code；stale task 必须成功 no-op，绝不能发送已经无法验证的旧码。
11. durable task/outbox 中的验证码明文必须使用服务端受保护密钥加密存储，不得出现在任务 JSON、日志、错误、审计或后台任务详情中。
12. unresolved 客户端按操作使用独立 emergency 桶，不得双重计数；其共享残余风险必须如实记录。
13. 单进程内存限流不具备多实例一致性；v1.0 只做告警、文档和未来接缝。

## 1. 当前漏洞

- `verifyLoginCode` 此前依赖 `attempt_count`，错误请求可把正确码锁死，形成 #66；S4 后该列仅为兼容旧 schema 保留，不再读写。
- verify route 当前无路由纵深限制，但简单增加“比较前 429”会重新制造正确码锁死。
- request-code 当前存在纯 email `code-hour`、`code-cooldown`，并先插入 code 再同步发信。
- request-code 当前保留 Turnstile，本切片不得回退。
- admin-login 当前使用 `ip ?? "unknown"`，unresolved 用户共享全局桶。
- auth schema、UI 与文案当前绑定 6 位数字码。

## 2. 共享 identity 与 keyed email digest

将 #60 的 `ClientRateLimitIdentity`、`resolveClientRateLimitIdentity`、`warnUnresolvedClientRateLimitIdentity` 上移到中性模块，download 与 auth 共用。

```ts
const normalizedEmail = normalizeEmail(rawEmail);
const emailDigest = hmacSha256WithPurpose(
  "auth-rate-limit-email",
  normalizedEmail,
);
```

要求：

- secret 来自现有受保护服务端密钥体系，并做 purpose/domain separation。
- 默认使用完整 256-bit hex/base64url；若截断，至少 128 bit，并在 PR 写明碰撞预算。
- raw email 不得进入 limiter key、dedupe key、日志或 metrics。
- `hashtext(normalizedEmail)` 只允许生成 advisory-lock 槽位，不能作为 identity；取得锁后重新按 normalizedEmail 查询状态。

策略：

- admin-login：resolved IP 桶 / `admin-login-unresolved`。
- verify-code：错误比较完成后才记账的 IP 桶、resolved emailDigest+IP 桶；unresolved 只记一次 `verify-unresolved`。
- request-code：解析前 IP 主桶；resolved emailDigest+IP 桶只表示真实发送/排队尝试预算；unresolved 只使用一次 `request-code-unresolved`。

## 3. 输入规范化与校验顺序

禁止把以下 `z.preprocess(... z.string().email().max(...))` 作为批准方案，因为 `.max()` 会在 trim 后执行，可能接受超长 raw 空白输入。

两条 auth route 必须使用**两阶段校验**：

```ts
const raw = rawSchema.parse(body); // email/code 都有 raw 最大长度
const email = normalizeEmail(raw.email);
const code = normalizeLoginCode(raw.code);
normalizedSchema.parse({ email, code });
```

要求：

- raw email 与 raw code 在 normalize 前已有明确最大长度。
- normalized email/code 再校验最终格式、字母表与长度。
- `Fan@Example.com`、` fan@example.com `、`fan@example.com` 得到同一 normalizedEmail。
- 超长 raw email 即使 trim 后很短也必须 400。

## 4. verify-code：正确码优先，熵不依赖限流

### 4.1 核心语义

在事务内读取并锁定该 email 最新未使用、未过期 code：

1. 先查找并比较 `hmac(normalizeLoginCode(submitted))` 与最新 active code 的 `code_hash`。
2. 正确：立即标记 `usedAt=now()` 并成功，完全不触达 wrong/invalid-attempt limiter。
3. `codeIncorrect` 与 `codeExpired`（不存在 active code、已过期或已用竞争）都先由核心返回失败，再由 route 做 abuse accounting。
4. route 的 wrong/invalid-attempt limiter 是唯一失败计数机制；遗留 `attempt_count` 列保留但 S4 不再读写。`codeAttemptsExceeded` 仅由 route limiter 产生。

### 4.2 路由顺序

```text
CL 预拒
→ 有界解析 raw email/code
→ normalize + validate
→ verifyLoginCode 比较正确性
→ 正确：直接登录，不查询/消费 wrong-attempt 桶
→ `codeIncorrect` / `codeExpired`：记账 IP 或 unresolved；resolved 再记账 emailDigest+IP
→ 桶耗尽返回 `429 codeAttemptsExceeded`，否则重新抛出核心的 400 错误
```

关键事实：**限流只能控制响应和资源滥用，不能再被当作验证码比较次数上限。**错误提交在返回 429 前已经完成比较，因此安全分析必须假定攻击者可持续请求直到 TTL 结束。

### 4.3 验证码熵

默认改为 **16 位 uppercase Crockford base32（80 bit）**，不再使用 9 位/45 bit 方案。

理由：

- 9 位 base32 只有 45 bit，只有在比较次数被严格限制时才满足先前 `B=10^7` 预算。
- 正确码优先要求先比较再限流，故实际比较次数不由 wrong-attempt limiter 封顶。
- 80 bit 即使面对远高于实际服务能力的 `2^40` 次比较，成功概率仍约 `2^-40`；不依赖单实例 limiter、多实例路由或攻击 IP 数量成立。

要求：

- `LOGIN_CODE_LENGTH` 下限不得低于 16（Crockford base32）；若支持其他字母表，最小熵不得低于 80 bit。
- 默认 uppercase Crockford base32，排除易混淆字符。
- `normalizeLoginCode` 至少 `trim().toUpperCase()`；后端不能依赖客户端自动大写。
- generator、HMAC、verify schema、UI `maxLength/inputMode/placeholder/disabled`、i18n 与测试全部同源。

## 5. request-code：非阻断、并发安全、投递一致

### 5.1 顺序

```text
CL 预拒
→ client IP / unresolved emergency 主门禁
→ 有界解析 raw email/turnstileToken
→ normalizeEmail 后校验
→ Turnstile
→ 事务外通过真实 `getSmtpConfig()` 路径预检 SMTP；未配置则 500
→ 按 normalizedEmail 串行化并重新检查 persistent delivery fence + dedupe
→ active code 的任务为 pending/processing/failed：统一 200 抑制；不写 code、不刷新窗口、不扣发送预算
→ active code 缺少对应 task：记录不含 raw email 的告警，并保守抑制到 code 过期
→ 任务为 succeeded/dead 后再按 60 秒 dedupe；命中仍统一 200 抑制
→ 未命中：resolved 时扣 emailDigest+IP 真实发送预算
→ 同一短事务创建 code + encrypted durable email task/outbox
→ commit 后返回严格 `{ "accepted": true }`
```

### 5.2 去重与并发

- 删除纯 email `code-hour` 与 429 cooldown。
- dedupe 默认 60 秒，仅在成功建立可交付任务时推进。
- persistent delivery fence 优先于 dedupe：active code 对应任务仍为 pending/processing/failed 时，后续重发统一 200 抑制，最长到 10 分钟 code TTL。
- active code 缺少对应 task 属数据不一致与不安全状态；不得静默当作 succeeded，必须告警并保守抑制到该 code 过期。
- 抑制返回 200，不创建新 code，不刷新窗口，不扣 email+IP 真实发送预算。
- advisory lock/稳定锁行按 normalizedEmail 串行化；锁槽碰撞时锁内仍按真实 email 隔离。
- 同 email 并发只允许一个创建 code/任务；另一个取得锁后重查并抑制。
- 取舍：投递在途或重试期间，同 email 的重发可能被静默抑制到 TTL 上限；这是为了严格保证应用不会在旧任务仍可能发送时产生更新 code。

### 5.3 durable task 与 stale code

任务必须包含：

- `codeId`
- normalizedEmail 的安全引用（优先 user/code 外键或 keyed digest，不放 raw email 到公开字段）
- 使用配置加密密钥或专用 task secret 加密后的邮件敏感载荷
- task schema/version

每次首次执行和每次重试都必须采用「短事务 fence → 提交释放 → 事务外 SMTP」：

1. handler 接收 dispatcher 已 claim 的 `taskId + lockedBy`；缺少 lock token 不得发信。
2. Tx1 先确认任务仍满足 `id/kind/status=processing/lockedBy/leaseUntil`；claim 已失效则成功 no-op，绝不解密或发送。
3. 在 Tx1 内取得 per-email advisory lock，再次确认 claim 仍有效。
4. 确认 code 未使用、未过期，且仍是该 normalizedEmail 的**最新有效 code**；任一条件不满足则成功 no-op。
5. 仅在 fence 全部通过时解密载荷，返回内存中的收件人与 code；随后提交 Tx1，释放数据库连接与 advisory lock。
6. `sendLoginCodeEmail()` 只能在事务和 advisory lock 外调用；成功返回后仍由既有 dispatcher 以 lock token 条件更新 task 状态，heartbeat、success/fail/dead fencing 不得绕过。

这样延迟任务或旧任务重试不会在新 code 创建后发送无法验证的旧码，也不会让慢 SMTP 占用事务连接或 per-email 锁。

安全要求：

- task 表 JSON 中不得存储明文验证码或完整渲染邮件正文。
- 日志、dead-task 管理页、错误序列化不得显示解密后的验证码。
- 解密失败视为不可重试配置/数据错误，抛 `PermanentTaskError`，但不得泄露载荷。
- 应用保证：旧 code 的 task 仍可能执行/重试时不会创建更新 code；stale claim 在 SMTP 前成功 no-op；SMTP 调用开始时该 code 仍为最新有效 code。
- worker 在 SMTP 成功后、标记 succeeded 前崩溃，最多造成**同一码 at-least-once 重复投递**；这是可接受残余。
- 不声称能控制外部 SMTP/邮箱提供商的最终到达或展示顺序；保证的是应用调用顺序与调用开始时的 code 有效性。
- `encryptAuthTaskSecret` 由 `SESSION_SECRET` 派生。轮换 `SESSION_SECRET` 会使在途登录码任务解密失败并进入 `PermanentTaskError`，用户需重新请求；登录码 TTL 仅 10 分钟，影响窗口有限。后续创建 S5 email reliability handoff 时必须继承这一已知语义。

若不实现 encrypted durable task，才允许同步 SMTP fallback；发送失败必须删除/作废新 code 且不推进 dedupe，并记录 crash-window 残余。默认实现必须使用 encrypted durable task。

## 6. admin-login

```text
CL 预拒 → admin resolved-IP / unresolved 门禁 → readJson → adminLogin
```

移除 `?? "unknown"`。unresolved 使用 `admin-login-unresolved` 专用高阈桶并节流告警；不波及 resolved-IP 用户。unresolved 客户端之间仍共享计数。

## 7. env 与多实例

```text
ADMIN_LOGIN_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
VERIFY_CODE_IP_RATE_MAX / VERIFY_CODE_EMAIL_IP_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
REQUEST_CODE_IP_RATE_MAX / REQUEST_CODE_EMAIL_IP_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
REQUEST_CODE_SEND_DEDUPE_SECONDS
LOGIN_CODE_LENGTH / LOGIN_CODE_ALPHABET
```

- 默认 `LOGIN_CODE_LENGTH=16`，Crockford base32；配置不得降到 80 bit 以下。
- 所有 env 有上下限，越界启动失败，`.env.example` 同步。
- v1.0 不实现共享 limiter；readiness/启动日志与部署文档必须说明多实例独立计数可被绕过。

## 8. 必测行为

- 同 IP、共享 NAT、跨多 IP 把 wrong/invalid-attempt 桶耗尽后，正确码仍成功；`attempt_count` 不再读写。
- 已耗尽 wrong-attempt 桶后继续错误请求仍会比较，但 16 位/80-bit code 空间使在线枚举不可行；测试/文档不得再用 limiter 阈值作为最大比较次数。
- raw email/code 先有界，再 normalize/validate；超长 raw 空白输入被拒。
- 16 位 uppercase base32 在生成、normalize、schema、UI、提交、邮件和 HMAC 中同源。
- raw email 不出现在 key/log/metrics；advisory-lock hash 碰撞时真实 email 状态隔离。
- Turnstile/schema/dedupe 未发送退出不扣 email+IP 发送预算。
- 同 email 并发真实 PG 测试：只新增一码、一个 encrypted task，另一个 200 抑制。
- 创建 code+task 的事务失败则两者均回滚。
- task 延迟期间创建新 code 后，旧 task 首次执行 no-op。
- task pending/processing/failed 时新请求统一 200 抑制，不产生更新 code；终态后才允许按 dedupe 规则创建新 code。
- 慢 SMTP 期间另一连接可立即取得同 email advisory lock，且同 email request-code 被 persistent fence 抑制。
- 最新有效 task 正常发送；同一码重复投递不改变可验证性。
- task DB 行、任务 API、日志和 dead-task 输出中不存在明文验证码。
- unresolved request-code 每请求只 +1；verify 仅在核心返回 `codeIncorrect` 或 `codeExpired` 后做 abuse accounting。
- download/#60、proof 上传、正常登录、管理员登录、Turnstile 无回退。

## 9. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm check:request-bodies
pnpm exec drizzle-kit generate
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

若 task 载荷加密或 code 状态需要 schema 变更，必须提交迁移；不得为了声称“无迁移”退回明文 task payload。

## 10. 验收 checklist

- [ ] 正确码先比较并绕过所有 verify wrong/invalid-attempt 限制
- [ ] `codeIncorrect` 与 `codeExpired` 仅在核心失败后计桶；错误提交不能作废或阻断正确码
- [ ] `attempt_count` 列保留但 S4 不再读写
- [ ] 安全分析不把 limiter 当作比较次数上限
- [ ] 验证码默认至少 80 bit（16 位 Crockford base32）
- [ ] generate/normalize/schema/UI/submit/i18n/tests 同源
- [ ] raw email/code 有界后再 normalize/validate
- [ ] email 使用 keyed HMAC-SHA-256 identity；禁止 hashtext/普通 hash
- [ ] request-code 保留 Turnstile，未发送退出不扣预算
- [ ] 删除纯 email 阻断键；dedupe 不滑动、不创建未发送新码
- [ ] 同 email 并发只一码一个 encrypted task
- [ ] persistent delivery fence 在 pending/processing/failed 期间抑制更新 code
- [ ] durable task 每次执行/重试都以 task claim fence 检查 codeId 仍为最新有效 code
- [ ] SMTP 在事务/advisory lock 外；stale task 成功 no-op，不发送旧码
- [ ] task payload/log/admin UI 不泄露明文验证码
- [ ] admin-login 去全局 unknown
- [ ] unresolved 不双计并如实记录共享残余
- [ ] 多实例边界已告警和文档化
- [ ] 真实 PostgreSQL 测试与完整 CI 全绿

## 已锁定决策（owner 确认 2026-06-26）

- 多实例共享限流存储不纳入 v1.0。
- verify-code wrong-attempt：IP `30/10min`，email+IP `10/10min`；正确码不受其影响。
- request-code：IP `20/hr`，真实发送 email+IP `5/hr`，dedupe `60s`。
- admin-login：`10/10min`。
- login code：默认 16 位 uppercase Crockford base32（80 bit），不得配置到低于 80 bit。
- email identity：keyed HMAC-SHA-256；`hashtext` 仅限 advisory lock 槽位。
- 登录码邮件默认走 encrypted durable task；pending/processing/failed 构成 persistent delivery fence，发送前还必须通过 task claim + 最新 active code fence。
- SMTP 不得发生在事务或 advisory lock 内；同一码保留 at-least-once 重投残余，不保证外部邮箱最终展示顺序。
- 轮换 `SESSION_SECRET` 会使在途 auth task 无法解密并永久失败，用户重新请求即可；后续 S5 email reliability handoff 必须继承此语义。