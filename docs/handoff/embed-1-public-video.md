# 交接：公开视频嵌入 — provider 白名单 iframe

> 给执行 agent 的自包含实现说明。**前置依赖:编辑器 Markdown 切片([ADR 0006](../adr/0006-markdown-editor.md) / `handoff/editor-1-markdown-inline-images.md`)已合并**——本切片**扩展**其 `src/modules/content/markdown.ts` 与编辑器组件。落地决策见 [ADR 0008](../adr/0008-public-video-embeds.md)。
>
> 开工前建 issue(如「feat(content): public video embeds」),PR 关联;Draft 直到 CI 全绿。

让创作者在正文嵌入 **YouTube / Vimeo / Bilibili** 公开视频(不占自托管存储/带宽)。**这是公开内容,不是会员专属**(会员专属走自托管附件 = ADR 0007)。

## 0. 红线

1. **绝不开裸 HTML/iframe**:`markdown-it` 仍 `html:false`;iframe **只能由 Core 从 provider 白名单 URL 生成**。
2. **iframe host 锁死白名单**:`sanitize-html` 用 `allowedIframeHostnames` 限定 `www.youtube-nocookie.com`/`player.vimeo.com`/`player.bilibili.com`;非白名单 URL → **不生成 iframe,退化为普通链接**。
3. **必须用 markdown-it block rule**(非逐行预处理):代码块/引用/列表/转义文本里的 `@video:` **不得**被转成 iframe。
4. **id/BVID 严格正则**,任何不匹配 → 不嵌入。
5. **不设半截 `sandbox`**;host 白名单常量 `EMBED_HOSTS` 单一来源,与未来 CSP `frame-src` 共用(§3/§4)。
6. embed **非会员专属**:UI/文档明确标注;会员专属视频引导用附件上传。
7. **AI 翻译保护**:整行 `@video: <url>` 是指令,纳入编辑器切片的占位保护 + token 校验集合(送模前占位、译后还原、不一致即拒)。

## 1. 现状(依赖编辑器切片)

- `src/modules/content/markdown.ts`(编辑器切片新建):`renderMarkdown(md)` = markdown-it(`html:false`)→ sanitize-html 白名单(**当前不含 iframe**)。本切片在此扩展。
- 编辑器 `src/components/admin/markdown-editor.tsx`(编辑器切片新建):工具栏 + 预览;本切片加「插入嵌入」按钮。
- 主题 `post-detail.tsx` 用 `dangerouslySetInnerHTML={{__html: bodyHtml}}` 渲染——**本切片无需改主题**(iframe 在 bodyHtml 内)。

## 2. 锁定决策(见 ADR 0008)

| # | 决策 |
|---|---|
| D1 | 显式标记 `@video: <url>`(单独一行)触发嵌入;不自动转任意链接。 |
| D2 | Core 校验 provider 白名单 → 生成规范 embed iframe;未命中 → 退化链接。 |
| D3 | `sanitize-html` 放行 `iframe` 且 `allowedIframeHostnames` 锁 host。 |
| D4 | 首批 provider:YouTube(`youtube-nocookie.com`)、Vimeo、Bilibili;小注册表可扩展。 |
| D5 | embed 公开;不做会员门禁;UI/文档标注。 |

## 3. provider 注册表 `src/modules/content/video-embed.ts`(新建)

