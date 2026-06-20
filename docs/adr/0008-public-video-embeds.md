# ADR 0008：公开视频嵌入(provider 白名单 iframe)

- **Status**：Accepted ✅（2026-06-20）
- **相关 issue**：v0.3 编辑器 / 视频（待建 issue）
- **依赖**：[ADR 0006](0006-markdown-editor.md)(Markdown 编辑器 + 渲染管线;**embed 扩展其管线,需 0006 切片先落地**)

## Context

[ADR 0007](0007-inline-video-playback.md) 解决**会员专属视频**(自托管字节 + 鉴权出口)。但还有一类需求:**公开视频**(预告片、教程、引流),创作者希望直接嵌 YouTube / Vimeo / Bilibili,**不占自己的存储与带宽**。

关键约束(必须讲清,避免误用):

- **外链/嵌入无法做会员门禁**。视频字节在第三方,任何拿到链接的人都能看。即便把 embed 放进 member-only 帖子,帖子正文虽对非会员隐藏,但 YouTube 上那条视频本身仍是公开/unlisted 的——**embed 不是会员专属的替代**,会员专属一律走 ADR 0007 自托管。
- ADR 0006 的 Markdown 管线**禁用裸 HTML**(`html:false`)且消毒白名单**不含 iframe**。embed 需要 iframe,因此必须以**受控、provider 白名单**的方式引入,绝不能开「任意用户 HTML/iframe」的口子。

## Decision

### 1. 不开裸 iframe;由 Core 从 provider 白名单 URL 生成受控 iframe

- 保持 `markdown-it({ html:false })`——**用户绝不能写裸 HTML/iframe**。
- 编辑器「插入嵌入」按钮:粘贴 provider 观看 URL → 在正文插入**显式标记**(单独一行)`@video: <url>`。
- 渲染时(扩展 `src/modules/content/markdown.ts`):预处理识别 `@video: <url>` 行 → 校验 URL 命中 **provider 白名单** → 解析出视频 id → 生成该 provider 的**规范 embed iframe**;**未命中白名单 → 退化为普通链接**(不产生 iframe)。
- `sanitize-html` 仅放行 `iframe`,且用 `allowedIframeHostnames` 把 `src` host 锁死在白名单(`www.youtube-nocookie.com`、`player.vimeo.com`、`player.bilibili.com`),属性仅 `src/width/height/allow/allowfullscreen/loading/referrerpolicy/title/sandbox`。

### 2. provider 白名单(小注册表,可扩展)

| provider | 观看 URL → embed |
|---|---|
| YouTube | `youtube.com/watch?v=ID` / `youtu.be/ID` → `https://www.youtube-nocookie.com/embed/ID` |
| Vimeo | `vimeo.com/ID` → `https://player.vimeo.com/video/ID` |
| Bilibili | `bilibili.com/video/BVID` → `https://player.bilibili.com/player.html?bvid=BVID` |

- 用 `youtube-nocookie.com`(隐私增强域)。
- id/BVID 严格正则提取,任何不匹配 → 不生成 iframe(退化链接)。
- iframe 加 `loading="lazy"`、`referrerpolicy="strict-origin-when-cross-origin"`、`title`(可访问性),用 `<div>` 包一层做 16:9 自适应(主题样式)。

### 3. 与会员专属明确区分

- embed 永远是**公开**内容;UI/文档明确标注「嵌入的第三方视频非会员专属,任何人可看;会员专属视频请用附件上传(自托管)」。
- 不混淆两条路:ADR 0007 = 自托管会员视频;ADR 0008 = 公开第三方嵌入。

## Alternatives

- **允许用户写裸 `<iframe>`**:否决。等于开 HTML 注入口,XSS/点击劫持风险;违背 ADR 0006 的 `html:false`。
- **自动把任意粘贴的 YouTube 链接转 iframe**:否决(易误转、不可控)。改用显式 `@video:` 标记,所见即所选。
- **用 embed 充当会员专属视频**:否决——第三方字节无法门禁,见 Context。
- **oEmbed 实时抓取 provider 元数据**:否决(本切片);需出站请求 + 缓存 + 失败处理,收益不抵复杂度;直接按 URL 模板生成 embed 即可。

## Consequences

- ✅ 公开视频零存储/带宽成本;复用 ADR 0006 的 Markdown 管线,主题层(`bodyHtml` + `dangerouslySetInnerHTML`)无需改。
- ✅ iframe 严格 provider 白名单 + host 锁定,安全面可控;`html:false` 不变。
- ⚠️ 引入 iframe = 引入第三方框架(点击劫持/隐私):必须 `allowedIframeHostnames` 锁 host、规范 embed 域、`referrerpolicy`,并测试非白名单 URL/注入向量被拒。
- ⚠️ **依赖 ADR 0006 切片先落地**(扩展其 `markdown.ts` 与编辑器);embed 切片排在编辑器之后。
- ⚠️ embed 非会员专属,需在 UI/文档反复明确,避免创作者误把私密内容放公开第三方。
- ⚠️ provider 改版 embed 域/参数会失效(白名单维护成本);初期仅 YouTube/Vimeo/Bilibili。
