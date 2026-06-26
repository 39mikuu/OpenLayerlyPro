# 交接：S6 安全响应头

> 自包含实现说明。前置依赖：当前 `main` 已含 S1a 文件响应 CSP（`/api/files/[id]/download` 的 `default-src 'none'; … sandbox`）、ADR 0008 视频嵌入 host 白名单 `EMBED_HOSTS`、Turnstile、会话 cookie 安全属性，以及后台公开页 `customFooterHtml` 自定义代码能力。属 v1.0 安全硬化 S6（epic #64）。
>
> 实现 PR 必须基于最新 `main`，保持 Draft，直到完整 CI、真机 CSP 验证和 legacy 自定义代码迁移演练全绿。

## 0. 不可违反的不变量

1. **既有更严格的响应头不得被放宽。** S1a 文件流响应的严格 CSP、`X-Content-Type-Options: nosniff` 与 `Cache-Control: private, no-store` 必须原样保留；S3 presigned 重定向分支也不得被全局头覆盖。
2. **生产 `script-src` 绝不使用 `'unsafe-inline'` 或 `'unsafe-eval'`。** 内联脚本只能由当前请求 nonce 明确授权；仅 development 可条件化加入 `'unsafe-eval'` 以兼容 React 调试。
3. **nonce CSP 必须同时进入 request 与 response，且使用同一 nonce、同一策略。** Next.js 15 只有从 request 的 `Content-Security-Policy` 解析到 nonce，才会为框架/RSC/bootstrap 脚本注入 nonce。
4. **CSP 来源必须由实际功能配置的单一数据源派生。** 视频来源来自 `EMBED_HOSTS`；Turnstile、S3 与公开 integration 的渲染计划和 CSP 来源不得维护两份清单。
5. **`customFooterHtml` 不得成为 CSP 绕过器。** 不得因兼容旧自定义代码给全站加入 `'unsafe-inline'`、`'unsafe-eval'`、裸 `https:`、`*`，不得信任管理员输入的 `nonce` 属性，也不得把原始 HTML 中所有 `<script>` 自动加 nonce 后原样放行。
6. **已有可执行 custom footer 不得静默失效或静默删除。** 强制 CSP 前必须检测并迁移；原值保留供复制/下载，后台和日志明确提示。未迁移时只能处于 Report-Only/迁移状态，或由运维显式选择禁用 legacy 代码后强制 CSP。
7. 会话 cookie 的 `httpOnly + secure(prod) + sameSite=lax` 不得回退；不引入 CORS；安全头由应用层唯一设置，代理只透传。

## 1. 当前状态（实测）

| 项 | 现状 | 文件 |
|---|---|---|
| middleware | 无 `middleware.ts` | — |
| 全局 CSP | 无；仅文件下载路由有严格 CSP | `src/app/api/files/[id]/download/route.ts` |
| 安全头 | nosniff 仅覆盖部分文件响应；无全局 HSTS/XFO/Permissions-Policy/COOP/CORP | 多处 |
| 根布局内联内容 | `THEME_INIT_SCRIPT` + 可选 `presetCss` | `src/app/layout.tsx` |
| Turnstile | 可由后台存储配置在运行时启用 | `src/modules/config/turnstile.ts` |
| 视频嵌入 | youtube-nocookie / Vimeo / Bilibili | `EMBED_HOSTS` |
| S3 公开资源 | 同源下载路由可 302 到 presigned 对象 URL | download/storage 模块 |
| 自定义页脚 | 后台接收最多 20,000 字符原始 HTML，公开页经 `dangerouslySetInnerHTML` 渲染；输入框明确支持 `<script>` | `src/app/api/admin/site/route.ts`、`src/themes/builtin/chrome.tsx`、`src/components/admin/site-settings-form.tsx` |

`customFooterHtml` 当前同时承担三种不同需求：普通页脚/备案内容、站点所有权验证、统计或其他可执行脚本。严格 nonce CSP 会拦截其中未授权脚本和事件属性，因此必须在同一切片内完成兼容迁移，不能只加响应头。

## 2. 目标响应头集合

对应用渲染的 HTML 文档响应统一设置：