```ts
type EmbedProvider = {
  id: "youtube" | "vimeo" | "bilibili";
  // 命中观看 URL → 返回规范 embed src；不匹配 → null
  toEmbedSrc(url: URL): string | null;
};

// YouTube: youtube.com/watch?v=ID | youtu.be/ID | youtube.com/shorts/ID
//   → https://www.youtube-nocookie.com/embed/ID   （ID: [A-Za-z0-9_-]{11}）
// Vimeo: vimeo.com/{digits}        → https://player.vimeo.com/video/{digits}
// Bilibili: bilibili.com/video/{BV...} → https://player.bilibili.com/player.html?bvid={BV...}

export function resolveEmbedSrc(rawUrl: string): string | null; // 遍历注册表，全不匹配 → null

// 单一来源:embed iframe 的允许 host，供 sanitize allowedIframeHostnames 与（后续）CSP frame-src 共用
export const EMBED_HOSTS = ["www.youtube-nocookie.com", "player.vimeo.com", "player.bilibili.com"] as const;
```
- 用 `new URL()` 解析,**校验 host**(含国别/`m.`/`www.` 变体白名单),再正则取 id;任何异常/不匹配 → `null`。
- 不做出站请求(无 oEmbed)。

## 4. 渲染管线扩展 `markdown.ts`

- **必须用 markdown-it 自定义 block rule**(`md.block.ruler.before(...)` 或 `md.use` 插件)识别 `@video: <url>` 行,**严禁逐行字符串预处理**。逐行预处理会把 **fenced code / inline code / blockquote / 列表项 / 已转义文本**里的 `@video:` 误转成 iframe;block rule 只在真正的 block 上下文命中。
  - rule 命中且 `resolveEmbedSrc(url)` 命中 → renderer **直接产出** HTML 片段(响应式容器 + iframe),例如
    ```html
    <div class="video-embed"><iframe src="<embedSrc>" title="<provider> video"
      loading="lazy" referrerpolicy="strict-origin-when-cross-origin"
      allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
      allowfullscreen></iframe></div>
    ```
    > renderer 产出的 HTML 不受 `html:false` 对“用户源文本”的限制(这是渲染器产出,非用户文本)。注意 `allow` 拼写为 `accelerometer`。
  - `resolveEmbedSrc` 未命中 → 当作普通文本/链接(linkify 处理),**不产 iframe**。
- **sanitize 配置**新增(host 白名单从 provider 注册表导出的**共享常量** `EMBED_HOSTS` 取,见 §3,便于与未来 CSP `frame-src` 共用):
  ```ts
  allowedTags: [...existing, "iframe", "div"],
  allowedAttributes: {
    ...existing,
    iframe: ["src","title","loading","referrerpolicy","allow","allowfullscreen","width","height"],
    div: ["class"],
  },
  allowedClasses: { div: ["video-embed"] },
  allowedIframeHostnames: EMBED_HOSTS, // = ["www.youtube-nocookie.com","player.vimeo.com","player.bilibili.com"]
  // 不放行 sandbox 属性（见下）；sanitize 默认校验 iframe hostname：src 非白名单 → 整个 iframe 被剥离
  ```
- **关键顺序**:iframe 必须在「block rule 产出 → sanitize」之间存在,由 sanitize 按 `allowedIframeHostnames` 兜底校验。即便 block rule 被绕过,sanitize 也会剥掉非白名单 iframe(纵深防御)。
- **sandbox 策略(统一)**:本切片**不设 `sandbox`**,也不在 sanitize 允许属性内。理由:provider 播放器需 `allow-scripts allow-same-origin allow-presentation allow-popups` 才能工作,这组合已抵消 sandbox 隔离收益,收紧又破坏播放;安全靠 host 锁死 + `nocookie` 域 + `referrerpolicy` +(后续)CSP 承担。要 per-provider sandbox 须给经测试的完整权限集,不可半设。
- **CSP 接入点**:把 `EMBED_HOSTS` 作为单一来源常量集中导出;后续 CSP `frame-src` **只**列举这些精确 host(**绝不** `https:`/`*`),与 `allowedIframeHostnames` 共用,避免漂移。

## 5. 编辑器「插入嵌入」`markdown-editor.tsx`

