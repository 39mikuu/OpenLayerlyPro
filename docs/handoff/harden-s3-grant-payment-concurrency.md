# 交接：S3 付款/会员授予并发锁

> 自包含实现说明。前置依赖:当前 `main`。落地决策见 [ADR 0010](../adr/0010-grant-payment-concurrency.md)。
> **属 v1.0 安全硬化 P1(epic #64),须先于订阅 #61 实现**(让 `grantMembershipForPeriod` 建在已串行的 grant 基础上)。开工前建 issue;Draft 直到真实 PG 集成 + CI 全绿。

## 0. 红线
1. **所有会员授予按 `userId` advisory 锁串行**,锁在**读当前会员之前**取;人工/自动/管理员/gift/(未来订阅)复用同一把。
2. **叠加基准必须含 scheduled(未来)行**:`getActiveMembership` 过滤 `startsAt<=now` 看不到排期行——背靠背续费会重叠丢时长(与并发无关的既有缺陷)。基准 = 同/高 tier、非 revoked、`endsAt>now` 的 `max(endsAt)`(含未来行),无则 now。
3. pending **部分唯一**兜底;**所有进入 pending 的路径**都要冲突处理;**不**在同事务 catch 唯一冲突(用 `ON CONFLICT DO NOTHING RETURNING`)。
4. 不改按笔账本 / #49 反转语义;不破坏现有回归。

## 1. 现状
- `src/modules/membership/index.ts` `grantMembership`:读 `getActiveMembership` → 计算 `startsAt`(同/低 tier active → `current.endsAt`,否则 now)→ INSERT。**无锁**。
- `src/modules/payment/index.ts` `createPaymentRequest`(~line 119):SELECT `pending_review` → 若有抛 `pendingPaymentExists` → INSERT。**check-then-insert,无锁/无唯一**。
- `createAutoCheckout`(~line 405):有 `pg_advisory_xact_lock('stripe:'||userId||':'||tierId)`——是 **checkout 创建去重**锁(`creating:` claim),**保留不动**(§2.2)。`confirmAutoPayment`(~line 526)先取 `payment_requests` 行锁(`.for("update")`)再 grant,**无** advisory 锁。
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

**叠加基准含 scheduled 行(必须,否则锁也救不了重叠)**:`grantMembershipTx` 取锁后计算 `startsAt` 时,**不要**只用 `getActiveMembership`(它过滤 `startsAt<=now`,看不到排期行)。改用「最新权益到期」查询:
```sql
select max(ends_at) from memberships
 where user_id = $1 and status <> 'revoked' and ends_at > now()   -- 含 active+suspended+scheduled，仅排除 revoked
   and tier_id in (<同/高 level 的 tier id>)   -- 或 join membershipTiers 比 level
```
`startsAt = max(now, 上述 max(endsAt))`;无则 `now`。**用 `status <> 'revoked'`(与 ADR 红线一致),不要窄到 `status='active'`**——否则 admin 暂停(suspended)的当前/未来窗口会被忽略,新 grant 从 `now` 起又造成重叠/绕过被暂停窗口。这样背靠背续费**首尾相接、零重叠、不丢已付时长**。锁保证串行、基准查询保证串行后读到前一笔排期,二者缺一不可。

### 2.2 不要动 checkout 去重锁;grant 锁只在 grant 路径 + 固定锁序

> 更正:现有 `stripe:userId:tierId` advisory 锁在 **`createAutoCheckout`(~line 405,`creating:` claim)**,是 **checkout 创建去重**锁(防同 user/tier 重复 Stripe 会话)——**与 grant 串行是两码事**。`confirmAutoPayment`(~line 526)本身**没有** advisory 锁,它先取 `payment_requests` 行锁(`.for("update")`,~line 555)再 grant。

- **保留 `createAutoCheckout` 的 checkout 去重锁不动**(它是独立关注点;ADR 0009 订阅的下单并发用其自己的 `(user,tier,provider)` 部分唯一/claim,也独立)。**不要**把它"替换"成 grant 锁,**不要**把 grant 锁加进 checkout 创建路径。
- **user grant 锁只在 grant 路径获取**(`grantMembershipTx` 内),即 `approvePaymentRequest` / `confirmAutoPayment` / 管理员手工 / gift / 订阅 `grantMembershipForPeriod` 调到 grant 时。
- **固定锁序防死锁**:同时持有「`payment_requests` 行锁」与「user grant 锁」的路径必须用**统一顺序**。现状 `confirmAutoPayment`/`approvePaymentRequest` 都是**先行锁(FOR UPDATE)→ 再 grant(取 user 锁)**,即**canonical = 行锁 → user-grant 锁**。**任何路径都不得**反过来「先 user-grant 锁 → 再取 payment_requests 行锁」。`grantMembershipTx` 只取 user 锁 + 插 membership(不碰 payment_requests 行锁),天然不破坏此序。

### 2.3 人工 pending 部分唯一
- 迁移加 `UNIQUE(user_id, tier_id) WHERE status IN ('pending_review','pending_payment')`(drizzle `uniqueIndex(...).where(...)`)。
- **所有进入 pending 的写入路径必须共享同一把 per-user(或 user+tier)序列化锁**:`createPaymentRequest` / `createAutoCheckout`(INSERT)与 `resubmitPaymentProof`(UPDATE)**都**先取 `pg_advisory_xact_lock(hashtextextended('payment-pending:'||userId, 0))`(事务内),再做检查/写入。否则在 READ COMMITTED 下,resubmit 的 `NOT EXISTS` 可能在并发 INSERT 提交前求值 → 随后撞部分唯一索引;而 UPDATE **无 `ON CONFLICT`**,会冒出原始唯一违例而非 `pendingPaymentExists`。共享锁后,三条路径互斥,检查-写入无竞争。(此锁与 grant 锁是不同关注点,可用不同 key;也可统一用 `membership-grant:userId`,只要三条 pending 写入与 grant 都用它即不冲突。)
- **所有进入 pending 的写入路径都要冲突处理**(部分唯一跨 `pending_review`+`pending_payment`、跨人工/自动)。按操作类型分两种正确写法(**`ON CONFLICT` 仅 `INSERT` 支持,`UPDATE` 不支持**):
  - **INSERT 路径**(`createPaymentRequest` 插 `pending_review`、`createAutoCheckout` 插 `pending_payment`):`INSERT ... ON CONFLICT DO NOTHING RETURNING`;无返回 = 已有未决 → 抛 `pendingPaymentExists`。
  - **UPDATE 路径**(`resubmitPaymentProof`:rejected→`pending_review`):**不能**用 `ON CONFLICT`。改**条件更新**:
    ```sql
    update payment_requests set status='pending_review', ...
     where id = $reqId and status='rejected'
       and not exists (
         select 1 from payment_requests p
          where p.user_id=$uid and p.tier_id=$tid
            and p.status in ('pending_review','pending_payment') and p.id <> $reqId )
    returning id;
    ```
    无返回行 → 区分是「非 rejected」(沿用 `resubmitRejectedOnly`)还是「已有其它未决」→ 抛 `pendingPaymentExists`。部分唯一索引仍作并发兜底;为避免并发 resubmit 撞原始唯一违例,该转换在**事务内**进行并可经统一 per-user 序列化(与 grant 锁同 `membership-grant:userId` 或专用锁),使条件更新足以避免违例。**不**靠 catch 唯一冲突。
  - 语义 = **每 (user,tier) 跨流程至多一个未决**(故意:有人工未决时不能再开 auto checkout,反之亦然)。
  - auto 路径现有 `creating:` claim / stale 恢复**复用同一行**(UPDATE 同 id,不新插)须与唯一索引兼容——确认恢复路径不会因唯一索引报错。
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
- **背靠背续费(已有 active 同/高 tier,连续两次 grant,即便串行)→ 两期首尾相接、零重叠、不丢时长**(基准含 scheduled 行);作回归基线:基准只看 active 时应能复现重叠。
- **所有 pending 入口**(createPaymentRequest / createAutoCheckout / resubmitPaymentProof)在已有未决时返回 `pendingPaymentExists`,**不抛原始唯一违例**;auto `creating:`/stale 恢复与唯一索引兼容。
- 部分唯一迁移前存在重复未决 → 迁移**明确失败 + 打印 user/tier/count** + remediation 脚本 + 重跑通过。

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
- [ ] `createAutoCheckout` 的 checkout 去重锁**保留不动**;user grant 锁**只在 grant 路径**;固定锁序 **行锁→user-grant 锁**(无路径反序)
- [ ] **叠加基准含 scheduled 行**(max(endsAt) of 同/高 tier、非 revoked、endsAt>now,非仅 `getActiveMembership`)→ 背靠背续费零重叠
- [ ] 叠加基准 SQL 用 `status <> 'revoked'`(含 suspended/scheduled),非 `'active'`
- [ ] pending 部分唯一;**INSERT 入口**(createPaymentRequest/createAutoCheckout)用 `ON CONFLICT DO NOTHING RETURNING`,**UPDATE 入口**(resubmitPaymentProof)用条件更新 + `NOT EXISTS` 守卫(`ON CONFLICT` 不支持 UPDATE);均返回 `pendingPaymentExists`、**不 catch 唯一违例**;auto claim/恢复兼容唯一索引
- [ ] **所有 pending 写入路径共享同一 per-user 序列化锁**(防 UPDATE 的 NOT EXISTS 与并发 INSERT 竞争撞原始违例);加并发 create-vs-resubmit 测试
- [ ] **测试证明锁在 read 与 insert 期间持续持有**(并发被阻塞 / `pg_locks` 跨 read→insert)
- [ ] 迁移:确定性检测 SQL → 有重复则**明确失败打印 user/tier/count** + 独立 remediation 脚本(不自动删财务)+ 升级文档
- [ ] 真实 PG 并发测试:无重复 pending、无重叠会员期
- [ ] 现有人工/一次性/#49 回归全绿