| 头 | 值 |
|---|---|
| `Content-Security-Policy` 或 rollout 阶段的 `Content-Security-Policy-Report-Only` | §3 |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`，仅显式启用 |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), browsing-topics=(), interest-cohort=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |

不设置 COEP 或 CORS。JSON API 至少通过 `jsonOk`/`jsonError`/`handleApiError` 统一带 `nosniff`。

## 3. CSP 策略：middleware per-request nonce

CSP 基线如下。所有占位来源必须是经过 URL 解析后得到的**精确 HTTPS origin**，禁止字符串拼接、通配符和裸 scheme：

```text
default-src 'self';
script-src 'self' 'nonce-<N>' <TURNSTILE> <INTEGRATION_SCRIPT>;
style-src 'self' 'nonce-<N>';
img-src 'self' data: <STORAGE> <INTEGRATION_IMG>;
media-src 'self' <STORAGE>;
font-src 'self';
connect-src 'self' <TURNSTILE> <INTEGRATION_CONNECT>;
frame-src <VIDEO> <TURNSTILE> <INTEGRATION_FRAME>;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

要求：

1. middleware 用 CSPRNG 生成至少 128 bit 的 base64 nonce。必须执行：

   ```ts
   const requestHeaders = new Headers(req.headers);
   requestHeaders.set("x-nonce", nonce);
   requestHeaders.set("Content-Security-Policy", csp);
   const response = NextResponse.next({ request: { headers: requestHeaders } });
   response.headers.set(responseHeaderName, csp);
   ```

   request 内部始终使用 `Content-Security-Policy` 供 Next 解析 nonce；浏览器侧 `responseHeaderName` 按 rollout 状态为强制或 Report-Only。根布局通过 `headers()` 读取 `x-nonce`。
2. 生产策略无 `'unsafe-eval'`；development 可条件化加入。真机必须确认 Next 注入的框架/RSC/bootstrap `<script>` 实际携带同一 nonce。
3. `frame-src` 视频来源从 `EMBED_HOSTS`/`EMBED_FRAME_SOURCES` 派生。
4. Turnstile 实际状态可由后台 DB 配置覆盖 env。为避免启用后登录页被旧 CSP 拦截，可始终包含固定可信 origin `https://challenges.cloudflare.com`，或由 §4 的运行时配置读取统一派生；不得只看 `TURNSTILE_ENABLED` env。
5. S3 模式必须放行**实际生成的 presigned URL origin**到 `img-src`/`media-src`。不得假定配置 `endpoint` 一定等于最终签名 URL host；应复用 storage adapter 的 URL/origin 解析原语并测试 path-style、virtual-hosted-style 与自定义 endpoint。local 模式不增加来源。
6. `style-src` 默认 nonce。只有真机证明框架存在无法携带 nonce 的内联样式时，才允许退路 `style-src 'self' 'unsafe-inline'`；此退路只影响样式，绝不波及脚本。
7. `/api/*`、`_next/static`、`_next/image` 与静态资源不走文档级 middleware CSP；文件下载路由保持自己的更严格策略。

> per-request nonce 会使根布局动态化并放弃全页静态缓存。该代价已接受。

## 4. `customFooterHtml` 兼容与迁移（S6 阻塞项）

### 4.1 目标能力拆分

不再让一个原始 HTML 字段同时承载展示、验证与代码。使用现有 `site_settings` JSON 键，不新增数据库 schema：

1. **安全页脚标记** `custom_footer_markup`：仅用于备案、版权、链接和普通展示内容。
2. **站点验证** `site_verification`：结构化的 provider/token 或受限 meta `name + content`；由服务端渲染到 `<head>`，禁止 `http-equiv`、原始标签和脚本。
3. **公开 integration** `public_integrations`：统计/分析等结构化配置。每个 adapter 同时产出：
   - 服务器控制的脚本渲染计划；
   - 精确的 `script/connect/img/frame` CSP origins；
   - 配置校验与后台说明。
4. 可保留显式 `provider: "custom"` 的高级可信脚本，但必须是结构化记录：`src` 或 `inlineCode`、位置、允许的 `data-*` 属性，以及精确的资源 origins。它是站点所有者信任代码，不是用户内容；后台必须显示高风险警告。

### 4.2 渲染规则

