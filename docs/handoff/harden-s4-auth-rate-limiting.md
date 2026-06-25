# 交接：S4 认证限流硬化（含 #66 verify-code 定向锁死）

> 自包含实现说明。前置依赖：当前 `main` 已含 #60 client identity helpers、`@/lib/rate-limit`、S1a/#70 请求体有界读取。属 v1.0 安全硬化 S4（epic #64，含 #66）。无需 ADR。
>
> 实现 PR 必须基于最新 `main`，保持 Draft，直到真实 PostgreSQL 集成测试与完整 CI 全绿。

## 0. 不可违反的安全不变量

1. **正确验证码必须始终能越过所有错误尝试限制并完成登录。**任何 IP、email+IP、`attempt_count` 或 unresolved 桶都不得在比较正确码前返回 429。
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

- `verifyLoginCode` 当前先增加 `attempt_count`，达到上限后连正确码也拒绝，形成 #66。
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

1. 先比较 `hmac(normalizeLoginCode(submitted))` 与 `code_hash`。
2. 正确：立即标记 `usedAt=now()` 并成功，完全不受 `attempt_count` 或 wrong-attempt limiter 影响。
3. 错误：增加 `attempt_count` 并返回结构化错误。
4. `attempts_exceeded` 只描述错误尝试状态，不得阻止未来正确码。

### 4.2 路由顺序

```text
CL 预拒
→ 有界解析 raw email/code
→ normalize + validate
→ verifyLoginCode 比较正确性
→ 正确：直接登录，不查询/消费 wrong-attempt 桶
→ 错误：记账 IP 或 unresolved；resolved 再记账 emailDigest+IP
→ 根据 wrong-attempt 桶与核心错误返回 400/429
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
→ 按 normalizedEmail 串行化并重新检查 dedupe
→ dedupe 命中：200；不写 code、不刷新窗口、不扣发送预算
→ 未命中：resolved 时扣 emailDigest+IP 真实发送预算
→ 同一事务创建 code + encrypted durable email task/outbox
→ commit 后 200
```

### 5.2 去重与并发

- 删除纯 email `code-hour` 与 429 cooldown。
- dedupe 默认 60 秒，仅在成功建立可交付任务时推进。
- 抑制返回 200，不创建新 code，不刷新窗口。
- advisory lock/稳定锁行按 normalizedEmail 串行化；锁槽碰撞时锁内仍按真实 email 隔离。
- 同 email 并发只允许一个创建 code/任务；另一个取得锁后重查并抑制。

### 5.3 durable task 与 stale code

任务必须包含：

- `codeId`
- normalizedEmail 的安全引用（优先 user/code 外键或 keyed digest，不放 raw email 到公开字段）
- 使用配置加密密钥或专用 task secret 加密后的邮件敏感载荷
- task schema/version

每次首次执行和每次重试都必须：

1. 读取 `codeId`。
2. 确认 code 未使用、未过期。
3. 确认它仍是该 normalizedEmail 的**最新有效 code**。
4. 任一条件不满足：任务以成功 no-op 完成，不发送邮件、不重试。
5. 条件满足才解密载荷并发信。

这样延迟任务或旧任务重试不会在新 code 创建后发送无法验证的旧码。

安全要求：

- task 表 JSON 中不得存储明文验证码或完整渲染邮件正文。
- 日志、dead-task 管理页、错误序列化不得显示解密后的验证码。
- 解密失败视为不可重试配置/数据错误，按任务框架既有策略进入 failed/dead，但不得泄露载荷。
- 同一 task 因 worker crash 可能造成同一码重复投递是可接受残余；不得造成不同旧码在新码之后投递。

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

- 同 IP、共享 NAT、跨多 IP 把 wrong-attempt 桶或 `attempt_count` 打满后，正确码仍成功。
- 已耗尽 wrong-attempt 桶后继续错误请求仍会比较，但 16 位/80-bit code 空间使在线枚举不可行；测试/文档不得再用 limiter 阈值作为最大比较次数。
- raw email/code 先有界，再 normalize/validate；超长 raw 空白输入被拒。
- 16 位 uppercase base32 在生成、normalize、schema、UI、提交、邮件和 HMAC 中同源。
- raw email 不出现在 key/log/metrics；advisory-lock hash 碰撞时真实 email 状态隔离。
- Turnstile/schema/dedupe 未发送退出不扣 email+IP 发送预算。
- 同 email 并发真实 PG 测试：只新增一码、一个 encrypted task，另一个 200 抑制。
- 创建 code+task 的事务失败则两者均回滚。
- task 延迟期间创建新 code 后，旧 task 首次执行 no-op。
- task SMTP 暂时失败后，在重试前创建新 code，旧 task retry no-op。
- 最新有效 task 正常发送；同一码重复投递不改变可验证性。
- task DB 行、任务 API、日志和 dead-task 输出中不存在明文验证码。
- unresolved request-code 每请求只 +1；verify 只在确认错误后 +1。
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

- [ ] 正确码先比较并绕过所有 verify wrong-attempt 限制
- [ ] 错误提交不能作废或阻断正确码
- [ ] 安全分析不把 limiter 当作比较次数上限
- [ ] 验证码默认至少 80 bit（16 位 Crockford base32）
- [ ] generate/normalize/schema/UI/submit/i18n/tests 同源
- [ ] raw email/code 有界后再 normalize/validate
- [ ] email 使用 keyed HMAC-SHA-256 identity；禁止 hashtext/普通 hash
- [ ] request-code 保留 Turnstile，未发送退出不扣预算
- [ ] 删除纯 email 阻断键；dedupe 不滑动、不创建未发送新码
- [ ] 同 email 并发只一码一个 encrypted task
- [ ] durable task 每次执行/重试都检查 codeId 仍为最新有效 code
- [ ] stale task 成功 no-op，不发送旧码
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
- 登录码邮件默认走 encrypted durable task；每次发送/重试前检查 codeId 仍为最新有效 code。