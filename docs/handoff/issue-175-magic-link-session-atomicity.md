# Issue #175：Magic Link 消费与 Session 创建原子化规格

- **状态**：Proposed
- **Issue**：[#175](https://github.com/39mikuu/OpenLayerlyPro/issues/175)
- **设计基线**：`origin/main` `8011a99ba088b8b1eca77756a8c87308d0b99ffa`
- **变更类型**：Auth / session 可靠性修复

## 1. 背景与优化原因

`docs/release-v1.2-plan.md` WP1 要求：只有满足 `hash + keyId + 未消费 + 未过期`
条件的第一笔事务，才能同时消费 Magic Link 并创建 session。当前实现只原子化了
`magic_link_tokens.consumed_at` 的条件更新，后续用户解析、`last_login_at` 更新和 session
写入分别发生在已提交的数据库操作中。

因此，只要 CAS 成功之后出现瞬时数据库错误，调用者就会同时得到两个坏结果：没有
session，原链接却已经永久变成 replay。该失败无法通过重试恢复，违反一次性登录凭证应有
的“成功全部提交、失败全部回滚”语义。

## 2. 权威来源与现状

### 2.1 权威来源

- `docs/release-v1.2-plan.md` §3 WP1：首个有效 CAS 事务创建 session。
- `AGENTS.md`：认证和并发状态必须明确事务边界、回滚、重试和并发行为，并使用真实
  PostgreSQL 验证。
- 当前代码与测试：
  - `src/modules/auth/magic-link.ts`
  - `src/modules/auth/session.ts`
  - `src/modules/user/index.ts`
  - `src/app/api/auth/magic-link/confirm/route.ts`
  - `src/modules/auth/magic-link.integration.test.ts`
  - `src/app/api/auth/magic-link/confirm/route.test.ts`

### 2.2 当前提交顺序

1. `consumeMagicLinkToken()` 用独立更新提交 `consumed_at = now()`。
2. `findOrCreateUserByEmail()` 用新的数据库调用解析或创建用户。
3. `touchLastLogin()` 用新的数据库调用更新用户。
4. 模块返回后，Route 再调用 `createSession()` 插入 session。
5. Route 最后设置 cookie。

第 2–4 步任一步失败，都无法撤销第 1 步。

## 3. 约束与不变量

实现必须同时满足：

1. Magic Link CAS、用户解析/创建、`last_login_at`/locale 更新和 session 插入属于同一
   PostgreSQL 事务。
2. 事务失败时，token、用户、last-login 和 session 均不得留下部分状态。
3. cookie 只能在事务成功提交后写入；数据库事务内不得调用 Next.js cookie API。
4. 并发确认最多产生一个已提交的消费结果和一个 session。先取得行锁的事务若回滚，等待
   它的健康事务允许继续成功。
5. token 过期、退役 key、伪造 token、redirect allowlist 和 replay 分类保持现状。
6. 原始 Magic Link token 与 session token 不进入日志或 `app_events`；数据库仍只持久化
   token/session 的 hash 或既有加密任务 payload。
7. `app_events` 保持当前“事务提交后、尽力记录、失败只写日志”的语义；本修复不把它升级
   为事务审计账本。
8. 不在本 Issue 内改变管理员邮箱的 Magic Link 策略。已关闭且未合并的 PR #169 所代表的
   管理员边界问题必须独立立项、独立审阅。
9. 事务内只执行数据库操作；不得引入 SMTP、外部网络或 cookie I/O。

## 4. 设计

### 4.1 可复用的事务感知 helper

保留所有现有调用点的行为，为以下 helper 增加可选 `DbClient`，默认仍使用 `getDb()`：

```ts
findUserByEmail(email, client = getDb())
findOrCreateUserByEmail(email, client = getDb())
touchLastLogin(userId, locale?, client = getDb())
createSession(userId, meta?, client = getDb())
```

`findOrCreateUserByEmail()` 内部的首次查询、冲突安全插入和冲突后复查必须始终使用同一个
传入 client，不能在事务路径中悄悄回退到全局连接。

`createSession()` 继续负责生成高熵原始 token、计算 hash、设置 30 天过期时间并插入
session；传入事务 client 时只插入行并返回 `{ token, expiresAt }`，不设置 cookie。

### 4.2 原子消费算法

`consumeMagicLinkToken()` 的成功输入扩展为 locale 与 session 元数据：

```ts
{
  locale?: Locale;
  ip?: string | null;
  userAgent?: string | null;
}
```

核心流程：

```text
解析并验证 token key/hash（无数据库写入）
└─ getDb().transaction(tx)
   ├─ 条件 UPDATE magic_link_tokens ... RETURNING
   ├─ 未命中：在同一 tx 查询并分类 invalid / replayed / expired
   └─ 命中：
      ├─ findOrCreateUserByEmail(email, tx)
      ├─ touchLastLogin(user.id, locale, tx)
      ├─ createSession(user.id, { ip, userAgent }, tx)
      └─ 返回 user、redirectPath 和 session 凭证
事务提交
├─ 成功：尽力记录 user_login / magic_link_consumed
└─ 拒绝：尽力记录 magic_link_rejected
```

成功返回类型在现有 `user`、`redirectPath` 基础上增加：

```ts
session: { token: string; expiresAt: Date }
```

原始 session token 只在内存中从 Auth 模块传到确认 Route。

### 4.3 Route 边界

确认 Route 将 client IP、user-agent 和 locale 一并传入 `consumeMagicLinkToken()`。成功时不再
独立调用 `createSession()`，只使用已提交事务返回的 session 凭证调用
`setSessionCookie()`，然后执行既有 tokenless 303 redirect。

若 cookie 写入失败，数据库 session 已存在但浏览器未收到 cookie。这与所有现有登录 Route
相同，不能通过数据库回滚解决；调用者可以重新发起登录。该场景不得错误地把已消费链接
重新开放，也不在本 Issue 内引入 session/cookie 两阶段协议。

### 4.4 失败与并发语义

- CAS 后、session 插入前的异常：整个事务回滚，链接仍为未消费。
- session 插入异常：整个事务回滚，不留下新用户或 last-login 更新。
- 两个健康并发确认：一个提交 consumed + session；另一个等待后读到 replayed。
- 第一个并发事务失败并回滚：第二个事务重新评估 UPDATE 条件后可以成功。
- `recordEvent()` 失败：保持当前 best-effort 行为，不撤销已提交的登录事务。

## 5. 文件范围

预计只修改：

- `src/modules/auth/magic-link.ts`
- `src/modules/auth/session.ts`
- `src/modules/user/index.ts`
- `src/app/api/auth/magic-link/confirm/route.ts`
- `src/modules/auth/magic-link.integration.test.ts`
- `src/app/api/auth/magic-link/confirm/route.test.ts`
- 必要时更新直接描述该原子性保证的 `CHANGELOG.md`

不新增 migration，不修改 token/session schema，不更改其他登录方式。

## 6. 测试与验收

### 6.1 真实 PostgreSQL 回滚测试

在集成测试中临时安装只作用于 `sessions` INSERT 的失败 trigger，至少覆盖两种有效确认：

1. **新邮箱**：调用失败后，`magic_link_tokens.consumed_at` 仍为 null，且没有留下 user 或
   session；移除 trigger 后，同一 token 可成功确认一次，最终恰好一个 user、一个 session、
   一个已消费 token。
2. **既有 member**：预置固定的旧 `last_login_at` 和非请求 locale；调用失败后，两者必须
   保持原值且 token 未消费；健康重试后，`last_login_at` 前进且 locale 更新为请求值。

第二组断言是 load-bearing：它能发现 `touchLastLogin()` 在事务路径中误用全局 `getDb()`
而更新 0 行或提前提交的问题。trigger/function 必须在 `finally` 中删除，避免污染其他测试。

### 6.2 并发测试

保留并强化现有“双健康确认”真实 PostgreSQL 测试：除一个 consumed、一个 replayed 外，还
断言 sessions 恰好一行，且归属于唯一创建/解析出的用户。

另加一个确定性的“回滚后等待者接管”用例，不依赖固定 sleep：

1. 用 test-only PostgreSQL sequence + session INSERT trigger + advisory-lock barrier，让事务 A 在
   已完成 Magic Link CAS、尚未插入 session 时阻塞；sequence 保证该 trigger 只让第一次插入
   失败，第二次插入正常执行。
2. A 持有 token 行锁期间启动事务 B，并通过 PostgreSQL lock/activity 状态的有界轮询确认 B
   已进入等待，而不是靠时序猜测。
3. 释放 barrier，使 A 的 session INSERT 抛错并整体回滚。
4. 断言 B 随后成功 consumed；最终只有一个已消费 token、一个 user 和一个 session。

该测试防止实现退化为“先提交 CAS、失败后补偿清空 `consumed_at`”；这种补偿方案会让已等待
的 B 先观察到 replayed，无法满足事务回滚后的正常接管语义。

### 6.3 Route 测试

- Route 把 IP、user-agent、locale 传入消费函数。
- 成功时只设置消费结果携带的 session cookie，不再调用独立 session 创建。
- invalid / expired / replayed 不设置 cookie。
- tokenless redirect 与安全响应头保持不变。

### 6.4 必跑门禁

- focused Magic Link integration tests（真实 PostgreSQL）
- focused confirm Route tests
- `pnpm check:request-bodies`
- `pnpm check:auth-before-body`
- `pnpm format:check`
- `pnpm lint`
- `pnpm exec tsc --noEmit`
- `RUN_DB_INTEGRATION_TESTS=true pnpm test`
- `pnpm build`
- 完整 diff 的独立只读审阅；修复发现后再做一次新鲜复核

## 7. 非目标

- 管理员 Magic Link 策略或 PR #169 的重做
- token TTL、keyring、rotation、重发抑制或枚举防护变化
- OAuth、邮箱验证码或管理员密码登录重构
- `app_events` 事务化
- session/cookie 跨系统 exactly-once 协议
- 自动合并、标记 Ready 或关闭 Issue

## 8. 回滚与风险

本变更无 schema 变化。若出现回归，可回滚 helper 的可选 client 和消费事务改造；旧数据无需
转换。主要风险是 helper 在事务路径中误用全局 `getDb()`，因此测试和独立审阅必须逐一确认
所有嵌套查询都使用传入的 client。
