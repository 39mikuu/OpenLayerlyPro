# 交接：S4 认证限流硬化（含 #66 verify-code 定向锁死)

> 自包含实现说明。前置依赖:当前 `main`(已含 #60 `resolveClientRateLimitIdentity`/`warnUnresolvedClientRateLimitIdentity`、`@/lib/rate-limit`、S1a/#70 的 proof pre-auth 桶)。属 v1.0 安全硬化 P2(epic #64,S4),**含已验证的 #66**。**无需 ADR**。
>
> 开工前建 issue;PR base `main`,Draft 直到真实 PG 集成 + 完整 CI 全绿。**复用 #60 的 resolved/unresolved 身份 + 专用 emergency 桶范式,勿落全局 `unknown` 桶。**

## 0. 红线

1. **核心不变量(必须由 `verifyLoginCode` 自身保证,外层限流救不了)**:**未持有正确验证码的第三方,不得仅靠提交错误码使正确码失效**。→ 正确码**始终优先校验并允许成功**(不受失败计数阻断);失败上限**只阻止后续错误尝试**,绝不导致正确码被拒。单纯在路由外叠 IP/email+IP 限流**挡不住**(攻击者用 ≤MAX 次错误、或跨多 IP 各错一次即打满全局 `attempt_count`)。
   - **耦合要求(因移除全局上限)**:全局失败上限既是锁死原语**也是**总猜测次数边界;移除后必须用**非锁死兜底 = 提高验证码熵**(§3.3)堵住分布式在线枚举,否则 6 位数字码 + 多 IP 可被僵尸网络在 TTL 内枚举。
2. **request-code 不得有纯 email 的【阻断】门禁**:任何只依赖受害者邮箱、会**返回 429/阻止其请求**的键(cooldown / 小时硬上限)都让攻击者从任意 IP 锁死受害者。阻断门禁只用 **IP + (email+IP)**;防邮件轰炸用**不阻断登录**的手段(发信去重/抑制,返回 200 不报错)。残余(分布式触发的邮件投递噪声)**如实记录**,不宣称已根除。
3. **不落全局 `unknown`/单一 unresolved 桶**:IP 未解析时用**每操作独立的 emergency 共享桶**(与 resolved-IP 桶分离)。**注意**:emergency 桶仍是「每操作一个共享桶」,unresolved 客户端之间**仍互相消耗**(无 IP 无法相互隔离,#60 同此)——这是**有意的残余**,文档如实写明,不宣称 unresolved 间已隔离。
4. **业务/敏感操作前**就限流(CL 预拒 → IP 门禁 → 解析 → email+IP 门禁 → 核心)。
5. 生产 IP 未解析要**告警**;**单进程内存限流**对多实例无效,文档化 + readiness 提示(§6)。

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
  - `getRequestCodeIpRateLimit(identity)`(unresolved → `request-code-unresolved`)、`getRequestCodeEmailIpRateLimit(identity, emailHash)`(**仅 resolved 适用**,unresolved 路由不调用)。**不提供任何纯 email 的阻断策略**(§4)。
  - email 一律 **hash**(`hmacSha256`/`hashtext`)入 key,不明文落限流键。
- **诚实记录**:emergency 桶是「每操作一个共享桶」,unresolved 客户端**彼此仍互相消耗**(无 IP 无法相互隔离);它只保证**不波及 resolved-IP 用户**,不保证 unresolved 之间隔离(#60 同此)。

## 3. verify-code:核心改语义(#66 必修)+ 前置门禁(纵深)

> **关键**:#66 的根因是 `verifyLoginCode` 的**全局 per-code 失败锁**——攻击者用 ≤5 次错误码(或跨 5 个 IP 各 1 次)即把 `attempt_count` 打到 `MAX`,使**正确码也被拒**。这**无法靠路由外叠限流解决**(攻击在限流阈值内即可达成)。**必须改核心语义。**

### 3.1 核心:正确码始终优先校验(`src/modules/auth/login-code.ts`)
重排 `verifyLoginCode`(事务 + 对最新有效 code `FOR UPDATE`):
1. 取最新「未用、未过期」code 行(无 → `400 codeExpired`);
2. **先比对** `safeEqual(hmac(submitted), code_hash)`:
   - **正确** → `usedAt=now()` 成功登录,**完全不看 `attempt_count`**(即便已达 MAX);
   - **错误** → `attempt_count+1`;若 `attempt_count >= MAX_ATTEMPTS` → `429 codeAttemptsExceeded`(**仅拒后续错误尝试**),否则 `400 codeIncorrect`。
- 不变量:**第三方提交错误码永远不能让正确码失效**;`attempt_count` 只用于对**错误**尝试返回 429,**绝不**作废/阻断正确码、也**不**作为总猜测次数上限(见 §3.3)。
- (可选)正确登录后可作废该 email 其它在途 code;**不要**因失败计数作废 code。

### 3.3 暴力枚举兜底:提高验证码熵(替代被移除的全局上限,非锁死)

> ⚠️ 因 §3.1 移除了「全局 per-code 失败上限」(它原是总猜测次数的边界、但也是 #66 的锁死原语),**总猜测次数的边界只剩 per-IP + (email+IP) 限流**。当前 code 为 **6 位数字(10^6)**;handoff 已把**分布式多 IP**纳入威胁模型——攻击者用大量 IP 在 10min TTL 内可凑出可观猜测量,6 位空间对僵尸网络在线枚举**不够安全**。

- **必须提高验证码熵**作为**非锁死**的暴力兜底:把登录码从 6 位数字提到**更高熵**(如 **≥8 位 Crockford base32(≈40bit)** 或 **≥9–10 位数字**;邮件内可复制,UX 可接受)。
- **熵预算判据**:`(per-IP × (email+IP) 限流在 TTL 内对单 email 的最大猜测量) × 合理 IP 规模 / 码空间` 必须**远小于 1**(留足安全裕度,如 ≤2^-20)。以 email+IP `10/10min` + TTL `10min` 计:K 个 IP ≈ `10K` 次/码;码空间须使 `10K / 空间` 可忽略(40bit ≈ 10^12 → 即便 K=10^6 也 ~10^-5)。
- 这样既满足 §3.1「正确码不可被作废」(无全局锁),又使**分布式在线枚举不可行**,无需任何锁死式上限。
- (`MAX_ATTEMPTS` 仅保留为对**错误**尝试的 429 速率信号,不再承担总量边界。)

### 3.2 纵深:路由前置门禁(`verify-code/route.ts`)
```
const identity = resolveClientRateLimitIdentity(getClientIp(req));
assertContentLengthWithinLimit(...)                 // CL 预拒
apply(getVerifyCodeIpRateLimit(identity))           // IP 桶 / unresolved→emergency 桶(解析前)
const { email, code } = await readJsonWithLimit(...)
if (identity.kind === "ip")                          // ★ 仅 resolved 才加第二层
  apply(getVerifyCodeEmailIpRateLimit(identity, hashEmail(email)))
await verifyLoginCode(email, code)
```
- **关键:unresolved 时只执行一次操作级 emergency 门禁,不再执行 email+IP 第二层**——否则两层都落到同一个 `verify-unresolved` 桶、**每请求计两次、有效阈值减半、unresolved 间更易互锁**。无 IP 时 email+IP 维度本就不成立,跳过更合语义。
- resolved:IP + (email+IP) 两层;限攻击者在线猜测**速率/体量**(配合 §3.1「正确码不可被作废」)。unresolved 命中 → 生产告警。
- **不加纯 email 阻断门禁**。

## 4. request-code:移除纯 email 阻断,IP/(email+IP) 为门禁 + 非阻断防轰炸

> 红线:**任何纯 email 的【阻断】键(返回 429)都是定向锁死杠杆**。删除之,防轰炸改用不阻断登录的发信抑制。

- **阻断门禁(429)只用**:per-IP `getRequestCodeIpRateLimit(identity)`(unresolved→`request-code-unresolved` emergency 桶)+ (email+IP) `getRequestCodeEmailIpRateLimit(identity, emailHash)`。`code-ip` 改走 #60 identity(不再「仅 ip 存在时」裸跳过)。
- **顺序 + 避免 emergency 桶双计**(同 §3.2):`apply(IP 门禁)` → 解析 email → `if (identity.kind==="ip") apply(email+IP 门禁)`。**unresolved 时只执行一次操作级 emergency 门禁,不再执行 email+IP**——否则两层都落 `request-code-unresolved`、每请求计两次、有效阈值减半。
- **删除** `code-hour:${email}`(纯 email 小时硬上限)与「会 429 的 `code-cooldown:${email}`」——它们让受害者**换 IP 也被锁**。
- **防邮件轰炸 = 非阻断发信抑制**:每 email 维护「**最近一次真正发信/排队投递**的时间戳」;若距该时间 < `SEND_DEDUPE_WINDOW`(默认 60s)→ **不发新邮件,但仍 `200`**(复用现有未过期 code 或静默跳过),**绝不 429**。→ 单地址邮件量 ≤1/窗口,受害者端点**永不被纯 email 硬锁**。
- **关键(防窗口无限延长)**:**只有真正发信/排队那一刻才更新该时间戳;被抑制的请求只返回 200、绝不更新时间戳**。否则攻击者每 59s 请求一次即可不断把窗口往前推、使真实邮件**永远发不出**。如此每个窗口至少放行一封真实邮件。
- **如实记录残余**:分布式攻击者跨多 IP 触发仍可造成**邮件投递噪声**、或在抑制窗口内压住某次合法发信(受害者过窗重试即得);这是**有界的投递降级,不是认证硬锁**(正确码不可被作废 §3.1、端点不纯 email-429)。**文档不得宣称分布式投递锁死已根除。**

## 5. admin-login:去 `unknown`,用 identity

`src/app/api/auth/admin/login/route.ts`:`ip = getClientIp(req) ?? "unknown"` + 裸 `admin-login:${ip}` →
- `const identity = resolveClientRateLimitIdentity(getClientIp(req))` → `getAdminLoginRateLimit(identity)`;unresolved 走 `admin-login-unresolved` 专用高阈桶(**不锁全站管理员登录**)+ 生产 `warnUnresolvedClientRateLimitIdentity`。
- 顺序保持 S1a:CL 预拒 → IP 门禁(429)→ readJson → adminLogin。

## 6. 告警 + 多实例边界

- 三个路由 unresolved 命中时 `warnUnresolvedClientRateLimitIdentity`(已节流);确保生产配 `TRUSTED_PROXY_HEADER/HOPS` 才能解析 IP(沿用 #60 提示文案)。**emergency 桶仅与 resolved 桶分离,unresolved 间不隔离(§2,文档如实写)。**
- **多实例**:`@/lib/rate-limit` 是**单进程内存**,横向扩容失效。**本切片不实现共享存储**;但:
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
LOGIN_CODE_LENGTH / LOGIN_CODE_ALPHABET   # §3.3 验证码熵(默认提到 ≥8 char base32 或 ≥9–10 位数字;`generateLoginCode` 据此)
```
(无任何 `REQUEST_CODE_EMAIL_RATE_MAX` 纯 email 阻断键;可合并复用同一 window;合理默认 + 上下限;`.env.example` 同步;测试默认/越界拒绝。)

## 8. 测试（真实行为)

- **verify-code 核心不变量(#66,必测)**:攻击者(同 IP 或**跨多 IP 各错一次**)把 `attempt_count` 打到/超过 `MAX` 后,**受害者提交正确码仍成功登录**(正确码不被作废)。错误猜测达 MAX 后继续错误 → `429 codeAttemptsExceeded`(只挡错误)。
- **verify-code 纵深**:单 IP 高频提交 → 命中 `verify-ip`/`verify-email-ip` `429`(限速率/体量,非「在 5 次前」)。
- **request-code 无纯 email 硬锁**:攻击者跨任意 IP 触发后,**受害者(异 IP)仍能 `200` 请求**(端点无纯 email 429);单 IP 触发命中 IP/(email+IP) 429。
- **request-code 防轰炸非阻断**:同一 email 在抑制窗口内多次请求 → 仍 `200`、**不重复发信**(断言未多发邮件、未返回 429)。
- **防窗口无限延长**:每 59s 请求一次(< 窗口)→ **抑制不刷新时间戳**,跨过窗口后下一次仍发出真实邮件(断言:被抑制请求不更新时间戳;每窗口 ≥1 封真实邮件,攻击者无法靠高频轮询永久压制)。
- **验证码熵(§3.3)**:登录码达到目标熵(位数/字符集);以「per-IP×(email+IP)×TTL 的猜测预算 / 码空间」断言枚举成功概率 ≪ 1(防分布式爆破);正确码在任意失败计数下仍成功。
- **unresolved 不双计(§3.2/§4)**:单个 unresolved verify/request 请求**只让 emergency 桶 +1**(非 +2);达配置第 N 次才 `429`(而非约 N/2);verify 与 request-code 都覆盖。
- **unresolved**:IP 未解析并发 admin/verify/request → 落**该操作 emergency 桶**,**不波及 resolved-IP 客户端**;告警触发(节流)。(不断言 unresolved 间隔离——设计上不隔离。)
- env 越界拒绝;email 以 hash 入 key(不明文)。
- 回归:正常登录/发码/管理员登录、download/#60、proof 上传限流不受影响。

## 9. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm check:request-bodies
pnpm exec drizzle-kit generate   # 预期无 schema 变更
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

## 10. PR

base `main`,Draft 直到 CI 全绿,关联 S4/#66 issue,标题 `fix(auth): harden login rate limiting against targeted lockout`。描述列出:**verify-code 核心改语义(正确码不可被作废)** + IP/(email+IP) 纵深门禁、**request-code 删纯 email 阻断** + 非阻断发信抑制(+残余说明)、admin-login 去 unknown、identity 上移共享、emergency 桶(如实表述)、告警、多实例边界、env、测试。

## 11. 验收 checklist

- [ ] **verify-code 核心**:`verifyLoginCode` 先比对正确性、**正确码始终成功**(不受 `attempt_count` 阻断);失败计数只挡后续错误;**第三方错误提交不能作废正确码**(跨多 IP 也不能)
- [ ] **暴力兜底(非锁死)**:提高验证码熵(§3.3)替代被移除的全局上限;熵预算使分布式枚举不可行
- [ ] verify-code 纵深:CL → IP 门禁(解析前)→ readJson → **(email+IP)门禁仅 resolved** → verifyLoginCode;**unresolved 不双计 emergency 桶**(request-code 同)
- [ ] request-code:**删除纯 email 阻断键**(`code-hour:email`、会 429 的 `code-cooldown:email`);阻断只 IP + (email+IP);防轰炸 = 非阻断发信抑制(超窗 200 不发信、不 429);`code-ip` 走 identity
- [ ] admin-login:去 `?? "unknown"`,用 `resolveClientRateLimitIdentity` + `admin-login-unresolved` emergency 桶
- [ ] emergency 桶 = 每操作独立、**与 resolved 桶分离**;文档**如实写 unresolved 间不隔离**;生产告警
- [ ] identity helpers 上移共享,download 行为不变;email 入 key 前 hash;env 越界拒绝;多实例内存限流文档化
- [ ] 真实测试:**#66 跨多 IP 仍不能锁死受害者正确码**;request-code 异 IP 不被纯 email 锁;防轰炸不重复发信;unresolved 不波及 resolved;回归绿

## 已锁定决策（owner 确认 2026-06-26）

1. **多实例共享限流存储(Redis/PG)= 不纳入 v1.0**:本切片**仅文档 + readiness 告警**(单创作者自托管多为单实例,内存限流够用);策略模块集中 key/阈作为未来接共享存储的接缝,横向扩容时再实现。
2. **默认阈值采用以下值**(均经 env 可调、越界拒绝):
   - verify-code:IP `30/10min`、(email+IP) `10/10min`,unresolved emergency 高阈;**核心:正确码始终可用(§3.1)**;
   - request-code:IP `20/hr`、(email+IP) `5/hr`、**发信抑制窗口 `60s`(非阻断,200 不发信)**;**无纯 email 阻断键**;
   - admin-login:`10/10min`,unresolved emergency 高阈。

> **修订说明(回应评审)**:#66 改为**核心语义修复**(正确码优先、不可被失败计数作废),限流退为纵深;**因移除全局上限,新增非锁死暴力兜底 = 提高验证码熵(§3.3)**;request-code **删除纯 email 阻断**,防轰炸用非阻断发信抑制(抑制不刷新时间戳)+ 如实记录分布式投递残余;emergency 桶**如实表述**为「每操作共享、与 resolved 分离、unresolved 间不隔离」,且 **unresolved 只走一层、不双计**。
