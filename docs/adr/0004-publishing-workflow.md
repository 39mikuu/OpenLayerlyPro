# ADR 0004：文章发布工作流——派生调度态 + token fencing

- **Status**：Accepted ✅（2026-06-19）
- **相关 issue**：#9
- **依赖**：ADR 0002（事务内审计）、ADR 0003（durable tasks）

## Context

当前文章只保存 `draft / published / archived` 三种状态，后台通过
`setPostStatus()` 无条件改写状态。立即发布的运行事件在事务提交后写入，缺少条件更新、
统一审计和 stale-state 错误。系统也没有调度字段、定时发布 handler、权限预览或完整的
文章状态迁移约束。

Issue #9 要求补齐：

- 草稿预览与访客权限预览；
- 定时发布和取消/改期；
- 文章、翻译和附件在各发布状态下的一致性；
- 与现有 durable task、审计和主题边界对齐。

这里最危险的竞争不是“同一时刻执行两次”，而是旧任务在取消或改期后仍然到期。如果
task payload 只有 `postId`，旧任务无法判断自己对应哪一版计划，可能提前发布新计划。

## Decision

### 1. 数据状态

`posts.status` 保持：

```text
draft | published | archived
```

不增加 `scheduled`。在 `posts` 新增：

```text
scheduled_at  timestamp with time zone nullable
schedule_token uuid nullable
content_updated_at timestamp with time zone not null
```

后台显示状态由数据库字段派生：

```text
draft     = status=draft and scheduled_at is null
scheduled = status=draft and scheduled_at is not null
published = status=published
archived  = status=archived
```

约束：

- `scheduled_at` 与 `schedule_token` 必须同时为空或同时非空；
- `status != draft` 时两者必须为空；
- `published` 必须有 `published_at`；
- `draft` 和 `archived` 不依赖 `published_at` 判断状态；归档后保留历史
  `published_at`，恢复草稿时清空它。

迁移增加 check constraints，并为后台调度列表增加
`(status, scheduled_at)` 索引。首版不增加文章 version 列；发布命令通过来源状态和
`schedule_token` 条件更新提供并发保护。

`content_updated_at` 表示原文内容版本，而不是整行最后更新时间：

- 创建文章时与 `created_at` / `updated_at` 一起初始化；
- migration 用现有 `updated_at` 回填；
- 仅 `title / summary / body / original_locale` 改变时更新；
- schedule/reschedule/cancel/publish/archive/restore 不更新；
- visibility、required tier、cover 和附件关联变化不更新；
- `updated_at` 仍记录任何 post 行更新，不能再用于翻译 stale 判定。

### 2. 状态迁移矩阵

只允许：

| 来源显示态 | 命令 | 目标显示态 |
|---|---|---|
| draft | schedule | scheduled |
| draft | publish | published |
| scheduled | reschedule | scheduled |
| scheduled | cancel schedule | draft |
| scheduled | publish | published |
| published | archive | archived |
| archived | restore | draft |

禁止其它直接迁移。所有状态改变必须经过 content/publishing canonical service，不允许
API route 或 UI 直接更新 `posts`。

所有命令使用数据库事务和条件更新（或先 `FOR UPDATE` 行锁再条件更新）。来源状态、
预期 token 或其它并发前置条件不再成立时返回稳定的 `409 postPublishingStale`，不得
静默覆盖新状态。

### 3. 调度 token

每次 schedule 或 reschedule 都生成新的随机 `schedule_token`，并在同一事务内创建：

```text
kind: publish_post
dedupe_key: publish_post:<postId>:<scheduleToken>
payload: { postId, scheduleToken, correlationId, schedulingAuditId }
run_after: scheduledAt
```

仅有 `scheduled_at` 不足以防 stale task：

1. 文章计划在 10:00 发布，任务 A 已入队；
2. 管理员取消后改成 12:00，任务 B 已入队；
3. A 仍会在 10:00 被 dispatcher 领取；
4. 如果 A 只检查 `scheduled_at <= now` 或只携带 `postId`，它无法证明自己对应旧计划。

`schedule_token` 是计划版本的 fencing token。改期生成新 token，取消、立即发布、归档
或恢复会清空 token；因此旧任务即使仍存在，也不能命中新计划。

不删除旧 tasks。旧 token 对应任务执行后以成功 no-op 结束，保留可观测历史，也避免
对 processing/leased task 做危险的跨状态取消。

