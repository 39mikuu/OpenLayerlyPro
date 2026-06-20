# 交接：编辑器优化 #1 — Markdown 正文 + 工具栏/预览 + 内联插图

> 给执行 agent 的自包含实现说明。**前置依赖:当前 `main` 即可**。落地决策见 [ADR 0006](../adr/0006-markdown-editor.md)。
>
> 开工前在 GitHub 建 issue(如「feat(content): markdown editor with inline images」),PR 关联;保持 Draft 直到真实 PG 集成测试 + 完整 CI 全绿。

把正文从「纯文本 textarea」升级为 **Markdown**:管理端加工具栏 + 实时预览 + 内联插图(编辑器内上传即嵌入正文);公开页服务端渲染 **Markdown → 消毒后 HTML**;翻译同为 Markdown,AI 翻译保结构。

## 0. 红线(碰安全/数据,务必遵守)

1. **正文渲染成 HTML = 引入 XSS 面。必须 `markdown-it({ html: false })`(禁裸 HTML)+ 输出再过 `sanitize-html` 白名单**(纵深防御,即便单作者)。URL scheme 白名单:`http`/`https`/`mailto` + 相对 `/api/files/...`;拦截 `javascript:` / `data:` / `vbscript:`、事件属性、`<script>/<iframe>/<object>/<svg>` 等。
2. **消毒是服务端权威边界**。客户端预览只给作者自看,可只用 markdown-it,但**绝不**当安全边界,也**绝不**把未消毒 HTML 发给访客。
3. **主题只拿已消毒 HTML**,不解析、不消毒、不碰 Markdown(保持「主题只展示」)。
4. **内联图鉴权靠 `file.purpose='content_image'` + post 链接**(现有 `canAccessFile` 已按此判定,见 §1),`kind='inline'` 仅用于画廊区分,**不要**改 `canAccessFile` 的鉴权语义。
5. **未引用内联图清理(reconcile)删错会丢图**:删除前必须汇总**所有 locale(含草稿翻译)**正文里的引用,只删谁都不引用的 `kind='inline'` 文件。
6. 旧纯文本 body 按 Markdown 渲染(`breaks:true`)可读即可;不做存量迁移(alpha 近乎无内容),升级说明注明。

## 1. 现状(必读,直接扩展别重写)

- 编辑器 `src/components/admin/post-editor.tsx`:正文是 `<Textarea rows={8}>`(L223-230);文件上传 `uploadAndAttach`(L127-143)——图片走 `uploadFile("/api/admin/files/upload", { purpose:"content_image" })`,再 `POST /api/admin/posts/{id}/files { fileId, kind }`。**上传仅在 `!isNew`(post 已存在)时可用**。
- 翻译编辑器 `src/components/admin/post-translation-editor.tsx`:同款纯文本 textarea,逐 locale。
- 公开页 `src/app/(site)/posts/[slug]/page.tsx`:`body = localizedPost.body`(原样字符串,L40),传 `PostDetailView.body`;图片/附件由 `listPostFiles` 按 `link.kind` 过滤成 `images`(kind=`image`)/`attachments`(kind=`attachment`)。
- 主题契约 `src/modules/theme/types.ts`:`PostDetailView.body: string | null`(L69);内置 `src/themes/builtin/post-detail.tsx` 用 `whitespace-pre-wrap` 原样渲染(L97-101)。
- 下载鉴权 `src/modules/download/index.ts` `canAccessFile`:**按 `file.purpose` 分流**,`content_image`/`content_attachment` → `listPostsForFile` 找关联 published post + `canAccessPost`。**与 `postFiles.kind` 无关** → 内联图(purpose=content_image)天然继承门禁。
- post files API `src/app/api/admin/posts/[id]/files/route.ts`:`attachSchema.kind` 枚举(L17)= `cover|image|attachment|preview|thumbnail`。
- `postFiles.kind` 枚举 `src/db/schema/index.ts` L355:同上。
- AI 翻译草稿:`src/app/api/admin/posts/[id]/translations/[locale]/ai-draft/route.ts` → translation 模块 `generateAiTranslationDraft`。

## 2. 锁定决策(动工前若有异议先提)

