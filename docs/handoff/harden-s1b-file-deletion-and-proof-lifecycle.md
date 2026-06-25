# 交接：S1b 文件删除与凭证生命周期

> 自包含实现说明。前置依赖:当前 `main`(已含 S1a 上传安全 / quarantine、`storage.delete_object` 两阶段删除、durable tasks + fencing)。属 v1.0 安全硬化 P2(epic #64,S1b)。**无需 ADR**。
>
> 开工前建 issue;PR base `main`,Draft 直到真实 PG 集成 + 完整 CI 全绿。**复用 #54 的两阶段删除范式(`src/modules/file/cleanup.ts`),勿另造。**

## 0. 红线

1. **删除原子**:DB 行与存储对象不得发散——**先在一个事务内删 DB 行 + 入队 `storage.delete_object`**(对象异步删、幂等),**不再「先删对象后删行」**。
2. **引用阻止删除**:被 `post_files` / cover / qr / 凭证 / 站点设置引用的文件**不可删**(当前 `deleteFile` 漏 `post_files`)。
3. **凭证按状态保留**:`payment_proof` 不静默删财务证据;按支付状态决定保留/宽限清理(对齐 ADR 0010「不自动改财务」)。
4. 检查与删除**同一事务 + `FOR UPDATE`**,杜绝 TOCTOU(检查后并发新增引用)。

## 1. 现状（必读,直接改造)

- `src/modules/file/index.ts`:
  - `assertFileNotReferenced(id)`:检 `paymentMethods.qrFileId`、`posts.coverFileId`、`paymentRequests.proofFileId`(**仅 `status='pending_review'`**)、3 个站点设置;**漏 `post_files`(正文内联图引用表)**。
  - `deleteFile(id)`:`getFileById` → quarantined→410 → `assertFileNotReferenced` → **`storage.deleteObject` 然后 `db.delete(files)`**(**非原子、对象先删**)。
- `src/modules/file/cleanup.ts`(**复用范式**):`cleanupOrphanFile` = 事务内 `FOR UPDATE` 查 `post_files/cover/qr/proof/settings` 引用 → 无引用则 **`enqueueTask(storage.delete_object)` + `tx.delete(files)`** 同事务;`storageDeleteDedupeKey(payload)`;`deleteStorageObject` 幂等(local ENOENT 吞 / s3 幂等)。
- `src/modules/payment/index.ts`:
  - `paymentRequests`:`proofFileId uuid null`;status ∈ `{pending_review, pending_payment, approved, rejected, cancelled, reversed}`。
  - `resubmitPaymentProof`(rejected→pending_review):`assertOwnProofFile` → UPDATE `proofFileId = 新`;**旧 proof 文件未清理 → 孤儿**(audit before/after 记录了 old→new)。
  - `createPaymentRequest`/`createAutoCheckout`:可带 `proofFileId`。
- `src/app/api/files/upload-payment-proof/route.ts`(S1a 后):pre-auth IP 桶 + `requireUser` + 用户/IP 限流 + bounded read → `saveUploadedFile(payment_proof)`。**无「保留凭证数量」配额**。
- `src/modules/tasks/handlers.ts`:`storage.delete_object`、`file.cleanup_orphan` 等;新增 task kind 在此注册。

## 2. deleteFile 改为两阶段原子 + 补全引用（管理员手动删除)

把 `deleteFile` 重写为**对齐 `cleanupOrphanFile` 的事务内范式**:
- 单一事务:`tx.select(files).where(id).for("update")`;不存在→404;`quarantinedAt`→410(保留)。
- **引用检查(同事务,补全)**:`post_files.fileId`(**新增**)、`posts.coverFileId`、`paymentMethods.qrFileId`、`paymentRequests.proofFileId`(**任意状态**,见下)、3 个站点设置。任一命中 → `400 fileInUse`(带计数)。
  - 凭证引用语义:手动删除时 proof 被**任何** `payment_requests` 引用即阻止(不限 pending_review)——凭证生命周期交 §3 自动清理,管理员不手动删活动凭证。
- 无引用 → **`enqueueTask(tx, storage.delete_object, dedupeKey=storageDeleteDedupeKey(payload))` + `tx.delete(files).where(id)`** 同事务提交。**删除 storage 现已不在 deleteFile 内同步执行**。
- 抽出共享的「两阶段删除一个 file 行」helper(`cleanup.ts` 与 deleteFile 共用 enqueue+delete 逻辑),避免重复。

## 3. 凭证（payment_proof）生命周期

### 3.1 保留矩阵（已锁定)
| 支付状态 | 凭证处置 |
|---|---|
| `pending_review` / `pending_payment` | **保留**(待审/待付) |
| `approved` | **默认永久保留**(财务证据);**可由创作者经后台设置启用「N 天审计窗口后清理」** |
| `reversed` | 同 `approved`(默认永久保留,受同一创作者设置控制) |
| `rejected` / `cancelled` | **宽限期后清理**(`PAYMENT_PROOF_RETENTION_DAYS` 默认 30,env 可配) |

> **创作者可配置项(已锁定)**:站点设置 `payment_proof_approved_retention_days`(后台可改,**非仅 env**,默认 `0 = 永久保留`)。设为 `>0` 时,`approved`/`reversed` 凭证在「结算时刻 + N 天」后被清理。**默认 0**(永久)。首次启用时对**存量**已 approved 凭证不追溯清理(仅对设置启用后新进入 approved/reversed 的请求排单)——文档化、不在本切片做周期扫描。

### 3.2 终态清理 task `payment_proof.cleanup`
- payload `{ requestId, fileId }`;dedupeKey=`proof-cleanup:${requestId}:${fileId}`(每 (request,file) 一条)。
- **入队时机**(在该状态变更的同事务内):
  - 进入 `rejected`/`cancelled` → `enqueueTask(runAfter = reviewedAt + PAYMENT_PROOF_RETENTION_DAYS)`;
  - 进入 `approved`/`reversed` 且站点设置 `payment_proof_approved_retention_days > 0` → `enqueueTask(runAfter = reviewedAt + 该设置天数)`;设置为 0(默认)→ **不入队**。
  - runAfter 仅为初始排期;**到期判定以 handler 重算为准**(下)。
- **handler 按当前设置重算 due,必要时 defer**(事务 + `FOR UPDATE` 该 request):
  1. 读 file `payload.fileId`;不存在 → no-op(幂等)。
  2. `payload.fileId` 被 post_files/cover/qr/settings 引用 → no-op(他处在用)。
  3. 读 request `requestId`,判保留:
     - **`request.proofFileId === payload.fileId`(仍挂在本请求)**:
       - `pending_review`/`pending_payment` → **no-op**(在用);
       - `approved`/`reversed` → 读**当前**站点设置:`=0` → **no-op**(永久保留);`>0` 则 `due = reviewedAt + 设置`;`now < due` → **`return { deferUntil: due }`**(创作者改长/改短设置后按现值重算);`now >= due` → 删;
       - `rejected`/`cancelled` → `due = reviewedAt + PAYMENT_PROOF_RETENTION_DAYS(当前 env)`;`now < due` → **defer**;否则删。
     - **`request.proofFileId !== payload.fileId`(已被 resubmit 取代而脱离)** → 该旧 proof 不再是活动凭证 → 直接进入删(它已按原排期到点,见 §3.3)。
  4. **删(两阶段)**:若仍等于则 `set proofFileId=null` + `enqueueTask(storage.delete_object)` + `tx.delete(files).where(id)`,同事务;**保留 request 行与审计**。
- 通过 `deferUntil` 让 handler 成为**到期权威**:设置改长 → 自动顺延;改回 0 → no-op 保留;env 宽限改动同理。

### 3.3 resubmit:旧凭证保留至原宽限期（已锁定:不立即删)
- `resubmitPaymentProof`:仅 `proofFileId = 新` + 状态回 `pending_review`,**不立即删旧 proof**。
- 旧 proof 在该请求 **rejected 时已排好** cleanup task(runAfter = rejected reviewedAt + `PAYMENT_PROOF_RETENTION_DAYS`),resubmit **不取消、不改**它。该 task 到点触发时,§3.2 走「`proofFileId !== payload.fileId`(已脱离)+ 未被引用」分支 → 删旧 proof。**于是旧凭证保留至其原始宽限期到期才回收**(给驳回-再提交留取证窗口)。
- 前提:**rejected/cancelled 转换必定入队** cleanup task(§3.2 入队时机),否则脱离的旧 proof 无人回收 → 务必保证该入队存在(测试覆盖)。
- 新 proof:请求回到 pending_review,被保留;待其终态再各自排单。

## 4. 每用户凭证配额（防存储滥用,持久计数 + 并发原子)

- **计数源必须持久、不随文件清理消失**:**不要**数 `files`(清理后行被删 → 计数回退 → 可绕过)。改用**只追加、不随 proof 删除而消失**的来源:新增轻量 append-only 表 `payment_proof_upload_log(id, user_id, created_at)`(或复用带 `userId` 的上传审计事件),每次成功上传 proof **追加一行**,**清理 proof 文件时不删该日志**。配额 = `count(*) where user_id=u and created_at > now - 24h`。
- **并发原子**:check-then-insert 有 TOCTOU(两个并发上传都过检查再各插一条 → 超额)。在路由(鉴权后、`saveUploadedFile` 前)用**同一事务 + per-user advisory 锁**串行:
  `pg_advisory_xact_lock(hashtextextended('proof-upload-quota:'||userId, 0))` → 数窗口内日志 → `>= PAYMENT_PROOF_MAX_PER_DAY` → `429 uploadQuotaExceeded` → 否则**插入一条日志**(同事务,与计数原子)→ 提交后再 `saveUploadedFile`。同一用户并发上传被串行,不会双双过关。
- 与 S1a/#70 既有 per-user/IP 突发限流叠加(本配额是日累计、防长期堆积 + 不可经清理绕过)。`PAYMENT_PROOF_MAX_PER_DAY`(env,默认 20,越界拒绝)。
- 日志表加 `(user_id, created_at)` 索引;可选周期清理超 30 天的日志行(不影响 24h 窗口)。

## 5. Schema / env / 迁移

- **新增 1 张表** `payment_proof_upload_log(id, user_id, created_at)`(§4 持久配额计数源,append-only,不随 proof 清理删除;索引 `(user_id, created_at)`)。`payment_requests`/`files` 字段够用(`proofFileId` 置 null 即摘除);两阶段删除是真删行 + 异步删对象,**不加软删列**。`drizzle-kit generate` 仅应有该日志表。
- **env**(有界正整数,越界拒绝,沿用既有写法):
  ```text
  PAYMENT_PROOF_RETENTION_DAYS    # 默认 30,rejected/cancelled 凭证宽限
  PAYMENT_PROOF_MAX_PER_DAY       # 默认 20,每用户日上传配额
  ```
- **创作者可配置站点设置**(后台 UI 可改,经 `siteSettings`/config 中心,**非 env**):
  ```text
  payment_proof_approved_retention_days   # 默认 0 = approved/reversed 永久保留;>0 启用审计窗口清理
  ```
  数值校验(整数、合理上下限,如 0–3650);后台表单加该项。`.env.example` 同步 env 两项;测试默认/合法/越界拒绝 + 设置 0↔N 的行为。

## 6. 测试（真实 PG)

**deleteFile**
- 被 `post_files` 引用的 content_image → `deleteFile` 拒 `fileInUse`(**回归本切片核心漏洞**);cover/qr/proof/settings 引用同样拒。
- 无引用 → 一个事务内删行 + 入队 `storage.delete_object`(行立即消失、对象由 task 异步删、dedupeKey 去重);中途对象删除 task 失败/重试幂等。
- quarantined → 410;检查与删除并发新增引用 → `FOR UPDATE` 串行,不出现「删了仍被引用」。

**凭证生命周期**
- request → rejected/cancelled 入队 cleanup(`runAfter` 正确);宽限内不删;到期 handler 删 proof(摘 `proofFileId`、删 file、入队 storage 删除)、**保留 request 行与审计**。
- **handler 按当前设置重算 due**:approved 窗口内设置改长 → handler `deferUntil` 顺延;改回 0 → no-op 保留;env 宽限改动同理(改长顺延)。
- **approved/reversed 保留**:设置=0(默认)→ 不排单、永久保留;设置=N>0 → 结算+N 天后清理;首次启用不追溯存量。
- **resubmit 保留旧 proof 至原宽限**:resubmit **不立即删**旧 proof;旧 proof 的原 cleanup task(rejected+宽限)到点经「脱离 + 未引用」分支删之 → 旧凭证恰在原宽限期到期回收;新 pending 请求被保留。
- 清理对象删除 task 幂等(已删=成功);保留 `payment_requests` 行与审计。

**配额**
- 用户日内第 21 次 proof 上传 → `429`;**清理了已上传的 proof 文件后再传仍计入(计数源是持久日志,不随文件删除回退)**;窗口滚动后恢复;env 越界拒绝。
- **并发原子**:同一用户并发多次上传 → per-user advisory 锁串行,日志条数不超 `PAYMENT_PROOF_MAX_PER_DAY`(不出现两个并发都过关)。

**回归**:S1a 上传/下载/quarantine、`cleanupOrphanFile`、现有支付审批/反转/#49 正常。

## 7. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm check:request-bodies
pnpm exec drizzle-kit generate   # 预期无 schema 变更(或仅可选 tombstone 列)
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

## 8. PR

base `main`,Draft 直到真实 PG + 完整 CI 全绿,关联 issue,标题 `fix(files): atomic deletion with references and payment-proof lifecycle`。描述列出:deleteFile 两阶段 + post_files、凭证保留矩阵 + cleanup task、resubmit 清旧、配额、env、全部测试。

## 9. 验收 checklist

- [ ] `deleteFile` 两阶段原子(事务内删行 + 入队 storage 删除,不再先删对象);`FOR UPDATE`
- [ ] 引用检查补 `post_files`;被引用(含任意状态 proof)→ `fileInUse`
- [ ] `payment_proof.cleanup` task:rejected/cancelled 入队 + 宽限;handler 状态/归属/引用守卫 + 两阶段删 + 保留 request/审计;幂等
- [ ] resubmit **不立即删**旧 proof;旧 proof 经原宽限 cleanup task(脱离分支)到期回收
- [ ] cleanup handler 按**当前**设置/env **重算 due + `deferUntil`**(设置改长顺延、改 0 保留)
- [ ] approved/reversed 默认永久保留;创作者设置 `payment_proof_approved_retention_days`>0 时启用审计窗口清理,改回 0 即停(handler 重读、不追溯存量)
- [ ] 配额计数源 = 持久 append-only 日志(不随 proof 清理回退);per-user advisory 锁保证并发原子;`PAYMENT_PROOF_MAX_PER_DAY`(429)、env 越界拒绝
- [ ] 复用 `storage.delete_object` 两阶段范式与 dedupeKey;删除幂等
- [ ] 真实 PG 测试齐;S1a / cleanupOrphan / 支付回归绿

## 已锁定决策（owner 确认 2026-06-25）

1. **approved/reversed = 默认永久保留**,另留**创作者后台可配置项** `payment_proof_approved_retention_days`(默认 0=永久;>0 启用审计窗口清理,不追溯存量)。
2. **rejected/cancelled 宽限 = 30 天**(`PAYMENT_PROOF_RETENTION_DAYS` env 可配)。
3. **配额 = 每用户每日 20 次 proof 上传**(`PAYMENT_PROOF_MAX_PER_DAY`,按上传次数计)。
