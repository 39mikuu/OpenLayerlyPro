# ADR 0006：Markdown 内容编辑器 + 正文内联插图

- **Status**：Proposed ▶（2026-06-20）
- **相关 issue**：v0.3 编辑器优化（待建 issue）
- **依赖**：现有内容模型（`posts.body` / `post_translations.body`）、文件与流式上传（`src/modules/file`、`src/modules/storage`）、主题契约（`src/modules/theme`）、内容多语言与 AI 翻译

## Context

当前正文编辑是**纯 `<textarea>` 存纯文本**：

- `posts.body` / `post_translations.body` 是 `text`，无格式语义；公开页 `src/themes/builtin/post-detail.tsx` 用 `whitespace-pre-wrap` 原样渲染，**无解析、无消毒**(纯文本天然安全)。
- 图片/附件是正文**下方独立画廊**(`post_files` 的 `kind=image/attachment`),**无法把图片嵌入叙述流**,正文里也无法加粗、标题、链接、列表、代码块。
- 已有内容多语言 + AI 翻译(`post_translations`,`source=manual|machine`),逐 locale 编辑同款纯文本 textarea。

创作者(插画师/创作者)需要基本排版与**正文内联插图**。这要求引入一种带格式的内容格式 + 渲染管线,且必须同时满足:**安全**(渲染到所有访客)、**对 AI 翻译友好**(结构稳)、**契合 SSR-first 主题**、**与现有文件鉴权一致**。

最危险的点是 XSS:正文渲染成 HTML 后会发给所有访客(含 member-only 内容的授权访客)。虽然**单创作者**模型下作者=唯一写入者(自伤面),但渲染管线仍须按不可信内容对待(纵深防御 + 未来多作者/导入场景)。

## Decision

### 1. 内容格式 = GFM Markdown(禁用裸 HTML)

`posts.body` / `post_translations.body` **复用现有 `text` 列存 Markdown**(GitHub 风格子集:标题、粗斜体、列表、链接、引用、代码/代码块、图片、分隔线、表格)。**不引入 `body_format` 鉴别列**:

- 历史纯文本按 Markdown 渲染时,用 `breaks: true`(换行→`<br>`)保证可读;特殊字符(`#`/`*`/`>`)的轻微走样在 alpha(几乎无存量内容)可接受,升级说明里注明。
- 杜绝把「展示文本当格式」之外的歧义:一种格式,逐 locale 一致。

> 否决「富文本 WYSIWYG 存 HTML」(见 Alternatives):HTML 对 AI 翻译不友好、消毒面更大、与 SSR 主题耦合更复杂。

### 2. 渲染管线在 Core,主题只展示

渲染 + 消毒在 **Core/页面层**完成,**主题拿到已消毒 HTML**:

- 新增共享模块 `src/modules/content/markdown.ts`:`renderMarkdown(md): string`(权威渲染) = markdown-it(`html:false`、`linkify:true`、`breaks:true`)→ **sanitize-html 白名单**(标签/属性/URL scheme 白名单:`http`/`https`/`mailto` + 相对 `/api/files/...`;禁 `javascript:`/`data:` 等)。
- 主题契约 `PostDetailView` 增加 `bodyHtml: string | null`(已消毒),内置主题用 `dangerouslySetInnerHTML` 渲染。**主题不解析、不消毒、不碰 Markdown**——保持「主题只展示、不含业务」。
- 列表/摘要(`summary`)仍按纯文本/截断处理,不渲染 Markdown。

### 3. 安全红线

- **禁用裸 HTML**(markdown-it `html:false`)+ **输出再过 sanitize-html 白名单**(纵深防御,即便单作者)。
- URL scheme 白名单;`rel="noopener nofollow"` + 外链处理由 sanitize 配置统一。
- 消毒是**服务端权威边界**;客户端预览仅作者自看,可只用 markdown-it(`html:false`)免重复打包 sanitize-html,但**绝不**把客户端预览当安全边界。

### 4. 正文内联插图,复用文件系统与鉴权

