# 交接：#9 完整发布工作流

> 给实现 agent 的自包含说明。设计依据：
> [ADR 0004](../adr/0004-publishing-workflow.md)（Proposed）。动工前先确认 ADR 已 review；
> 实施不得绕过 canonical publishing service。

## 0. 范围与前置条件

Issue #7 已合并，当前 `main` 已有：

- 通用 `tasks` 表、事务内 `enqueueTask()`；
- `FOR UPDATE SKIP LOCKED` claim、lease、heartbeat、fencing；
- `failed/dead` 重试模型和 admin task view；
- `audit_events` / `recordAudit(tx, ...)`。

本任务实现 scheduled publishing、文章状态机、exact-theme admin preview 和权限 audience
预览。不要顺手实现 #10 tags/categories、内容版本历史、通知、SEO、多实例 worker 或插件
接口。

## 1. 当前入口与已知缺口

### Schema

- `src/db/schema/index.ts`
  - `posts.status` 已是 `draft | published | archived`；
  - 目前没有 `scheduledAt` / `scheduleToken`；
  - translation 有独立 `draft | published | archived`；
  - `post_files` 支持 cover/image/attachment/preview/thumbnail；
  - `tasks.kind` 是开放 text，可直接增加 `publish_post`。

### Content

- `src/modules/content/index.ts`
  - `createPost()` 固定创建 draft；
  - `updatePost()` 更新内容和权限字段；
  - `setPostStatus()` 无条件更新，发布后事务外 `recordEvent()`，必须替换；
  - `listPosts({ publishedOnly: true })` 是公开列表门禁；
  - `getLocalizedPost()` / `localizePostCards()` 只读取 published translation；
  - `canAccessPost()` 混合了 session user、tier 查询和纯 visibility 判断，需拆核心；
  - `listPostFiles()` / `listPostsForFile()` 已提供附件关联。

### Tasks / audit

- `src/modules/tasks/index.ts`：`enqueueTask`、claim、fencing、retry；
- `src/modules/tasks/handlers.ts`：当前只支持 email；
- `src/modules/tasks/dispatcher.ts`：handler 抛错会自动 failed/dead；
- `src/modules/audit/index.ts`：`recordAudit()` 接受事务 client；
- 需要增加 `publish_post` handler，以及 malformed payload 的 non-retryable dead 通道。

### Public and admin UI

- `src/app/(site)/posts/[slug]/page.tsx` 已用 active theme `PostDetail`；
- `src/modules/theme/types.ts` 的 `PostDetailView` 已包含权限、正文、图片和附件；
- `src/components/admin/post-editor.tsx` 目前只有 publish/archive；
- `src/app/admin/(dashboard)/posts/[id]/page.tsx` 只显示存储 status；
- 当前没有 restore、schedule、cancel、reschedule 或 preview。

### Download

- `src/modules/download/index.ts` 对普通用户只允许关联到 published post 的内容文件；
- admin 在现有下载路径直通；
- S3 正常下载可能返回 signed redirect，不适合严格 admin-only preview；
- preview 需要专用 admin streaming endpoint，不记 download log。

## 2. Schema 与 migration

在 `posts` 增加：

```ts
scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
scheduleToken: uuid("schedule_token"),
```

增加：

```text
posts_status_scheduled_idx(status, scheduled_at)
```

增加 check constraints（名称按 migration 风格调整）：

```sql
(scheduled_at IS NULL) = (schedule_token IS NULL)

status = 'draft'
OR (scheduled_at IS NULL AND schedule_token IS NULL)

status <> 'published'
OR published_at IS NOT NULL
```

迁移步骤：

1. 修改 Drizzle schema；
2. `pnpm exec drizzle-kit generate`；
3. 人工检查 migration 只增加两列、constraints 和索引；
4. 不新增 `scheduled` enum 值；
5. 不修改 translation schema。

现有数据的两个新字段均为 null，迁移无需回填。

`Post` test fixtures、view models 和 API mocks 必须补两个 nullable 字段。

