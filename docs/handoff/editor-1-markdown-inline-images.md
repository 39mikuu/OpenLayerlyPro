# 交接：编辑器优化 #1 — Markdown 正文 + 工具栏/预览 + 内联插图

> 给执行 agent 的自包含实施说明。前置依赖：当前 `main`。设计依据：[ADR 0006](../adr/0006-markdown-editor.md)。
>
> 开工前创建独立 Issue；实施 PR 保持 Draft，直到真实 PostgreSQL 集成测试和完整 CI 全绿。

## 1. 目标

将正文从纯文本 textarea 升级为：

- GFM Markdown 子集；
- 服务端权威渲染和消毒；
- 管理端工具栏和安全预览；
- 原文与翻译都支持内联插图；
- AI 翻译保护代码、URL、图片引用和未来视频指令；
- 不破坏现有自定义主题。

## 2. 红线

1. `markdown-it({ html:false })` 后必须再经过 `sanitize-html`。
2. `<img src>` 只允许 `/api/files/{uuid}/download`。
3. 预览必须调用服务端 POST API，不得在客户端维护第二套 renderer。
4. 主题只接收已消毒 `bodyHtml`。
5. 内联图只允许 `purpose="content_image"`。
6. 上传图片时不立即创建 `post_files` link；link 与正文保存事务同步。
7. 每个未关联上传必须安排延迟 durable orphan cleanup，避免永久泄漏。
8. 不直接调用现有 `deleteFile` 清理内联图片。
9. 存储对象删除不放进正文保存事务，必须走 durable cleanup。
10. 已发布文章允许内部 inline 同步，但通用 attach/detach API不得破坏仍被正文引用的文件。

## 3. 依赖

新增：

```text
markdown-it
@types/markdown-it
sanitize-html
@types/sanitize-html
```

不新增客户端 Markdown 解析依赖。

## 4. Schema 与迁移

`post_files.kind` 增加 TypeScript enum 值：

```ts
kind: text("kind", {
  enum: ["cover", "image", "attachment", "preview", "thumbnail", "inline"],
}).notNull(),
```

当前列是 PostgreSQL `text`，没有 CHECK 约束，因此通常不会生成 SQL：

```bash
pnpm exec drizzle-kit generate
```

要求：

- 没有 schema diff 时不提交空迁移；
- 不占用迁移编号；
- 若意外生成 SQL，先排查 drift。

## 5. 服务端 Markdown 模块

新增 `src/modules/content/markdown.ts`：

```ts
export type MarkdownEmbedMode = "public" | "preview";

export type RenderMarkdownOptions = {
  embedMode?: MarkdownEmbedMode;
};

export function renderMarkdown(
  markdown: string | null | undefined,
  options: RenderMarkdownOptions = { embedMode: "public" },
): string;
```

基础配置：

```ts
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});
```

sanitizer 至少允许：

- 段落、标题、列表、引用、代码、代码块、表格；
- 链接的 `href/title`；
- 图片的 `src/alt/title`；
- 表格对齐属性。

安全规则：

- 链接只允许 `http`、`https`、`mailto` 和安全相对 URL；
- `target="_blank"` 时统一加 `rel="noopener nofollow ugc"`；
- 图片整个标签只有在 `src` 精确匹配内部 UUID 下载路由时保留；
- `javascript:`、`data:`、协议相对图片、事件属性、SVG、object、裸 iframe 全部拒绝。

ADR 0008 落地后，`embedMode` 决定真实 iframe 或预览占位卡片；本切片先保留该参数和测试接口。

## 6. 管理端预览 API

新增：

```http
POST /api/admin/posts/preview
Content-Type: application/json
```

请求：

```json
{
  "markdown": "# Preview",
  "embedMode": "preview"
}
```

实现要求：

- `requireAdmin`；
- Zod 校验；
- `markdown` 设置明确长度上限，与正文最大长度一致；
- `embedMode` 仅允许 `preview`；
- 返回 `{ html }`，其中 html 已消毒；
- `Cache-Control: no-store`；
- 不写入数据库；
- rate limit 防止管理员会话被滥用为高成本渲染接口。

编辑器 debounce 调用该 API。客户端只渲染响应中的已消毒 HTML。

