# ADR 0010：付款与会员授予的并发不变量（userId 串行 + pending 唯一）

- **Status**：Accepted ✅（2026-06-21）
- **相关 issue**：v1.0 安全硬化 / S3（epic #64）
- **依赖**：[ADR 0001](0001-membership-lifecycle-model.md)（会员生命周期：按笔时间窗）、[ADR 0005](0005-auto-payments.md)（自动收付款）、[ADR 0009](0009-recurring-subscriptions.md)（周期性会员;其 `grantMembershipForPeriod` 必须建在本 ADR 的串行基础上）

## Context

会员授予是「**先读当前有效会员 → 计算下一期 `startsAt` → INSERT 新行**」(ADR 0001 的按笔时间窗)。这是典型的 **read-modify-write**,当前**没有并发保护**:

- `grantMembership`（`src/modules/membership/index.ts`）读 `getActiveMembership` 再 INSERT,**无 advisory lock / 无行锁**。
- 人工付款创建（`createPaymentRequest`,`payment/index.ts`）「同等级 pending 去重」是 **check-then-insert**(SELECT pending_review → INSERT),**无事务锁、无部分唯一约束**;schema 只有普通 `payment_requests_user_created_idx`。
- 仅 Stripe **自动**路径有一把 `pg_advisory_xact_lock(hashtext('stripe:'||userId||':'||tierId))`——**key 过窄**:只串行「同 user 同 tier 的 stripe 自动创建」,**不**串行人工审批、管理员手工开通、跨 tier、以及 `grantMembership` 本身。

**可观察的并发缺陷**:两笔付款 / 双击审批 / 两个管理员同时操作 / 自动+人工并发时——

- 出现**两条重复 `pending_review`**(去重被 TOCTOU 绕过);
- 两次 grant 都读到**同一个旧 `endsAt`** 作基准 → 生成**两段相互重叠**的会员期 → 用户付两次钱却只得到约一段时长(顺延丢失)。

ADR 0009 的订阅又**新增**了 `grantMembershipForPeriod`,若不先建立统一串行,会再添一条无保护的 grant 路径。

## Decision

### 1. 单一串行点：所有 grant 按 `userId` advisory 锁串行

- 引入统一锁键 **`membership-grant:<userId>`**,在**读取当前会员之前**、在 grant 所在事务内获取。key 用 **64 位 `hashtextextended(..., 0)`**(而非 32 位 `hashtext`),降低不同用户哈希碰撞导致的无关串行。
- **所有授予路径复用同一把锁**:人工审批、Stripe 自动确认、管理员手工开通、gift、以及 ADR 0009 的 `grantMembershipForPeriod`。
- **严格事务契约(关键)**:`pg_advisory_xact_lock` 只在当前事务期间持有。因此 `lock → read → calculate → INSERT → audit` **必须同一显式事务**:
  - 锁 helper **只接受事务 client(`TxClient`)**,**禁止**传 root `getDb()`(否则锁随隐式事务立即释放,read→insert 失去保护——「看似加锁实则提前释放」)。
  - 核心实现为仅事务的内部函数;公开入口有外部事务则复用、否则新开事务。
  - 同事务内重复获取安全(可被外层先取)。
- **替换**现有过窄的 `stripe:user:tier` 锁为本 `membership-grant:userId` 锁(按 user 串行,覆盖跨 tier 与跨流程),避免「窄锁串行不到人工/管理员」。

> 选 advisory xact lock 而非行锁:grant 是 INSERT 新行(无既有行可 `FOR UPDATE`);按 userId 串行即可保证「读基准→插新行」原子,且事务结束自动释放。

### 2. 人工 pending 唯一:部分唯一索引兜底

- 加**部分唯一索引**:每 `(user_id, tier_id)` 至多一个**未决**付款请求——`UNIQUE(user_id, tier_id) WHERE status IN ('pending_review','pending_payment')`。
- check-then-insert 的 TOCTOU 即便在锁外也由约束兜底(双保险);命中冲突按 `pendingPaymentExists` 处理(用 `ON CONFLICT DO NOTHING RETURNING` 判定,**勿**在同事务 catch 唯一冲突)。
- 自动流的并发创建同样受益(同一未决唯一)。
- **迁移 remediation(自托管升级可执行)**:迁移先跑确定性检测 SQL;有重复未决 → **明确失败并打印 user/tier/count**(不静默、不自动改财务);提供独立 remediation 脚本由管理员择一保留、其余 `cancelled`/`rejected`(带审计);修复后重跑迁移;升级文档写明。

### 3. 不改按笔账本与反转语义

- ADR 0001 的按笔模型、#49 的按行反转**不变**;本 ADR 只加「串行 + 唯一」保护,不动 grant 的业务语义。

## Alternatives

- **只加部分唯一、不加 advisory 锁**:否决——唯一能挡重复 pending,但**挡不住会员期重叠**(重叠源于两次 grant 读同一基准,与 pending 无关)。
- **行锁 `FOR UPDATE`**:否决——grant 是插新行,无目标行可锁;且需锁住「用户维度」而非某行。
- **沿用 `stripe:user:tier` 窄锁**:否决——串行不到人工/管理员/跨 tier/`grantMembership`。
- **应用层互斥(单进程内存锁)**:否决——多实例失效(与限流单进程同病);advisory lock 在 PG 层,天然跨实例。

## Consequences

- ✅ 重复 pending、重叠会员期、双击/双管理员/自动+人工并发都被关闭;订阅 `grantMembershipForPeriod` 建在已串行基础上(故 S3 须先于订阅实现)。
- ✅ 复用 PG advisory lock,跨实例有效;无需外部组件。
- ⚠️ 串行按 userId:同一用户的并发 grant 变串行(可接受;单用户并发 grant 本就罕见且应串行)。
- ⚠️ 部分唯一索引需迁移;现有数据若已存在重复未决需先清理(迁移前置检查)。
- ⚠️ 所有 grant 调用方都必须经统一入口取锁——**审计现有每一处 `grantMembership` 调用**确保无旁路。

## 必须覆盖的测试（真实 PostgreSQL 并发）

- 两个**同时**创建同 user 同 tier 付款请求 → 仅一条 pending(锁 + 唯一)。
- 两个**同时** grant 同 user 同 tier → 顺延正确、**无重叠**、无重复。
- 高 tier active + 低 tier grant 并发 → 调度正确。
- 双 webhook / 双管理员审批 / 自动+人工 并发组合 → 不重复开通、不重叠。
- **锁在 read 与 insert 期间持续持有**:并发第二个 grant 阻塞至第一个提交(或 `pg_locks` 断言跨 read→insert);传 root client 的误用被类型/结构挡住。
- 部分唯一迁移前存在重复未决 → 迁移**明确失败 + 打印** + remediation 脚本 + 重跑通过。
