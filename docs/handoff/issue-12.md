# 交接：#12 跨切面授权与不变量回归测试（收口）

> 给执行 agent 的自包含实现说明。**前置依赖:#4–#11 全部已合并(当前 main)**。这是 v1 Core epic(#3)的**最后一项 + 完成门槛**。
>
> 本任务以**测试为主**:补齐跨模块「接缝」处的回归测试,尤其是私有文件下载授权(目前无集成测试)。**不改产品代码,除非测试暴露真实 bug**——那时修复并在 PR 注明。

## 0. 必读

- GitHub issue #12、#3(完成标准)
- 现有集成测试范式(真实 PG,`RUN_DB_INTEGRATION_TESTS=true` 才跑,`beforeEach` 清表):
  `membership` / `payment` / `content/publishing` / `tasks` / `taxonomy` / `auth(admin-account, admin-reset)` 各自的 `*.integration.test.ts`
- 关键被测代码:
  - `src/modules/download/index.ts`(`canAccessFile` / `authorizeAndPrepareDownload`)——**核心新增覆盖**
  - `src/modules/content/index.ts`(`canAccessPost` / `getActiveLevel`)
  - `src/modules/membership/index.ts`(生命周期 + `getActiveMembership` 含 `status='active'`、不含 `tier.isActive`)
  - `src/modules/payment/index.ts`(approve/reject/reverse + 因果链)
  - `src/modules/tasks/index.ts`(`enqueueTask` 幂等、claim/lease/fencing)
  - `audit_events`(correlation/causation)

## 1. 已锁定的范围决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | **仅加回归测试,不改产品代码**;若测试发现真实 bug,**最小修复 + 在 PR 显著标注**(这正是 #12 的价值)。 | #12 是「收口」,不是新功能。 |
| D2 | 复用现有真实 PG 集成范式(`RUN_DB_INTEGRATION_TESTS` gate)。**新增** `src/modules/download/index.integration.test.ts` 覆盖文件授权;跨多模块的「接缝」用例放 `src/modules/__invariants__/cross-cutting.integration.test.ts`(或就近)。 | 与现有一致,CI 已跑 PG。 |
| D3 | 跨切面测试触及大量表,提供**共享 FK 安全清库 helper**(见 §3),避免再次踩 #6/#7 的删除顺序坑。 | 多表清理易错。 |
| D4 | 用例**映射 issue #12 九项 + #3 完成标准**;已被单模块覆盖的不重复造,只补「跨模块」与「下载授权」缺口。 | 不灌水。 |

## 2. 必测清单（按 #12 九项组织;★ = 当前缺口,重点）

### a. 访问控制 / 私有文件 ★(最大缺口,无集成测试)
针对 `canAccessFile` / `authorizeAndPrepareDownload`,**逐 `purpose` + 角色矩阵**:

- `payment_proof`:**仅本人或 admin**;他人 → 403 `accessDenied`;匿名 → 401。
- `content_attachment` / `content_image`:
  - 关联文章为 **draft/scheduled/archived 时不可下载**(只有 `published` 才放行)——★ #9 之后务必覆盖「scheduled(status=draft+scheduledAt)文章的附件匿名/会员都拿不到」。
  - `visibility=member` 文章附件:**suspended/revoked/过期会员 → 拒(memberAccessDenied)**;有效会员 → 放行。
  - `visibility=login`:匿名 401、登录用户放行。
  - 未关联任何文章的 content 文件 → `fileUnlinked` 拒。
- 公开类(`artist_avatar`/`payment_qr`/`cover`/`thumbnail`)→ 匿名放行。
- admin → 全放行。
- `authorizeAndPrepareDownload` 放行时写 `download_logs` + `file_downloaded` 事件;拒绝时不写日志。

### b. 重复动作(幂等)
- 重复 approve(双击)→ 仅一次开通(已有 payment 覆盖,跨切面补:重复 approve 后 `memberships` 仅一行、email 任务仅一条 dedupe)。
- 重复 reverse → 第二次 `paymentNotApproved`。
- 生命周期重复 suspend → `alreadyInState`。