| # | 决策 |
|---|---|
| D1 | 正文 = GFM Markdown,**复用现有 `text` 列**(`posts.body` / `post_translations.body`),不加 `body_format` 列;旧纯文本用 `breaks:true` 兼容渲染。 |
| D2 | 渲染管线 = `markdown-it({ html:false, linkify:true, breaks:true })` → `sanitize-html` 白名单,封装在 `src/modules/content/markdown.ts`,**服务端权威**。 |
| D3 | `PostDetailView` 增 `bodyHtml: string \| null`(已消毒),主题用 `dangerouslySetInnerHTML` 渲染;移除/保留 `body` 见 §5。摘要 `summary` 仍纯文本。 |
| D4 | 内联图:编辑器上传 `purpose:"content_image"` → 关联 post `kind:"inline"` → 正文插入 `![alt](/api/files/{id}/download)`;画廊只渲染 `kind="image"`。鉴权不变(purpose 已覆盖)。 |
| D5 | `postFiles.kind` 与 post files API 枚举新增 `inline`(增量迁移)。 |
| D6 | 翻译同为 Markdown;翻译编辑器复用同款工具栏 + 预览;AI 翻译 prompt 声明 Markdown 并保结构/代码/URL/图片引用。 |
| D7 | 保存时 reconcile:删除谁都不引用的 `kind='inline'` 文件(汇总所有 locale 正文,含草稿翻译)。 |
| D8 | Markdown 子集:GFM 标题/粗斜体/列表/链接/引用/代码与代码块/图片/分隔线/**表格**;不含任务列表(可调)。 |

## 3. Schema + 迁移

`src/db/schema/index.ts`:`post_files.kind` 枚举加 `inline`:

```ts
kind: text("kind", {
  enum: ["cover", "image", "attachment", "preview", "thumbnail", "inline"],
}).notNull(),
```

`pnpm exec drizzle-kit generate`(纯枚举增量,低风险无回填)。
> drizzle 对 `text enum` 不生成 DB 级 check,枚举仅 TS 层;迁移可能为空——确认 `attachSchema`(§6)与类型同步即可。

## 4. 渲染模块 `src/modules/content/markdown.ts`(新建)

```ts
import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
// 表格默认开启;如需任务列表另加插件（本切片不加）。

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p","br","hr","h1","h2","h3","h4","h5","h6",
    "strong","em","del","blockquote",
    "ul","ol","li","a","img","code","pre",
    "table","thead","tbody","tr","th","td",
  ],
  allowedAttributes: {
    a: ["href","title"],
    img: ["src","alt","title"],
    th: ["align"], td: ["align"],
  },
  // 只允许 http/https/mailto + 相对路径（含 /api/files/...）
  allowedSchemes: ["http","https","mailto"],
  allowProtocolRelative: false,
  allowedSchemesByTag: { img: ["http","https"] },
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener nofollow ugc", target: "_blank" }),
  },
  // 相对 URL（/api/files/{id}/download）默认放行；确保配置不剥离相对 href/src
};

/** 服务端权威渲染：Markdown → 已消毒 HTML。空/空白 → "" */
export function renderMarkdown(markdown: string | null | undefined): string {
  if (!markdown || !markdown.trim()) return "";
  return sanitizeHtml(md.render(markdown), SANITIZE_OPTS);
}
```

要点:
- **务必验证相对 URL 不被 sanitize-html 剥离**(内联图是 `/api/files/{id}/download`)。如被剥离,用 `allowedSchemesAppliedToAttributes` 或在白名单显式允许相对路径(写测试覆盖)。
- 客户端预览(§5)可 `import` 同一个 `md`(markdown-it 浏览器可用);**预览不引入 sanitize-html**(减小包体,作者自看非安全边界),但要在注释标注「权威消毒在服务端」。若担心预览与最终不一致,预览也可调一个轻量 `GET /api/admin/posts/preview`(可选,不强制)。

## 5. 渲染接线(公开页 + 主题)

### 5.1 公开页 `src/app/(site)/posts/[slug]/page.tsx`
- `import { renderMarkdown } from "@/modules/content"`(从 markdown 模块 re-export)。
- `allowed` 时:`const bodyHtml = renderMarkdown(localizedPost.body)`;传 `view.bodyHtml = bodyHtml`(不再传原始 `body`,或保留 `body` 仅作兜底——见下)。

### 5.2 主题契约 `src/modules/theme/types.ts`
- `PostDetailView` 把 `body: string | null` 改为 `bodyHtml: string | null`(语义更清晰)。**这是 breaking 的主题契约变更**:同步更新内置主题;在 PR / `docs/architecture` 注明自定义主题需消费 `bodyHtml`。

### 5.3 内置主题 `src/themes/builtin/post-detail.tsx`
- 把 L97-101 改为:
```tsx
{view.bodyHtml && (
  <div
    className="prose-content text-[15px] leading-8 sm:text-base"
    dangerouslySetInnerHTML={{ __html: view.bodyHtml }}
  />
)}
```
- 加一组排版样式(`prose-content`:标题/列表/引用/代码块/表格/`img` 圆角自适应等),可用项目现有 CSS 约定或 tailwind typography(若不想加依赖,手写少量样式即可)。内联 `<img>` 应 `max-width:100%`。
- 画廊(`images`)继续渲染 `kind='image'`(内联图是 `inline`,不会进 `images`,无重复)。

## 6. 编辑器:Markdown 工具栏 + 预览 + 内联插图

新建 `src/components/admin/markdown-editor.tsx`(受控组件,`value` / `onChange` / `onInsertImage`),正文与翻译正文共用:
- **工具栏**:粗体 `**`、斜体 `*`、标题 `#`、链接 `[]()`、无序/有序列表、引用 `>`、行内代码 `` ` ``、代码块 ```` ``` ````、表格、**插入图片**。按钮在 textarea 选区上包裹/插入 Markdown(维护光标/选区)。
- **预览**:切换/分栏,用 §4 的 markdown-it 客户端渲染(`dangerouslySetInnerHTML`);标注权威消毒在服务端。
- **插入图片**:文件选择 / 拖拽 / 粘贴 → 调 `onInsertImage(file)`,由父组件上传 + attach + 回插 Markdown(见下)。
- 字数统计等可选增强。

