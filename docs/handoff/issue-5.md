# 交接：#5 后台会员生命周期控制

> 给执行 agent 的自包含实现说明。**前置依赖：#4（PR #15）已合并**——复用 `memberships.status/version`、生命周期 service（`suspend/resume/revoke/extendMembership`）、`audit_events`。
>
> 可与 #6 并行（两者都只依赖 #4，彼此独立）。

## 0. 必读

- `docs/architecture/membership-lifecycle.md`（生命周期 service / 错误码 / 状态矩阵）
- `docs/adr/0001-membership-lifecycle-model.md`（行级 suspend、派生态、乐观锁）
- GitHub issue #5
- 现有代码：`src/app/admin/(dashboard)/memberships/page.tsx`、`src/app/api/admin/memberships/[id]/route.ts`、`src/components/admin/membership-grant-form.tsx`、`src/components/admin/delete-button.tsx`、`src/modules/auth/session.ts`（`requireAdmin()` 返回 `User`，用作 admin actor）

**范围**：把 #4 的生命周期能力暴露到后台 UI，并修复遗留的无审计盲写/硬删路由。
**不含**：重定义状态/转移规则（#4 已定）、付款审核 schema（#6）、批量操作。

## 1. 现状与差距

| 现状 | 差距 |
|---|---|
| 列表状态徽章只按时间窗算 active/expired | **不显示 suspended/revoked**；需按存储态 + 派生态展示 |
| 每行一个 `DeleteButton` → `DELETE /api/admin/memberships/[id]` 硬删 | 无审计、不可追溯；应改为 `revoke`（软终态） |
| `PUT /api/admin/memberships/[id]` → `updateMembership` 无条件盲写 | 无 version、无审计；应删除或改走审计化路径 |
| 无 suspend/resume/revoke/extend 入口 | 需新增动作 + reason + 确认对话框 |
| 无历史时间线 | 需展示该会员的 `audit_events` |

## 2. 已锁定的设计决策（动工前若有异议先提）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **UI 不再硬删会员**；「删除」改为 `revoke`（终态、可审计）。移除 `DELETE` 路由的使用，或保留路由但前端不再调用。 | 满足「状态变更全程可追溯」。 |
| D2 | **移除 `PUT`（盲写日期）路由**；延长有效期只通过审计化的 `extendMembership`。任意改日期（缩短/回拨）**v1 暂不提供**，需要时再加带 `expectedVersion`+`reason`+`recordAudit` 的 `adjustMembership`。 | 去掉无审计写路径；保持最小面。 |
| D3 | **状态展示 = 存储态 + 派生态合成标签**：revoked / suspended 直接显示；active 行再按时间窗细分 active(生效中) / scheduled(未开始) / expired(已过期)。 | 与 ADR 0001 派生态一致。 |
| D4 | **乐观并发暴露到 UI**：动作请求携带管理员看到的 `version` 作为 `expectedVersion`；命中 `membershipStale` 时提示「已被他人修改，请刷新」。 | 满足验收「stale 不静默覆盖」。 |

## 3. Service / 数据读取补充

`src/modules/membership/index.ts`（或 audit 模块）新增：

```ts
// 后台详情需要：单条会员 + tier + 当前 version/status
getMembershipDetail(id): Promise<{ membership: Membership; tier: MembershipTier; userEmail: string } | null>

// 历史时间线：该会员的审计事件，倒序
listMembershipHistory(id): Promise<AuditEvent[]>
//   = select * from audit_events where entity_type='membership' and entity_id=:id order by created_at desc
```

`listMemberships()` 已返回 `membership`（含 `status`/`version`）——列表页直接用其 `status` 渲染。

## 4. API 路由（新增，均 `requireAdmin()`）

每个动作路由：解析入参 → 取 `const admin = await requireAdmin()` → 调用对应 service，`actor: { type: "admin", id: admin.id }`，透传 `expectedVersion`。统一 `jsonOk` / `handleApiError`。