- `custom_footer_markup` 在**写入时和读取时**使用共享 sanitizer。允许最小展示标签（如 `a/br/span/div/p`）及安全属性；禁止 `script/style/iframe/object/embed/meta/link`、全部 `on*` 属性、`javascript:` URL、管理员输入的 `nonce`、内联 style（除非另有经过验证的主题能力）。
- 站点验证由 React/Metadata 生成 `<meta>`，不得通过 footer 注入。
- integration 脚本只能由服务器组件从结构化配置生成。每个 `<script>` 使用本请求 nonce；不得把原始 `<script>` 字符串继续交给 `dangerouslySetInnerHTML`。内联代码只作为受信任 script body 渲染，外层标签和 nonce 始终由服务器控制；序列化必须安全处理 `</script>`、U+2028/U+2029，避免代码逃逸出 script 元素。
- 外部脚本只允许 HTTPS URL、已知布尔属性和受限 `data-*`/`integrity`/`crossOrigin`；拒绝 `on*`、原始 HTML 属性串和管理员提供的 nonce。
- integration adapter 与 CSP builder 必须共用同一个 registry。新增 provider 时只改一处；不得出现“页面会渲染，但 CSP 清单忘记同步”的第二份来源。
- 不加入 `'strict-dynamic'` 作为兜底。provider 动态加载的脚本/网络端点必须在 adapter 中显式声明并测试。

### 4.3 middleware 运行时配置与竞态

公开 integration 来自 DB，middleware 因此锁定 **Node.js runtime**，通过共享 `getPublicCspRuntimeConfig()` 读取经过验证的紧凑配置。单画师低流量站点允许每个 HTML 请求读取 DB；若实现 TTL 缓存，必须满足：

- 失败时回落到 fail-closed 基线，不得扩宽来源；
- 缓存有短且有界 TTL，并记录刷新错误；
- 配置新增时，旧缓存最多导致脚本暂时不执行，不能导致未声明来源被放行；删除时的旧授权窗口受 TTL 上限约束。

设置中保存不可预测的 `revision`。middleware 把所用 revision 写入内部 request header `x-csp-config-revision`；公开布局仅当自己读到的 integration revision 与该 header 一致时渲染脚本。若保存恰好发生在 middleware 与布局读取之间，布局应跳过 integration 并记录一次可重试告警，不能用新脚本配旧 CSP。

### 4.4 legacy 检测与 rollout

现有 `custom_footer_html` 必须分类：

- `empty`；
- `safe_markup`：只含允许的展示标记，可显式一键迁移到 `custom_footer_markup`；
- `needs_migration`：包含 `script/meta/style/iframe/object/embed/link`、事件属性、`javascript:`、外部资源或其他可执行/策略相关内容。

新增：

```text
SECURITY_CSP_MODE = auto | report-only | enforce   # default auto
```

- `auto`：无 legacy 冲突时强制 CSP；存在 `needs_migration` 时浏览器响应使用 Report-Only，继续保留旧代码行为，并在后台、日志和生产检查页持续显示阻塞警告。
- `report-only`：显式迁移/观测模式。
- `enforce`：始终强制；若仍有 `needs_migration`，不渲染 legacy 可执行内容，只渲染已迁移安全标记，并给出明确管理员告警。不得悄悄丢弃原值。

后台迁移页必须提供原值查看、复制/下载、清除和迁移入口。原 `custom_footer_html` 在迁移完成前只读保留；完成后可删除旧键。实现 PR 不得仅靠 release note 要求人工查库。

## 5. 设置位置

1. 新增 `middleware.ts`，锁定 Node.js runtime；matcher 只覆盖文档请求。它生成 nonce、读取 §4 运行时配置、构造 CSP，并同时设置 request/response 头及其他文档级安全头。
2. 根布局将 nonce 赋给 `THEME_INIT_SCRIPT`/`presetCss`；公开 site layout 渲染结构化 verification/integration，并执行 revision fence。
3. `src/lib/api.ts` 统一补 JSON `nosniff`。
4. 不在 `next.config.ts` 重复设置同名安全头；不改文件下载路由响应头。

## 6. HSTS

新增：

```text
SECURITY_HSTS_ENABLED = true | false   # default false
```

仅确认实际经 HTTPS 提供时启用；值为 `max-age=31536000; includeSubDomains`，不默认加入 `preload`。

