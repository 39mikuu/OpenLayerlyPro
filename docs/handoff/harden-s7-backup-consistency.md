# 交接：S7 备份一致性硬化

> 自包含实现说明。现有 `scripts/backup.sh`、`scripts/restore.sh` 和 `docs/deployment/backup-restore.md` 已完成基础备份/恢复并于 2026-06-19 演练。本切片不重写备份机制，只关闭热备时点差、恢复任务重放、DB↔存储漂移、外部密钥和 Stripe 实时状态之间的一致性缺口。属 v1.0 安全硬化 S7（epic #64）。
>
> 实现 PR 必须基于最新 `main`，保持 Draft，直到真实 PostgreSQL、local/S3 收敛测试、shellcheck、隔离恢复演练和完整 CI 全绿。

## 0. 不可违反的不变量

1. **恢复不能触发新的数据丢失。** 特别是恢复 DB 重新引用的对象，绝不能被快照里的旧 `storage.delete_object` 任务删除。
2. **已确认的支付事件不能丢失。** Stripe webhook 在事件+task 落库后即返回 2xx；恢复时不能假设 Stripe 会再次投递，也不能用订阅 reconcile 替代一次性付款、expired、refund、dispute 等事件重放。
3. **DB↔存储漂移必须先收敛再对外服务。** 缺失对象写入 S1a quarantine 后授权下载返回 410；孤儿对象走 S1b cleanup。不得在 app 已接受流量后才开始补救。
4. **任务恢复必须尊重领取条件、独立领域锁和全局 dedupeKey。** 不得产生 `processing + lease_until=NULL` 的永久 stranded 行，不得用终态行占住可复用 dedupeKey，也不得保留已耗尽的 attempts。
5. `CONFIG_ENCRYPTION_KEY(_FILE)`、`SESSION_SECRET` 的恢复语义必须真实；不得声称单归档包含所有外部秘密。
6. 既有 `umask 077`、归档 `chmod 600`、归档路径校验、直配 `CONFIG_ENCRYPTION_KEY` 时拒绝“单归档完整恢复”、forward-only 迁移等安全属性不得回退。
7. Stripe DB 快照与实时状态无法原子一致；目标是事件重放 + reconcile + 明确残余，不承诺完全时点一致。

## 1. 当前缺口

| 缺口 | 当前行为 | 风险 |
|---|---|---|
| DB 与 local uploads 非原子 | 先 `pg_dump`，后复制 uploads | 快照内悬挂引用或孤儿字节 |
| tasks 原样恢复 | app 启动后 dispatcher 直接领取 | 删除已恢复文件、重复邮件、事件丢失或 stranded |
| provider event 双层状态 | `tasks` 与 `payment_provider_events` 各有 status/lease/attempts | 只复位一层会把 task 标成功但事件未处理 |
| 恢复后才收敛 | app 先启动 | 收敛窗口内缺失对象仍可能 500 |
| 归档无内容校验 | 仅检查文件非空 | 截断/损坏发现过晚 |
| SESSION_SECRET 不入档 | 仅 env/外部管理 | 运维误判恢复完整性 |
| Stripe 已前进 | DB 回滚到旧时点 | 订阅、发票和撤销状态陈旧 |
| app/schema 版本约束不明确 | 依赖启动时前滚迁移 | 新 dump 恢复到旧镜像会失败或损坏 |

## 2. 备份期模型与完整性

1. 默认保留热备顺序 `pg_dump(T1) → local uploads(T2)`，明确记录 T1–T2 窗口。低写入站点依靠 §4 收敛；需要完全自洽时提供可选步骤：先停止 app，备份完成后再启动。
2. `FORMAT_VERSION` 升到 2。先生成 `manifest.env`，再生成 `checksums.sha256`，校验范围覆盖归档中的所有有效载荷成员（`db.sql`、manifest、配置密钥、uploads 全部文件或 S3 marker），**不包含 `checksums.sha256` 自身**。
3. restore 在任何数据库破坏操作前验证 archive 路径安全、必需成员和全部 sha256；任一失败立即中止。`FORMAT_VERSION=1` 旧档允许恢复，但必须 warn 无校验和保护。
4. manifest 记录应用版本、最新 migration 标识、storage driver、uploads 是否包含和创建时间，供 §7 校验与演练记录。

## 3. app 启动前的 schema 对齐与任务中和

### 3.1 固定恢复顺序

正常 app/dispatcher 在全过程保持停止：