### 4. 定时发布处理器

`publish_post` handler 校验 payload 后，在一个事务中执行条件发布：

```text
post.id = payload.postId
status = draft
scheduled_at <= database_now
schedule_token = payload.scheduleToken
```

命中时：

```text
status = published
published_at = database_now
scheduled_at = null
schedule_token = null
updated_at = database_now
```

随后在同一事务写：

```text
entity_type = post
entity_id = post.id
action = post.published
actor_type = system
actor_id = null
correlation_id = payload.correlationId
causation_id = payload.schedulingAuditId
```

schedule/reschedule 事务先写 `post.scheduled` / `post.rescheduled` audit，再把该
audit event 的 id 与 correlation id 写入 task payload。定时发布审计复用这两个值，因此
`causation_id` 仍严格指向 `audit_events.id`，不改变 ADR 0002 已接受的语义。task id
只用于 dispatcher 领取、fencing 和运行追踪。

以下情况都是成功 no-op，task 最终标为 `succeeded`，可附简短 note：

- 相同 task 重复执行；
- post 不存在；
- 计划已取消；
- 计划已改期、token 已变化；
- 已被管理员立即发布；
- 已发布后又归档或恢复草稿；
- 任何不再满足来源状态/token 的 stale task。

生产环境中的 task claim 和 publish handler 必须使用同一 PostgreSQL 时间源：

- `run_after <= now()`；
- `lease_until < now()`；
- 新 lease、renewal 和 failure backoff 都从 PostgreSQL `now()` 计算；
- publish handler 也用同一事务的 PostgreSQL 时间判断 `scheduled_at <= now()`。

测试辅助路径可以注入固定时间，但生产路径不能用应用进程 `new Date()` 决定 task 到期或
lease。这样“同一 token 仍匹配但尚未到期”在正常执行中不会发生。

如果该异常仍因手工数据或测试注入出现，不能走普通 failure/backoff 并继续消耗 attempts。
handler 应返回精确 `scheduledAt`，dispatcher 使用带 fencing 的
`deferTask(id, lockToken, scheduledAt)` 把任务恢复为 pending、设置准确 runAfter，并撤销
本次 claim 增加的 attempt。`deferTask` 只是防御路径，不能替代统一数据库时间。

### 5. 确定性 task 错误

无效 `publish_post` payload（缺字段、非法 UUID）不会因重试而恢复，不应消耗五次执行。
实施时为通用 task dispatcher 增加最小的 non-retryable 错误通道：

- handler 对 payload schema 失败抛 `PermanentTaskError`；
- dispatcher 使用当前 claim token fencing，将任务直接置 `dead` 并记录安全错误摘要；
- 数据库暂时不可用或事务冲突仍走现有 retry/backoff；
- “同 token 但尚未到期”使用精确 defer，不进入失败退避，也不消耗执行预算；
- post 不存在或 token/state stale 属于幂等业务 no-op，返回 success，不是错误。

后台任务 API 继续只返回安全 `TaskAdminView`，不返回 payload。

### 6. 立即发布、归档与恢复

- draft 立即发布：条件为 `status=draft AND scheduled_at IS NULL`；
- scheduled 立即发布：请求必须携带当前 `expectedScheduleToken`，更新条件同时匹配 token；
- 立即发布总是清空 `scheduled_at` 和 `schedule_token`；
- archive 只允许 `published -> archived`，并防御性清空调度字段；
- restore 只允许 `archived -> draft`，清空调度字段和 `published_at`；
- cancel/reschedule 必须携带当前 `expectedScheduleToken`；
- schedule 只允许未调度 draft，不能把 scheduled 当作第一次 schedule 覆盖。

立即发布与到期 task 竞争时，只有一个事务能命中条件更新。胜者完成发布和审计；败者读取
当前状态后返回 `409`（管理员命令）或 success no-op（旧 task）。不会产生第二次
`post.published` 审计。

### 7. 内容版本语义

定时发布不保存正文快照。执行时读取数据库中的最新：

- 文章标题、摘要、正文和 visibility；
- cover 和 post-file 关联；
- 已发布翻译。

管理员 schedule 后继续保存的内容和附件会成为最终发布内容。这是明确的
“publish latest at execution time”语义。若将来需要冻结版本，应单独设计内容版本表，
不能把快照塞进 task payload。

普通内容编辑不改变 `scheduled_at` 或 `schedule_token`。编辑页面必须明确显示“已计划，
后续保存会影响最终发布内容”。

