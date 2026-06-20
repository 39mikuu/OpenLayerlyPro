# 交接：编辑器优化 #1 — Markdown 正文 + 工具栏/预览 + 内联插图

> 给执行 agent 的自包含实现说明。**前置依赖:当前 `main` 即可**。落地决策见 [ADR 0006](../adr/0006-markdown-editor.md)。
>
> 开工前在 GitHub 建 issue(如「feat(content): markdown editor with inline images」),PR 关联;保持 Draft 直到真实 PG 集成测试 + 完整 CI 全绿。

把正文从「纯文本 textarea」升级为 **Markdown**:管理端加工具栏 + 实时预览 + 内联插图(编辑器内上传即嵌入正文);公开页服务端渲染 **Markdown → 消毒后 HTML**;翻译同为 Markdown,AI 翻译保结构。

## 0. 红线(碰安全/数据,务必遵守)

1. **正文渲染成 HTML = 引入 XSS 面。必须 `markdown-it({ html: false })`(禁裸 HTML)+ 输出再过 `sanitize-html` 白名单**(纵深防御,即便单作者)。URL scheme 白名单:`http`/`https`/`mailto` + 相对 `/api/files/...`;拦截 `javascript:` / `data:` / `vbscript:`、事件属性、`<script>/<iframe>/<object>/<svg>` 等。
2. **`<img src>` 仅相对 `/api/files/{uuid}/download`**:剥离外部 `http(s)` 图片(否则绕过文件门禁 + 泄露访客 IP/UA/时间给第三方)。见 §4。
3. **消毒是服务端权威边界。预览统一走 `GET /api/admin/posts/preview`(管理员鉴权,复用服务端 `renderMarkdown`)**,客户端**不**各自实现一套渲染;**绝不**把未消毒 HTML 发给访客。见 §4/§6。
4. **主题只拿已消毒 HTML**,不解析、不消毒、不碰 Markdown(保持「主题只展示」)。
5. **内联图鉴权靠 `file.purpose='content_image'` + post 链接**(现有 `canAccessFile` 已按此判定,见 §1),`kind='inline'` 仅用于画廊区分,**不要**改 `canAccessFile` 的鉴权语义。但 attach API **必须校验 `kind↔purpose`**(`inline/image→content_image`、`attachment→content_attachment`),否则「inline 必继承 content_image 门禁」的前提不成立。见 §6。
6. **reconcile 不可用 `deleteFile`**(它级联解除其他帖子的 `post_files` 关联):必须做**引用计数 orphan-check**,仅引用为 0 才删,且**正文保存成功后**才执行 + 暂存/宽限,避免误删「已 attach、正文未保存」的新图。汇总**所有 locale(含草稿翻译)**引用,只删谁都不引用的 `kind='inline'`。见 §7。
7. 旧纯文本 body 按 Markdown 渲染(`breaks:true`)可读即可;不做存量迁移(alpha 近乎无内容),升级说明注明。

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
| D3 | `PostDetailView` **新增** `bodyHtml: string \| null`(已消毒),内置主题用 `dangerouslySetInnerHTML` 渲染;**`body` 标 deprecated 但保留**(仍填原始文本),不在本切片删,避免打断自定义主题(见 §5）。摘要 `summary` 仍纯文本。 |
| D9 | 预览统一走 `GET /api/admin/posts/preview`(管理员鉴权 + 服务端 `renderMarkdown`);客户端不再单跑 markdown-it,避免安全边界漂移。 |
| D10 | attach API 校验 `kind↔purpose`(`inline/image→content_image`、`attachment→content_attachment`)。 |
| D11 | `kind='inline'` 放宽 `attachFileToPost`/`detachFileFromPost` 的 draft-only 门槛(已发布文章/翻译可挂内联图;reconcile 不依赖 post 状态);其余 kind 保持 draft-only(见 §6.1)。 |
| D4 | 内联图:编辑器上传 `purpose:"content_image"` → 关联 post `kind:"inline"` → 正文插入 `![alt](/api/files/{id}/download)`;画廊只渲染 `kind="image"`。鉴权不变(purpose 已覆盖)。 |
| D5 | `postFiles.kind` 与 post files API 枚举新增 `inline`(增量迁移)。 |
| D6 | 翻译同为 Markdown;翻译编辑器复用同款工具栏 + 预览;AI 翻译 prompt 声明 Markdown 并保结构/代码/URL/图片引用。 |
| D7 | 保存时 reconcile:删除谁都不引用的 `kind='inline'` 文件(汇总所有 locale 正文,含草稿翻译)。 |
| D8 | Markdown 子集:GFM 标题/粗斜体/列表/链接/引用/代码与代码块/图片/分隔线/**表格**;不含任务列表(可调)。 |

## 3. Schema(大概率无迁移)

`src/db/schema/index.ts`:`post_files.kind` 是 **`text` 列 + TS `enum` 提示**,**不是数据库 CHECK 约束**。加 `inline`:

```ts
kind: text("kind", {
  enum: ["cover", "image", "attachment", "preview", "thumbnail", "inline"],
}).notNull(),
```

- 这是**纯 TS 层**变更,列类型不变 → `drizzle-kit generate` **多半不产生任何 SQL**。
- **不要生成空迁移文件,也不要为本切片占用迁移编号**;跑一次 `generate` 确认无 diff 即可。真正要同步的是 `attachSchema`(§6)与该 TS 枚举。
- 若 `generate` 意外产出非空 SQL,先核对是否夹带了无关 drift,再决定是否提交。

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
  // 链接：http/https/mailto + 相对路径；图片：仅内部相对 /api/files/...
  allowedSchemes: ["http","https","mailto"],
  allowProtocolRelative: false,
  allowedSchemesByTag: { img: [] }, // img 不允许任何带 scheme 的绝对 URL（含 http/https）
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener nofollow ugc", target: "_blank" }),
  },
  // 相对 URL（/api/files/{id}/download）默认放行；href/src 不被剥离
  exclusiveFilter: (frame) =>
    frame.tag === "img" &&
    !/^\/api\/files\/[0-9a-f-]{36}\/download(?:[?#].*)?$/i.test(frame.attribs.src ?? ""),
  // ↑ img 的 src 必须是内部文件相对路径，否则整个 <img> 被丢弃（剥离外链图，杜绝门禁绕过 + 第三方追踪）
};

/** 服务端权威渲染：Markdown → 已消毒 HTML。空/空白 → "" */
export function renderMarkdown(markdown: string | null | undefined): string {
  if (!markdown || !markdown.trim()) return "";
  return sanitizeHtml(md.render(markdown), SANITIZE_OPTS);
}
```

要点:
- **务必验证内部相对 URL 不被剥离**(内联图 `/api/files/{uuid}/download` 必须保留),且**外部 `http(s)` 图被剥离**(写测试覆盖两侧)。
- **预览不在客户端各自渲染**。新增 `GET /api/admin/posts/preview`(`requireAdmin`,body 收 markdown,返回 `renderMarkdown(md)` 的已消毒 HTML),编辑器预览**调用它**渲染。前后端**单一渲染/消毒实现**,避免后续 `@video:` iframe renderer(ADR 0008)落地后前端预览与权威渲染的安全边界漂移。

## 5. 渲染接线(公开页 + 主题)

### 5.1 公开页 `src/app/(site)/posts/[slug]/page.tsx`
- `import { renderMarkdown } from "@/modules/content"`(从 markdown 模块 re-export)。
- `allowed` 时:`const bodyHtml = renderMarkdown(localizedPost.body)`;**同时**传 `view.body = localizedPost.body`(deprecated,原始文本)与 `view.bodyHtml = bodyHtml`。

### 5.2 主题契约 `src/modules/theme/types.ts`(非 breaking 演进)
- `PostDetailView` **新增** `bodyHtml: string | null`(已消毒),**保留** `body: string | null` 并标注 `@deprecated`。同一主题版本内二者并存:内置主题切到 `bodyHtml`,旧自定义主题继续读 `body` 不至于立刻崩。
- 在 PR / `docs/architecture` 注明:`body` 将在**下一主题大版本**移除,自定义主题应迁移到 `bodyHtml`。**不在本切片直接删 `body`**(避免无预警打断自定义主题)。

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
- **预览**:切换/分栏,**调 `GET /api/admin/posts/preview`**(管理员鉴权 + 服务端 `renderMarkdown`)拿已消毒 HTML 再 `dangerouslySetInnerHTML`(可 debounce)。**不**在客户端单跑 markdown-it——前后端单一渲染实现,杜绝边界漂移。
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
- ⚠️ **已发布态约束(必须解决,见 §6.1)**:`attachFileToPost`/`detachFileFromPost`(`content/index.ts:616/635`)对 `post.status !== 'draft'` 抛 **409 `postNotEditable`**。已发布文章的**翻译**仍可编辑(创建草稿翻译),但此时插入内联图会按**文章**状态被拒 → 上传成功却 attach 409、留下孤儿文件。**上传前必须先判状态**,并按下述方案处理。

`post-translation-editor.tsx`:正文区同样换成 `MarkdownEditor`,内联图同理 attach 到同一 post(`kind:"inline"`)。**注意已发布文章的翻译编辑会撞 §6.1 的 409**。

### 6.1 已发布文章的内联图 —— 放宽 `kind='inline'` 的 draft-only 门槛(owner 已定调:方案 A)

`attachFileToPost`/`detachFileFromPost`(`content/index.ts:616/635`)现仅允许 `post.status==='draft'`(保护 ADR 0004 的发布/fencing 不变量)。**决策:对 `kind='inline'`(且 file `purpose==='content_image'`)放宽该门槛**,允许已发布文章/其翻译也挂、解内联图。

依据:内联图是 **purpose 鉴权的内容文件**,attach/detach 它**不改动**被 draft-only 门槛保护的「已发布正文/调度 fencing」状态(ADR 0004),因此可安全放宽。

实现要点:
- `attachFileToPost`/`detachFileFromPost`:**仅当 `kind==='inline'`(或经校验 purpose=content_image)时跳过 `status==='draft'` 检查**;其余 kind(cover/image/attachment/…)**保持 draft-only 不变**。
- **reconcile 必须能在已发布文章上运行**——否则发布后在正文里换图,旧内联文件永远清不掉(存储泄漏)。§7 的 orphan-check 不依赖 post 状态。
- 编辑器**仍在上传前检查可行性**,杜绝「上传成功 → attach 409 → 孤儿文件」;放宽后 inline 路径对 draft/published 都应成功。
- 测试:已发布文章 + 其草稿翻译插入/移除内联图 → attach/detach 成功(非 409)、reconcile 正常;同一文章对 `kind='image'`(画廊)在已发布态仍 409(确认只放宽了 inline)。

post files API `src/app/api/admin/posts/[id]/files/route.ts`:
- `attachSchema.kind` 枚举加 `"inline"`。
- **新增 `kind↔purpose` 校验**(attach 时取 `getFileById(fileId).purpose` 比对,不符 → 400):
  - `inline` / `image` / `cover` / `preview` / `thumbnail` → 要求 `purpose==='content_image'`(或对应图片类 purpose);
  - `attachment` → 要求 `purpose==='content_attachment'`。
  否则攻击者/误操作可把 `content_attachment` 文件挂成 `kind='inline'`,「inline 必继承 content_image 门禁」的前提即被破坏。校验写在 `attachFileToPost`(content 模块)更稳,API 与内联上传都经过它。

## 7. 未引用内联图 reconcile(D7)— orphan-check,非 deleteFile 级联

> ⚠️ **两个必须正面解决的数据安全问题:**
> 1. **不能复用 `deleteFile`**:`file/index.ts:315` 注释明确「`post_files` 关联会随删除级联解除」——直接删 file 会把该 file 在**其他帖子**的关联一并解除/丢图。
> 2. **误删窗口**:现流程是「先 upload+attach,再把 Markdown 放进客户端内存」;此刻若另一处保存/翻译保存触发 reconcile,会把数据库正文尚未引用的新图当垃圾删掉。

**触发时机(消除窗口)**:reconcile 只在**该 post 正文/翻译保存成功落库之后**对**同一 post** 执行(保存事务提交后,基于刚落库的正文)。**不**在上传时、不跨 post 全局扫描。这样「已 attach 但正文未保存」的新图永远不会被本次保存的 reconcile 看成孤儿。如担心并发,加短宽限(`created_at` 晚于本次保存起始的 inline 文件本轮跳过)。

**orphan-check 流程**(content 模块新增,**不调 `deleteFile`**):

```ts
reconcileInlineImages(postId): Promise<void>
// 在保存事务提交后调用：
// 1) 汇总该 post 的原始 body + 所有 locale translation body（任意 status，含草稿）
//    用正则 /\/api\/files\/([0-9a-f-]{36})\/download/gi 抽出 referenced fileId 集合。
// 2) 取该 post 下 kind='inline' 的 post_files；候选 = 不在 referenced 集合中的。
// 3) 对每个候选 file，FOR UPDATE 锁定后：
//    a. 删除“当前 post 对该 file 的 inline link”（仅这一条 link）。
//    b. 重新查询该 file 是否仍被【任意】 post_files 引用（含其他帖子、其他 kind）。
//    c. 仅当引用计数 === 0 时，才删 file 行 + 删存储对象（本地 unlink / S3 delete）。
//       引用计数 > 0 → 只解当前 link，绝不删 file/object。
// 4) 处理并发重新关联：a→c 在同一事务 + 行锁内，避免 b 之后他处再 attach 又被删。
```

- **安全第一**:集合务必含草稿翻译引用;引用计数为 0 才删;删 file/object 走「检查后」的显式删除,**不走** `deleteFile` 的级联路径。
- 保存事务内或紧接其后执行均可,但锁与「先 detach 当前 link → 再数引用 → 才删」的顺序不可乱。
- 若本切片不做:PR 注明「未引用内联图会累积,留作后续清理」(但推荐做)。

## 8. AI 翻译:占位保护 + token 校验(不靠 prompt)(D6)

`generateAiTranslationDraft` **不能只靠 prompt 保结构**。流程:

1. **送模前占位保护**:把不可译片段替换为不可破坏的占位 token(如 `⟦OL0⟧`、`⟦OL1⟧`…,选模型不会改写的形式):
   - fenced/inline 代码块整体;
   - 裸 URL 与 `![alt](url)` 的 `url`(只让模型译 `alt`);链接 `[text](url)` 的 `url`;
   - 未来的整行 `@video: <url>` 指令(ADR 0008,**整行**保护)。
2. prompt 声明输入为 Markdown、保留占位 token 原样、只译自然语言(辅助手段,非唯一保证)。
3. **返回后**按 token 还原。
4. **不可变 token 集合校验**:还原前比对「返回文本里的 token 集合」与「送出的集合」必须**完全一致**;缺失/多出/被改写 → **拒绝采用该草稿**(报错或回退,不写入 `post_translations`)。

译后仍 `source:"machine"`,**不输出裸 HTML**。测试:含代码块/URL/图片/`@video:` 的输入,mock provider 返回(含「模型篡改了 token」的负例)→ 断言结构保全或被拒。

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
- **外链图剥离**:`![](https://evil.example/track.gif)`、`![](//cdn.x/y.png)`、`![](/api/files/notauuid/download)` → 渲染后**无该 `<img>`**(只允许内部 `/api/files/{uuid}/download`)。
- `breaks:true`:旧纯文本多行 → `<br>`,可读。
- 空/空白 → `""`。

**集成/行为**:
- 内联图鉴权:member-only post 的内联 `content_image`,未授权访客 `GET /api/files/{id}/download` → 401/403;授权会员 → 200(复用 `canAccessFile` 现有矩阵,断言 `kind='inline'` 不改变结果)。
- 内联图不进画廊:`listPostFiles` 的 images 数组不含 `kind='inline'`。
- reconcile:① 正文删掉某内联图引用并保存 → 该 inline 文件被删;② 该图仍被**某草稿翻译**引用 → **不删**;③ 仍被引用的图永不删;④ **同一 file 被另一帖子的 `post_files` 引用** → reconcile 只解当前 post 的 link、**保留 file/object**(回归:不走 `deleteFile` 级联);⑤ 「已 attach 但正文未保存」的新图,触发另一保存的 reconcile → **不被误删**。
- attach `kind↔purpose`:把 `content_attachment` 文件以 `kind='inline'` attach → **400**;`content_image` 以 `kind='inline'` → 通过。
- 预览 API:`GET /api/admin/posts/preview` 非管理员 → 401/403;管理员传含 XSS 的 markdown → 返回**已消毒** HTML(与公开页 `renderMarkdown` 一致)。
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
- 描述:新增 markdown-it/sanitize-html;`markdown.ts` 渲染+消毒(img 仅内部文件);`PostDetailView` **新增 `bodyHtml`、保留 `body`(deprecated)**;`MarkdownEditor`(工具栏 + 预览经 `/api/admin/posts/preview`);内联图(content_image + kind=inline + attach `kind↔purpose` 校验);`post_files.kind` 加 inline(**TS 枚举,大概率无迁移**);reconcile(orphan-check,非 deleteFile);AI 翻译占位保护 + token 校验;i18n。注明旧纯文本兼容渲染。
- 关联 issue。

## 14. 验收 checklist

- [ ] 正文 Markdown 服务端渲染 + sanitize 白名单;XSS 向量全部被拦(有针对性测试)
- [ ] 相对 `/api/files/{uuid}/download` 在消毒后保留;**外部 `http(s)` 图被剥离**(有测试)
- [ ] 工具栏 + 预览**经 `/api/admin/posts/preview`**(管理员鉴权 + 服务端 `renderMarkdown`),客户端不单跑渲染
- [ ] 内联插图:上传 content_image + 关联 `kind='inline'` + 正文插入 Markdown;新建态先存草稿
- [ ] attach **校验 `kind↔purpose`**(`inline→content_image`、`attachment→content_attachment`)
- [ ] **`kind='inline'` 放宽 draft-only 门槛**(已发布文章/翻译可挂/解内联图 + reconcile 可运行;其余 kind 仍 draft-only)
- [ ] 内联图继承 member-only 门禁(purpose 鉴权,未改 `canAccessFile` 语义)
- [ ] 画廊只显 `kind='image'`,内联图不重复
- [ ] 翻译同为 Markdown + 同款编辑器;AI 翻译**占位保护 + token 集合校验**(篡改即拒)
- [ ] reconcile **orphan-check**(引用计数为 0 才删,**不走 `deleteFile` 级联**);保存后执行无误删窗口;跨帖子共享 file 不被误删
- [ ] 主题契约**新增 `bodyHtml`、保留 `body`(deprecated)**,内置主题渲染 + 排版样式;自定义主题迁移注明
- [ ] `post_files.kind` 加 inline 为 **TS 枚举层**;确认无空迁移/不占迁移编号
- [ ] 旧纯文本兼容渲染(`breaks`),升级说明注明

## 不在本切片(后续)

- 富文本 WYSIWYG 高级模式;自动保存 / 草稿恢复;版本历史;协同编辑。
- 视频/嵌入(B2);任务列表、脚注等 GFM 扩展;数学公式。
- 历史纯文本精确保真迁移(如未来需要)。