## 3. Publishing service

建议新建：

```text
src/modules/content/publishing.ts
```

或放进 content module 后从 `src/modules/content/index.ts` re-export。API routes 和 task handler
只能调用这里的命令。

建议类型：

```ts
export type PublishingActor =
  | { type: "admin"; id: string }
  | { type: "system"; id: null };

export type DerivedPostState = "draft" | "scheduled" | "published" | "archived";

export function derivePostState(
  post: Pick<Post, "status" | "scheduledAt">,
): DerivedPostState;

export async function schedulePost(
  postId: string,
  input: { scheduledAt: Date; actor: PublishingActor },
): Promise<Post>;

export async function reschedulePost(
  postId: string,
  input: {
    scheduledAt: Date;
    expectedScheduleToken: string;
    actor: PublishingActor;
  },
): Promise<Post>;

export async function cancelPostSchedule(
  postId: string,
  input: { expectedScheduleToken: string; actor: PublishingActor },
): Promise<Post>;

export async function publishPostNow(
  postId: string,
  input:
    | { expectedState: "draft"; actor: PublishingActor }
    | {
        expectedState: "scheduled";
        expectedScheduleToken: string;
        actor: PublishingActor;
      },
): Promise<Post>;

export async function archivePost(
  postId: string,
  input: { actor: PublishingActor },
): Promise<Post>;

export async function restorePost(
  postId: string,
  input: { actor: PublishingActor },
): Promise<Post>;
```

所有函数：

- 外层开启 `getDb().transaction()`；
- 读取需要时用 `FOR UPDATE`；
- 最终 update 仍带来源状态/token 条件，避免 TOCTOU；
- 0 行命中后重新读取，404 用 `postNotFound`，其它使用
  `ApiError(409, "postPublishingStale")`；
- 在同一事务调用 `recordAudit()`；
- 不再调用 `recordEvent("post_published")`。

`scheduledAt` 必须是有效未来时间（`scheduledAt > server/database now`），否则返回
`400 postScheduleTooSoon`。不要在 UI 时钟上做唯一校验。

## 4. Transition matrix 与写入值

| 命令 | 来源条件 | 写入 |
|---|---|---|
| schedule | `status=draft AND scheduled_at IS NULL` | 新 token、scheduledAt、publishedAt=null |
| reschedule | `status=draft AND schedule_token=expected` | 新 token、新 scheduledAt |
| cancel | `status=draft AND schedule_token=expected` | scheduledAt=null、token=null |
| publish draft | `status=draft AND scheduled_at IS NULL` | published、publishedAt=now、清 schedule |
| publish scheduled | `status=draft AND schedule_token=expected` | published、publishedAt=now、清 schedule |
| archive | `status=published` | archived、清 schedule、保留 publishedAt |
| restore | `status=archived` | draft、publishedAt=null、清 schedule |

schedule/reschedule 每次生成 `randomUUID()` token，并在同一事务：

```ts
await enqueueTask(tx, {
  kind: "publish_post",
  dedupeKey: `publish_post:${post.id}:${scheduleToken}`,
  payload: { postId: post.id, scheduleToken },
  runAfter: scheduledAt,
});
```

顺序可以是 update → audit → enqueue，但三者必须在同一 transaction。任何一步抛错，全部
回滚。

普通 `updatePost()` 允许编辑 draft/scheduled 内容，但不得写 `status`、`publishedAt`、
`scheduledAt` 或 `scheduleToken`。

## 5. Audit

在 `src/modules/audit/index.ts` 增加：

```ts
pickPostPublishingAudit(post)
```

只返回：

```text
status
publishedAt
scheduledAt
scheduleToken
```

动作：

| 命令 | action | actor |
|---|---|---|
| schedule | `post.scheduled` | admin |
| reschedule | `post.rescheduled` | admin |
| cancel | `post.schedule_cancelled` | admin |
| immediate/task publish | `post.published` | admin/system |
| archive | `post.archived` | admin |
| restore | `post.restored` | admin |