## 7. 主题契约与公开页

`PostDetailView`：

```ts
export type PostDetailView = {
  /** @deprecated 下一主题大版本移除 */
  body: string | null;
  bodyHtml: string | null;
  // existing fields...
};
```

公开页仅在 `allowed === true` 时：

```ts
body: localizedPost.body,
bodyHtml: renderMarkdown(localizedPost.body, { embedMode: "public" }),
```

locked 状态不得渲染正文、不得把正文 HTML 传给主题。

内置主题改用：

```tsx
<div
  className="prose-content"
  dangerouslySetInnerHTML={{ __html: view.bodyHtml ?? "" }}
/>
```

增加标题、列表、引用、代码块、表格和响应式图片样式。画廊继续只使用 `kind="image"`。

## 8. MarkdownEditor

新增受控组件：

```ts
<MarkdownEditor
  value={body}
  onChange={setBody}
  onInsertImage={uploadInlineImage}
/>
```

功能：

- 粗体、斜体、标题、链接；
- 无序/有序列表；
- 引用、行内代码、代码块、表格；
- 图片选择、拖拽、粘贴；
- 编辑/预览切换或分栏；
- 保存中和上传中的明确状态。

新建文章仍需先保存草稿，获得 post ID 后才允许上传图片。

## 9. 内联图片上传流程

上传只创建文件，不 attach：

```ts
const file = await uploadFile("/api/admin/files/upload", image, {
  purpose: "content_image",
});

insertAtCursor(`![alt](/api/files/${file.id}/download)`);
```

上传接口在成功创建 file 记录后立即 enqueue：

```text
kind: file.cleanup_orphan
payload: { fileId }
dedupeKey: file:cleanup_orphan:<fileId>
availableAt: now + INLINE_UPLOAD_GRACE_PERIOD
```

建议默认：

```text
INLINE_UPLOAD_GRACE_PERIOD = 24 小时
```

该任务用于回收“已上传但从未保存正文”的文件。若正文在此之前保存，link 已建立，任务到期后重查引用并安全 no-op。

要求：

- 上传成功但 enqueue 失败时，整个上传流程返回失败并清理刚创建的对象/记录，不能静默留下无界 orphan；
- 同一 fileId 的 cleanup task 必须可 dedupe；
- 延迟可配置但必须设上下限。

管理员预览读取未关联 `content_image` 时沿用现有 admin bypass；普通访客仍不能访问未关联文件。

## 10. 保存时同步 inline links

新增内部服务，例如：

```ts
syncInlineImageLinks(
  tx: DbClient,
  input: {
    postId: string;
    nextSourceBody?: string | null;
    nextTranslation?: { locale: string; body: string | null };
  },
): Promise<void>;
```

必须与正文/翻译保存处于同一数据库事务。

步骤：

1. 根据即将提交的原文或翻译，构造保存后的“原文 + 所有 locale 翻译”正文集合；
2. 解析所有 `/api/files/{uuid}/download` 引用；
3. 批量加载文件并验证：
   - 文件存在；
   - `purpose === "content_image"`；
   - 不接受外部 URL 或非 UUID；
4. 为新增引用创建 `kind="inline"` link；
5. 对当前 post 已存在但不再被任何 locale 引用的 inline link 执行内部 detach；
6. 对被 detach 的 fileId，在事务内重新统计所有引用；
7. 引用为 0 时 enqueue 同一种 `file.cleanup_orphan` task，可立即执行；
8. 正文、翻译、link 变化和 task enqueue 一起提交或一起回滚。

### 已发布内容

- 原文/翻译保存流程可调用内部 inline sync helper；
- 内部 helper 对 `kind="inline"` 不受通用 draft-only attach 限制；
- `image/attachment/cover/...` 仍保持原有 draft-only 规则；
- 通用 detach API 对已发布内容不得解除仍被任何 locale 正文引用的 inline link；
- 推荐不向普通 attach API 暴露 `kind="inline"`，由保存服务独占维护。

## 11. durable orphan cleanup

新增任务类型：

```text
file.cleanup_orphan
```

同一 handler 同时处理：

