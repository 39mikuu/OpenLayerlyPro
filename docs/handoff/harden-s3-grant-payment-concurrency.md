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

### 2.1 统一授予锁(membership 模块)—— 严格事务契约

> ⚠️ **致命陷阱**:`pg_advisory_xact_lock` **只在当前 DB 事务期间持有**。现有 `grantMembership(input, dbc?)` 若传入的是 **root `getDb()` client(非事务)**,锁语句在其隐式事务结束时**立即释放**,随后的 `getActiveMembership → INSERT` **不再受锁保护**——「看起来加了锁、实际提前释放」。必须用类型 + 结构强制。

**类型层区分(必须)**:`DbClient = Db | Tx`(现状是联合)。新增**仅事务**别名并让锁 helper 只接受它:
```ts
// db/index.ts: 导出仅事务类型
export type TxClient = Parameters<Parameters<Db["transaction"]>[0]>[0];

// lock helper 只接受 TxClient（不可传 root getDb()）；编译期即挡住误用
export async function acquireUserGrantLock(tx: TxClient, userId: string): Promise<void> {
  // 64 位 key（hashtextextended，降哈希碰撞导致的无关串行）；seed 固定即可
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`membership-grant:${userId}`}, 0))`);
}
```

**结构契约(必须)**:`lock → read(getActiveMembership) → calculate → INSERT → audit` **全部在同一显式事务内**,无论调用方有没有事务:
- 把核心实现拆成**仅事务**的内部函数 `grantMembershipTx(input, tx: TxClient)`(第一步即 `acquireUserGrantLock(tx, userId)`)。
- 公开入口 `grantMembership(input, dbc?)`:**若 `dbc` 是事务**→ 直接 `grantMembershipTx(input, dbc)`;**若无 `dbc` / 是 root**→ `getDb().transaction(tx => grantMembershipTx(input, tx))` **新开事务**。**禁止**把 root `getDb()` 当事务直接执行 lock。
- 同理 `grantMembershipForPeriod`(订阅切片)走同一 `grantMembershipTx` 范式。
- 外层已有事务时,内层 `acquireUserGrantLock` 在同一事务重复获取安全(已持有)。
- **审计所有 `grantMembership` 调用点**(payment approve、admin manual、auto confirm、gift、订阅)确保都经取锁入口、且都在事务内,无旁路。
- **测试必须证明锁在 read 与 insert 期间仍持有**(例如:并发两 grant,断言第二个被阻塞直到第一个事务提交;或用 `pg_locks` 断言持锁跨越 read→insert)。

### 2.2 替换窄锁
- `confirmAutoPayment` 把 `stripe:userId:tierId` 锁换成**经 `acquireUserGrantLock(tx, userId)`**(同 helper、同 64 位 key、按 user 串行,覆盖跨 tier 与跨流程)。下单创建订阅/checkout 的并发去重(ADR 0009 的 `(user,tier,provider)` 部分唯一)各自独立,不与本锁冲突。

### 2.3 人工 pending 部分唯一
- 迁移加 `UNIQUE(user_id, tier_id) WHERE status IN ('pending_review','pending_payment')`(drizzle `uniqueIndex(...).where(...)`)。
- `createPaymentRequest`:仍可先查(快速失败),但**插入用 `INSERT ... ON CONFLICT DO NOTHING RETURNING`**;无返回 = 已有未决 → 抛 `pendingPaymentExists`。**不要** try/catch 唯一冲突(同事务会 abort)。
- **迁移前置 remediation(自托管升级必须可执行,不能只说"脚本或手动")**:
  1. 迁移内**先跑确定性检测**:`SELECT user_id, tier_id, count(*) FROM payment_requests WHERE status IN ('pending_review','pending_payment') GROUP BY 1,2 HAVING count(*) > 1`。
  2. 若有结果 → **迁移明确失败并打印** `user_id/tier_id/count`(不静默、不自动改财务数据)。
  3. 提供**独立 remediation 脚本**(如 `scripts/dedupe-pending-payments.*`):列出冲突,由**管理员选择保留哪一条**,其余置 `cancelled`/`rejected`(带审计),**绝不自动删除财务记录**。
  4. remediation 完成后**重新运行迁移**(检测通过 → 建唯一索引)。
  5. **升级文档**(`docs/deployment` / 升级说明)写明这套步骤。

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
- [ ] `acquireUserGrantLock` **只接受 `TxClient`**(类型层挡 root `getDb()`);用 `hashtextextended`(64 位 key)
- [ ] `lock→read→calc→insert→audit` **同一显式事务**:核心拆 `grantMembershipTx(tx)`,公开入口有 tx 用 tx、无 tx 新开事务;**禁止**对 root client 跑 lock
- [ ] 所有 grant 路径(人工/自动/管理员/gift/订阅)经取锁入口且在事务内(审计无旁路)
- [ ] `confirmAutoPayment` 窄锁换成经 `acquireUserGrantLock`
- [ ] 人工 pending 部分唯一 + `ON CONFLICT DO NOTHING RETURNING`(不 catch 冲突)
- [ ] **测试证明锁在 read 与 insert 期间持续持有**(并发被阻塞 / `pg_locks` 跨 read→insert)
- [ ] 迁移:确定性检测 SQL → 有重复则**明确失败打印 user/tier/count** + 独立 remediation 脚本(不自动删财务)+ 升级文档
- [ ] 真实 PG 并发测试:无重复 pending、无重叠会员期
- [ ] 现有人工/一次性/#49 回归全绿
