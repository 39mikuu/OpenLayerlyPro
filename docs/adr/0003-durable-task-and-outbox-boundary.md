# ADR 0003：持久化任务与 outbox 边界

- **Status**：Proposed ▶
- **相关 issue**：#7（事务性邮件 outbox）、#9（定时发布）

## Context

两个 issue 都需要「业务事务提交后，可靠地异步执行某件事」：

- #7：邮件投递。现状是在事务**之后**内联 `await send...`，失败仅 `logger.error` 吞掉（见 `payment/index.ts`），状态成了但邮件可能永久丢失。
- #9：定时发布。issue 明确写「复用 durable task 机制做定时发布」。

如果 #7 实现成「邮件专用 outbox」，#9 复用时要么重写 #7，要么再造一个轮询器。需要先定边界：是邮件专用，还是通用任务。

## Decision

1. **建一张通用持久化任务表 `tasks`**（database-backed，**单实例**假设，与 #7 文本一致）：

   | 列 | 说明 |
   |---|---|
   | `id` | uuid 主键 |
   | `kind` | `email` / `publish_post` / …（可扩展） |
   | `dedupe_key` | text，唯一；用于幂等，重复入队同 key 不重复执行 |
   | `payload_json` | jsonb，任务参数（如邮件收件人/模板、待发布 post id） |
   | `run_after` | 时间戳，最早执行时间（即时任务 = now，定时发布 = 发布时刻） |
   | `status` | `pending` / `processing` / `succeeded` / `failed` / `dead` |
   | `attempts` / `max_attempts` | 重试计数与上限 |
   | `last_error` | 失败原因 |
   | `created_at` / `updated_at` | 时间戳 |

2. **入队必须在业务事务内**：状态变更与「插入 tasks 行」同提交。这样「状态成了但任务没排上」不可能发生。
3. **派发器（dispatcher）单实例、数据库轮询**：用 `for update skip locked` 领取到期任务（`status='pending' and run_after <= now`），执行后置 `succeeded`，失败按指数退避重排，超过 `max_attempts` 置 `dead`。首版跑在应用进程内的定时器即可，符合 #7「single-instance」。
4. **`kind` 区分处理器**：`email` 处理器发信；`publish_post` 处理器把 post 由 `scheduled` 转 `published`（#9）。两者共用领取/重试/幂等骨架。
5. **幂等**：处理器自身也要幂等（发布任务用条件更新 `where status='scheduled'`；邮件用 `dedupe_key` + 业务层去重），防止重试重复副作用。
6. **后台可视**：#7 要求的「retry view」即 `tasks` 列表 + 手动重试 `failed`/`dead` 行，对所有 `kind` 通用。

## Alternatives

- **邮件专用 outbox（mail_outbox）**：#7 范围最小，但 #9 无法复用，违背其 issue 描述，最终会有两套轮询。否决。
- **引入外部队列（Redis/BullMQ 等）**：能力强，但给「单画师自托管、Docker Compose、可无公网 IP」的部署画像增加一个必须运维的组件，与项目非目标相悖。否决（多实例/HA 已在 #3 deferred）。
- **node-cron 直接定时发布、邮件单独 outbox**：定时发布不持久化，重启即丢，且仍是两套机制。否决。

## Consequences

- ✅ #7 与 #9 共享一套持久化任务骨架；#7 是 `kind='email'` 的首个使用者。
- ✅ 投递/发布从「事务后内联、失败即丢」升级为「事务内入队、可重试、可观测、可手动重放」。
- ✅ 与 ADR 0001/0002 协同：任务执行若改变状态，同样走条件更新 + `recordAudit`。
- ⚠️ 显式假设单实例。多实例下 `skip locked` 可并发安全领取，但应用内定时器会重复触发，需到 HA 阶段再处理（已 deferred）。
- ⚠️ #7 落地时要同时把 `payment/index.ts` 现有内联发信改为入队，属于行为变更，需测试。
- ⚠️ 命名按通用任务（`tasks`）而非 `mail_outbox`，#7 的 issue 标题虽叫 outbox，但实现是通用任务表的一个 kind，PR 描述需说明这一取舍。