每个命令生成一个 correlation id。task 发布的 `causationId=task.id`。这会推广 ADR 0002
对 causation 的原始窄定义；ADR review 若要求 audit-only causation，则实施前改用独立
`sourceTaskId` 字段，不能省略 task 因果引用。task no-op 不写 audit。audit 失败必须让
post update 和 enqueue 一起回滚。

## 6. `publish_post` task

在 `src/modules/tasks/handlers.ts` 增加：

```ts
const publishPostPayloadSchema = z.object({
  postId: z.string().uuid(),
  scheduleToken: z.string().uuid(),
});
```

建议把 kind dispatch 改成明确 switch，不要让 email schema 解析 `publish_post`。

handler 调用：

```ts
executeScheduledPublish({
  taskId: task.id,
  postId: payload.postId,
  scheduleToken: payload.scheduleToken,
});
```

service 在事务内用 database time 或同一事务获取的 now，条件：

```text
id = postId
status = draft
scheduled_at <= now
schedule_token = scheduleToken
```

命中后发布、清 schedule，并写 system audit。未命中时分类：

- post 不存在：success no-op；
- token 不同/null：success no-op；
- status 非 draft：success no-op；
- token 相同但 scheduledAt > now：抛 retryable not-due error；
- 命中：success published。

返回结果可为：

```ts
{ note: "published" | "stale schedule; skipped" | "post missing; skipped" }
```

### Permanent task failure

payload schema 错误是确定性错误，不应重试。增加最小通用机制：

```ts
class PermanentTaskError extends Error {}
markTaskDead(id, lockToken, error): Promise<boolean>
```

`markTaskDead` 必须使用现有 fencing：

```text
id = ?
status = processing
locked_by = ?
```

dispatcher 捕获 `PermanentTaskError` 时直接 dead；其它 error 保持现有
`markTaskFailed()` 退避。不要把 DB 暂时错误误判为 permanent。

补 admin task i18n 时不要暴露 payload；`lastError` 只保存 schema 的安全摘要，不拼入完整
payload。

## 7. 纯权限 audience

从 `canAccessPost()` 提取：

```ts
export type PostAudience =
  | { type: "guest" }
  | { type: "logged_in_without_membership" }
  | { type: "tier"; level: number };

export function evaluatePostAudience(
  audience: PostAudience,
  input: {
    visibility: Post["visibility"];
    requiredTierLevel: number | null;
  },
): boolean;
```

矩阵：

| visibility | guest | logged in/no membership | tier(level) |
|---|---:|---:|---:|
| public | allow | allow | allow |
| login | deny | allow | allow |
| member, no required tier | deny | deny | deny |
| member, required level N | deny | deny | `level >= N` |

`canAccessPost(user, post)` 保持对外 API：

1. admin 直接 true；
2. 查询 required tier level；
3. 查询真实 active membership；
4. 映射 audience；
5. 调纯函数。

公开 page/API 仍必须在调用权限核心前要求 parent post 为 published。不要把 status 判断偷偷
塞进 preview audience，否则 preview 无法模拟未发布文章。

## 8. Preview view builder

建议新建：

```text
src/modules/content/preview.ts
```

```ts
export async function buildPostPreview(input: {
  postId: string;
  locale: Locale;
  audience: PostAudience;
}): Promise<PostDetailView>;
```

builder：

1. 读取任意状态 post；
2. 读取 required tier；
3. 用 `getLocalizedPost()`，只采用 published translation，否则回退原文；
4. 用 `evaluatePostAudience()` 计算模拟 allowed；
5. allowed 时读取当前 post-file 关联；
6. 图片、cover、附件使用 admin preview file URL；
7. denied 时 body=null、images=[]、attachments=[]；
8. 复用 machine translation label policy；
9. 不读取/创建 session、user、membership；
10. 不写 download log。

preview 使用执行时最新内容，不做快照。

## 9. Admin preview route 与文件 endpoint

页面：

```text
src/app/admin/(preview)/posts/[id]/preview/page.tsx
```

配套 preview route-group layout：

