# 交接：6 位数字登录码与请求挑战绑定

> 状态：已实现。本文已取代 S4 中“登录码至少 80 bit、错误提交永不写 `attempt_count`”两项约束；S4 的来源硬预算、email+IP 失败桶、持久投递 fence、加密任务和 SMTP 边界继续生效。

## 1. 目标与威胁模型

产品登录码固定为 **6 位十进制数字**，便于人工读取、移动端自动填充和跨语言输入。6 位数字只有约 20 bit，不能再把验证码本身当作可承受无限在线尝试的高熵秘密。

新协议要求同时持有：

1. 邮件中的 6 位数字登录码；
2. 发起该次登录码请求的浏览器保存的 256-bit 随机 challenge。

数据库只保存二者各自的 purpose-separated HMAC。攻击者仅知道邮箱、仅拿到数据库、或仅能提交验证码，都不能绕过 challenge 比较。来源/IP 限流仍是第一层门禁；数据库内的 challenge-bound 尝试上限是跨实例、IP 轮换和代理异常下的最终在线猜测上限。

不解决的边界：能够控制发码浏览器 challenge 的攻击者仍可用 5 次错误尝试耗尽该次 code，但不能在不知道 challenge 时通过猜测使受害者已发起的 code 失效。对邮箱和浏览器同时失守的场景不提供额外保护。

## 2. 固定参数

| 参数 | 值 | 说明 |
| --- | --- | --- |
| 登录码格式 | `^[0-9]{6}$` | 不允许字母、空格或可配置字母表 |
| challenge | 32 个 CSPRNG 字节 | base64url 传输，固定 43 字符、无 padding |
| code TTL | 10 分钟 | 保持当前行为 |
| challenge 匹配后的错误上限 | 5 次 / code | 第 5 次错误后该 code 不再可用 |
| code HMAC purpose | `auth-login-code` | 保持当前 purpose，避免迁移中改变存量 hash |
| challenge HMAC purpose | `auth-login-code-challenge` | 与 code、session、限流 identity 分离 |

`LOGIN_CODE_LENGTH` / `LOGIN_CODE_ALPHABET` 不再是安全可调参数。为兼容已有 `.env`，实现版本可在一个发布周期内接受旧值但必须把最终运行策略归一为 `6` / `decimal`，并输出不含敏感信息的弃用告警；不得继续据旧值生成 16 位码。

## 3. 客户端协议

### 3.1 challenge 生命周期

- 浏览器在第一次请求某个 normalized email 的登录码前，用 Web Crypto 生成 32 字节 challenge。
- challenge 仅保存在当前浏览器的登录流程状态和 `sessionStorage`；不得进入 URL、analytics、console、错误上报或持久 cookie。
- 同一 `requestedEmail` 的重发必须复用已有 challenge。服务端可能因 active code / durable task fence 返回统一 `accepted` 但不创建新 code；客户端此时若换 challenge，会使仍在途的 code 无法验证。
- 唯一例外是 challenge 已匹配且第 5 次错误刚耗尽 code：verify route 在 `codeAttemptsExceeded` 的 429 中返回非敏感的 `challengeRotationRequired=1` 指令。客户端只在收到该精确指令时立即生成并保存新 challenge、清除旧 pending marker；普通 source/target 限流 429 或预先已耗尽的重试不得触发轮换。随后请求的 replacement 必须绑定这个新 challenge，因此旧耗尽行与新行不会共享 challenge HMAC。
- 点击“更换邮箱”只解锁输入框，不得立即删除旧 challenge。只有实际向另一个 normalized email 发起 code 请求时，`getOrCreate` 才用新 challenge 覆盖旧值；若用户未改变地址，或编辑后又改回原地址，必须继续复用原 challenge。登录成功、显式取消或 code 过期后删除。
- 页面刷新后从 `sessionStorage` 恢复。若浏览器会话在 code 仍 active 时丢失，服务端不能仅凭一个新 challenge 安全替换旧 code，否则第三方可借重发接口使受害者的 code 失效。UI 必须明确提示：在原浏览器完成验证，或等待最多一个 code TTL（10 分钟）后再请求新 code；也可改用 Magic Link / OAuth。不得提示用户立即重发并暗示会生成可用的新 code。