- 工具栏加按钮 → 弹输入框收 URL → 校验 `resolveEmbedSrc(url) !== null`(命中才插)→ 在光标处插入新行 `@video: <url>`。
- 不命中 → 提示「暂不支持该来源,目前支持 YouTube / Vimeo / Bilibili」。
- 预览:走编辑器切片统一的 `GET /api/admin/posts/preview`(服务端 `renderMarkdown`),**不**在客户端单独渲染。**预览默认渲染占位卡片**(provider 名 + 「点击加载」),点击后才挂真 iframe;**只有公开页**默认 lazy 真 iframe。避免作者一开预览就自动向第三方发请求(隐私 + 噪声)。

## 6. 主题样式

`.video-embed`:16:9 响应式容器(`aspect-ratio: 16/9; width:100%`),`iframe` 充满、`border:0`、圆角。放内置主题已有的内容样式区(或 `prose-content` 旁)。

## 7. i18n

`{zh,en,ja}.ts` 补:插入嵌入按钮、URL 输入提示、「非会员专属/任何人可看」说明、不支持来源提示。

## 8. 文档

`docs/admin/` 或 README 注明:嵌入的第三方视频**非会员专属**;会员专属视频请用附件上传(自托管)。

## 9. 测试

- `resolveEmbedSrc`:YouTube(watch/youtu.be/shorts)、Vimeo、Bilibili 各形态 → 正确 embed src;非白名单 host、缺 id、`javascript:`、伪装 host(`youtube.com.evil.com`)→ `null`。
- 渲染:`@video: <合法>` → 含**白名单 host** iframe + `.video-embed`;`@video: <非法>` → **无 iframe**(退化链接/文本)。
- **block rule 上下文**:`@video:` 出现在 ① fenced code、② inline code、③ blockquote、④ 列表项、⑤ 已转义/缩进文本中 → **均不**转 iframe(只在独立 block 行命中)。
- **消毒兜底**:即便构造一个非白名单 host 的 iframe 进入 sanitize,也被 `allowedIframeHostnames`(=`EMBED_HOSTS`)剥离(直接测 sanitize 层);`sandbox` 属性不被放行。
- XSS:`@video: javascript:...`、属性注入、`<iframe>` 裸写在正文(应被 `html:false` 转义)→ 全部无可执行 iframe。
- 编辑器:插入合法 URL → 正文出现 `@video:` 行;非法 URL → 提示且不插;预览默认占位卡片(不自动请求第三方)。

## 10. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```
(无 schema 迁移。)

## 11. PR

- base `main`,draft,标题 `feat(content): public video embeds`。
- 描述:provider 白名单(YouTube/Vimeo/Bilibili)、`@video:` 标记、markdown.ts 生成受控 iframe + sanitize `allowedIframeHostnames`、编辑器插入按钮、主题 16:9 样式、明确非会员专属。依赖编辑器切片;无迁移。
- 关联 issue。

## 12. 验收 checklist

- [ ] `html:false` 不变;iframe 仅由 Core 从白名单 URL 生成
- [ ] **markdown-it block rule**(非逐行预处理);代码块/引用/列表/转义文本里的 `@video:` 不转(有测试)
- [ ] sanitize `allowedIframeHostnames`=`EMBED_HOSTS` 锁 host;非白名单 iframe 被剥离(有测试);不放行 `sandbox`
- [ ] `EMBED_HOSTS` 单一来源常量,预留 CSP `frame-src` 共用接入点
- [ ] 非白名单/畸形 URL → 退化链接,不产 iframe
- [ ] 编辑器插入按钮校验来源;预览**默认占位卡片**(不自动打第三方),走统一 preview API
- [ ] 响应式 16:9;`loading=lazy` + `referrerpolicy`;`allow` 拼写 `accelerometer`
- [ ] AI 翻译把整行 `@video:` 纳入占位保护 + token 校验
- [ ] UI/文档标注「嵌入视频非会员专属」
- [ ] 无 schema 迁移

## 不在本切片(后续)

- oEmbed 实时元数据/标题抓取;更多 provider;封面缩略图卡片(点击再加载 iframe,省第三方请求与隐私)。
- 音频/其它 embed(音乐、推文等)。