### c. stale 记录(乐观/条件并发)
- membership 旧 `expectedVersion` → `membershipStale`(已有,跨切面可略)。
- 发布命令旧 `expectedScheduleToken` → `postPublishingstale`。
- 账号改密/改邮箱旧哈希并发 → `adminAccountChanged`。

### d. 回滚
- 审计插入失败 → 业务整体回滚(membership/payment 已各有触发器手法;补一个**端到端**:reverse 时 membership revoke 审计失败 → 付款回到 approved、会员仍 active、无任何审计残留)。

### e. 会员状态 × 访问(跨模块接缝)★
- **suspended / revoked / 过期** 会员:`getActiveMembership=null` 且 **member 文章内容 + 附件均拒**。
- **停用 tier**:存量有效会员**仍可访问** member 内容与附件(验证 `tier.isActive` 已从访问判定移除)。

### f. scheduled 内容 ★
- scheduled 文章(status=draft+scheduledAt+token)对**前台不可见**、其附件不可下载。
- 到期 `executeScheduledPublish` 后变 published 才可见/可下载。
- 旧 token 任务(改期/取消后)执行 → no-op,不会误发布。

### g. 审计因果引用
- approve→grant:两事件共享 `correlation_id`,grant 事件 `causation_id = approve 事件 id`。
- reverse→revoke:revoke 事件 `causation_id = reverse 事件 id`。
- schedule→publish:publish 事件 `causation_id = scheduling 事件 id`。
- 敏感动作 `before/after` **不含密码哈希 / 私人字段**(白名单)。

### h. 幂等消息投递
- 相同 `dedupeKey` 重复 `enqueueTask` → 仅一行任务。
- email 任务重试不重复入队;SMTP 未配置 → no-op `succeeded`。

### i. 升级/迁移不变量(可选,轻量)
- 全套迁移在干净库可重复执行(`pnpm db:migrate` 幂等)——CI 已隐含,可不单列。

## 3. 共享清库 helper(必做,避免 FK 删除顺序坑)

新增测试工具(如 `src/modules/__invariants__/db-reset.ts`):

```ts
// 用 TRUNCATE ... RESTART IDENTITY CASCADE 一次清空所有业务表，规避删除顺序问题
export async function resetDatabase(db = getDb()) {
  await db.execute(sql`
    truncate table
      audit_events, tasks, app_events, download_logs,
      post_tags, post_categories, post_files, post_translations,
      payment_requests, memberships,
      posts, files, tags, categories, membership_tiers, payment_methods,
      sessions, login_codes, users, site_settings, app_settings
    restart identity cascade
  `);
}
```

> 用 `TRUNCATE ... CASCADE` 比逐表 `delete` 更稳(自动处理外键)。表清单以当前 schema 为准,新表要补进来。

## 4. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test   # 需本地 PG
pnpm build:migrator && pnpm build
```

CI 已带 PostgreSQL,会跑全部集成用例。

## 5. PR

- base `main`,draft,标题 `test(core): harden authorization and state invariants`。
- 描述:列出新增覆盖(尤其下载授权 + 跨模块接缝)、是否发现并修复了真实 bug(若有,单独小节)。
- 关联 `Closes #12`,并在描述对照 #3 完成标准逐条说明已覆盖。

## 6. 验收 checklist（对应 issue #12 + epic 完成门槛）

- [ ] 私有文件下载授权:purpose × 角色 × 文章状态/可见性 全矩阵
- [ ] suspended/revoked/过期会员 内容与附件均被拒
- [ ] 停用 tier 不影响存量会员访问
- [ ] scheduled/draft/archived 文章附件不可下载
- [ ] 重复 approve/reverse、stale token/version 行为正确
- [ ] 端到端回滚(审计失败回滚业务)
- [ ] 因果链(approve→grant、reverse→revoke、schedule→publish)可断言
- [ ] 审计快照不含密码/私人字段
- [ ] 幂等入队 + SMTP 未配置 no-op
- [ ] 若发现真实 bug,已修复并在 PR 标注
