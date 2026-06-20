# 交接：公开视频嵌入 — provider 白名单 iframe

> 给执行 agent 的自包含实施说明。前置依赖：ADR 0006 的 Markdown 编辑器切片已合并。设计依据：[ADR 0008](../adr/0008-public-video-embeds.md)。
>
> 开工前创建独立 Issue；实施 PR 保持 Draft，直到完整 CI 全绿。

## 1. 目标

让创作者使用显式 Markdown 指令嵌入：

- YouTube；
- Vimeo；
- Bilibili。

这是公开第三方内容，不提供会员字节门禁。会员专属视频必须使用 ADR 0007 的自托管附件。

## 2. 红线

1. 保持 `markdown-it({ html:false })`，不允许裸 iframe。
2. iframe 只能由 Core 根据 provider 注册表生成。
3. 必须使用顶层 markdown-it block rule，禁止逐行字符串替换。
4. preview/public 使用同一 `renderMarkdown`，由 `embedMode` 区分。
5. preview 默认不自动加载第三方 iframe。
6. sanitizer 的 iframe host 只能来自 `EMBED_HOSTS`。
7. 本切片不设置 sandbox。
8. 整行 `@video:` 必须纳入 AI 翻译 token 保护。

## 3. provider 注册表

新增 `src/modules/content/video-embed.ts`：

```ts
export type EmbedProviderId = "youtube" | "vimeo" | "bilibili";

export type ResolvedVideoEmbed = {
  provider: EmbedProviderId;
  originalUrl: string;
  embedSrc: string;
  title: string;
};

export function resolveVideoEmbed(rawUrl: string): ResolvedVideoEmbed | null;

export const EMBED_HOSTS = [
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "player.bilibili.com",
] as const;
```

### YouTube

接受：

```text
https://www.youtube.com/watch?v=<11-char-id>
https://youtu.be/<11-char-id>
https://www.youtube.com/shorts/<11-char-id>
```

输出：

```text
https://www.youtube-nocookie.com/embed/<id>
```

### Vimeo

接受：

```text
https://vimeo.com/<digits>
```

输出：

```text
https://player.vimeo.com/video/<digits>
```

### Bilibili

接受：

```text
https://www.bilibili.com/video/<BVID>
```

输出：

```text
https://player.bilibili.com/player.html?bvid=<BVID>
```

要求：

- `new URL()` 解析；
- scheme 仅 HTTPS；
- host 精确匹配允许变体；
- ID / BVID 严格正则；
- 拒绝 `youtube.com.evil.com` 等伪装 host；
- 不发送 oEmbed 或其他出站请求。

## 4. markdown-it 顶层 block rule

在 `markdown.ts` 注册自定义 block rule。

只在以下全部成立时命中：

```ts
state.parentType === "root";
state.sCount[startLine] === 0;
当前行去除尾部换行后完整匹配 /^@video:\s+(\S+)\s*$/;
```

并确认当前上下文不是：

- fenced code；
- indented code；
- blockquote；
- list；
- 其他嵌套 block。

rule 不直接输出 HTML，而是生成自定义 token：

```ts
token.type = "video_embed";
token.meta = resolvedEmbed;
```

未命中 provider 时不生成 token，让 Markdown 正常按文本/linkify 处理。

必须验证以下内容均不转换：

```markdown
`@video: https://...`

> @video: https://...

- @video: https://...

    @video: https://...

\@video: https://...

普通句子 @video: https://...
```

## 5. renderer 的 public / preview 模式

ADR 0006 提供：

```ts
renderMarkdown(markdown, {
  embedMode: "public" | "preview",
});
```

### public renderer

输出：

```html
<div class="video-embed">
  <iframe
    src="https://allowed-host/..."
    title="YouTube video"
    loading="lazy"
    referrerpolicy="strict-origin-when-cross-origin"
    allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
    allowfullscreen
  ></iframe>
</div>
```

### preview renderer

输出不自动请求第三方的占位：

```html
<div
  class="video-embed-placeholder"
  data-provider="youtube"
  data-embed-src="https://www.youtube-nocookie.com/embed/..."
>
  <button type="button">点击加载 YouTube 视频</button>
</div>
```

要求：

- `data-embed-src` 只能来自注册表的规范 URL；
- 管理端点击后再次 `new URL()` 并验证 hostname ∈ `EMBED_HOSTS`；
- 通过验证后才将 placeholder 替换为 iframe；
- 默认预览不会产生第三方网络请求；
- 组件卸载时清理事件监听；
- 不使用 `innerHTML` 拼接用户输入创建 iframe。

## 6. preview API

复用 ADR 0006：

```http
POST /api/admin/posts/preview
```

请求：

```json
{
  "markdown": "@video: https://youtu.be/...",
  "embedMode": "preview"
}
```

服务端只允许 `embedMode="preview"`，调用同一个 `renderMarkdown` 并返回已消毒 HTML。

公开页面调用：

```ts
renderMarkdown(body, { embedMode: "public" });
```

## 7. sanitizer

扩展允许标签：

```text
iframe
div
button
```

允许属性：

```ts
iframe: [
  "src",
  "title",
  "loading",
  "referrerpolicy",
  "allow",
  "allowfullscreen",
  "width",
  "height",
];