只有 draft / scheduled 文章可编辑内容、visibility、required tier、cover 和附件关联。
published / archived 的更新、attach、detach 或 cover 替换必须返回
`409 postNotEditable`。修改已发布内容的明确流程是：

```text
published -> archived -> draft (restore) -> edit -> publish/schedule
```

首版不支持 published live edit。

### 8. 翻译一致性

- 不新增 translation 的 scheduled 状态；
- 发布 parent post 不自动发布 translation draft；
- 只有 `post_translations.status=published` 的目标语言版本可用于公开渲染；
- 没有 published 目标语言时回退原文；
- parent post 为 draft、scheduled 或 archived 时，普通访客不能公开读取任何译文；
- 文章 archive 或 restore 不批量修改 translation 状态；
- 恢复并再次发布后，原先 published translation 可再次公开；
- 保留每个 post/locale 仅一个 published translation 的现有约束。
- translation 的 `source_updated_at` 记录 source post 的 `content_updated_at`；
- stale 判定比较 `posts.content_updated_at > translation.source_updated_at`；
- 原文内容更新后，published translation 继续公开，但后台显示源内容已变化警告；
- 不自动下架已批准译文；draft/machine translation 使用 stale 提示重新生成或审核。

换言之，translation 的 `published` 表示“该语言版本已获创作者批准”，parent post 的
`published` 表示“整篇文章当前可公开”。公开可见性要求两者同时满足。

### 9. 附件一致性

- 非 published 文章的 `content_image` / `content_attachment` 不允许普通用户下载；
- admin 可通过预览专用接口访问；
- published 文章继续按 visibility 和 required tier 判断；
- 不复制附件，不做发布快照；
- schedule 后增加、删除或替换的附件在执行时生效；
- 同一文件关联多个文章时，只要任一 published 文章允许当前真实用户访问，现有公开
  下载语义保持不变。

预览不能把 admin session 的真实直通结果误当成模拟 audience 结果。preview view builder
先按模拟 audience 决定是否包含 body/附件；只有允许时才生成 admin-only preview URL。

### 10. 权限判定与预览

定义不访问 session、不创建用户/会员数据的纯 audience：

```ts
type PostAudience =
  | { type: "guest" }
  | { type: "logged_in_without_membership" }
  | { type: "tier"; level: number };
```

真实访问和预览共用纯判定核心：

```text
public: guest/login/tier 均允许
login: guest 拒绝；login/tier 允许
member: 仅 tier.level >= requiredTier.level 允许
member 且 requiredTier 缺失: 全部拒绝（配置错误，fail closed）
```

真实访问 wrapper：

- 权限核心内部 admin 对已进入 preview 的内容保持直通；
- guest 映射为 guest；
- 已登录无有效会员映射为 logged_in_without_membership；
- 有效会员映射为 tier(level)；
- public 页面和 public API 在进入 audience 判定前一律要求 parent post 为 published，
  admin 也不例外；普通 slug/API 对 draft、scheduled、archived 统一 404；
- admin 查看非 published post 只能使用专用 preview route。

预览页面使用 `/admin/posts/[id]/preview`，放在独立的 admin preview route group：

- 服务端 `requireAdmin()`；
- 不使用 dashboard sidebar，也不经过 public `SiteLayout`，因此不执行 custom footer code；
- 包裹 `.site-theme`，调用当前活动主题的 `PostDetail` 组件；
- 显示固定、明显且不可被主题隐藏的 admin preview 横幅；
- 支持 locale 和 guest/login/tier audience 切换；
- locale 只使用 published translation，否则回退原文，不预览 translation draft；
- 预览不会创建伪 session、用户、membership 或下载日志。
- 普通公开 post URL/API 不再承担 admin preview，避免执行 public chrome/custom footer 或
  产生普通下载路径。

预览图片/附件 URL 使用专用接口：

```text
GET /api/admin/posts/:postId/preview/files/:fileId
```

接口必须 `requireAdmin()`，验证 file 是该 post 的 cover 或 post-file 关联，并由服务端直接
stream local/S3 object；不得返回可脱离 admin session 使用的 S3 signed redirect。这样即使
URL 被复制，非 admin 也无法访问。模拟 audience 不允许时，view builder 根本不生成这些
URL。

### 11. 审计

至少定义：

```text
post.scheduled
post.rescheduled
post.schedule_cancelled
post.published
post.archived
post.restored
```

