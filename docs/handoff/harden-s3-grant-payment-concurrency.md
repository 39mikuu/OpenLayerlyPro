# 交接：S3 付款/会员授予并发锁

> 自包含实现说明。前置依赖:当前 `main`。落地决策见 [ADR 0010](../adr/0010-grant-payment-concurrency.md)。
> **属 v1.0 安全硬化 P1(epic #64),须先于订阅 #61 实现**(让 `grantMembershipForPeriod` 建在已串行的 grant 基础上)。开工前建 issue;Draft 直到真实 PG 集成 + CI 全绿。

## 0. 红线
1. **所有会员授予按 `userId` advisory 锁串行**,锁在**读当前会员之前**取;人工/自动/管理员/gift/(未来订阅)复用同一把。
2. 人工 pending **部分唯一**兜底;**不**在同事务 catch 唯一冲突(用 `ON CONFLICT DO NOTHING RETURNING`)。
3. 不改按笔账本 / #49 反转语义;不破坏现有回归。

## 1. 现状
- `src/modules/membership/index.ts` `grantMembership`:读 `getActiveMembership` → 计算 `startsAt`(同/低 tier active → `current.endsAt`,否则 now)→ INSERT。**无锁**。
- `src/modules/payment/index.ts` `createPaymentRequest`(~line 119):SELECT `pending_review` → 若有抛 `pendingPaymentExists` → INSERT。**check-then-insert,无锁/无唯一**。
- `confirmAutoPayment`(~line 403):有 `pg_advisory_xact_lock(hashtext('stripe:'||userId||':'||tierId))`——**过窄,本切片改成统一锁**。
- schema `paymentRequests`:仅 `payment_requests_user_created_idx`(普通)。

## 2. 实现

### 2.1 统一授予锁(membership 模块)
```ts
// 在 grant 所在事务内、读当前会员之前获取；同事务内重复获取安全
export async function acquireUserGrantLock(tx: DbClient, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`membership-grant:${userId}`}))`);
}
```
- `grantMembership` / `grantMembershipForPeriod`(订阅切片)**入口先调 `acquireUserGrantLock(tx, userId)`** 再 `getActiveMembership` → 计算 → INSERT。
- 若 grant 被更外层事务调用(如付款审批),外层在进入 grant 前已持锁也无妨(advisory xact lock 同事务可重入获取)。
- **审计所有 `grantMembership` 调用点**(payment approve、admin manual、auto confirm、gift)确保都经过取锁的入口,无旁路。

### 2.2 替换窄锁
- `confirmAutoPayment` 把 `stripe:userId:tierId` 锁换成 `membership-grant:userId`(按 user 串行,覆盖跨 tier 与跨流程)。下单创建订阅/checkout 的并发去重(ADR 0009 的 `(user,tier,provider)` 部分唯一)各自独立,不与本锁冲突。

### 2.3 人工 pending 部分唯一
- 迁移加 `UNIQUE(user_id, tier_id) WHERE status IN ('pending_review','pending_payment')`(drizzle `uniqueIndex(...).where(...)`)。
- `createPaymentRequest`:仍可先查(快速失败),但**插入用 `INSERT ... ON CONFLICT DO NOTHING RETURNING`**;无返回 = 已有未决 → 抛 `pendingPaymentExists`。**不要** try/catch 唯一冲突(同事务会 abort)。
- **迁移前置**:若库里已存在同 (user,tier) 多条未决,迁移前需先合并/清理(脚本或手动),否则唯一索引创建失败——在迁移说明里写清。

## 3. 测试(真实 PostgreSQL 并发)
- 两并发创建同 user/tier 付款请求 → 仅一条 pending。
- 两并发 grant 同 user/tier → 顺延正确、**无重叠**、无重复(断言两行 `startsAt`/`endsAt` 首尾相接而非都基于旧 `endsAt`)。
- 高 tier active + 低 tier grant 并发 → 调度正确。
- 双 webhook / 双管理员审批 / 自动+人工 并发 → 不重复、不重叠。
- 部分唯一迁移前存在重复未决 → 迁移前置处理。

## 4. 提交前验证
```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm exec drizzle-kit generate   # 应有迁移（部分唯一索引）
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

## 5. PR
base `main`,Draft 直到真实 PG 集成 + CI 全绿,关联 issue,标题 `fix(payment): serialize membership grants and dedupe pending requests`。

## 6. 验收 checklist
- [ ] `acquireUserGrantLock` 统一锁;所有 grant 路径经其入口(审计无旁路)
- [ ] `confirmAutoPayment` 窄锁换成 `membership-grant:userId`
- [ ] 人工 pending 部分唯一 + `ON CONFLICT DO NOTHING RETURNING`(不 catch 冲突)
- [ ] 迁移前置检查重复未决
- [ ] 真实 PG 并发测试:无重复 pending、无重叠会员期
- [ ] 现有人工/一次性/#49 回归全绿