div: ["class", "data-provider", "data-embed-src"];
button: ["type"];
```

允许 class：

```ts
div: ["video-embed", "video-embed-placeholder"];
```

iframe：

```ts
allowedIframeHostnames: EMBED_HOSTS;
```

额外要求：

- `data-embed-src` 只允许 HTTPS 且 host ∈ `EMBED_HOSTS`；
- 非白名单 iframe 整体剥离；
- 不允许 sandbox 属性；
- 裸 iframe 源文本被 `html:false` 转义；
- sanitizer 测试应直接注入伪造 HTML验证兜底。

## 8. CSP 接入点

`EMBED_HOSTS` 是未来 CSP `frame-src` 的唯一来源。

不得在文档或代码中建议：

```text
frame-src https:
frame-src *
```

若本切片同时新增 CSP，则只生成：

```text
frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com https://player.bilibili.com
```

若项目暂未启用 CSP，只保留集中常量和接入测试，不额外扩大其他 directive。

## 9. 编辑器按钮

`MarkdownEditor` 工具栏新增“插入公开视频”：

1. 输入观看 URL；
2. 客户端调用共享 URL validator 或轻量 API确认支持；
3. 合法时插入独立行：

```text
@video: <original-url>
```

4. 非法时显示支持列表，不插入正文；
5. UI 明确提示“第三方嵌入不是会员专属”。

客户端校验只改善 UX，服务端 renderer 必须重新校验。

## 10. 主题样式

在内容样式区增加：

```css
.video-embed,
.video-embed-placeholder {
  width: 100%;
  aspect-ratio: 16 / 9;
}

.video-embed iframe {
  width: 100%;
  height: 100%;
  border: 0;
}
```

placeholder 应提供清晰按钮和 provider 名称。

## 11. AI 翻译

ADR 0006 的保护器必须把整行：

```text
@video: <url>
```

作为单个不可变 token。模型返回后 token 集合不一致则拒绝 machine draft。

## 12. i18n 与文档

zh/en/ja 增加：

- 插入公开视频；
- URL 输入提示；
- 不支持来源；
- 点击加载；
- 第三方视频非会员专属；
- 会员视频请上传附件。

管理员文档说明第三方隐私请求和可用性依赖。

## 13. 测试

### provider resolver

- YouTube watch/youtu.be/shorts；
- Vimeo；
- Bilibili；
- 错误 host；
- 伪装 host；
- HTTP、javascript、缺 ID、属性注入；
- 输出 host 必须在 `EMBED_HOSTS`。

### block rule

- 顶层零缩进独立行转换；
- fenced/inline code 不转换；
- blockquote 不转换；
- list 不转换；
- indented code 不转换；
- 转义和普通句子不转换。

### public renderer

- 合法 URL输出 iframe；
- iframe host 白名单；
- loading/referrerpolicy/allow 正确；
- 非法 URL无 iframe；
- 裸 iframe 无可执行结果。

### preview renderer/API

- POST preview 返回 placeholder，无 iframe；
- 打开预览不请求第三方；
- 点击前 host 再验证；
- 点击合法 placeholder 后创建 iframe；
- 伪造 data-embed-src 被拒绝；
- 非管理员 401/403；
- no-store。

### sanitizer

- 非白名单 iframe 剥离；
- 非白名单 data-embed-src 剥离或 placeholder 整体删除；
- sandbox 不保留；
- script、事件属性和注入向量被拒绝。

## 14. 验证

```bash
pnpm lint
pnpm format:check
pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator
pnpm build
```

## 15. 验收清单

- [ ] 顶层 markdown-it block rule
- [ ] Core 生成规范 embed，不允许裸 iframe
- [ ] public/preview 模式明确
- [ ] preview 默认占位且点击前二次校验
- [ ] sanitizer host 与 data 属性白名单
- [ ] 不设置 sandbox
- [ ] EMBED_HOSTS 作为 CSP 单一来源
- [ ] AI 翻译整行保护
- [ ] UI/文档标明非会员专属
- [ ] 无 schema 迁移
- [ ] 完整 CI 全绿

## 不在本切片

- oEmbed；
- 自动缩略图和第三方标题抓取；
- 更多 provider；
- 音频、音乐、推文等其他 embed；
- 会员专属第三方视频。