- `requireAdmin()` 或等价 server guard；
- 不渲染 dashboard sidebar；
- 不经过 `(site)/layout.tsx`，因此不执行 custom footer code；
- 使用 `.site-theme` scope；
- 加明显 admin preview banner；
- 调 `getActiveTheme().components.PostDetail`；
- query 支持 `locale=zh|en|ja`、
  `audience=guest|logged_in_without_membership|tier`、`tierLevel=<int>`；
- tier selector 可用真实 tiers 生成 level 选项，但不创建 membership。

文件 endpoint：

```text
GET /api/admin/posts/[id]/preview/files/[fileId]
```

要求：

- `requireAdmin()`；
- post/file 存在；
- file 是 `post.coverFileId` 或存在对应 `post_files` 行；
- 只允许 cover/content_image/content_attachment；
- 直接 `storage.getObject()` 并 stream，S3 也不返回 signed redirect；
- `Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`；
- attachment 使用安全 Content-Disposition；
- 不写 download log / app event；
- 不复用普通用户 audience 来授权此 endpoint，授权边界就是 admin + 关联校验。

## 10. Admin APIs

全部 `requireAdmin()`，调用 canonical service：

```text
POST /api/admin/posts/:id/schedule
  { scheduledAt }

POST /api/admin/posts/:id/reschedule
  { scheduledAt, expectedScheduleToken }

POST /api/admin/posts/:id/schedule/cancel
  { expectedScheduleToken }

POST /api/admin/posts/:id/publish
  { expectedState, expectedScheduleToken? }

POST /api/admin/posts/:id/archive
  {}

POST /api/admin/posts/:id/restore
  {}
```

现有 publish/archive route 保留 URL，但改为调用新 service。所有输入用 zod；时间必须是带
timezone 的 ISO datetime。错误使用稳定 code：

```text
postNotFound                 404
postScheduleTooSoon          400
postPublishingStale          409
invalidPostTransition        409
invalidPreviewAudience       400
previewFileNotLinked         404
```

不要返回 SQL、task payload 或 schedule task 内部字段。admin GET post 可以返回
`scheduledAt` 和 `scheduleToken`，因为 UI 需要并发 token。

## 11. Admin UI

更新 `src/components/admin/post-editor.tsx` 和 edit page：

- badge 使用派生状态，而不是只看 `post.status`；
- draft：Schedule、Publish now；
- scheduled：显示本地化时间、Reschedule、Cancel schedule、Publish now；
- published：Archive；
- archived：Restore to draft；
- 所有危险操作使用现有确认模式；
- mutation 后 refresh，409 显示稳定 i18n 错误并提示重新加载；
- schedule/reschedule UI 提交带 timezone 的 ISO；
- scheduled 内容编辑区显示“继续保存会影响最终发布内容”；
- preview 入口支持 locale 和 guest/login/tier audience；
- zh/en/ja 全部补齐；
- 不修改主题组件实现，只传现有 `PostDetailView`。

不要在本 PR 添加 tags/categories、通知选项或 translation draft 自动发布。

## 12. Translation 与附件规则

### Translation

- publish post 不调用 `publishTranslation()`；
- `getLocalizedPost()` 保持只读 published translation；
- public post query 继续先过滤 parent `status=published`；
- archive/restore 不更新 `post_translations`；
- restore 后 published translation 保持已批准但因 parent draft 不公开；
- 再次 publish 后可重新公开；
- preview locale 也只用 published translation，draft translation 继续在现有翻译 editor 审核。

### Attachment

- 现有 public `canAccessFile()` 继续要求至少一个关联 post published 且真实用户有权限；
- schedule 不复制/冻结 `post_files`；
- schedule 后 attach/detach 在执行时生效；
- preview builder 只在模拟 allowed 时给出 admin preview URL；
- preview endpoint 必须验证 post-file 关联，不能只凭 file id；
- 不让 guest/tier preview 改变真实 download API 的用户权限。

## 13. PostgreSQL integration tests

实施 PR 1 至少覆盖：