浏览器生成逻辑必须使用 `crypto.getRandomValues`，禁止 `Math.random()`、时间戳、UUID v1 或可预测 PRNG。

### 3.2 API 请求体

`POST /api/auth/request-code`：

```json
{
  "email": "fan@example.com",
  "challenge": "<43-char base64url>",
  "turnstileToken": "..."
}
```

`POST /api/auth/verify-code`：

```json
{
  "email": "fan@example.com",
  "code": "123456",
  "challenge": "<43-char base64url>"
}
```

两条 route 都必须在有界 JSON 读取后校验 challenge 的长度和 base64url 字符集。challenge 不得出现在成功响应、错误详情或日志。`request-code` 仍统一返回 `{ accepted: true }`，不得泄露是否创建、抑制或替换了 code。

## 4. 数据库与迁移

`login_codes` 新增：

```sql
challenge_hash text null
```

- 新协议创建的行必须写非空 `challenge_hash`。
- 迁移不得给存量行伪造 challenge；`NULL` 明确表示 legacy Crockford code。存量长度由部署前的 `LOGIN_CODE_LENGTH` 决定，旧 schema 曾允许 16–64，因此兼容分支必须覆盖整个范围。
- 不需要 challenge 索引；查询仍以 normalized email 的最新 active code 为入口。
- `attempt_count` 保留非负默认值。新协议中它只统计 **challenge 已匹配** 后的错误 code 比较。
- 不新增 raw challenge、code format 或 code 明文列。

迁移是 additive nullable 变更。部署必须先迁移再启动新代码。由于旧实例不能验证 6 位新码，切换发码格式时要排空旧实例或采用单版本切换；不得把“新实例发 6 位码、旧实例仍按 16 位校验”描述为可安全滚动。

## 5. 发码事务

现有 request-code 顺序、Turnstile、source budget、email+IP 发送预算、per-email advisory lock、active-code dedupe、persistent delivery fence 和 encrypted durable task 均保持。

创建新 code 时，在同一事务内：

1. 规范化 email；
2. 校验 challenge；
3. 生成 6 位数字 code；
4. 写 `code_hash = HMAC("auth-login-code", code)`；
5. 写 `challenge_hash = HMAC("auth-login-code-challenge", challenge)`；
6. 写 `attempt_count = 0`；
7. 加密 code 后写 durable task；task payload 不保存 challenge。

active code 被抑制时，不更新其 `challenge_hash`、`attempt_count`、创建时间或 task。客户端复用原 challenge 是协议的一部分。

对新协议行，`attempt_count >= 5` 表示 code 已耗尽：它不再属于 active-code dedupe/fence 的候选，后续请求可以创建绑定新 challenge 的 code。该旧 code 对应的 pending、processing 或可重试 failed 投递任务必须在取得任务 ownership 与 per-email fence 后判定为 stale，并成功 no-op；不得再解密或发送已耗尽 code。legacy 行仍只按 `used_at` 与 expiry 判断 active。

`tasks.status='processing'`、非空 current owner 和 `lease_until > now()` 共同构成 SMTP 最后安全点的短期发送预留。worker 在 per-email advisory lock 内重新确认 task ownership 后，必须 `FOR UPDATE` 锁定 code 行并完成 exhausted / superseded 检查；事务提交后 task 在整个 SMTP 调用和 handler 返回前保持有 owner 的未过期 processing claim。验证事务对新旧协议行都必须检查该预留；命中时返回内部 `delivery_in_progress`，对外保持通用 `codeIncorrect`，但不比较 code、不增加 attempts、也不消费 resolved email+IP 失败桶。这样 worker 提交最后检查后，验证不能再消费或耗尽即将发送的 code。只有 status=processing 但 owner 为空或 lease 已过期的 abandoned 行不构成预留，验证不得无限等待 worker reclaim；现有 ownership fencing 负责阻止该过期 worker 开始新的 SMTP。回收后的 worker 重新执行同一检查，不把数据库连接或 advisory lock 跨 SMTP 持有。