```text
解包并校验归档
→ 启动 postgres
→ 替换并导入 DB
→ 还原密钥与 local uploads（S3 则先完成 bucket 时点恢复）
→ 用 one-off app 容器运行 forward migrator
→ 执行任务/支付事件中和 SQL
→ 用 one-off app 容器运行 DB↔存储收敛命令
→ 启动正常 app/dispatcher
→ 等待 /api/ready
→ 核对事件重放、reconcile 和收敛简报
```

旧归档可能缺 `tasks`、`payment_provider_events` 或 quarantine 字段，因此必须先单独运行目标镜像中的 migrator，再执行中和/收敛。不能依赖正常 app entrypoint 迁移，因为它会同时启动 dispatcher。

### 3.2 必须避开的任务 footgun

- `processing` 只有 `lease_until < now()` 才可重领；清成 NULL 会永远不可领取。
- `enqueueTask` 对全表唯一 `dedupe_key` 使用 `onConflictDoNothing`；把可复用 key 的旧行置 dead/succeeded 会阻止未来合法入队。
- `attempts >= max_attempts` 无法领取；恢复复位必须给出新的重试预算。
- `payment_provider_events` 有独立的 status/locked_by/lease_until/attempts；只改 task 不等于事件可重放。

### 3.3 分类中和

1. **`storage.delete_object` 非终态 task：删除 task 行，不删除对象。** 这同时取消快照里的危险删除意图并释放对象级 dedupeKey。恢复收敛若确认对象仍是孤儿，会重新走 S1b 原语入队。
2. **支付 provider event：以非终态 event 行为事实来源，成对复位并补齐 task。**
   - 对 `payment_provider_events.status in ('received','processing','failed')`：设回 `received`，清 `locked_by/lease_until/error`，`attempts=0`。
   - 对每一行按 `payment-provider-event:<eventRowId>` **upsert/重建恰好一条** `payment_provider_event.dispatch` task；不能只更新现存 task，因为缺失 task 会让已 2xx 的事件永久无人处理。
   - task 设 `pending`、`run_after=now()`，清 `locked_at/locked_by/lease_until/last_error`，`attempts=0`，payload 指向正确 eventRowId。
   - 已终态 event 行不回滚；若快照处于“event 已 processed、task 仍 processing”的窄窗口，旧 task 可安全复位后由 handler no-op/succeed，或明确归一为 succeeded，但不得重新应用业务事件。
3. **业务 `email` 按模板处理。**
   - `renewal_reminder`：复位为 pending；发送前已有 subscription/period stale 检查。
   - `membership_activated`、`membership_revoked`、`payment_rejected`：默认置 `dead` 并写 `last_error='neutralized on restore: delivery outcome unknown'`，不自动重发可能已发送的通知；后台可见并由运维决定是否人工补发。
4. **其余非终态 task：复位为可领取。** 设 `pending`、`run_after=now()`、清全部锁/错误、`attempts=0`。包含 `auth.login_code_email`、`publish_post`、`subscription.renewal_reminder`、`file.cleanup_orphan`、`payment_proof.cleanup` 等；依赖各 handler 的幂等/stale no-op。登录码若 SECRET 已变化，解密失败进入明确 dead，用户重新申请。
5. **`subscription.reconcile` 全局 task：无论快照状态都归一为一条可领取 pending 行。** 固定 dedupeKey 不能留终态占位；可 update/upsert 或删除后重建，`run_after=now()`、`attempts=0`。

所有中和操作在单个 SQL 事务中完成；失败则 restore 中止，不得启动 app。

## 4. app 启动前的 DB↔存储收敛

实现可重复执行的 one-off 命令（例如构建为 `dist/restore-converge.mjs`），复用 S1a/S1b/storage 原语，不新增 schema：

1. **DB 行引用对象缺失 → 写 quarantine。** 遍历 files，按各自 storage driver/bucket/object key 做存在性探测；缺失时写 `quarantined_at`、`quarantine_reason='missing after restore'` 和现有 remediation/version 字段。必须验证 `prepareAuthorizedDownload` 随后返回 410，而不是继续 `getObject` 抛错。
2. **对象无 files 行 → 走 orphan cleanup。** local 枚举受控 uploads 根；S3 只枚举配置 bucket/prefix。使用分页、批量上限和 dry-run/日志简报，不允许因空/错 prefix 扫整个未知 bucket；删除仍通过既有 `storage.delete_object` task 原语完成。
3. 收敛输出机器可读与人类可读简报：扫描数、缺失数、新 quarantine 数、孤儿数、入队数、截断/错误数。任一未处理错误使命令非零退出，restore 不启动 app。
4. S3 归档不含对象。运维应先把 bucket/version 恢复到接近 DB 快照时点，再执行收敛；否则前进后的合法对象可能被识别为孤儿。文档必须把顺序和残余风险写清楚。

