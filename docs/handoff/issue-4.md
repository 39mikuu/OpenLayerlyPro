# 交接：#4 membership 生命周期 + 审计基座

> 给执行 agent 的自包含实现说明。无需对话上下文即可照做。

## 0. 背景与必读（均已在 `main`）

- `docs/adr/0001-membership-lifecycle-model.md`（Accepted）— 会员模型权威决策
- `docs/adr/0002-audit-and-event-strategy.md`（Accepted）— 审计表与因果模型
- `docs/architecture/membership-lifecycle.md` — #4 设计稿（schema / 状态矩阵 / service / 测试清单）
- GitHub issue #4；审计表 `audit_events` 由 #6 复用

**本任务范围**：service + schema 层，并建 #6 复用的 `audit_events` 与 `recordAudit`。
**不含**：后台 UI（#5）、邮件（#7）、付款事件 schema 与反转（#6）、批量操作。

## 1. 分支策略

- 每个 issue 一个短命 feature 分支 → green 后直接合进 `main`（trunk-based）。
- **不开长期 `dev` 大分支**：违背 issue #3「focused PRs」原则，且单人维护下大合并成本高。
- 需要稳定发布点时，在 #4–#12 全部完成后于 `main` 打 `v1.0.0` tag，而非长期分叉。

本任务：

```bash
git checkout main && git pull origin main
git checkout -b feat/membership-lifecycle
```

提交用 Conventional Commits（`feat(membership): ...`）；husky / commitlint / lint-staged 已启用，小步提交。

## 2. 任务清单（按顺序）

### Step 1 — Schema `src/db/schema/index.ts`

`memberships` 表加两列（放在 `note` 后即可）：

```ts
status: text("status", { enum: ["active", "suspended", "revoked"] })
  .notNull()
  .default("active"),
version: integer("version").notNull().default(0),
```

文件末尾（`appEvents` 之后）新增审计表：

```ts
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").notNull(), // membership | payment_request | admin
    entityId: uuid("entity_id").notNull(),
    action: text("action").notNull(), // grant|suspend|resume|revoke|extend|approve|...
    actorType: text("actor_type", { enum: ["admin", "user", "system"] }).notNull(),
    actorId: uuid("actor_id"),
    reason: text("reason"),
    beforeJson: jsonb("before_json"), // 仅白名单字段
    afterJson: jsonb("after_json"),
    correlationId: uuid("correlation_id").notNull(),
    causationId: uuid("causation_id"), // 可空，软引用 audit_events.id
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_events_entity_idx").on(table.entityType, table.entityId, table.createdAt.desc()),
    index("audit_events_correlation_idx").on(table.correlationId),
    index("audit_events_causation_idx").on(table.causationId),
  ],
);
```

文件底部加：`export type AuditEvent = typeof auditEvents.$inferSelect;`

### Step 2 — 生成并验证迁移

```bash
pnpm exec drizzle-kit generate   # 生成 0007_*.sql + meta 快照 + journal 条目
```

- 加列均带 `default`，存量行自动获值，**无需手写回填**。
- 起本地 PG 验证：

```bash
docker run -d --name ams-postgres -e POSTGRES_DB=artist_member \
  -e POSTGRES_USER=artist -e POSTGRES_PASSWORD=artist_password -p 5432:5432 postgres:16
cp .env.example .env
pnpm db:migrate
```

- ⚠️ 迁移文件一旦生成不要再改语义（项目规约，见 CONTRIBUTING）。

### Step 3 — 审计模块 `src/modules/audit/index.ts`（新建）

```ts
// recordAudit 必须接收事务句柄 tx，与状态变更同提交/同回滚；不得 try/catch 吞异常
export async function recordAudit(
  tx: DbClient,
  input: {
    entityType: string;
    entityId: string;
    action: string;
    actor: { type: "admin" | "user" | "system"; id: string | null };
    reason?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    correlationId: string;
    causationId?: string | null;
  },
): Promise<{ id: string }>; // insert ... returning id
```

- 字段白名单：实现 `pickMembershipAudit(m)` → 仅 `{ status, startsAt, endsAt, tierId }`。**禁止整行序列化**（ADR 0002 §4），避免把 note / 私人信息写进审计表。

### Step 4 — 生命周期 service `src/modules/membership/index.ts`（扩展）

权威规则见 ADR 0001。每个操作：**单事务内** = 条件更新（`version` 守卫 + 允许来源态）+ `recordAudit(tx)`。

