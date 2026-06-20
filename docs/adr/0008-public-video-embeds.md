# ADR 0008：公开视频嵌入（provider 白名单 iframe）

- **Status**：Proposed ▶（2026-06-20；评审完成后再转 Accepted）
- **相关 issue**：v0.3 编辑器 / 视频（待建 issue）
- **依赖**：[ADR 0006](0006-markdown-editor.md)

## Context

创作者需要在正文中嵌入 YouTube、Vimeo 和 Bilibili 公开视频，避免占用自托管存储和带宽。

这些视频字节由第三方托管，无法提供真正的会员门禁。因此：

- 公开嵌入只适合预告、教程、引流等公开内容；
- 即使 iframe 出现在 member-only 帖子中，第三方视频本身仍可能被任何拿到链接的人观看；
- 会员专属视频必须使用 ADR 0007 的自托管附件流程。

ADR 0006 保持 `html:false`，因此不能允许作者直接写裸 iframe。

## Decision

### 1. 显式 `@video:` 指令

作者在独立一行写：

```text
@video: https://www.youtube.com/watch?v=...
```

系统不会自动把普通链接转成 iframe。

合法 URL命中 provider 注册表后，由 Core 生成规范 embed。非法或不支持 URL退化为普通文本/链接。

### 2. provider 注册表是唯一来源

新增 `src/modules/content/video-embed.ts`：

```ts
export type EmbedProviderId = "youtube" | "vimeo" | "bilibili";

export type ResolvedVideoEmbed = {
  provider: EmbedProviderId;
  originalUrl: string;
  embedSrc: string;
};

export function resolveVideoEmbed(rawUrl: string): ResolvedVideoEmbed | null;

export const EMBED_HOSTS = [
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "player.bilibili.com",
] as const;
```

注册表负责：

- 校验观看 URL host；
- 严格提取 ID / BVID；
- 生成规范 HTTPS embed URL；
- 拒绝伪装 host、缺失 ID、属性注入和非 HTTPS scheme；
- 向 sanitizer 和未来 CSP 导出同一 host 列表。

首批转换：

| provider | 观看 URL | embed URL |
|---|---|---|
| YouTube | watch / youtu.be / shorts | `www.youtube-nocookie.com/embed/{id}` |
| Vimeo | `vimeo.com/{digits}` | `player.vimeo.com/video/{id}` |
| Bilibili | `/video/{BVID}` | `player.bilibili.com/player.html?bvid={BVID}` |

不做 oEmbed 或任何运行时第三方抓取。

### 3. 必须使用顶层 markdown-it block rule

不得使用逐行字符串替换。

block rule 只允许在：

- `state.parentType === "root"`；
- 当前行零缩进；
- 整行只包含 `@video:` + URL；
- 不处于 fenced/indented code、blockquote、列表或其他嵌套容器；

时命中。

以下全部不得转换：

- fenced code；
- inline code；
- blockquote；
- 列表项；
- 缩进代码；
- 转义文本；
- 行内普通句子。

rule 应生成结构化 token，并在 renderer 阶段根据 `embedMode` 决定输出，不直接依赖用户 HTML。

### 4. public 与 preview 使用同一 renderer 的不同模式

ADR 0006 的接口：

```ts
renderMarkdown(markdown, {
  embedMode: "public" | "preview",
});
```

#### public

输出：

```html
<div class="video-embed">
  <iframe ...></iframe>
</div>
```

iframe：

- `loading="lazy"`；
- `referrerpolicy="strict-origin-when-cross-origin"`；
- `allowfullscreen`；
- 精确 `allow` 权限；
- 规范 embed host。

#### preview

默认不输出 iframe，而输出安全占位卡片：

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

- `data-embed-src` 必须来自 `resolveVideoEmbed` 的规范结果；
- sanitizer 只允许该 placeholder class 和必要 data 属性；
- 客户端点击后再次校验 URL host ∈ `EMBED_HOSTS`，再创建 iframe；
- 打开预览时不自动向第三方发请求；
- 预览 API 使用 POST，见 ADR 0006。

### 5. sanitizer 兜底

允许：

- `iframe`；
- `.video-embed` 容器；
- `.video-embed-placeholder` 占位容器；
- placeholder button；
- 必要属性和 data 属性。

iframe host 必须通过：

```ts
allowedIframeHostnames: EMBED_HOSTS
```

非白名单 iframe 整体剥离。裸 HTML中的 iframe 仍会先被 `html:false` 转义。

### 6. sandbox 策略

本切片不设置 iframe `sandbox`，也不把 `sandbox` 加入 sanitizer 白名单。

原因：三个 provider 的播放器通常需要 scripts、same-origin、presentation 和 popup 能力；半设置 sandbox 会直接破坏播放，而宽松组合又缺少实际隔离收益。

安全边界依赖：

- 规范 embed URL；
- 精确 host allowlist；
- youtube-nocookie；
- referrerpolicy；
- sanitizer；
- 未来 CSP `frame-src`。

### 7. CSP 接入

`EMBED_HOSTS` 同时作为未来 CSP `frame-src` 的唯一数据源。

不得配置：

```text
frame-src https:
frame-src *
```

只能列举精确 embed host。

### 8. AI 翻译保护

整行 `@video: <url>` 作为不可译指令，在送模前整体替换为 token；返回后校验 token 集合并恢复。

模型不得修改：

- provider URL；
- 指令前缀；
- 行结构。

### 9. 产品提示和隐私

管理端必须明确提示：

> 第三方嵌入不是会员专属视频。会员内容请上传自托管视频附件。

公开页面加载真实 iframe 会向第三方发起请求；管理员文档应说明该隐私权衡。

## Alternatives

- **允许裸 iframe**：拒绝，扩大 HTML/XSS 面。
- **逐行字符串预处理**：拒绝，会误处理代码、引用和列表。
- **自动转换所有视频链接**：拒绝，行为不透明。
- **把 embed 当会员视频**：拒绝，无法控制第三方字节。
- **预览自动加载 iframe**：拒绝，会在作者打开预览时立即请求第三方。
- **半设置 sandbox**：拒绝，兼容性和安全收益都不明确。

## Consequences

- ✅ 公开嵌入不占自托管带宽；
- ✅ 用户不能注入任意 iframe；
- ✅ preview/public 共用同一 renderer，行为由明确模式区分；
- ✅ sanitizer 与未来 CSP 共用 host 常量；
- ⚠️ 第三方隐私和可用性依赖仍存在；
- ⚠️ provider URL规则变化时需要维护注册表；
- ⚠️ 必须在 ADR 0006 实现完成后串行实施。

## 待转 Accepted 前确认

1. 首批 provider 为 YouTube/Vimeo/Bilibili。
2. 只识别顶层零缩进独立块。
3. preview 默认占位，点击后才加载。
4. 本切片不设置 sandbox。
5. CSP 未来使用 `EMBED_HOSTS` 精确生成。
