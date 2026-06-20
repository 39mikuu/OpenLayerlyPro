# ADR 0006：Markdown 内容编辑器 + 正文内联插图

- **Status**：Proposed ▶（2026-06-20；评审完成后再转 Accepted）
- **相关 issue**：v0.3 编辑器优化（待建 issue）
- **依赖**：现有内容模型、文件与存储模块、主题契约、内容多语言与 AI 翻译

## Context

当前 `posts.body` / `post_translations.body` 是纯文本，管理端使用 textarea，公开页按纯文本显示；图片和附件只能显示在正文下方，无法嵌入叙述流。

目标是增加基本 Markdown 排版、服务端安全渲染、正文内联插图和翻译结构保护，同时保持：

- SSR-first；
- 主题只负责展示；
- 现有文件权限矩阵继续作为唯一授权依据；
- 不引入 WYSIWYG HTML 存储；
- 不破坏现有自定义主题。

## Decision

### 1. 正文统一使用 GFM Markdown 子集

继续复用现有 `text` 列存储 Markdown，不新增 `body_format`：

- 支持标题、粗体、斜体、列表、链接、引用、代码、代码块、图片、分隔线和表格；
- 不支持任务列表；
- `breaks: true` 让历史纯文本换行保持可读；
- 历史内容中 `#`、`*`、`>` 等字符可能产生轻微格式变化，在升级说明中明确。

### 2. 服务端是唯一渲染与消毒边界

新增 `src/modules/content/markdown.ts`：

```ts
export type MarkdownEmbedMode = "public" | "preview";

export type RenderMarkdownOptions = {
  embedMode?: MarkdownEmbedMode;
};

export function renderMarkdown(
  markdown: string | null | undefined,
  options?: RenderMarkdownOptions,
): string;
```

基础实现：

```text
markdown-it({ html: false, linkify: true, breaks: true })
→ sanitize-html 白名单
→ 已消毒 HTML
```

`embedMode` 在本切片先预留，ADR 0008 扩展后：

- `public`：输出经过白名单验证的真实第三方 iframe；
- `preview`：输出不自动请求第三方的占位卡片。

公开页面使用 `embedMode: "public"`。管理端预览使用 `embedMode: "preview"`。

### 3. 管理端预览使用 POST API

预览统一走：

```http
POST /api/admin/posts/preview
Content-Type: application/json
Cache-Control: no-store

{
  "markdown": "...",
  "embedMode": "preview"
}
```

要求：

- `requireAdmin`；
- Zod 校验和明确正文长度上限；
- 服务端调用同一个 `renderMarkdown`；
- 客户端不加载第二套 markdown-it / sanitizer；
- 响应只返回已消毒 HTML。

### 4. 主题契约非破坏性演进

`PostDetailView` 新增：

```ts
bodyHtml: string | null;
```

同时保留：

```ts
/** @deprecated 下一主题大版本移除 */
body: string | null;
```

Core 同时填充两者，内置主题改用 `bodyHtml`。主题不解析 Markdown、不执行消毒。

### 5. 内联图片只允许内部受控文件

Markdown 图片只允许：

```text
/api/files/{uuid}/download
```

作为 `<img src>`。外部 `http(s)`、协议相对 URL、`data:`、`javascript:` 等全部剥离。

理由：

- 外链图绕过 OpenLayerlyPro 文件门禁；
- 会把访客 IP、User-Agent 和访问时间泄露给第三方；
- 远程内容可在发布后被替换。

内联图片仍使用 `purpose="content_image"`，并以 `post_files.kind="inline"` 关联帖子；权限继续由现有 `canAccessFile` 决定。

### 6. 内联图片采用“上传未关联、保存时同步关联”

为彻底关闭“上传并 attach 后，正文尚未保存而被另一保存误删”的窗口，流程锁定为：

1. 编辑器上传图片，只创建 `files` 记录并返回 `fileId`；**上传时不创建 `post_files` link**。
2. 编辑器把内部文件 URL 插入 Markdown。
3. 保存正文或翻译时，服务端解析即将提交的正文，并在同一内容保存事务中：
   - 验证引用的文件存在且 `purpose="content_image"`；
   - 对新增引用创建 `kind="inline"` link；
   - 汇总原文和所有 locale（含草稿翻译）计算仍有效的引用；
   - 解除不再使用的当前 post inline links。