- 编辑器内上传图片(工具栏按钮 / 拖拽 / 粘贴)→ 走**现有图片上传**(`content_image`,buffered + sharp 尺寸校验)→ 返回 fileId → 在光标处插入 Markdown `![alt](/api/files/{fileId}/download)`。
- **内联图片必须 link 成该 post 的 `post_files`**(新增 `kind='inline'`),从而**继承现有下载鉴权**(purpose×post 状态×可见性×会员态的既有矩阵),与正文同授权;下方画廊只渲染 `kind='image'`,内联图不重复出现。
- **未引用清理**:保存帖子时解析正文中的 `/api/files/{id}` 引用,unlink+删除不再被引用的 `kind='inline'` 文件,避免存储泄漏(reconcile;复用 #6/文件删除范式)。

### 5. 翻译也是 Markdown,AI 翻译保结构

- `post_translations.body` 同为 Markdown;翻译编辑器获得**同款工具栏 + 预览**。
- AI 翻译草稿 prompt 更新:声明输入为 Markdown,**保留结构/代码块/URL/图片引用**(只译 alt 文本与正文,`![](...)` 的 URL 原样)。
- 编辑正文照旧 bump `content_updated_at`(翻译陈旧判定不变)。

### 6. 依赖

新增:`markdown-it`(+ `@types/markdown-it`)、`sanitize-html`(+ `@types/sanitize-html`)。在 PR 注明。

## Alternatives

- **富文本 WYSIWYG(TipTap/ProseMirror,存 HTML)**:体验最直观,但 ① HTML 对 AI 翻译不友好(标签噪声、易破坏结构);② 消毒面更大、存储即 HTML 风险更高;③ 包更重、与 SSR 主题(服务端出 HTML)耦合更复杂。否决,留作未来可选高级编辑模式。
- **仅增强纯文本**(字数/自动保存/全屏,不改格式):改动最小,但解决不了「无法排版 / 无法插图」的核心诉求。否决(可作为本切片之外的独立 UX 增强)。
- **加 `body_format` 鉴别列**(plain|markdown):back-compat 最稳,但逐 post + 逐 translation 线程化 format、复杂度高;alpha 存量内容近乎为零,收益不抵成本。否决,改用 §1 的统一 Markdown + `breaks` 兼容;若未来有大量历史纯文本需精确保真,再评估。
- **remark/rehype + rehype-sanitize 管线**:消毒为 AST 一等步骤、非常稳;但包更多、配置更重。本版选 markdown-it + sanitize-html(更小、更直接、广泛使用);交接评审时可改选,接口不变。
- **客户端也用 sanitize-html 做预览**:预览不是安全边界(作者自看),为减小客户端包,预览仅 markdown-it。

## Consequences

- ✅ 复用现有地基:文件流式上传 + sharp 校验 + 下载鉴权矩阵 + 翻译模型 + 主题契约;编辑器优化主要是「加格式 + 渲染消毒 + 内联上传接线」。
- ✅ Markdown 对 AI 翻译友好,结构稳;SSR 出已消毒 HTML,主题零业务。
- ✅ 内联图片继承既有授权(link 成 `post_files.kind='inline'`),member-only 内容的内联图同样受控。
- ⚠️ 引入 HTML 渲染 = 引入 XSS 面:**必须** `html:false` + sanitize 白名单 + URL scheme 白名单,并有针对性测试(脚本注入、`javascript:`/`data:` URL、事件属性、SVG/iframe 等被拦截)。
- ⚠️ 需轻量迁移:`post_files.kind` 增 `inline` 枚举值(增量、低风险);历史纯文本 body 渲染走样需在升级说明注明。
- ⚠️ 主题契约扩字段 `PostDetailView.bodyHtml`;自定义主题需消费它(内置主题随本切片更新)。
- ⚠️ 未引用内联图的 reconcile 需正确处理(删多了会丢图、删少了会泄漏);需测试。
- ⚠️ 富文本 WYSIWYG、自动保存/草稿恢复、版本历史、协同编辑均不在本 ADR;后续单独评估。

## 待确认的决策

1. Markdown 子集是否含**表格**与**任务列表**(GFM 扩展)?默认含表格、不含任务列表(可调)。
2. 渲染库二选一:**markdown-it + sanitize-html**(推荐,本版默认) vs remark/rehype + rehype-sanitize。
3. 是否本切片即做**未引用内联图 reconcile**(推荐做,防泄漏),还是先留 TODO。