```ts
suspendMembership(id, { reason, actor, expectedVersion, correlationId?, causationId? })
resumeMembership(id,  { reason, actor, expectedVersion, ... })
revokeMembership(id,  { reason, actor, expectedVersion, ... })
extendMembership(id,  { days,   actor, expectedVersion, dedupeKey?, ... })
```

条件更新示例（suspend，仅 active→suspended）：

```sql
update memberships
set status='suspended', version=version+1, updated_at=now()
where id=:id and version=:expectedVersion and status='active'
returning *
```

命中 0 行的错因区分（再查该行判断）：

- 行不存在 → `ApiError(404, "membershipNotFound")`
- version 不符 → `ApiError(409, "membershipStale")`
- status 不在允许来源态 → `ApiError(409, "invalidMembershipTransition")`

规则要点（完整见 ADR 0001 两张表）：

- **extend**：仅 `endsAt > now` 允许，`endsAt = endsAt + days`，**保持原 status**（suspended extend 后仍 suspended，不恢复）；过期记录拒绝 extend，改走 `grantMembership` 续期。
- **suspend / resume / revoke**：只改存储态，与时间窗正交。
- **revoked 终态**：任何操作（含 extend）拒绝。
- **幂等**：目标态相同视为成功 no-op（已 suspended 再 suspend 返回当前态）；`extend` 带 `dedupeKey` 只生效一次。
- **抽纯函数** `evaluateTransition({ status, startsAt, endsAt }, action, now) => { ok, errorCode }`，供单测（Step 6）。

### Step 5 — 权限判定改造（最易漏，重点）

`getActiveMembership` / `getActiveLevel`：**删除 `eq(membershipTiers.isActive, true)` 过滤**、**新增 `eq(memberships.status, "active")` 过滤**（ADR 0001 §5）。

> 这是对现有行为的**有意修正**：停用 / 隐藏 tier 不再吊销已付费会员；tier.isActive / purchaseEnabled 只管能否售卖与展示。

- `grantMembership` 新建行写 `status:"active"`，并在同事务写一条 `audit_events`（`action:"grant"`）。
- 全量排查直接读 `memberships` 或 join `tier.isActive` 的位置：`src/modules/content`（member 权限）、`payment`（等级比较）、`/me`、`tiers`、`checkout`。
- 用 `rg "isActive|getActiveMembership|from\(memberships\)"` 扫一遍，逐处确认。

### Step 6 — 测试

现有单测**纯 mock `getDb`**（见 `src/modules/payment/index.test.ts`），无法真实验证事务 / 并发 / 回滚。两层应对：

1. **纯函数单测（必做，跑在现有 CI）**：`evaluateTransition` 全覆盖——合法 / 非法转移、expired 不可 extend、scheduled 可操作、revoked 终态、suspended extend 不恢复。
2. **集成测试（强烈建议）**：事务回滚、`version` 并发、停用 tier 后存量会员仍有效、suspended/revoked 不得访问 member 内容——**需真实 PG**。在 `.github/workflows/ci.yml` 的 `check` job 加 `services: postgres`（postgres:16）并设 `DATABASE_URL`，迁移后运行。若不动 CI，至少写成可本地运行的集成测试，并在 PR 描述注明 CI 未覆盖。

逐条对照设计稿 §8 测试清单。

## 3. 提交前验证（必跑）

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm test && pnpm build:migrator && pnpm build
```

## 4. 文档

- `CHANGELOG.md`：记「停用等级不再吊销存量会员（行为变更）」+ 会员生命周期。
- `docs/architecture/membership-lifecycle.md` 顶部状态由 🚧 改为 ✅（实现完成时）。

## 5. PR

- base `main`，draft，标题 `feat(membership): add lifecycle states, history and audit base`。
- 描述声明：改了 schema / 迁移、改了权限判定（行为变更）、引入 `audit_events`（#6 复用）、CI 是否加 PG。
- 关联 `Closes #4`。

## 6. 验收 checklist（对应 issue #4）

- [ ] 非法转移确定性拒绝（409）
- [ ] 适当幂等（重复 suspend no-op；dedupeKey extend 只一次）
- [ ] 状态与审计同提交 / 同回滚（审计失败回滚整笔）
- [ ] 权限判定用新规则（status=active，去 tier.isActive）
- [ ] 测试覆盖：合法 / 非法转移、stale version、duplicate、rollback、停用 tier 存量有效、suspended/revoked 无访问权
