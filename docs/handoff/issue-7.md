# 交接：#7 事务性 outbox / 持久化任务

> 给执行 agent 的自包含实现说明。**前置依赖：#4 / #6 已合并**（复用 `audit_events`、`recordAudit`、事务化 service、`getDb().transaction`）。
>
> 落地决策见 [ADR 0003](../adr/0003-durable-task-and-outbox-boundary.md)（Accepted）。

## 0. 必读

- `docs/adr/0003-durable-task-and-outbox-boundary.md`（Accepted）— 通用 `tasks` 表、单实例、DB 轮询 + 租约
- GitHub issue #7
- 现有代码：
  - `src/modules/mail/index.ts`（`renderX` / `sendX`：loginCode / membershipActivated / paymentRejected / test）
  - `src/modules/payment/index.ts`（approve 第 ~329 行、reject 第 ~380 行：**事务后内联发信**，#7 要改）
  - `src/modules/config`（`getSmtpConfig()`）
  - `src/instrumentation.ts`（`register()`，Node runtime 启动钩子——派发器在此启动）

**范围**：把「业务事务提交后必须可靠送达的消息」改为**事务内入队 + 后台派发器投递**，并提供失败可见/可重试。首版**单实例、DB 轮询**（ADR 0003）。
**不含**：多实例 / HA（已 deferred）、把所有邮件都搬进 outbox（见 D1）、定时发布（#9，复用本表但不在本任务）。

## 1. 已锁定的设计决策（动工前若有异议先提）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **只有「付款 approve→会员开通」「付款 reject」两封邮件进 outbox**。**登录验证码邮件保持内联**（10 分钟 TTL，时效性强，轮询会增加延迟）；**管理员「发送测试邮件」保持内联**（同步动作，需即时返回成功/错误）。 | outbox 解决的是「状态已提交但通知可能丢」，登录码/测试邮件不属于这一类。 |
| D2 | **派发器 = 应用进程内单实例轮询**，在 `src/instrumentation.ts` 的 `register()`（`NEXT_RUNTIME==='nodejs'`）里启动；用模块级单例 + flag 防重复启动（dev HMR / 多次 register）。 | 与 ADR 0003「single-instance、跑在应用进程内定时器」一致；不引入外部组件。 |
| D3 | **payload 存「模板 + 参数」，不存渲染后 HTML**：`{ template: 'membership_activated' | 'payment_rejected', to, locale, params }`，派发时调现有 `renderX`/`sendX` 渲染发送。 | 模板变更不影响在途任务；payload 体积小。 |
| D4 | **SMTP 未配置时，email 任务记为 `succeeded` 并附 note（视为 no-op），不重试**。 | 避免无 SMTP 环境下任务永久失败堆积；与现有「未配置即跳过」语义一致。 |
| D5 | **本任务包含最小「管理员任务视图 + 手动重试」**（issue #7 明确要求 retry view）：列表 + 对 `failed`/`dead` 手动重排。**不做花哨 UI**。 | issue 验收项。 |
| D6 | **重试参数**：`max_attempts=5`，指数退避（如 1m/2m/4m/8m/16m），`lease` 时长 60s，轮询间隔 ~10s。可放常量便于调整。 | 合理默认；单实例足够。 |

## 2. Schema 变更 `src/db/schema/index.ts`

新增 `tasks` 表（字段同 ADR 0003）：

```ts
export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(), // 'email'（#9 起将有 'publish_post'）
    dedupeKey: text("dedupe_key"), // 可空；非空时唯一，用于幂等
    payloadJson: jsonb("payload_json").notNull(),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    status: text("status", {
      enum: ["pending", "processing", "succeeded", "failed", "dead"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("tasks_dedupe_key_unique").on(table.dedupeKey), // 部分唯一：null 多行允许（PG 默认）
    index("tasks_claim_idx").on(table.status, table.runAfter),
  ],
);
export type Task = typeof tasks.$inferSelect;
```

> 注意：PostgreSQL 唯一索引允许多个 NULL，因此可空 `dedupe_key` + 唯一索引天然满足「有键去重、无键不限」。
> 迁移：`pnpm exec drizzle-kit generate`（注意 `status` 是 Drizzle text-enum，非 PG native enum，迁移只建表 + 索引，不会有 `CREATE TYPE`）。

## 3. 任务模块 `src/modules/tasks/index.ts`（新建）

```ts
// 入队：必须在业务事务内调用，与状态变更同提交
enqueueTask(tx, { kind, dedupeKey?, payload, runAfter? }): Promise<void>
//   insert ... on conflict (dedupe_key) do nothing  —— 幂等入队

// 领取（派发器用）：原子领取一批到期任务
claimDueTasks(limit): Promise<Task[]>
//   update tasks set status='processing', locked_at=now, locked_by=:id, lease_until=now+lease
//   where id in (
//     select id from tasks
//     where (status='pending' and run_after<=now)
//        or (status='processing' and lease_until < now)   -- 回收卡死
//     order by run_after limit :limit for update skip locked
//   ) returning *

markSucceeded(id) / markFailed(id, error): Promise<void>
//   失败：attempts+1；attempts<max → status='pending', run_after=now+backoff(attempts)；否则 status='dead'
```