1. migration 后旧 post 字段为 null，constraints 生效；
2. draft schedule 同事务写 post、audit、task；
3. enqueue 失败回滚 post 和 audit；
4. audit 失败回滚 post 和 task；
5. reschedule 生成新 token 和新 dedupe key；
6. stale reschedule/cancel token 返回 409；
7. cancel 后旧 task success no-op；
8. reschedule 后旧 task success no-op，新 task 到期发布；
9. scheduled immediate publish 清 schedule，旧 task no-op；
10. task 与 immediate publish 并发只发布一次、只写一条 publish audit；
11. 第一次 handler 成功发布，重复 handler no-op；
12. archive/restore 与旧 task 竞争不会重新发布；
13. restore 清 publishedAt，保留 translation 行；
14. scheduled 内容/附件修改后，最终公开读取最新数据；
15. parent draft/scheduled/archived 时 published translation 不公开；
16. parent published 时 published translation 可见，draft translation 不可见；
17. non-published post 的附件普通用户不可下载；
18. published post 附件仍按 guest/login/tier 权限；
19. malformed payload 直接 dead，不走五次 retry；
20. transient DB/too-early error 仍进入 failed/backoff。

测试必须使用真实 PostgreSQL 验证条件更新、row lock、事务回滚和 task/audit 原子性。

## 14. API、权限与组件测试

实施 PR 2 至少覆盖：

- 所有 publishing/preview API 未登录 401、非 admin 403；
- schedule/reschedule/cancel/publish/archive/restore 请求体校验；
- stale token/state 映射为 409 稳定 code；
- admin GET post 返回派生状态所需字段；
- audience 矩阵完整参数化测试；
- preview 不调用 user/membership 写入；
- guest/login/tier preview 使用同一权限核心；
- locale preview：published ja 命中，缺失时回退原文，draft ja 不显示；
- denied preview 不包含 body 或附件 URL；
- allowed preview 使用 admin preview URL；
- preview file endpoint 拒绝未关联文件和非 admin；
- S3 preview 不返回 signed redirect；
- preview 页面调用当前 active theme 的 `PostDetail`；
- preview banner 存在；
- admin UI 在四种派生状态显示正确操作；
- zh/en/ja key 完整。

避免大 snapshot；断言行为、权限、错误码和关键 props。

## 15. 完整验证命令

每份实施 PR 都运行：

```bash
pnpm lint
pnpm format:check
pnpm exec tsc --noEmit
pnpm db:migrate
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator
pnpm build
```

涉及 migration 时额外检查：

```bash
git diff -- src/db/schema drizzle
```

确认没有意外 enum、表或历史 migration 改写。

## 16. 推荐拆分 PR

### 实施 PR 1

标题：

```text
feat(content): add scheduled publishing state machine
```

范围：

- schema/migration；
- publishing canonical service；
- `publish_post` task payload/handler；
- permanent task failure 最小通道；
- audit；
- translation/file invariants；
- PostgreSQL integration tests。

PR 描述使用：

```text
Refs #9
```

不要关闭 Issue #9。

### 实施 PR 2

标题：

```text
feat(admin): add publishing and permission preview
```

依赖实施 PR 1 合并后的 main。范围：

- schedule/reschedule/cancel/publish/archive/restore API；
- post editor controls；
- exact-theme preview route；
- guest/login/tier + locale preview；
- admin-only preview file streaming；
- zh/en/ja；
- API/component tests。

最终使用：

```text
Closes #9
```

## 17. 实施红线

- 不新增 `scheduled` post status；
- 不直接从 route/UI 更新 post 状态；
- 不删除旧 scheduled tasks 代替 token fencing；
- 不把正文或附件写进 task payload；
- 不自动发布 translation draft；
- 不为 preview 创建用户、session 或 membership；
- 不让 preview 执行 custom footer code；
- 不给 preview 返回可脱离 admin session 使用的 S3 signed URL；
- 不新增外部队列、HA worker、tags/categories、SEO、通知或插件 API。