## 5. SESSION_SECRET

`SESSION_SECRET` 不写入应用归档，必须在 backup-restore 文档和 production checklist 明确：

- 与 `CONFIG_ENCRYPTION_KEY` 一样单独安全备份；无缝恢复必须提供备份时相同值。
- 丢失/轮换后所有会话失效，既有验证码 hash 无法用旧码验证，在途加密登录码任务可能无法解密并 dead；用户重新登录/申请即可。属于可恢复但强制全员重新登录，不得描述为完全无损。

## 6. Stripe 时点错配

- §3 先重放所有已落库但非终态的 provider event；这是一次性付款、expired、refund、dispute 等的唯一可靠恢复路径之一。
- `subscription.reconcile` 随后作为额外兜底，拉取实时订阅状态和已支付发票；不能替代事件重放。
- ready 后输出提示，要求核对恢复时点附近的支付、撤销、争议和订阅状态。不承诺 DB 快照与实时 Stripe 完全一致。

## 7. 版本约束

- 目标 app schema 必须等于或新于归档 migration 标识；更新 schema 的 dump 不得恢复到更旧镜像。
- restore 在 drop DB 前读取 manifest 并检查目标镜像兼容性；无法确认时默认中止而不是猜测。
- 旧 app → 新 app 通过 one-off migrator 前滚；禁止自动 down migration。

## 8. 测试与恢复演练

- checksum：篡改任一 payload 后 restore 在 drop DB 前失败；v1 旧档 warn 后可走兼容路径。
- 删除 task：非终态 `storage.delete_object` 行被删除，同 dedupeKey 可重新入队，已恢复引用对象未被删除。
- provider event：覆盖 processing 且 lease 未过期、attempts 饱和、task 缺失、task/event 状态窄窗口；中和后每个非终态 event 恰有一个可领取 task，能够幂等处理。
- email：renewal reminder 可重放；其他三类变 dead 且不会在“快照后已发送”场景重复投递。
- 其他 task：原 processing/failed 均变可领取 pending，attempts=0；stale handler 成功 no-op。
- reconcile：快照含 succeeded/dead/pending 多种全局行时，最终只有一条可领取任务并确实运行。
- 收敛：local 与 S3 fake/provider 测试覆盖缺失→quarantine→授权 410、孤儿→cleanup、分页/上限、错误非零退出；正常 app 尚未启动。
- 版本：旧 schema dump 先迁移再中和；新 dump + 旧镜像在破坏 DB 前被拒绝。
- 隔离 E2E：备份 → 独立 Compose 恢复 → 中和/收敛完成 → 启动 app → `/api/ready` 绿 → 内容、会员、加密配置、文件与任务状态核对。
- `shellcheck`；`pnpm lint && pnpm format:check && pnpm exec tsc --noEmit && RUN_DB_INTEGRATION_TESTS=true pnpm test && pnpm build:migrator && pnpm build`。

## 9. 验收 checklist

- [ ] archive v2 有完整 sha256；v1 兼容且明确警告
- [ ] 正常 app 全程停止，迁移→中和→收敛完成后才启动
- [ ] `storage.delete_object` 危险 task 被删除并释放 dedupeKey
- [ ] 每个非终态 provider event 被复位且补齐唯一 dispatch task；不依赖 Stripe 重投
- [ ] email 按模板中和；未知投递结果不自动重复发送
- [ ] 其余非终态 task 可领取、attempts=0、锁字段完整清理
- [ ] 全局 `subscription.reconcile` 归一为可领取任务
- [ ] 缺失对象已写 quarantine 并返回 410；孤儿经受控 cleanup
- [ ] SESSION_SECRET 外部备份与丢失语义写明
- [ ] Stripe 残余与版本约束写明
- [ ] local/S3 隔离恢复演练、shellcheck 和完整 CI 全绿

## 已锁定决策（owner 确认 2026-06-26）

- S7 只硬化既有方案，不重写备份机制；热备默认、停 app 备份为可选强一致步骤。
- 固定顺序为导入 → 还原存储 → one-off 迁移 → 事务中和 → one-off 收敛 → 启动正常 app。
- 删除恢复出的非终态 storage delete task；支付事件成对复位并按 event 行补齐 dispatch task，绝不批量 dead。
- email 根据模板决定重放或 dead；其余任务清锁并重置 attempts，依赖幂等/stale no-op。
- 缺失对象实际写 S1a quarantine，孤儿使用 S1b cleanup；收敛失败不启动 app。
- SESSION_SECRET 外部备份；丢失意味着强制重新登录。
- Stripe 采用事件重放 + reconcile + 人工核对，不承诺实时原子一致。