`enqueueTask` 用 `onConflictDoNothing({ target: tasks.dedupeKey })` 实现幂等入队。

## 4. 处理器 `src/modules/tasks/handlers.ts`（新建）

```ts
// kind -> handler 映射
const handlers = { email: handleEmailTask };

async function handleEmailTask(payload): Promise<void> {
  const cfg = await getSmtpConfig();
  if (!cfg.configured) return; // D4：未配置视为 no-op success（调用方据返回标记 succeeded）
  switch (payload.template) {
    case "membership_activated": await sendMembershipActivatedEmail(payload.to, payload.params.tierName, new Date(payload.params.endsAt), payload.locale); break;
    case "payment_rejected":     await sendPaymentRejectedEmail(payload.to, payload.params.tierName, payload.params.reviewNote ?? null, payload.locale); break;
  }
}
```

> 处理器要幂等（重试不产生重复副作用）：邮件已有 `dedupe_key` 防重复入队；send 自身重试在极端情况下可能重复发信，可接受（邮件投递语义为 at-least-once）。

## 5. 派发器 `src/modules/tasks/dispatcher.ts`（新建）+ 启动

```ts
let started = false;
export function startTaskDispatcher() {
  if (started) return;            // 防重复（dev HMR / 多次 register）
  started = true;
  const tick = async () => {
    try {
      const due = await claimDueTasks(BATCH);
      for (const task of due) {
        try { await runHandler(task); await markSucceeded(task.id); }
        catch (e) { await markFailed(task.id, String(e)); }
      }
    } catch (e) { logger.error("task dispatcher tick failed", { error: String(e) }); }
  };
  setInterval(tick, POLL_INTERVAL_MS); // ~10s
}
```

在 `src/instrumentation.ts` 的 `register()` 内、Node runtime 分支里调用 `startTaskDispatcher()`（在 `getEnv()` 校验之后）。

## 6. 改造 `src/modules/payment/index.ts`

approve / reject 当前是**事务后** `if ((await getSmtpConfig()).configured) { await sendX(...) }`。改为：

- 在各自的**业务事务内**（approve 已有事务；reject 需确认在事务内）调用 `enqueueTask(tx, { kind:'email', dedupeKey, payload })`：
  - approve：`dedupeKey = "email:membership_activated:" + requestId`，payload `{ template:'membership_activated', to:user.email, locale:user.locale, params:{ tierName, endsAt } }`。
  - reject：`dedupeKey = "email:payment_rejected:" + requestId + ":" + reviewedAt`，payload 同理。
- **删除事务后的内联 `sendMembershipActivatedEmail` / `sendPaymentRejectedEmail` 调用**（含其 try/catch 吞错块）。
- 注意：approve 事务内为了拿 `user.email`/`locale`，需在事务内 select user（当前是事务后查的，挪进去）。

## 7. 管理员任务视图（D5，最小实现）

- `GET /api/admin/tasks?status=`（`requireAdmin`）→ 列表（kind/status/attempts/lastError/runAfter）。
- `POST /api/admin/tasks/[id]/retry`（`requireAdmin`）→ 仅 `failed`/`dead` 行：重置 `status='pending'`、`run_after=now`、`attempts=0`（或保留 attempts，按需）。
- 后台页面 `src/app/admin/(dashboard)/...` 加一个简单列表 + 重试按钮（复用现有 UI 原语与 i18n 模式）。

## 8. i18n

`{zh,en,ja}.ts` 补：任务状态、重试按钮、任务列表标题/列名等。

## 9. 测试（issue #7 验收）

真实 PG 集成（参照 `payment/index.integration.test.ts`）：

- `enqueueTask` 在事务回滚时不留任务；提交后任务存在。
- 幂等入队：相同 `dedupeKey` 重复入队只产生一行。
- `claimDueTasks`：到期任务被领取并置 `processing` + `lease_until`；未到期不被领取。
- **租约回收**：`processing` 且 `lease_until<now` 的任务可被重新领取。
- 失败重试：失败 → `attempts+1` 且按退避重排;超 `max_attempts` → `dead`。
- approve/reject 现在**事务内入队**：审核成功后存在对应 email 任务；审核回滚时无任务。
- SMTP 未配置：email 任务 → `succeeded`（no-op）。
- 派发器：纯函数/可注入 handler 的单测（避免真发邮件）。

## 10. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm test && pnpm build:migrator && pnpm build
```

## 11. PR

- base `main`，draft，标题 `feat(tasks): add transactional outbox and dispatcher`。
- 描述声明：新增 `tasks` 表 + 迁移、派发器（单实例、instrumentation 启动）、payment 邮件改为事务内入队、管理员任务视图。
- 关联 `Closes #7`。

## 12. 验收 checklist

- [ ] 业务事务内入队，提交/回滚与任务一致
- [ ] 相同 dedupeKey 幂等入队
- [ ] 派发器单实例、`skip locked` + 租约回收卡死任务
- [ ] 有界重试 + `dead` 终态 + `last_error`
- [ ] payment approve/reject 邮件改为事务内入队（删除事务后内联发送）
- [ ] 管理员可见任务并手动重试 failed/dead
- [ ] SMTP 未配置时 email 任务为 no-op success，不无限重试