`post-editor.tsx` 改造:
- 正文区换成 `<MarkdownEditor value={form.body} onChange={...} onInsertImage={insertInlineImage} />`。
- `insertInlineImage(file)`(仅 `!isNew`,与现有上传同约束):
```ts
const record = await uploadFile<{ id: string }>("/api/admin/files/upload", file, { purpose: "content_image" });
await api(`/api/admin/posts/${post.id}/files`, { method: "POST", body: { fileId: record.id, kind: "inline" } });
// 在光标处插入 ![](/api/files/{record.id}/download)
```
- **新建态**:post 未保存时禁用「插入图片」并提示「请先保存草稿」(沿用现有画廊上传的同款约束)。

`post-translation-editor.tsx`:正文区同样换成 `MarkdownEditor`,内联图同理 attach 到同一 post(`kind:"inline"`)。

post files API `src/app/api/admin/posts/[id]/files/route.ts`:`attachSchema.kind` 枚举加 `"inline"`。

## 7. 未引用内联图 reconcile(D7)

保存帖子(`PUT /api/admin/posts/[id]`)与保存翻译后,在 content 模块加:

```ts
// 汇总该 post 的 原始 body + 所有 translation body（任意 status），抽出 /api/files/{uuid}/download 的 id 集合，
// 删除该 post 下 kind='inline' 且 fileId 不在集合中的 post_files（detach + 删 file/对象）。
reconcileInlineImages(postId): Promise<void>
```
- 正则:`/\/api\/files\/([0-9a-f-]{36})\/download/gi`。
- **安全第一**:集合务必包含草稿翻译里的引用,只删谁都不引用的;删文件复用现有 detach + 文件/对象删除路径(本地 unlink / S3 delete)。
- 事务内或保存后best-effort均可,但**绝不可**误删仍被引用的图。
- 若本切片不做:PR 注明「未引用内联图会累积,留作后续清理」(但推荐做)。

