# ADR 0006：Markdown 内容编辑器 + 正文内联插图

- **Status**：Proposed ▶（2026-06-20；评审阻塞项修订中，锁定后转 Accepted）
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
- **`img` src 锁内部文件**:首切片 sanitizer 只放行**相对** `/api/files/{uuid}/download` 作为 `<img src>`,**剥离外部 `http(s)` 图片**。理由:外链图会 ① 绕过 OpenLayerlyPro 文件门禁(会员图能被第三方 hotlink),② 把每个访客的 IP/UA/访问时间泄露给任意第三方域。需要外部图床时后续单加显式 allowlist 域,不在本切片默认开。
- 主题契约 `PostDetailView` **新增** `bodyHtml: string | null`(已消毒),内置主题切到 `dangerouslySetInnerHTML` 渲染。**主题不解析、不消毒、不碰 Markdown**——保持「主题只展示、不含业务」。
- **不在本切片直接删 `body`**:同一主题版本内 `body`(标 deprecated,仍填充原始文本)与 `bodyHtml` 并存,内置主题切到 `bodyHtml`;旧自定义主题继续读 `body` 不至于立刻崩。`body` 留待**下一主题大版本**移除并在 `docs/architecture` 注明迁移窗口。这样契约演进不打断现有自定义主题。
- 列表/摘要(`summary`)仍按纯文本/截断处理,不渲染 Markdown。

### 3. 安全红线

- **禁用裸 HTML**(markdown-it `html:false`)+ **输出再过 sanitize-html 白名单**(纵深防御,即便单作者)。
- URL scheme 白名单;`<img src>` 仅相对 `/api/files/...`(见 §4);`rel="noopener nofollow"` + 外链处理由 sanitize 配置统一。
- 消毒是**服务端权威边界**。**预览统一走管理员鉴权的 `GET /api/admin/posts/preview`**,复用同一服务端 `renderMarkdown`——前后端单一渲染/消毒实现,杜绝「预览只跑 markdown-it」与权威渲染在后续(`@video:` iframe renderer 等)发生安全边界漂移。客户端不再各自实现一套渲染。

### 4. 正文内联插图,复用文件系统与鉴权

- 编辑器内上传图片(工具栏按钮 / 拖拽 / 粘贴)→ 走**现有图片上传**(`content_image`,buffered + sharp 尺寸校验)→ 返回 fileId → 在光标处插入 Markdown `![alt](/api/files/{fileId}/download)`。
- **内联图片必须 link 成该 post 的 `post_files`**(新增 `kind='inline'`),从而**继承现有下载鉴权**(purpose×post 状态×可见性×会员态的既有矩阵),与正文同授权;下方画廊只渲染 `kind='image'`,内联图不重复出现。
- **未引用清理(reconcile)**:保存帖子时解析正文(及所有 locale 翻译)中的 `/api/files/{id}` 引用,删除不再被任何引用的 `kind='inline'` 文件。**不可直接复用现有 `deleteFile`**——它会级联解除该 file 在**其他帖子**的 `post_files` 关联(见 `file/index.ts` 注释)。正确流程:detach 当前 post 的 link → 检查该 file 是否仍被**任意** `post_files` 引用 → **仅当引用计数为 0** 才删 file/object,并处理并发重新关联。详见 handoff。
- **误删窗口**:必须避免「图已上传 attach、正文尚未保存」期间被另一处保存触发的 reconcile 当垃圾删掉。采用「正文保存成功后再 reconcile + 暂存/宽限」的明确方案(见 handoff §7),不靠时序巧合。

### 5. 翻译也是 Markdown,AI 翻译保结构

- `post_translations.body` 同为 Markdown;翻译编辑器获得**同款工具栏 + 预览**。
- **AI 翻译不能只靠 prompt 保结构**:送模前对**不可译片段做占位保护**(fenced/inline 代码块、URL、`![alt](url)` 的 `url`、未来的整行 `@video: <url>` 指令)→ 替换为不可破坏的占位 token → 译后按 token 还原;并做**不可变 token 集合校验**(返回文本的 token 集合须与送出完全一致),不一致即**拒绝采用该草稿**。prompt 声明输入为 Markdown 仅作辅助,不作为唯一保证。
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

## 已确认的决策（2026-06-20）

1. **Markdown 子集含表格,不含任务列表**。任务列表需把 `input[type=checkbox]` 纳入消毒白名单、扩大攻击面,而「已发布创作内容」几乎用不上;需要时后续单加。
2. **渲染库 = markdown-it + sanitize-html**。决定因素是客户端预览需一个服务端/客户端**共用的轻量解析器**,markdown-it 浏览器侧更轻;remark/rehype 在浏览器更重。在已强制 `html:false` + 输出再过白名单后,rehype-sanitize 的 AST 级消毒并无显著增量收益。
3. **本切片即做未引用内联图 reconcile**,但走**引用计数 orphan-check**(非 `deleteFile` 级联),且**正文保存成功后**才执行 + 暂存/宽限避免误删窗口。删错风险由「汇总所有 locale(含草稿翻译)引用 + 引用计数为 0 才删 + 处理并发重关联」兜住(见 handoff §7)。