```
POST /api/admin/memberships/[id]/suspend   body: { reason, expectedVersion }
POST /api/admin/memberships/[id]/resume    body: { reason, expectedVersion }
POST /api/admin/memberships/[id]/revoke    body: { reason, expectedVersion }
POST /api/admin/memberships/[id]/extend    body: { days, expectedVersion }
```

- 校验：reason 非空（suspend/resume/revoke）；days 为正整数（extend）。
- 错误透传 service 的 `ApiError`：`membershipStale`(409) / `alreadyInState`(409) / `invalidMembershipTransition`(409) / `membershipNotFound`(404) / `membershipReasonRequired`(400)。
- **删除旧 `PUT`/`DELETE` 处理器**（D1/D2）；如担心破坏既有调用，先确认无其它调用方（`rg "api/admin/memberships"`）。

## 5. UI 改动

### 5.1 列表 `page.tsx`

- 状态列改为合成标签（D3）：
  - `status==='revoked'` → 撤销；`status==='suspended'` → 暂停；
  - `status==='active'`：`endsAt<=now`→已过期、`startsAt>now`→未开始、否则→生效中。
- 行操作区：移除 `DeleteButton`；改为打开「会员详情/操作」面板或行内动作菜单。

### 5.2 详情/操作面板（新组件 `src/components/admin/membership-actions.tsx`，client component）

- 展示当前状态、有效期、`version`。
- **按当前状态只渲染合法动作**（与 `evaluateTransition` 一致）：
  - active 生效中：暂停、撤销、延长
  - suspended：恢复、撤销、延长
  - revoked：无动作
  - 过期(active 但 endsAt<=now)：撤销（不可延长）
- 敏感动作（suspend/revoke）弹**确认对话框**，对话框内含 reason 输入并**摘要将产生的状态变化**（如「张三 · 高级会员 将从 生效中 → 已撤销」）。
- 提交携带 `expectedVersion`；成功后刷新列表与历史。
- 错误提示分级：校验错误、`alreadyInState`、`membershipStale`（提示刷新）、其它/rollback。
- 复用现有 UI 原语（`@/components/ui/*`，参考 `membership-grant-form.tsx`、`payment-method-manager.tsx` 的写法与 i18n 用法）。

### 5.3 历史时间线

- 在详情面板渲染 `listMembershipHistory(id)`：动作、操作者、reason、时间、before→after（仅白名单字段）。

## 6. i18n

`src/modules/i18n/messages/{zh,en,ja}.ts` 补：状态标签（suspended/revoked/scheduled）、动作名（暂停/恢复/撤销/延长）、确认文案、reason 占位、错误提示（stale/alreadyInState 等如 #4 未加全）。

## 7. 测试

- 路由层：各动作鉴权（无 admin 会话 → 403）、参数校验、错误码透传（可沿用 mock `getDb` 风格或集成测试）。
- 纯函数：若新增「按状态可用动作」的推导函数，单测其与 `evaluateTransition` 一致。
- 集成（建议，真实 PG）：suspend→历史出现一条事件；stale `expectedVersion`→`membershipStale`；revoke 后列表状态为撤销、该用户失去 member 访问。

## 8. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm test && pnpm build:migrator && pnpm build
```

## 9. PR

- base `main`，draft，标题 `feat(admin): add membership lifecycle controls`。
- 描述声明：移除无审计的 PUT/DELETE 路由（行为变更）、新增动作路由与 UI、历史时间线。
- 关联 `Closes #5`，并在描述提及修复了 PR #15 review 记录的遗留路由缺口。

## 10. 验收 checklist（对应 issue #5）

- [ ] UI 只暴露当前状态合法的动作
- [ ] 敏感操作需确认 + reason
- [ ] 成功后立即出现在历史时间线
- [ ] stale/并发不静默覆盖（`membershipStale` 提示刷新）
- [ ] 所有后台动作需 admin 会话
- [ ] 不再存在无审计的盲写/硬删路径（修复 #15 review 缺口）
