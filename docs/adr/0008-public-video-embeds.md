# ADR 0008：公开视频嵌入(provider 白名单 iframe)

- **Status**：Proposed ▶（2026-06-20；评审阻塞项修订中，锁定后转 Accepted）
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
- 渲染时(扩展 `src/modules/content/markdown.ts`):**必须用 markdown-it 自定义 block rule**(`md.block.ruler`)识别 `@video: <url>` 行,**不得**用逐行字符串预处理。逐行预处理会把 fenced code / blockquote / 列表 / 已转义文本里的 `@video:` 误转成 iframe;block rule 只在真正的 block 上下文命中。命中后:校验 URL 命中 **provider 白名单** → 解析视频 id → 由 renderer 直接产出该 provider 的**规范 embed iframe**;**未命中白名单 → 退化为普通链接/文本**(不产生 iframe)。
- 必须测试:fenced code、inline code、blockquote、列表项、转义文本中的 `@video:` **均不**被转成 iframe。
- `sanitize-html` 仅放行 `iframe`,且用 `allowedIframeHostnames` 把 `src` host 锁死在白名单(`www.youtube-nocookie.com`、`player.vimeo.com`、`player.bilibili.com`),属性仅 `src/width/height/allow/allowfullscreen/loading/referrerpolicy/title`。
- **sandbox 策略(统一,消除 ADR/handoff/sanitize 三处不一致)**:本切片**不对 provider iframe 设 `sandbox`**,`sandbox` 也**不在** sanitize 允许属性内。理由:让 YouTube/Vimeo/Bilibili 播放器正常工作需 `allow-scripts allow-same-origin allow-presentation allow-popups`,这组合实际已抵消 sandbox 的隔离收益,而收紧又会直接破坏播放;安全控制改由「host 锁死白名单 + `nocookie` 域 + `referrerpolicy` + 后续 CSP `frame-src`」承担。若将来要 per-provider 固定 sandbox 组合,须为每个 provider 给出**经测试**的权限集合,不可半设。

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

### 4. 编辑器预览不即时打第三方(默认占位卡片)

- 编辑器预览里 `@video:` **默认渲染占位卡片**(provider 名 + 缩略说明 + 「点击加载」),**点击后**才挂真 iframe;**公开页**才默认 lazy 真 iframe。
- 理由:避免作者一打开编辑器/预览就自动向 YouTube/Vimeo/Bilibili 发请求(隐私 + 噪声)。预览仍走统一的 `/api/admin/posts/preview`(ADR 0006),由其决定输出占位还是 iframe。

### 5. CSP 纳入设计,与 sanitize 白名单共用常量

- 后续若加 CSP,`frame-src` **只能**列举 provider 注册表里的**精确 host**(`www.youtube-nocookie.com player.vimeo.com player.bilibili.com`),**绝不**用 `https:` 或 `*`。
- sanitize 的 `allowedIframeHostnames` 与 CSP `frame-src` **共用同一份常量**(provider 注册表导出 host 列表),避免两处漂移。本切片至少把该常量集中、留好 CSP 接入点。

### 6. AI 翻译保护扩展到 `@video:` 指令

- 整行 `@video: <url>` 是**指令**,不可被 AI 翻译改写。按 ADR 0006 的占位保护机制,把整行 `@video:` 纳入**不可译占位 + token 校验**集合(送模前占位、译后还原、集合不一致即拒)。

## Alternatives

- **允许用户写裸 `<iframe>`**:否决。等于开 HTML 注入口,XSS/点击劫持风险;违背 ADR 0006 的 `html:false`。
- **自动把任意粘贴的 YouTube 链接转 iframe**:否决(易误转、不可控)。改用显式 `@video:` 标记,所见即所选。
- **用 embed 充当会员专属视频**:否决——第三方字节无法门禁,见 Context。
- **oEmbed 实时抓取 provider 元数据**:否决(本切片);需出站请求 + 缓存 + 失败处理,收益不抵复杂度;直接按 URL 模板生成 embed 即可。

## Consequences

- ✅ 公开视频零存储/带宽成本;复用 ADR 0006 的 Markdown 管线,主题层(`bodyHtml` + `dangerouslySetInnerHTML`)无需改。
- ✅ iframe 严格 provider 白名单 + host 锁定,安全面可控;`html:false` 不变。
- ⚠️ 引入 iframe = 引入第三方框架(点击劫持/隐私):必须 `allowedIframeHostnames` 锁 host、规范 embed 域、`referrerpolicy`、(后续)CSP `frame-src` 与白名单共用常量,并测试非白名单 URL/注入向量被拒;不设半截 sandbox。
- ⚠️ 必须用 markdown-it block rule(非逐行预处理),否则代码块/引用/列表里的 `@video:` 会被误转;编辑器预览默认占位卡片,避免自动打第三方。
- ⚠️ **依赖 ADR 0006 切片先落地**(扩展其 `markdown.ts` 与编辑器);embed 切片排在编辑器之后。
- ⚠️ embed 非会员专属,需在 UI/文档反复明确,避免创作者误把私密内容放公开第三方。
- ⚠️ provider 改版 embed 域/参数会失效(白名单维护成本);初期仅 YouTube/Vimeo/Bilibili。
