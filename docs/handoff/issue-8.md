# 交接：#8 管理员账号维护、会话与恢复

> 给执行 agent 的自包含实现说明。**前置依赖：#6 已合并**（复用 `audit_events` / `recordAudit`，`entity_type='admin'`）。
>
> 与 #10 完全独立（auth/session vs content），可并行。

## 0. 必读

- GitHub issue #8
- 现有代码：
  - `src/modules/auth/session.ts`（`createSession` / `getCurrentUser` / `destroyCurrentSession` / `requireAdmin`；`SESSION_COOKIE`、`hmacSha256(token)` 存 `sessions.tokenHash`）
  - `src/modules/auth/admin-login.ts`（`verifyPassword`）
  - `src/lib/crypto`（`hashPassword` / `verifyPassword` / `hmacSha256`——确认 bcrypt cost）
  - `src/db/schema/index.ts`（`users`、`sessions`：id/userId/tokenHash/expiresAt/createdAt/ip/userAgent——**已够用**）
  - `src/modules/audit`（`recordAudit(tx, …)`）
  - `scripts/migrate.mjs` + `package.json`（`build:migrator`）——恢复脚本照此范式
  - `docker/entrypoint.sh`（容器启动流程，恢复脚本的运行环境）

**范围**：管理员账号维护（改密/改邮箱）、会话可见与吊销、敏感操作审计历史、锁死恢复手段。
**不含**：多管理员/角色系统（单创作者仍单 admin）、2FA、邮箱验证流程改造。

## 1. 已锁定的设计决策（动工前若有异议先提）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **恢复 = CLI 脚本，不是纯文档**。新增 `scripts/admin-reset.mjs`（ESM，用 `DATABASE_URL` + `bcryptjs`），`package.json` 加 `admin:reset` 与 `build:admin-reset`（bundle 到 `dist/`，供容器 `docker compose exec` 运行）。 | 单 admin 锁死=进不去后台,纯文档无法自助恢复;脚本可靠且可在容器内执行。 |
| D2 | 恢复脚本**非交互**,从 env 取 `ADMIN_EMAIL` / `ADMIN_PASSWORD`:upsert 该邮箱为 `role='admin'`、写 `passwordHash=bcrypt(ADMIN_PASSWORD)`,并**吊销该用户全部 sessions**。 | 容器内无 TTY;env 输入安全且可脚本化;重置后旧会话立即失效。 |
| D3 | **改密/改邮箱需重新输入当前密码**(re-auth),且**改密成功后吊销除当前外的所有 session**。 | 敏感操作防代持;改密即踢掉其它设备(安全惯例)。 |
| D4 | **会话可见 + 吊销**:列出当前 admin 的有效 session(标记「当前」),支持「吊销单个」「吊销其余全部」。复用 `sessions` 表,**无需迁移**。 | issue 要求 session visibility;schema 已够。 |
| D5 | **敏感操作写 `audit_events`(`entity_type='admin'`)**:`password_changed` / `email_changed` / `session_revoked` / `sessions_revoked_all` / `account_recovered`(脚本侧)。actor=admin(脚本侧 actor=system)。 | issue 要求「可审计」;复用 ADR 0002 审计基座。 |
| D6 | 登录事件保持现状写 `app_events`(遥测),**不**搬进 audit_events;操作历史页只读 `audit_events` 的 admin 维护动作。 | 登录非状态变更;避免审计噪音。 |

> 结论:**#8 无 schema 迁移**(复用 users/sessions/audit_events)。

## 2. 恢复脚本 `scripts/admin-reset.mjs`（新建）

仿 `migrate.mjs`:

```js
// 读 DATABASE_URL、ADMIN_EMAIL、ADMIN_PASSWORD（缺失即报错退出）
// import postgres from "postgres"; import bcrypt from "bcryptjs";
// 1) 校验 ADMIN_PASSWORD 强度（最小长度，与 setup 一致）
// 2) const hash = bcrypt.hashSync(password, COST)   // COST 必须与 src/lib/crypto 一致
// 3) upsert users：存在该 email → set role='admin', password_hash=hash；不存在 → insert admin
// 4) delete from sessions where user_id = <该用户>     // 吊销全部会话
// 5) insert audit_events(entity_type='admin', action='account_recovered', actor_type='system', ...)
// 退出码 0/1，打印结果（不打印密码）
```

`package.json`:

```jsonc
"admin:reset": "node scripts/admin-reset.mjs",
"build:admin-reset": "esbuild scripts/admin-reset.mjs --bundle --platform=node --format=esm --outfile=dist/admin-reset.mjs"
```

