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

### 3.1 保留矩阵（需 owner 确认,见末节;以下为默认)
| 支付状态 | 凭证处置 |
|---|---|
| `pending_review` / `pending_payment` | **保留**(待审/待付) |
| `approved` | **保留**(财务证据 / 退款·拒付取证) |
| `reversed` | **保留**(反转后仍为证据) |
| `rejected` / `cancelled` | **宽限期后清理**(`PAYMENT_PROOF_RETENTION_DAYS` 默认 30) |

### 3.2 终态清理 task `payment_proof.cleanup`
- payload `{ requestId, fileId }`。
- **入队时机**:`payment_requests` 进入 `rejected`/`cancelled` 时(在该状态变更的同事务内)`enqueueTask(runAfter = now + PAYMENT_PROOF_RETENTION_DAYS, dedupeKey=`proof-cleanup:${requestId}:${fileId}`)`。
- **handler**(事务 + `FOR UPDATE` 该 request):
  - 重新读状态:若**已离开** rejected/cancelled(如 resubmit 回到 pending_review)→ **no-op**(凭证又在用);
  - 若 `request.proofFileId !== payload.fileId`(已换/已清)→ no-op;
  - 否则:确认该 file 未被其它引用(post_files/cover/qr/其它 request/settings) → **两阶段删**:`tx.update(paymentRequests).set({ proofFileId: null })` + `enqueueTask(storage.delete_object)` + `tx.delete(files).where(id)`,同事务;**保留 `payment_requests` 行与审计**(只摘除 proof 文件,不动财务记录)。
  - 幂等:file 已不存在 → no-op。
- 宽限期给用户查看驳回原因/再提交的窗口;到期未变即回收存储。

### 3.3 resubmit 清旧凭证
- `resubmitPaymentProof`:在更新 `proofFileId = 新` 的**同一事务**内,取旧 `proofFileId`,若旧 ≠ 新且旧文件不被其它引用 → **立即两阶段删旧 proof**(`enqueueTask(storage.delete_object)` + `tx.delete(files)` 旧行);旧 proof 是被取代的失败尝试,无审计价值(原 reject 审计已记 fileId)。
- 与 §3.2 兼容:若旧 proof 之前已排了 cleanup task,handler 的 `proofFileId !== fileId` / file 不存在守卫使其 no-op,不重复删。

## 4. 每用户凭证配额（防存储滥用)

- 在 `upload-payment-proof` 路由,鉴权后、`saveUploadedFile` 前,加**每用户滚动窗口配额**:`PAYMENT_PROOF_MAX_PER_DAY`(env,默认 20)——统计该用户近 24h 上传的 proof 文件数(`files` where purpose='payment_proof' and created_by=user and createdAt> now-24h),超限 → `429 uploadQuotaExceeded`。
- 与 S1a/#70 既有的 per-user/IP 速率限流叠加(那是突发限流,本配额是日累计防长期堆积)。
- 配额计的是「上传次数」,清理后的历史不减计数(防绕过);用 createdAt 窗口即可。

## 5. Schema / env / 迁移

- **无新表**;`payment_requests`/`files` 字段够用(`proofFileId` 置 null 即摘除)。如需记录清理时间可选加 `files.deleted_at` tombstone——**默认不加**(两阶段删除是真删行 + 异步删对象,无需软删)。确认 `drizzle-kit generate` 无意外 schema 变更。
- env(有界正整数,越界拒绝,沿用既有写法):
  ```text
  PAYMENT_PROOF_RETENTION_DAYS    # 默认 30,rejected/cancelled 凭证宽限
  PAYMENT_PROOF_MAX_PER_DAY       # 默认 20,每用户日上传配额
  ```
  `.env.example` 同步;测试默认/合法/越界拒绝。

## 6. 测试（真实 PG)

**deleteFile**
- 被 `post_files` 引用的 content_image → `deleteFile` 拒 `fileInUse`(**回归本切片核心漏洞**);cover/qr/proof/settings 引用同样拒。
- 无引用 → 一个事务内删行 + 入队 `storage.delete_object`(行立即消失、对象由 task 异步删、dedupeKey 去重);中途对象删除 task 失败/重试幂等。
- quarantined → 410;检查与删除并发新增引用 → `FOR UPDATE` 串行,不出现「删了仍被引用」。

**凭证生命周期**
- request → rejected/cancelled 入队 cleanup(`runAfter` 正确);宽限内不删;到期 handler 删 proof(摘 `proofFileId`、删 file、入队 storage 删除)、**保留 request 行与审计**。
- 宽限内 resubmit 回 pending_review → cleanup handler no-op(凭证又在用);approved/reversed 永不被 cleanup 排单。
- resubmit:旧 proof 立即两阶段删、新 proof 生效;旧 proof 同时有 cleanup task 时不重复删(守卫 no-op)。
- 清理对象删除 task 幂等(已删=成功)。

**配额**
- 用户日内第 21 次 proof 上传 → `429`;窗口滚动后恢复;清理历史不减计数。env 越界拒绝。

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
- [ ] resubmit 同事务清旧 proof;与 cleanup task 守卫不重复删
- [ ] approved/reversed 凭证保留,永不自动删
- [ ] 每用户 `PAYMENT_PROOF_MAX_PER_DAY` 配额(429);env 越界拒绝
- [ ] 复用 `storage.delete_object` 两阶段范式与 dedupeKey;删除幂等
- [ ] 真实 PG 测试齐;S1a / cleanupOrphan / 支付回归绿

## 需 owner 确认

1. **保留矩阵**:`approved`/`reversed` 凭证**永久保留**(默认)还是「审计窗口 N 月后也清理」?
2. **宽限期**:`rejected`/`cancelled` 默认 30 天是否合适?
3. **配额**:每用户每日 20 次 proof 上传是否合适,还是按「未清理保留数上限」计?