## 8. AI 翻译 prompt(D6)

`generateAiTranslationDraft` 的 prompt 增加:输入是 **Markdown**,**保留所有 Markdown 结构与代码块**,**不翻译 URL 与图片链接**(`![alt](url)` 只译 `alt`、`url` 原样),**不输出裸 HTML**。其余不变(译后仍 `source:"machine"`)。

## 9. i18n

`{zh,en,ja}.ts` 补:工具栏各按钮、预览/编辑切换、插入图片、「请先保存草稿」、Markdown 帮助提示等。

## 10. 依赖

新增 `markdown-it` + `@types/markdown-it`、`sanitize-html` + `@types/sanitize-html`。PR 注明。
> 备选:remark/rehype + rehype-sanitize(消毒为 AST 一等步骤);接口不变,评审可改选。

## 11. 测试

**渲染/消毒单测(`markdown.ts`,最关键)**:
- 基本 Markdown → 预期 HTML(标题/列表/链接/代码块/表格)。
- **XSS**:`<script>`、`<img onerror=...>`、`[x](javascript:alert(1))`、`![x](javascript:...)`、`<iframe>`、`<svg/onload>`、HTML 注释绕过 → **全部被消毒/转义**,断言输出不含可执行向量。
- **相对 URL 保留**:`![](/api/files/<uuid>/download)` 渲染后 `src` **仍是该相对路径**(回归,内联图能加载)。
- `breaks:true`:旧纯文本多行 → `<br>`,可读。
- 空/空白 → `""`。

**集成/行为**:
- 内联图鉴权:member-only post 的内联 `content_image`,未授权访客 `GET /api/files/{id}/download` → 401/403;授权会员 → 200(复用 `canAccessFile` 现有矩阵,断言 `kind='inline'` 不改变结果)。
- 内联图不进画廊:`listPostFiles` 的 images 数组不含 `kind='inline'`。
- reconcile:① 正文删掉某内联图引用并保存 → 该 inline 文件被删;② 该图仍被**某草稿翻译**引用 → **不删**;③ 仍被引用的图永不删。
- 主题渲染:`PostDetailView.bodyHtml` 注入,locked(`!allowed`)时不渲染 body。
- AI 翻译草稿:Markdown 结构/图片链接保留(可 mock provider 断言 prompt 含约束)。

## 12. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

## 13. PR

- base `main`,draft,标题 `feat(content): markdown editor with inline images`。
- 描述:新增 markdown-it/sanitize-html;`markdown.ts` 渲染+消毒;`PostDetailView.body→bodyHtml`(主题契约变更);`MarkdownEditor`(工具栏+预览);内联图(content_image + kind=inline);`post_files.kind` 加 inline + 迁移;reconcile;AI 翻译 prompt;i18n。注明旧纯文本兼容渲染。
- 关联 issue。

## 14. 验收 checklist

- [ ] 正文 Markdown 服务端渲染 + sanitize 白名单;XSS 向量全部被拦(有针对性测试)
- [ ] 相对 `/api/files/{id}/download` 在消毒后保留(内联图可加载)
- [ ] 工具栏 + 预览;预览非安全边界、不外发未消毒 HTML
- [ ] 内联插图:上传 content_image + 关联 `kind='inline'` + 正文插入 Markdown;新建态先存草稿
- [ ] 内联图继承 member-only 门禁(purpose 鉴权,未改 `canAccessFile` 语义)
- [ ] 画廊只显 `kind='image'`,内联图不重复
- [ ] 翻译同为 Markdown + 同款编辑器;AI 翻译保结构/图片链接
- [ ] reconcile 只删无任何 locale 引用的内联图,绝不误删
- [ ] 主题契约 `bodyHtml` 更新,内置主题渲染 + 排版样式;自定义主题迁移注明
- [ ] 旧纯文本兼容渲染(`breaks`),升级说明注明

## 不在本切片(后续)

- 富文本 WYSIWYG 高级模式;自动保存 / 草稿恢复;版本历史;协同编辑。
- 视频/嵌入(B2);任务列表、脚注等 GFM 扩展;数学公式。
- 历史纯文本精确保真迁移(如未来需要)。