文档(`docs/admin/...` 或 README 安全段)写明用法:
```
docker compose exec -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='...' app node dist/admin-reset.mjs
```

> ⚠️ bcrypt cost 必须和 `src/lib/crypto` 的 `hashPassword` 相同,否则登录校验逻辑虽兼容(bcrypt 自带 cost),但保持一致更稳。先确认 lib/crypto 用的是 bcryptjs 及其 cost。

## 3. Service 层

`src/modules/auth/session.ts`（或新 `src/modules/auth/admin-account.ts`）新增：

```ts
// 会话
listMySessions(userId, currentTokenHash): Promise<{ id, ip, userAgent, createdAt, expiresAt, current:boolean }[]>
revokeSession(userId, sessionId): Promise<void>          // 仅能删自己的；写审计
revokeOtherSessions(userId, currentTokenHash): Promise<number>  // 删除除当前外全部；写审计

// 账号维护（均需 requireAdmin + 校验 currentPassword）
changeAdminPassword(userId, { currentPassword, newPassword }): Promise<void>
//   verifyPassword(current) → 否则 401 invalidCredentials；
//   set password_hash=hashPassword(new)；吊销除当前外所有 session；recordAudit('password_changed')
changeAdminEmail(userId, { currentPassword, newEmail }): Promise<void>
//   re-auth；email 唯一冲突 → 409 emailTaken；recordAudit('email_changed', before/after 仅记 email)

// 操作历史
listAdminAuditHistory(limit): Promise<AuditEvent[]>      // entity_type='admin' 倒序
```

- 审计快照走白名单(沿用 #4/#6 的 `pickXAudit` 思路:邮箱可记,密码哈希**不可**入审计)。
- `getCurrentUser` 已用 cookie token;service 里拿 `currentTokenHash = hmacSha256(cookieToken)` 用于「标记当前 / 吊销其余」。

## 4. API 路由（均 `requireAdmin()`）

```
GET    /api/admin/account/sessions            列出我的会话
DELETE /api/admin/account/sessions/[id]       吊销单个
POST   /api/admin/account/sessions/revoke-others  吊销其余
POST   /api/admin/account/password            { currentPassword, newPassword }
POST   /api/admin/account/email               { currentPassword, newEmail }
GET    /api/admin/account/history             操作历史
```

- 错误透传:`invalidCredentials`(401)、`emailTaken`(409)、密码强度不足(400)。
- 改密成功后:若**当前会话**因「吊销其余」逻辑被误删要避免——明确**保留当前 session**。

## 5. 后台 UI

- 新增 `src/app/admin/(dashboard)/account/page.tsx`:
  - 改密 / 改邮箱表单(需当前密码;**确认对话框**)。
  - 会话列表(当前高亮 + 吊销按钮 + 「登出其它设备」)。
  - 操作历史时间线(复用 #5 的历史展示范式;actor/动作/时间)。
- 复用现有 UI 原语与 i18n 模式。

## 6. i18n

`{zh,en,ja}.ts` 补:账号设置/改密/改邮箱/当前密码/会话/吊销/登出其它设备/操作历史/各错误文案。

## 7. 测试

- service:改密需正确当前密码(错→401);改密后其它 session 失效、当前保留;改邮箱唯一冲突→409;`revokeOtherSessions` 只留当前;敏感操作各写一条 `audit_events`。
- 路由:`requireAdmin` 鉴权(401/403)。
- 恢复脚本:可写一个集成测试或手动验证——给定 env 重置后,旧 session 全失效、可用新密码登录、留有 `account_recovered` 审计。
- 审计:密码哈希不得出现在 `audit_events`。

## 8. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm test && pnpm build:migrator && pnpm build:admin-reset && pnpm build
```

## 9. PR

- base `main`,draft,标题 `feat(admin): add account maintenance, session controls and recovery`。
- 描述声明:无 schema 迁移(复用 users/sessions/audit_events)、新增恢复脚本(及 build/运行方式)、敏感操作审计与「改密踢其它会话」行为。
- 关联 `Closes #8`。

## 10. 验收 checklist（对应 issue #8）

- [ ] 管理员可改密/改邮箱(需当前密码 + 确认)
- [ ] 会话可见、可吊销单个/其余
- [ ] 敏感操作进入 `audit_events` 且可在操作历史查看
- [ ] 密码哈希等敏感数据不入审计
- [ ] 锁死可经 `admin-reset` 脚本恢复,且重置后旧会话失效
- [ ] 改密后其它会话失效、当前会话保留
- [ ] 全部后台动作需 admin 会话