- 上传后延迟检查；
- 正文删除引用后的即时检查。

handler：

1. `FOR UPDATE` 锁定 file；
2. 文件不存在 → 成功 no-op；
3. 检查所有 `post_files` 引用；
4. 检查 post cover、支付凭证、站点设置等现有受保护引用；
5. 仍有引用 → 成功 no-op；
6. 仅允许清理预期 purpose 的 orphan；
7. 幂等删除本地/S3 对象；
8. 删除 file 行；
9. 临时存储或数据库失败由任务重试。

不得在正文事务中直接删除对象。宁可暂留孤儿，不得制造正文引用指向不存在对象。

## 12. kind ↔ purpose 校验

统一放在内容模块，而非只写在 API：

```text
inline / image → content_image
attachment     → content_attachment
cover/preview/thumbnail → 现有明确允许的图片 purpose
```

错误组合返回 400。

## 13. AI 翻译结构保护

新增共享保护器：

```ts
protectMarkdownForTranslation(markdown)
restoreProtectedMarkdown(translated, tokens)
```

保护：

- fenced code；
- inline code；
- 裸 URL；
- `[text](url)` 的 URL；
- `![alt](url)` 的 URL；
- 整行 `@video: <url>`。

返回后要求 token 集合与次数完全一致；缺失、重复、改写或新增 token 均拒绝保存 machine draft。

## 14. 测试

### renderer / sanitizer

- Markdown 基本格式和表格；
- `html:false`；
- script、事件属性、SVG、object、裸 iframe；
- `javascript:`、`data:`、协议相对 URL；
- 内部图片 URL保留；
- 外链图和伪 UUID 图片剥离；
- `breaks:true`；
- public/preview 参数接口稳定。

### preview API

- 非管理员 401/403；
- GET 不作为支持契约；
- POST 正常；
- 超长 body 400/413；
- XSS 输出已消毒；
- no-store；
- 与公开页共用 renderer；
- admin 可预览尚未 link 的上传图片，普通访客不可访问。

### PostgreSQL 集成

- 上传成功时创建延迟 cleanup task；
- 上传 task enqueue 失败时对象和 DB 记录回滚/补偿清理；
- 未保存正文的上传在宽限期后被清理；
- 宽限期内成功保存建立 link 后，延迟 cleanup no-op；
- 保存正文并引用新图片 → 正文和 inline link 同事务提交；
- 保存失败 → link 不产生；
- 翻译引用图片 → link 保留；
- 最后一个 locale 移除引用 → detach 并 enqueue cleanup；
- 同一文件被另一帖子引用 → cleanup no-op；
- 多标签页并发保存不会删除另一个已提交正文正在引用的文件；
- 已发布文章和草稿翻译可同步 inline links；
- 已发布文章的其他 kind 仍被 409 保护；
- 通用 detach 不能破坏仍被正文引用的 inline link；
- cleanup task 重放幂等；
- 存储删除失败可重试，DB 引用不被破坏。

### AI 翻译

- 正常 token 完整恢复；
- 模型删除、复制、修改 token → 拒绝采用；
- 代码、图片 URL、链接 URL和 `@video:` 保持不变。

## 15. 验证

```bash
pnpm lint
pnpm format:check
pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator
pnpm build
```

## 16. 验收清单

- [ ] POST preview API + 服务端单一 renderer
- [ ] `bodyHtml` 新增、`body` deprecated 保留
- [ ] 外部图片全部剥离
- [ ] 上传不立即 attach
- [ ] 上传后安排 delayed durable cleanup
- [ ] 正文保存与 inline link 同事务同步
- [ ] 已发布内容只放宽内部 inline sync
- [ ] kind↔purpose 服务端校验
- [ ] detach 后只 enqueue durable cleanup
- [ ] cleanup worker 重查所有引用并幂等删除
- [ ] AI 翻译 token 校验
- [ ] 默认无数据库迁移
- [ ] 真实 PostgreSQL 集成测试与完整 CI 全绿

## 不在本切片

- WYSIWYG；
- 自动保存和草稿恢复；
- 版本历史与协同编辑；
- 外部图片域 allowlist；
- 公开视频 iframe（由 ADR 0008 后续切片实现）。