## 7. 部署与文档

- 部署文档写明安全头由应用唯一设置，Caddy/Cloudflare Tunnel 不重复加同名头。
- production checklist 增加 HSTS、CSP mode、legacy custom code 已迁移、integration origins 已核对等项目。
- S6 上线顺序：升级到 `auto/report-only` → 后台完成 legacy 迁移 → 真机检查统计/验证/备案 → 切 `enforce` 或确认 `auto` 已强制 → 再标记实现 PR Ready。

## 8. 测试要求

- middleware：request/response CSP 同策略同 nonce；每请求 nonce 不同；production 无 `'unsafe-inline'/'unsafe-eval'`；development 可有 `'unsafe-eval'`。
- Next E2E：框架/RSC/bootstrap、自定义主题脚本和结构化 integration 脚本均携带 nonce，页面无 CSP 报错。
- CSP 来源：视频、Turnstile、实际 S3 signed URL、每个 integration adapter 的来源与渲染计划共源；拒绝非 HTTPS、凭据 URL、通配符、裸 scheme、换行和无效 origin。
- sanitizer：阻止 script/style/meta/iframe、事件属性、`javascript:`、nonce 和危险 URL；备案文本/链接保持可用。
- verification：meta 位于 `<head>`，不依赖脚本。
- legacy：`safe_markup` 可迁移；`needs_migration` 在 `auto` 下为 Report-Only 且有后台告警；`enforce` 下不执行 legacy 代码但保留原值和明确告警。
- revision fence：模拟保存竞态，CSP revision 与 layout revision 不一致时不渲染 integration 脚本。
- 功能 E2E：至少覆盖备案链接、一个站点验证项、一个外部统计脚本及其 connect/img 请求；迁移前后功能结果明确。
- 回归：文件下载严格 CSP、JSON nosniff、登录 Turnstile、视频 iframe、S3 图片/视频、会话 cookie 均未回退。
- 完整命令：`pnpm lint && pnpm format:check && pnpm exec tsc --noEmit && RUN_DB_INTEGRATION_TESTS=true pnpm test && pnpm build:migrator && pnpm build`；预期无 schema migration。

## 9. 验收 checklist

- [ ] 文档响应包含 CSP/HSTS(条件)/nosniff/Referrer-Policy/XFO/Permissions-Policy/COOP/CORP
- [ ] CSP 同时写 request/response，Next 与业务脚本使用同一 per-request nonce
- [ ] 生产 `script-src` 无 `'unsafe-inline'/'unsafe-eval'`，无宽泛自定义来源
- [ ] 视频/Turnstile/S3/integration 来源均由实际渲染配置单一派生
- [ ] `customFooterHtml` 已拆为安全 footer、verification、integration；legacy 不静默损坏
- [ ] sanitizer、结构化 script renderer、revision fence 与三种 CSP mode 均有测试
- [ ] S1a 文件响应与 S3 重定向头未被覆盖；JSON 带 nosniff
- [ ] HSTS 默认关且仅 HTTPS 开启；不设 COEP/CORS
- [ ] 真机确认登录、媒体、统计、验证、备案均正常；完整 CI 全绿

## 已锁定决策（owner 确认 2026-06-26）

- 使用 middleware per-request nonce；request 与 response 同策略同 nonce；接受全页动态化。
- 生产脚本策略绝不靠 `'unsafe-inline'/'unsafe-eval'`，development 仅可加 `'unsafe-eval'`。
- `customFooterHtml` 不获得全局 CSP 例外：安全标记、站点验证、统计 integration 分离；脚本由服务器结构化生成并附 nonce。
- legacy 可执行 footer 必须检测、提示和迁移；`SECURITY_CSP_MODE=auto` 默认避免升级后静默损坏，迁移完成后强制。
- middleware 使用 Node.js runtime 读取统一公开 CSP 配置；revision fence 防止新脚本配旧 CSP。
- Turnstile、S3 与 integration 来源由实际配置/adapter 单一派生；禁止通配符、裸 `https:` 和管理员提供 nonce。
- `style-src` 默认 nonce，必要时仅样式可退到 `'unsafe-inline'`。
- HSTS 默认关、无 preload；头由应用唯一设置；不引入 COEP/CORS。