管理员命令使用 `{ type: "admin", id: adminId }`；task 发布使用 system actor。文章审计
快照只允许：

```text
status
publishedAt
scheduledAt
scheduleToken
```

不复制标题、正文、附件、翻译或其它可能膨胀/敏感的数据。每个状态命令在同一事务内只写
一条 post audit。audit 写入失败必须回滚 post 更新；schedule/reschedule 的 task enqueue
失败也必须同时回滚 post 更新和 audit。

### 12. 并发与失败规则

- schedule/reschedule/cancel/publish/archive/restore 全部使用事务；
- schedule/reschedule/cancel 使用行锁和 token 条件；其它命令使用来源状态条件；
- stale 管理员请求返回 `409 postPublishingStale`；
- 旧 token 永远不能覆盖或发布新计划；
- 立即发布、archive、restore 清空不适用的 schedule；
- audit 失败回滚状态变更；
- enqueue `publish_post` 失败回滚 schedule/reschedule 和 audit；
- task 成功 no-op 不写 post audit；
- 对同一计划重复调用 handler 最多产生一次状态更新和一次 `post.published` audit。
- schedule/reschedule 的 audit event id 和 correlation id 必须进入 task payload；
  publish audit 使用它们恢复完整因果链。
- task claim、lease、renewal、backoff 和 handler due check 使用 PostgreSQL 时间；
  应用进程时钟不能消耗尚未到期任务的 execution attempts。

## Alternatives

- **增加 `scheduled` post status**：会扩展所有 status 枚举、查询和 translation/file
  判断；scheduled 本质是 draft + 时间，不值得成为第四个存储态。否决。
- **只存 `scheduled_at`**：无法区分取消/改期前后的任务，旧 task 可发布新计划。否决。
- **取消时删除旧 task**：可能与已领取 task 竞争，也破坏任务历史；token fencing 更可靠。
  否决。
- **把正文/附件快照存入 task**：payload 膨胀，和编辑器数据模型重复，还需要文件引用
  生命周期。否决。
- **预览创建临时用户或会员**：污染真实数据、审计和权限查询。纯 audience 更安全。否决。
- **预览直接复用公开 signed URL**：链接可能在 TTL 内脱离 admin session 被使用。专用
  admin streaming endpoint 更符合预览边界。否决。

## Consequences

- ✅ 保持现有三态模型和公开查询，scheduled 是低侵入派生态。
- ✅ token fencing 让取消、改期、立即发布和 task 重试都具备确定性。
- ✅ 状态、审计和 task enqueue 同事务，不会出现已计划但无任务的半成功。
- ✅ 真实访问与预览共用权限核心，不会因 UI 模拟产生另一套规则。
- ✅ 非 published 内容不再通过普通公开 URL 对 admin 暴露，安全预览边界唯一。
- ✅ 独立内容版本时间避免调度和状态操作误报翻译 stale。
- ✅ 主题仍只负责展示，Core 继续负责状态、权限和 URL。
- ⚠️ schema 需要两个 nullable 调度字段、`content_updated_at`、check constraints 和索引。
- ⚠️ 现有 task 时间逻辑需统一到 PostgreSQL，并增加极端提前领取的精确 defer 防线。
- ⚠️ task dispatcher 需要最小 permanent-failure 通道，避免坏 payload 无意义重试。
- ⚠️ admin-only S3 预览需要服务端代理流量，预览大附件会经过应用进程；这是安全优先的
  有意取舍，不改变正常公开下载路径。

## Non-goals

- Issue #10 tags/categories；
- 内容版本历史或正文/附件快照；
- 多实例/HA dispatcher；
- Redis、BullMQ 或其它外部队列；
- 第三方主题 API；
- 自动发布 translation draft；
- SEO、通知订阅、邮件通知或社交媒体同步；
- 修改公开站点的主题设计；
- 新的文件上传或媒体管理能力。

## Proposed review points

ADR 转为 Accepted 前确认：

1. 接受 schedule 后继续编辑会改变最终发布内容；
2. 接受 malformed durable task 直接 `dead`，而 stale business task 成功 no-op；
3. 接受 preview S3 文件由应用服务端代理，以保持 admin-only；
4. 接受恢复草稿时保留 published translation 状态，但 parent draft 继续阻止其公开。
5. 接受 published/archived 必须先 archive/restore 回 draft 才能编辑，不支持 live edit。