## 6. 验证事务

route 顺序仍为：输入校验 → target failure bucket 只读检查 → source comparison budget 消费 → 核心数据库事务 → 失败后 resolved email+IP 记账。

核心事务不得复用发码 dedupe 的 “active code” 谓词。它通常锁定 normalized email 最新的 unused、unexpired code；但如果请求携带的 challenge HMAC 匹配某个 unused、unexpired 且 `attempt_count >= 5` 的新协议行，则优先锁定该已耗尽行。这个窄例外只用于在 replacement 已创建后仍识别旧 challenge 的 `attempts_already_exhausted`，不得让未耗尽的旧 code 越过更新 code 重新生效。由此在 replacement 创建前后，已耗尽重试都不会退化成 `codeExpired` / 普通错误并重复消费 target bucket。

replacement 使用耗尽响应后轮换的新 challenge；新 challenge 必须选择最新未耗尽行。只有携带旧 challenge 的请求才会命中上述耗尽行优先规则，因此新邮件中的 code 可以立即验证，不必等待旧行过期。

锁定目标行后，先检查其 delivery task 是否持有上述有效 SMTP 预留；命中则按 `delivery_in_progress` 返回。随后按行类型执行：

### 6.1 新协议行（`challenge_hash IS NOT NULL`）

1. 常量时间比较 challenge HMAC。
2. challenge 不匹配：返回通用 `codeIncorrect`；不得比较 code、不得更新 `attempt_count` / `used_at`。
3. challenge 匹配但 `attempt_count >= 5`：返回 `codeAttemptsExceeded`；不得比较 code。
4. 常量时间比较 code HMAC。
5. code 正确：条件更新 `used_at = now()` 并登录；不增加 `attempt_count`。
6. code 错误：在持有行锁时把 `attempt_count` 原子增加 1；第 1–4 次返回 `codeIncorrect`，第 5 次产生内部 `attempts_exhausted_now` 结果并对外返回 `codeAttemptsExceeded`。

challenge mismatch 与 code mismatch 对外都不得暴露可区分的正文、字段或稳定可利用的时序差异。route 可以继续让两者进入相同的 source / resolved email+IP 失败记账路径，但数据库 attempts 只由 challenge-matched code mismatch 推进。

route 必须把 `attempts_exhausted_now` 当作本次真实错误比较计入 resolved email+IP 失败桶，同时保持 429 响应；已经在进入请求前耗尽的 code 则返回单独的内部 `attempts_already_exhausted`，不得重复消费该失败桶。这样第 5 次错误不会绕过 S4 记账，也不会让耗尽后的重试继续累积 target-scoped 失败次数。

### 6.2 legacy 行（`challenge_hash IS NULL`）

- 接受 16–64 位 uppercase Crockford base32 输入，以覆盖旧版允许的全部 `LOGIN_CODE_LENGTH`；challenge 可缺省且不参与比较。最终仍由存量 `code_hash` 常量时间比较决定是否正确，扩大兼容输入长度不产生可用 code。
- legacy 行同样先受有效 SMTP 预留保护，避免 retry worker 在用户刚消费 code 后发送已失效邮件。
- 保持 S4 行为：错误输入不写 `attempt_count`，正确输入仍可在过期前使用。
- legacy 支持只为迁移窗口存在；新代码不得再创建此类行。

route 的原始 code schema 在迁移窗口内可接受 `^[0-9]{6}$` 或 legacy 16–64-char Crockford；核心必须根据锁定行的 `challenge_hash` 决定最终格式，不能只靠客户端传入格式选择协议。

## 7. 并发与失败语义

