# 交接：S4 认证限流硬化（含 #66 verify-code 定向锁死)

> 自包含实现说明。前置依赖:当前 `main`(已含 #60 `resolveClientRateLimitIdentity`/`warnUnresolvedClientRateLimitIdentity`、`@/lib/rate-limit`、S1a/#70 的 proof pre-auth 桶)。属 v1.0 安全硬化 P2(epic #64,S4),**含已验证的 #66**。**无需 ADR**。
>
> 开工前建 issue;PR base `main`,Draft 直到真实 PG 集成 + 完整 CI 全绿。**复用 #60 的 resolved/unresolved 身份 + 专用 emergency 桶范式,勿落全局 `unknown` 桶。**

## 0. 红线

1. **核心不变量(必须由 `verifyLoginCode` 自身保证,外层限流救不了)**:**未持有正确验证码的第三方,不得仅靠提交错误码使正确码失效**。→ 正确码**始终优先校验并允许成功**(不受失败计数阻断);失败上限**只阻止后续错误尝试**,绝不导致正确码被拒。单纯在路由外叠 IP/email+IP 限流**挡不住**(攻击者用 ≤MAX 次错误、或跨多 IP 各错一次即打满全局 `attempt_count`)。
   - **耦合要求(因移除全局上限)**:全局失败上限既是锁死原语**也是**总猜测次数边界;移除后必须用**非锁死兜底 = 提高验证码熵**(§3.3)堵住分布式在线枚举,否则 6 位数字码 + 多 IP 可被僵尸网络在 TTL 内枚举。
2. **request-code 不得有纯 email 的【阻断】门禁**:任何只依赖受害者邮箱、会**返回 429/阻止其请求**的键(cooldown / 小时硬上限)都让攻击者从任意 IP 锁死受害者。阻断门禁只用 **IP + (email+IP)**;防邮件轰炸用**不阻断登录**的手段(发信去重/抑制,返回 200 不报错)。残余(分布式触发的邮件投递噪声)**如实记录**,不宣称已根除。
3. **不落全局 `unknown`/单一 unresolved 桶**:IP 未解析时用**每操作独立的 emergency 共享桶**(与 resolved-IP 桶分离)。**注意**:emergency 桶仍是「每操作一个共享桶」,unresolved 客户端之间**仍互相消耗**(无 IP 无法相互隔离,#60 同此)——这是**有意的残余**,文档如实写明,不宣称 unresolved 间已隔离。
4. **门禁顺序按操作语义区分**:
   - verify-code:CL 预拒 → IP 门禁 → 解析/规范化 → resolved email+IP 门禁 → 核心验证;
   - request-code:CL 预拒 → IP 门禁 → 解析/规范化 → Turnstile → 原子去重判定 → **仅真正准备发送/排队时**扣减 resolved email+IP 发送预算 → 创建 code + 投递。
   - 不得让 Turnstile 失败或去重抑制这种“未发送退出”消耗 5/hr 的 email+IP 发送预算。
5. 生产 IP 未解析要**告警**;**单进程内存限流**对多实例无效,文档化 + readiness 提示(§6)。
6. **身份同源**:所有 email 维度的限流键、去重键、查询与写库必须使用与 auth 核心一致的规范化邮箱(当前语义为 `trim().toLowerCase()`)；禁止对原始输入直接 hash，否则大小写/空白变体可绕过 email+IP 与 dedupe。
7. **保留现有 bot 防护**:`request-code` 在 `TURNSTILE_ENABLED=true` 时必须继续执行 `assertTurnstile(turnstileToken, ip)`；本切片只调整限流/去重，不得通过重排流程把 Turnstile 静默删掉。
8. **去重必须并发安全**:同一 normalizedEmail 的“检查窗口→决定发送→创建最新 code→建立投递”必须串行/原子；两个并发请求不得都观察为可发送并各自生成邮件。

## 1. 现状（必读,确认漏洞)

- **verify-code 定向锁死(#66,已验证)**:
  - `src/app/api/auth/verify-code/route.ts`:**无任何限流**(仅 S1a 的 CL 预拒)。
  - `src/modules/auth/login-code.ts` `verifyLoginCode`:对**最新有效 code** 每次尝试 `attempt_count+1`,`>= MAX_ATTEMPTS(5)` 后即使**正确码**也 `429 codeAttemptsExceeded`。→ 知道邮箱的攻击者连发 5 错码即作废受害者有效码;无路由限流 → 可无限重复。
  - `requestLoginCode`:per-email `code-hour:${email}` **硬上限 5/hr**(锁死杠杆:攻击者触发 5 封即锁受害者 1 小时 + 骚扰邮件);`code-cooldown:${email}` 60s;`code-ip:${ip}` 20/hr(**仅 ip 存在时**)。
- **全局 `unknown` 桶**:`src/app/api/auth/admin/login/route.ts`:`ip = getClientIp(req) ?? "unknown"` → `rateLimit('admin-login:'+ip, 10, 10min)`。IP 未解析时所有客户端共享 `admin-login:unknown` → 少量请求即锁死**全站管理员登录**。(proof 上传 S1a 已用 pre-auth IP/unresolved 分桶,**不在本切片**;download 已 #60 修。)
- **#60 资源**(`src/modules/download/rate-limit-policy.ts`):`ClientRateLimitIdentity`(`ip`|`unresolved`)、`resolveClientRateLimitIdentity(ip)`、`getFilePreAuthRateLimit`(unresolved 走专用桶+专用阈)、`warnUnresolvedClientRateLimitIdentity`(节流告警)。**复用/上移这些**。

## 2. 抽共享身份 + 新增 auth 限流策略

- 把 `ClientRateLimitIdentity`/`resolveClientRateLimitIdentity`/`warnUnresolvedClientRateLimitIdentity` 上移到中性模块(如 `src/lib/rate-limit-policy.ts` 或 `src/modules/security/rate-limit-policy.ts`),download 与 auth 共用(download 现引用改为 re-export 或直接引新址,**不破坏其行为/测试**)。
- 新增 auth 策略(每个返回 `{key,max,windowMs}`):**resolved → per-IP 桶**;**unresolved → 该操作专用 emergency 共享桶**(与 resolved 桶分离、阈值较高)。
  - `getAdminLoginRateLimit(identity)`:`admin-login-ip:${ip}`(10/10min)/ `admin-login-unresolved`(高阈)。
  - `getVerifyCodeIpRateLimit(identity)`:`verify-ip:${ip}`(30/10min)/ `verify-unresolved`(高阈)。
  - `getVerifyCodeEmailIpRateLimit(identity, emailHash)`:**仅 resolved 适用** → `verify-email-ip:${emailHash}:${ip}`(10/10min)。**unresolved 时路由不调用此层**(无 IP 时 email+IP 维度不成立;且避免与 IP 门禁双计同一 emergency 桶,§3.2)。
  - `getRequestCodeIpRateLimit(identity)`(unresolved → `request-code-unresolved`)、`getRequestCodeEmailIpRateLimit(identity, emailHash)`(**仅 resolved 适用**,unresolved 路由不调用)。request 的 email+IP 桶表示**实际发送/排队尝试预算**，只在 Turnstile 通过且 dedupe 判定需要新投递后扣减。**不提供任何纯 email 的阻断策略**(§4)。
  - email 一律先通过共享 `normalizeEmail`（与 auth 查询/写入同源，当前 `trim().toLowerCase()`），再对规范化结果做 **hash**(`hmacSha256`/`hashtext`)入 key；不得把原始 email 明文或其 raw hash 落限流键。
- **诚实记录**:emergency 桶是「每操作一个共享桶」,unresolved 客户端**彼此仍互相消耗**(无 IP 无法相互隔离);它只保证**不波及 resolved-IP 用户**,不保证 unresolved 之间隔离(#60 同此)。

## 3. verify-code:核心改语义(#66 必修)+ 前置门禁(纵深)

> **关键**:#66 的根因是 `verifyLoginCode` 的**全局 per-code 失败锁**——攻击者用 ≤5 次错误码(或跨 5 个 IP 各 1 次)即把 `attempt_count` 打到 `MAX`,使**正确码也被拒**。这**无法靠路由外叠限流解决**(攻击在限流阈值内即可达成)。**必须改核心语义。**

### 3.1 核心:正确码始终优先校验(`src/modules/auth/login-code.ts`)
重排 `verifyLoginCode`(事务 + 对最新有效 code `FOR UPDATE`):
1. 取最新「未用、未过期」code 行(无 → `400 codeExpired`);
2. **先比对** `safeEqual(hmac(normalizeLoginCode(submitted)), code_hash)`:
   - **正确** → `usedAt=now()` 成功登录,**完全不看 `attempt_count`**(即便已达 MAX);
   - **错误** → `attempt_count+1`;若 `attempt_count >= MAX_ATTEMPTS` → `429 codeAttemptsExceeded`(**仅拒后续错误尝试**),否则 `400 codeIncorrect`。
- 不变量:**第三方提交错误码永远不能让正确码失效**;`attempt_count` 只用于对**错误**尝试返回 429,**绝不**作废/阻断正确码、也**不**作为总猜测次数上限(见 §3.3)。
- (可选)正确登录后可作废该 email 其它在途 code;**不要**因失败计数作废 code。

### 3.3 暴力枚举兜底:提高验证码熵(替代被移除的全局上限,非锁死)

> ⚠️ 因 §3.1 移除了「全局 per-code 失败上限」(它原是总猜测次数的边界、但也是 #66 的锁死原语),**总猜测次数的边界只剩 per-IP + (email+IP) 限流**。当前 code 为 **6 位数字(10^6)**;handoff 已把**分布式多 IP**纳入威胁模型——攻击者用大量 IP 在 10min TTL 内可凑出可观猜测量,6 位空间对僵尸网络在线枚举**不够安全**。

- **最小熵必须从预算【推导】,不得拍脑袋给不达标的示例**。判据:`成功率 = 猜测预算 B / 码空间 ≤ 目标(默认 2^-20 ≈ 9.5e-7)` ⇒ **码空间 ≥ B / 2^-20**。
- **预算 B**:email+IP `10/10min` + TTL `10min` ⇒ 每 IP ≈ 10 次/码;K 个 IP ⇒ `B = 10·K`。
- **据此推导**(目标 2^-20):
  - 取保守 **K=10^6**(大型僵尸网络)⇒ `B=10^7` ⇒ 码空间 ≥ `10^7 / 9.5e-7 ≈ 1.05e13 ≈ 2^43.3`。
  - 满足该值需:**≥14 位数字(10^14)** 或 **≥9 位 Crockford base32(2^45≈3.5e13)**。**8 位 base32(2^40)/9–10 位数字均不达标**(分别约 1e-5 / 1%–0.1%)。
  - **推荐 9 位 uppercase Crockford base32**(邮件复制,UX 可接受;K=10^6 时成功率 ≈ 2.9e-7 ✓)。若按更小、更现实的 K(如 10^3–10^4)推导,可用更短码——**实现方须以【自己选定的 K】按上式推导最小长度,并在 PR 写明所用 K 与达标计算**。
- 这样既满足 §3.1「正确码不可被作废」(无全局锁),又使**分布式在线枚举不可行**,无需任何锁死式上限。
- (`MAX_ATTEMPTS` 仅保留为对**错误**尝试的 429 速率信号,不再承担总量边界。)
- **生成器、规范化、API 校验、登录 UI、文案和测试必须一起改**:
  - `generateLoginCode` 的字母表/长度与 `LOGIN_CODE_ALPHABET/LENGTH` 同源，默认生成 uppercase Crockford base32；
  - 提供共享 `normalizeLoginCode`（至少 `trim()`；使用字母表时统一 `toUpperCase()`），生成后 hash 与验证前 hash 使用同一规范化结果；
  - `verify-code/route.ts` 当前 `code: z.string().regex(/^\d{6}$/)` 必须同步，schema 应对规范化后的值校验最终字母表与长度，否则新码会在 `verifyLoginCode` 前被拒;
  - `src/components/auth/login-form.tsx` 当前 `maxLength={6}`、numeric-only `inputMode`/placeholder、以及提交按钮的 `code.length !== 6` 禁用条件，必须全部按最终字符集与长度同步；字母码输入可自动 uppercase，但后端仍须规范化，不能依赖客户端;
  - i18n 错误/提示文案及前后端测试一并更新。生成集合、规范化集合、API 接受集合、UI 可输入/可提交集合必须一致。

### 3.2 纵深:路由前置门禁(`verify-code/route.ts`)
```
const identity = resolveClientRateLimitIdentity(getClientIp(req));
assertContentLengthWithinLimit(...)                 // CL 预拒
apply(getVerifyCodeIpRateLimit(identity))           // IP 桶 / unresolved→emergency 桶(解析前)
const { email, code } = await readJsonWithLimit(...)
const normalizedEmail = normalizeEmail(email)       // 与 auth 核心同源
const normalizedCode = normalizeLoginCode(code)
if (identity.kind === "ip")                          // ★ 仅 resolved 才加第二层
  apply(getVerifyCodeEmailIpRateLimit(identity, hashEmail(normalizedEmail)))
await verifyLoginCode(normalizedEmail, normalizedCode)
```
- **规范化必须先于 hash/限流/查询**:大小写或首尾空白 email 变体必须落入同一个 email+IP 桶，并命中同一 login code/user；验证码大小写/首尾空白按共享规则归一，不能出现邮件码可见但 API/HMAC 不一致。
- **关键:unresolved 时只执行一次操作级 emergency 门禁,不再执行 email+IP 第二层**——否则两层都落到同一个 `verify-unresolved` 桶、**每请求计两次、有效阈值减半、unresolved 间更易互锁**。无 IP 时 email+IP 维度本就不成立,跳过更合语义。
- resolved:IP + (email+IP) 两层;限攻击者在线猜测**速率/体量**(配合 §3.1「正确码不可被作废」)。unresolved 命中 → 生产告警。
- **不加纯 email 阻断门禁**。

## 4. request-code:移除纯 email 阻断,IP/(email+IP) 为门禁 + 非阻断防轰炸

> 红线:**任何纯 email 的【阻断】键(返回 429)都是定向锁死杠杆**。删除之,防轰炸改用不阻断登录的发信抑制。

- **完整顺序（Turnstile、dedupe 与发送预算均不得回退）**:
  1. CL 预拒;
  2. 解析 client identity，执行 IP 门禁（unresolved → 一次操作级 emergency 桶）;
  3. `readJsonWithLimit` 解析 `{ email, turnstileToken }`;
  4. `normalizedEmail = normalizeEmail(email)`;
  5. 当 `TURNSTILE_ENABLED=true` 时执行现有 `assertTurnstile(turnstileToken, ip)`；失败即停止，不得创建 code、排队邮件或扣减 email+IP 发送预算;
  6. 进入以 normalizedEmail 串行化的原子区（PostgreSQL advisory lock、稳定锁行或等价机制），检查最近一次**已成功排队/可交付**的 code 是否仍在 `SEND_DEDUPE_WINDOW`；命中则直接 `200`，不写新 code、不刷新窗口、不扣减 email+IP 发送预算;
  7. 仅在确需新投递时，resolved 身份执行 `(normalizedEmail+IP)` 发送预算门禁；unresolved 不执行第二层;
  8. 在同一串行/事务边界内创建新 code，并优先把邮件作为 durable task/outbox 原子排队；事务提交后返回 `200`。
- `code-ip` 改走 #60 identity(不再「仅 ip 存在时」裸跳过)。**unresolved 时只执行一次操作级 emergency 门禁,不再执行 email+IP**——否则两层都落 `request-code-unresolved`、每请求计两次、有效阈值减半。
- **email+IP 桶是发送尝试预算，不是端点请求预算**:Turnstile 失败、schema 失败、dedupe 抑制均不得消费；SMTP/outbox 真正准备投递时才消费。IP 主桶仍在解析前消费，用于控制端点与 bot 压力。
- **删除** `code-hour:${email}`(纯 email 小时硬上限)与「会 429 的 `code-cooldown:${email}`」——它们让受害者**换 IP 也被锁**。
- **所有 email 维度状态必须使用 normalizedEmail**:email+IP key、发送时间戳、dedupe 查找、`login_codes` 查询/插入与邮件目的地址的账号匹配都以同一规范化值为准；raw 大小写/空白变体不得绕过抑制或另建最新码。
- **防邮件轰炸 = 非阻断发信抑制**:每 normalizedEmail 维护「**最近一次真正成功排队/可交付**的时间戳」;若距该时间 < `SEND_DEDUPE_WINDOW`(默认 60s)→ **不发新邮件,但仍 `200`**(复用现有未过期 code 或静默跳过),**绝不 429**。→ 单地址邮件量 ≤1/窗口,受害者端点**永不被纯 email 硬锁**。
- **关键(防窗口无限延长)**:**只有真正成功排队/建立可交付投递那一刻才更新该时间戳;被抑制的请求只返回 200、绝不更新时间戳**。否则攻击者每 59s 请求一次即可不断把窗口往前推、使真实邮件**永远发不出**。如此每个窗口至少放行一封真实邮件。
- **关键(不得铸造用户未收到的新码)**:抑制命中时**不得插入新的 `login_codes` 行**。新 code 与 durable email task/outbox 应在同一事务中创建，确保“最新有效码”必有对应可交付邮件。若实现坚持同步 SMTP，则发送失败必须补偿删除/作废该 code，且不得推进 dedupe 时间；禁止留下用户从未收到的最新有效码。
- **关键(并发去重)**:对同一 normalizedEmail 的两个并发请求，只有一个可越过 dedupe 并创建 code/投递；另一个在取得锁后重新检查并走 200 抑制路径。单纯“先查再插”而无锁/唯一约束不合格。
- **如实记录残余**:分布式攻击者跨多 IP 触发仍可造成**邮件投递噪声**、或在抑制窗口内压住某次合法发信(受害者过窗重试即得);这是**有界的投递降级,不是认证硬锁**(正确码不可被作废 §3.1、端点不纯 email-429)。**文档不得宣称分布式投递锁死已根除。**

## 5. admin-login:去 `unknown`,用 identity

`src/app/api/auth/admin/login/route.ts`:`ip = getClientIp(req) ?? "unknown"` + 裸 `admin-login:${ip}` →
- `const identity = resolveClientRateLimitIdentity(getClientIp(req))` → `getAdminLoginRateLimit(identity)`;unresolved 走 `admin-login-unresolved` 专用高阈桶(**不锁全站管理员登录**)+ 生产 `warnUnresolvedClientRateLimitIdentity`。
- 顺序保持 S1a:CL 预拒 → IP 门禁(429)→ readJson → adminLogin。

## 6. 告警 + 多实例边界

- 三个路由 unresolved 命中时 `warnUnresolvedClientRateLimitIdentity`(已节流);确保生产配 `TRUSTED_PROXY_HEADER/HOPS` 才能解析 IP(沿用 #60 提示文案)。**emergency 桶仅与 resolved 桶分离,unresolved 间不隔离(§2,文档如实写)。**
- **多实例**:`@/lib/rate-limit` 是**单进程内存**,横向扩容失效。**本切片不实现共享限流存储**;但:
  - 在 `/api/ready`(或启动日志)对「多实例 + 内存限流」给出**明确警告/说明**;
  - 策略模块已集中 key/阈,作为未来接 Redis/PG 限流的**接缝**;
  - 文档(部署/升级)写明:多实例须接共享限流存储,否则各实例独立计数、限流被绕过。
  - (是否在 v1.0 实现共享存储 = owner 决策,见末节;默认仅文档+告警。)

## 7. env（有界,越界拒绝,沿用既有写法)

```text
ADMIN_LOGIN_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
VERIFY_CODE_IP_RATE_MAX / VERIFY_CODE_EMAIL_IP_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
REQUEST_CODE_IP_RATE_MAX / REQUEST_CODE_EMAIL_IP_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
REQUEST_CODE_SEND_DEDUPE_SECONDS    # 发信抑制窗口(非阻断,默认 60)
LOGIN_CODE_LENGTH / LOGIN_CODE_ALPHABET   # §3.3 验证码熵,从预算推导(默认 9 uppercase base32;生成/规范化/API/UI 同源)
```
(无任何 `REQUEST_CODE_EMAIL_RATE_MAX` 纯 email 阻断键;可合并复用同一 window;合理默认 + 上下限;`.env.example` 同步;测试默认/越界拒绝。)

## 8. 测试（真实行为)

- **verify-code 核心不变量(#66,必测)**:攻击者(同 IP 或**跨多 IP 各错一次**)把 `attempt_count` 打到/超过 `MAX` 后,**受害者提交正确码仍成功登录**(正确码不被作废)。错误猜测达 MAX 后继续错误 → `429 codeAttemptsExceeded`(只挡错误)。
- **verify-code 纵深**:单 IP 高频提交 → 命中 `verify-ip`/`verify-email-ip` `429`(限速率/体量,非「在 5 次前」)。
- **email 规范化同源**:`Fan@Example.com`、` fan@example.com `、`fan@example.com` 在 verify/request-code 中落同一个 email+IP 桶、同一个 dedupe 时间戳、同一 login code/user；大小写/空白变体不能增加猜测预算或绕过发信抑制。
- **code 规范化同源**:uppercase 邮件码、用户输入 lowercase/首尾空白按 `normalizeLoginCode` 归一后均可验证；非法/歧义字符仍被 schema 拒绝；生成与 HMAC 比较使用同一规范化值。
- **request-code 保留 Turnstile**:`TURNSTILE_ENABLED=true` 时缺失/错误 token 仍被 `assertTurnstile` 拒绝，且不插入 code、不排队邮件、**不消费 email+IP 发送预算**；有效 token 才进入 dedupe/发送判定。关闭 Turnstile 时保持现有兼容行为。
- **未发送退出不扣发送预算**:连续 5 次 Turnstile 失败或窗口内重复请求不会耗尽 `REQUEST_CODE_EMAIL_IP_RATE_MAX=5`；下一次通过 Turnstile且跨出/未命中 dedupe 的合法发送仍可进行。真正第 6 次发送尝试才 429。
- **request-code 无纯 email 硬锁**:攻击者跨任意 IP 触发后,**受害者(异 IP)仍能 `200` 请求**(端点无纯 email 429);单 IP 高频端点请求命中 IP 门禁；同一 resolved email+IP 的真实发送尝试命中发送预算门禁。
- **request-code 防轰炸非阻断**:同一 email 在抑制窗口内多次请求 → 仍 `200`、**不重复发信**(断言未多发邮件、未返回 429、发送预算不变)。
- **抑制不得新建未发送码**:窗口内抑制请求不插入新的 `login_codes` 行、不改变 verifier 看到的最新有效码;用户使用上一封邮件中的码仍能成功登录。
- **并发去重真实 PG 测试**:同一 normalizedEmail 并发请求（均通过 Turnstile、来自允许的身份）最终只新增 1 个 code、只排队/发送 1 封邮件；另一请求 200 抑制；不存在两个“最新”码或未送达码。
- **投递失败一致性**:outbox 原子排队失败则事务回滚不留 code；若同步 SMTP 失败则 code 被作废/删除且 dedupe 不推进，重试可真正发送。
- **防窗口无限延长**:每 59s 请求一次(< 窗口)→ **抑制不刷新时间戳**,跨过窗口后下一次仍发出真实邮件(断言:被抑制请求不更新时间戳;每窗口 ≥1 封真实邮件,攻击者无法靠高频轮询永久压制)。
- **验证码熵(§3.3)**:码空间 ≥ `B/2^-20`(B 由所选 K 推导,PR 写明);默认 9 uppercase base32 达标;正确码在任意失败计数下仍成功。
- **生成↔规范化↔API↔UI 同源**:`generateLoginCode` 产出的码能通过 verify-code schema，也能在登录表单完整输入并成功提交;新字母表/长度不受旧 `^\d{6}$`、`maxLength={6}`、numeric-only input hints 或 `code.length !== 6` 阻断;畸形码仍 400;i18n 文案更新。
- **unresolved 不双计(§3.2/§4)**:单个 unresolved verify/request 请求**只让 emergency 桶 +1**(非 +2);达配置第 N 次才 `429`(而非约 N/2);verify 与 request-code 都覆盖。
- **unresolved**:IP 未解析并发 admin/verify/request → 落**该操作 emergency 桶**,**不波及 resolved-IP 客户端**;告警触发(节流)。(不断言 unresolved 间隔离——设计上不隔离。)
- env 越界拒绝;email 以规范化后 hash 入 key(不明文)。
- 回归:正常登录/发码/管理员登录、Turnstile、download/#60、proof 上传限流不受影响。

## 9. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm check:request-bodies
pnpm exec drizzle-kit generate   # 若复用 durable task/outbox + advisory lock,预期无 schema 变更；若新增持久 dedupe 字段则必须提交迁移
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

## 10. PR

base `main`,Draft 直到 CI 全绿,关联 S4/#66 issue,标题 `fix(auth): harden login rate limiting against targeted lockout`。描述列出:**verify-code 核心改语义(正确码不可被作废)** + IP/(email+IP) 纵深门禁、验证码熵与规范化、**规范化 email 后再 hash/去重**、**request-code 删纯 email 阻断且保留 Turnstile** + 未发送退出不扣发送预算 + 并发安全非阻断发信抑制/投递一致性(+残余说明)、admin-login 去 unknown、identity 上移共享、emergency 桶(如实表述)、告警、多实例边界、env、测试。

## 11. 验收 checklist

- [ ] **verify-code 核心**:`verifyLoginCode` 先比对正确性、**正确码始终成功**(不受 `attempt_count` 阻断);失败计数只挡后续错误;**第三方错误提交不能作废正确码**(跨多 IP 也不能)
- [ ] **暴力兜底(非锁死)**:验证码熵**从预算推导**(码空间 ≥ B/2^-20,PR 写明 K 与计算;默认 9 uppercase base32,8 base32/9–10 digits 不达标)
- [ ] **生成↔规范化↔API↔UI 同源**:`generateLoginCode` + `normalizeLoginCode` + verify schema + `login-form.tsx` 的 maxLength/inputMode/placeholder/提交 disabled 条件 + i18n + 前后端测试一起改
- [ ] **email 规范化同源**:verify/request-code 在 hash、email+IP key、dedupe、login_codes 查询/写入前统一 `trim().toLowerCase()`；大小写/空白变体不得分桶或绕过
- [ ] verify-code 纵深:CL → IP 门禁(解析前)→ readJson → normalize email/code → **(email+IP)门禁仅 resolved** → verifyLoginCode;**unresolved 不双计 emergency 桶**
- [ ] request-code:**保留 Turnstile**；CL → IP 门禁 → readJson → normalize email → `assertTurnstile` → 原子 dedupe → **仅真实发送时 resolved email+IP 门禁** → code+outbox；Turnstile/dedupe 退出不扣发送预算
- [ ] request-code:**删除纯 email 阻断键**;防轰炸 = 非阻断发信抑制;抑制路径不插入新 code、不刷新窗口、不改变最新可验证码、不扣发送预算
- [ ] request-code:**并发与失败一致性**:同 email 串行化；并发仅一封/一码；code 与 durable 投递原子，或同步 SMTP 失败有补偿且不推进 dedupe
- [ ] admin-login:去 `?? "unknown"`,用 `resolveClientRateLimitIdentity` + `admin-login-unresolved` emergency 桶
- [ ] emergency 桶 = 每操作独立、**与 resolved 桶分离**;文档**如实写 unresolved 间不隔离**;生产告警
- [ ] identity helpers 上移共享,download 行为不变;email 规范化后 hash;env 越界拒绝;多实例内存限流文档化
- [ ] 真实测试:#66 跨多 IP仍不能锁死正确码;email/code 变体同源;Turnstile 不回退;未发送不扣预算;并发 dedupe/投递失败一致;新码 UI 可提交;unresolved 不波及 resolved;回归绿

## 已锁定决策（owner 确认 2026-06-26）

1. **多实例共享限流存储(Redis/PG)= 不纳入 v1.0**:本切片**仅文档 + readiness 告警**(单创作者自托管多为单实例,内存限流够用);策略模块集中 key/阈作为未来接共享存储的接缝,横向扩容时再实现。
2. **默认阈值采用以下值**(均经 env 可调、越界拒绝):
   - verify-code:IP `30/10min`、(email+IP) `10/10min`,unresolved emergency 高阈;**核心:正确码始终可用(§3.1)**;
   - request-code:IP `20/hr`、(email+IP) **真实发送尝试** `5/hr`、**发信抑制窗口 `60s`(非阻断,200 不发信)**;**无纯 email 阻断键**;
   - admin-login:`10/10min`,unresolved emergency 高阈。

> **修订说明(回应评审 + 独立复核)**:#66 改为核心语义修复并提高验证码熵；验证码生成/规范化/API/UI 同源；所有 email 维度状态先规范化再 hash/去重；request-code 保留 Turnstile，且 Turnstile 失败与 dedupe 抑制不扣 email+IP 发送预算；发信去重按 normalizedEmail 串行化，code 与 durable 投递原子（或同步失败补偿），防止并发双发与未送达最新码；emergency 桶每操作共享、与 resolved 分离、unresolved 间不隔离且只计一次。