4. 已发布文章/翻译允许上述**内部 inline 同步 helper**运行；其他 kind 继续遵守 draft-only 限制。
5. 通用 attach/detach API 不得绕过正文引用校验去破坏已发布正文。

这样正文和 link 的权威状态由一次保存统一提交，不依赖宽限期或多标签页时序。

### 7. orphan 删除使用 durable cleanup

正文保存事务只负责解除 link，并为“当前已无任何引用”的候选文件写 durable cleanup task；**事务内不删除本地/S3 对象**。

cleanup worker 每次执行时必须重新：

1. 锁定 file 行；
2. 检查任意 `post_files`、cover、设置项及其他受保护引用；
3. 有引用则安全 no-op；
4. 无引用时幂等删除存储对象；
5. 删除 file 行；
6. 失败由 durable task 重试。

允许短期残留孤儿对象，不允许 DB 仍引用而对象已被不可回滚地删除。

### 8. kind 与 purpose 必须在服务端匹配

服务端统一校验：

```text
inline / image / cover / preview / thumbnail → content_image 或该 kind 明确允许的图片 purpose
attachment                                  → content_attachment
```

错误组合返回 400。不能只依赖客户端传参。

`post_files.kind` 当前是 `text` + TypeScript enum 提示，不是数据库 CHECK；新增 `inline` 默认是纯 schema 类型更新，**不应生成空迁移或占用迁移编号**。只有实际新增数据库约束时才提交非空迁移。

### 9. AI 翻译使用占位保护和 token 校验

送模前保护：

- fenced / inline code；
- 裸 URL；
- Markdown 链接和图片的 URL 部分；
- ADR 0008 的整行 `@video: <url>` 指令。

流程：

```text
抽取不可译片段
→ 替换为不可变 token
→ 调用模型
→ 校验返回 token 集合完全一致
→ 恢复原片段
→ 不一致则拒绝采用草稿
```

prompt 约束只作为辅助，不是结构安全保证。

## Security requirements

- `html: false`；
- 输出再经过严格 sanitizer；
- 禁止脚本、事件属性、SVG、object、裸 iframe；
- 链接 scheme 白名单；
- 内联图片仅内部 UUID 路径；
- 管理端 preview API 需鉴权、限长、no-store；
- 公开页 locked 状态不得生成或传递正文 HTML。

## Alternatives

- **WYSIWYG / 存 HTML**：拒绝。AI 翻译结构更脆弱，消毒面更大，主题耦合更深。
- **仅增强纯文本**：拒绝。不能解决排版和正文插图。
- **增加 body_format**：当前 alpha 存量很小，复杂度大于收益；暂不采用。
- **客户端独立预览渲染器**：拒绝。会与服务端安全边界和后续 embed renderer 漂移。
- **上传时立即 attach + 宽限期 reconcile**：拒绝。多标签页和长时间未保存仍可能误删。

## Consequences

- ✅ Markdown、主题、翻译和文件权限边界清晰；
- ✅ 预览与公开页共用同一服务端 renderer；
- ✅ 内联图 link 与正文保存原子同步，不存在 attach 后未保存窗口；
- ✅ 对象清理由 durable task 重试，不把不可回滚 I/O 放进 DB 事务；
- ✅ 默认无 schema 迁移；
- ⚠️ 未保存正文时上传的文件可能暂时成为未关联文件，需要通用 orphan cleanup 定期处理；
- ⚠️ 自定义主题应在下一主题大版本前迁移到 `bodyHtml`；
- ⚠️ 自动保存、版本历史、协同编辑和 WYSIWYG 不在本 ADR。

## 待转 Accepted 前确认

1. Markdown 子集含表格、不含任务列表。
2. 渲染库为 markdown-it + sanitize-html。
3. preview API 使用 POST，公开/预览通过 `embedMode` 区分。
4. 内联图只在正文保存事务中同步 link。
5. orphan 对象通过 durable cleanup task 删除。
6. 默认不产生数据库迁移。