- 同一 code 的验证继续使用 `FOR UPDATE`；并发正确提交最多一个成功。
- 并发错误提交在 challenge 匹配时串行增加 attempts，最终值不得超过 5。
- challenge mismatch 并发不得改变 attempts。
- 第 5 次错误与同时到达的正确提交按取得行锁的顺序决定；一旦 attempts 已到 5，后到的正确提交必须失败。
- worker 的最后检查与验证通过同一 code 行锁排序；worker 检查通过后由 processing task 预留覆盖 SMTP 窗口，验证只消耗 source budget 并延后比较。不得持有数据库事务或 advisory lock 执行 SMTP。
- SMTP / task 重试只携带加密 code；challenge 永不进入 outbox，因此现有敏感数据边界不回退。
- `SESSION_SECRET` 轮换仍使存量 code HMAC 与在途加密 task 失效，用户重新请求即可。

## 8. UI 与邮件

- 输入框使用 `inputMode="numeric"`、`autoComplete="one-time-code"`。迁移发布中 `maxLength` 暂为 64，状态模型允许粘贴 16–64 位 legacy Crockford code；legacy TTL 排空后再收紧为只保留 6 位数字。
- placeholder、帮助文案和邮件模板都必须显示 6 位数字语义，不再提大小写或 16 位长度。
- 登录码邮件 HTML 化属于独立事务邮件 PR；本协议实现不能依赖 HTML 邮件才能完成验证，纯文本邮件仍包含 6 位 code。
- challenge 丢失时返回通用失败，并提示在发起请求的浏览器重新发送，不得把 challenge 是否匹配暴露给攻击者。

## 9. 必测行为

- generator 只产生 6 位数字，包含前导零的值保持 6 字符；
- client challenge 使用 Web Crypto，重发复用，更换邮箱/成功后清理；
- request/verify route 拒绝短、长、带 padding 或非 base64url challenge；
- 新 code 行同时写 code/challenge HMAC，task JSON 不含 challenge 或明文 code；
- challenge 错误时 attempts 不变，正确 challenge + 错误 code 每次只加 1；
- 第 5 次错误封锁该 code，正确 code 在 attempts 达 5 后也失败；
- 第 5 次错误同时计入 resolved email+IP 失败桶，耗尽后的后续请求不重复记账；
- replacement 创建前后，旧 challenge 都能命中已耗尽行并返回 `attempts_already_exhausted`；未耗尽的旧 code 不得因此重新可用；
- 第 5 次匹配错误的响应指示客户端轮换 challenge，replacement 绑定新 challenge 并立即可验证；普通 429 不轮换；
- 已耗尽 code 不抑制新 code 创建，其旧投递任务在 SMTP 前成功 no-op；
- 新旧协议行在 active processing claim 的 SMTP 阻塞期间都不推进 attempts/used_at/target bucket；owner 缺失或 lease 过期后不再延后比较；
- challenge 丢失时 UI 不进入立即重发循环，而是提示等待旧 code 最多 10 分钟过期或改用其他登录方式；
- attempts 未达 5 时正确 code 成功且不增加 attempts；
- 并发错误 attempts 不丢失、不超过 5，并发正确最多一次成功；
- 来源硬预算和 resolved email+IP 门禁的 S4 测试全部保留；
- legacy 16–64 位行在 TTL 内可验证且错误不写 attempts；新协议行拒绝 legacy 格式；
- migration 保留存量行并允许新旧 verifier 分支；
- 日志、task、audit、API 响应不出现 raw email、challenge 或 code；
- lint、format、类型、真实 PostgreSQL 集成测试、build 与完整 CI 全绿。

## 10. 验收清单

- [x] 固定 6 位 decimal，旧 env 值不再控制生成策略
- [x] 32-byte challenge 由浏览器 CSPRNG 生成并在同一邮箱重发时复用
- [x] 数据库只存 purpose-separated challenge HMAC
- [x] challenge mismatch 不比较 code、不写 attempts
- [x] attempts 仅在 challenge-matched code mismatch 后增加，最大 5
- [x] 正确 code 仍受 attempts 上限、source gate 与 target gate 约束
- [x] legacy 16–64 位行只在自然过期窗口兼容
- [x] active-code dedupe 不替换 challenge，并排除已耗尽新协议行
- [x] durable task、SMTP、日志和审计不泄露 challenge/code
- [x] 迁移和部署说明明确旧实例不能验证新 6 位码
