# 交接：S4 认证限流硬化（含 #66 verify-code 定向锁死)

> 自包含实现说明。前置依赖:当前 `main`(已含 #60 `resolveClientRateLimitIdentity`/`warnUnresolvedClientRateLimitIdentity`、`@/lib/rate-limit`、S1a/#70 的 proof pre-auth 桶)。属 v1.0 安全硬化 P2(epic #64,S4),**含已验证的 #66**。**无需 ADR**。
>
> 开工前建 issue;PR base `main`,Draft 直到真实 PG 集成 + 完整 CI 全绿。**复用 #60 的 resolved/unresolved 身份 + 专用 emergency 桶范式,勿落全局 `unknown` 桶。**

## 0. 红线

1. **限流本身不得成为锁死杠杆**:**不做纯按 email 的硬锁**(否则知道邮箱即可锁死受害者);按 **IP + (email+IP)** 门禁,per-code 暴力上限仅作兜底。
2. **不落全局 `unknown`/单一 unresolved 桶**:IP 未解析时用**专用高阈 emergency 桶**(#60 范式),否则少量未解析请求即锁死全站(如管理员登录)。
3. **业务/敏感操作前**就限流(CL 预拒 → IP 门禁 → 解析 → email+IP 门禁 → 核心)。
4. 生产环境 IP 未解析要**告警**;**单进程内存限流**对多实例无效,须文档化 + readiness 提示(共享存储实现见 §6 边界)。

## 1. 现状（必读,确认漏洞)

- **verify-code 定向锁死(#66,已验证)**:
  - `src/app/api/auth/verify-code/route.ts`:**无任何限流**(仅 S1a 的 CL 预拒)。
  - `src/modules/auth/login-code.ts` `verifyLoginCode`:对**最新有效 code** 每次尝试 `attempt_count+1`,`>= MAX_ATTEMPTS(5)` 后即使**正确码**也 `429 codeAttemptsExceeded`。→ 知道邮箱的攻击者连发 5 错码即作废受害者有效码;无路由限流 → 可无限重复。
  - `requestLoginCode`:per-email `code-hour:${email}` **硬上限 5/hr**(锁死杠杆:攻击者触发 5 封即锁受害者 1 小时 + 骚扰邮件);`code-cooldown:${email}` 60s;`code-ip:${ip}` 20/hr(**仅 ip 存在时**)。
- **全局 `unknown` 桶**:`src/app/api/auth/admin/login/route.ts`:`ip = getClientIp(req) ?? "unknown"` → `rateLimit('admin-login:'+ip, 10, 10min)`。IP 未解析时所有客户端共享 `admin-login:unknown` → 少量请求即锁死**全站管理员登录**。(proof 上传 S1a 已用 pre-auth IP/unresolved 分桶,**不在本切片**;download 已 #60 修。)
- **#60 资源**(`src/modules/download/rate-limit-policy.ts`):`ClientRateLimitIdentity`(`ip`|`unresolved`)、`resolveClientRateLimitIdentity(ip)`、`getFilePreAuthRateLimit`(unresolved 走专用桶+专用阈)、`warnUnresolvedClientRateLimitIdentity`(节流告警)。**复用/上移这些**。

## 2. 抽共享身份 + 新增 auth 限流策略

- 把 `ClientRateLimitIdentity`/`resolveClientRateLimitIdentity`/`warnUnresolvedClientRateLimitIdentity` 上移到中性模块(如 `src/lib/rate-limit-policy.ts` 或 `src/modules/security/rate-limit-policy.ts`),download 与 auth 共用(download 现引用改为 re-export 或直接引新址,**不破坏其行为/测试**)。
- 新增 auth 策略(每个返回 `{key,max,windowMs}`,按 identity 分 per-IP / 专用 unresolved emergency 桶):
  - `getAdminLoginRateLimit(identity)`:`admin-login-ip:${ip}`(默认 10/10min)/ `admin-login-unresolved`(专用高阈,如 30/10min)。
  - `getVerifyCodeIpRateLimit(identity)`:`verify-ip:${ip}`(如 30/10min)/ `verify-unresolved`(专用高阈)。
  - `getVerifyCodeEmailIpRateLimit(identity, emailHash)`:`verify-email-ip:${emailHash}:${ip}`(如 10/10min);unresolved 时退化为 `verify-email-unresolved:${emailHash}`(仍按 email 分,但**软上限**、不硬锁)。
  - `getRequestCodeIpRateLimit(identity)`、`getRequestCodeEmailIpRateLimit(identity, emailHash)`(见 §4)。
  - email 一律 **hash**(如 `hmacSha256`/`hashtext`)入 key,不明文落限流键。

## 3. verify-code:加 IP + (email+IP) 前置门禁（#66 核心)

`src/app/api/auth/verify-code/route.ts`,顺序:
1. CL 预拒(现状)。
2. **IP 门禁(解析前)**:`getVerifyCodeIpRateLimit(identity)` → 超 `429`(用 `resolveClientRateLimitIdentity(getClientIp)`;unresolved 专用桶 + 生产告警)。
3. `readJsonWithLimit` 取 `{email,code}`。
4. **(email+IP) 门禁**:`getVerifyCodeEmailIpRateLimit(identity, hash(email))` → 超 `429`。
5. `verifyLoginCode(email,code)`(**保留** per-code `MAX_ATTEMPTS` 作暴力兜底)。
- **不加纯 email 硬门禁**:否则攻击者从任意 IP 刷受害者 email 即锁死。靠 IP / email+IP 限攻击者速率;per-code 上限挡暴力枚举。
- 效果:单 IP 无法廉价打满受害者 code 的 5 次;受害者重新 request 新码即恢复(配合 §4 软化)。

## 4. request-code:软化 per-email 硬锁,改 IP 为主

`requestLoginCode`(或路由层)调整:
- **保留** `code-cooldown:${emailHash}` 60s(防刷新,低危:受害者等 60s)。
- **per-email 纯硬上限 5/hr → 软化**:改为
  - 主门禁 **per-IP** `getRequestCodeIpRateLimit(identity)`(如 20/hr,unresolved 专用桶);
  - **(email+IP)** `getRequestCodeEmailIpRateLimit(identity, emailHash)`(如 5/hr,限单 IP 对单 email 的发信);
  - per-email 仅留**宽松的发信防轰炸上限**(如 `EMAIL` 维度 15/hr,纯保护收件箱,不作为登录阻断的主杠杆)。
- 关键:**攻击者从单 IP 触发的发信受 IP/email+IP 限**;受害者(不同 IP)不因攻击者耗尽 per-email 而被锁出登录。`code-ip` 改用 #60 identity(不再「仅 ip 存在时」裸跳过)。

## 5. admin-login:去 `unknown`,用 identity

`src/app/api/auth/admin/login/route.ts`:`ip = getClientIp(req) ?? "unknown"` + 裸 `admin-login:${ip}` →
- `const identity = resolveClientRateLimitIdentity(getClientIp(req))` → `getAdminLoginRateLimit(identity)`;unresolved 走 `admin-login-unresolved` 专用高阈桶(**不锁全站管理员登录**)+ 生产 `warnUnresolvedClientRateLimitIdentity`。
- 顺序保持 S1a:CL 预拒 → IP 门禁(429)→ readJson → adminLogin。

## 6. 告警 + 多实例边界

- 三个路由 unresolved 命中时 `warnUnresolvedClientRateLimitIdentity`(已节流);确保生产配 `TRUSTED_PROXY_HEADER/HOPS` 才能解析 IP(沿用 #60 提示文案)。
- **多实例**:`@/lib/rate-limit` 是**单进程内存**,横向扩容失效。**本切片不实现共享存储**;但:
  - 在 `/api/ready`(或启动日志)对「多实例 + 内存限流」给出**明确警告/说明**;
  - 策略模块已集中 key/阈,作为未来接 Redis/PG 限流的**接缝**;
  - 文档(部署/升级)写明:多实例须接共享限流存储,否则各实例独立计数、限流被绕过。
  - (是否在 v1.0 实现共享存储 = owner 决策,见末节;默认仅文档+告警。)

## 7. env（有界,越界拒绝,沿用既有写法)

```text
ADMIN_LOGIN_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
VERIFY_CODE_IP_RATE_MAX / VERIFY_CODE_EMAIL_IP_RATE_MAX / _WINDOW_MS / _UNRESOLVED_MAX
REQUEST_CODE_IP_RATE_MAX / REQUEST_CODE_EMAIL_IP_RATE_MAX / REQUEST_CODE_EMAIL_RATE_MAX / _WINDOW_MS
```
(可合并复用同一 window;给合理默认 + 上下限;`.env.example` 同步;测试默认/越界拒绝。)

## 8. 测试（真实行为)

- **verify-code(#66)**:单 IP 连发 N 次错码 → 命中 `verify-ip` / `verify-email-ip` `429`(在 per-code 5 次之前就被限);**受害者**(异 IP)用正确码 → 仍可登录(攻击者未能从异 IP 锁死);per-code MAX_ATTEMPTS 仍挡同源暴力。
- **request-code**:攻击者单 IP 触发发信 → 命中 IP/email+IP 限;受害者异 IP 仍能请求新码(不被 per-email 硬锁);cooldown 生效;`code-ip` 在 ip 解析/未解析两路径都走 identity。
- **unknown→unresolved**:IP 未解析的并发 admin-login/verify/request → 落**专用 emergency 桶**,**不**锁死有正常 IP 的客户端;生产告警触发(节流)。
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

base `main`,Draft 直到 CI 全绿,关联 S4/#66 issue,标题 `fix(auth): harden login rate limiting against targeted lockout`。描述列出:verify-code IP+email+IP 门禁、request-code 软化、admin-login 去 unknown、identity 上移共享、emergency 桶、告警、多实例边界、env、测试。

## 11. 验收 checklist

- [ ] verify-code:CL → IP 门禁(解析前)→ readJson → (email+IP)门禁 → verifyLoginCode;**无纯 email 硬锁**;per-code MAX_ATTEMPTS 保留
- [ ] request-code:per-email 硬锁软化为 IP 主 + (email+IP) + 宽松 email 防轰炸 + cooldown;`code-ip` 走 identity
- [ ] admin-login:去 `?? "unknown"`,用 `resolveClientRateLimitIdentity` + `admin-login-unresolved` 专用桶
- [ ] 三路由 unresolved 走**专用 emergency 桶**(非全局单桶)+ 生产 `warnUnresolvedClientRateLimitIdentity`
- [ ] identity helpers 上移共享,download 行为不变;email 入 key 前 hash
- [ ] env 有界越界拒绝;**多实例内存限流**经 readiness/文档明确(共享存储为后续/owner 决策)
- [ ] 真实测试:#66 异 IP 不可锁死受害者 + 同源暴力仍挡;unknown→emergency 不锁全站;回归绿

## 需 owner 确认

1. **多实例共享限流存储**(Redis/PG)是否纳入 v1.0?默认**仅文档 + readiness 告警**(单创作者自托管多为单实例);如需横向扩容再实现。
2. 各默认阈值(verify IP 30/10min、email+IP 10/10min;request IP 20/hr、email+IP 5/hr、email 15/hr;admin 10/10min)是否合适。
