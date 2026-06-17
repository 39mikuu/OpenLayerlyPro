# i18n 与 AI Translation 架构

> Phase 6 的 UI i18n v1 已完成。内容多语言数据模型与 AI 辅助翻译统一进入 Phase 7。

## Phase 6：UI i18n v1 ✅

### 基础架构

- 支持语言：中文（`zh`）与英文（`en`），默认语言为 `zh`。
- `src/modules/i18n/` 提供最小自研字典，无新增依赖。中英文语言包保持同构，并支持点路径查找、默认语言回落和参数插值。
- 服务端语言解析顺序固定为：`locale` cookie → `Accept-Language` → 默认 `zh`。
- 服务端通过 `resolveLocale()` / `getT()` 读取语言；客户端通过 `I18nProvider` / `useT()` 使用翻译。
- client/server split 保证客户端模块不引入 `next/headers` 等服务端 API。
- 根布局设置 `<html lang>`，语言切换器更新 cookie 并刷新服务端组件。

### 用户语言偏好

- 已登录用户的语言偏好保存到 `users.locale`，现有用户默认使用 `zh`。
- `PUT /api/me/locale` 用于同步登录用户主动选择的语言。
- 邮箱验证码登录成功时同步当前 locale；登录后的语言切换也更新用户偏好。
- 用户偏好用于需要异步发送的收件人邮件，不依赖发送时浏览器是否仍在线。

### 覆盖范围

- 公开站点：chrome、首页、作品列表、作品详情、会员、登录、账号、订单、收银台及交互组件。
- 管理界面：`/admin/*`、`/admin/setup`、表单、状态、确认框和通知提示。
- API 错误：服务端返回稳定 `code`、结构化 `params` 和兼容 `error` 字段；客户端按当前 locale 翻译，未知错误回退兼容文案。
- 邮件：登录验证码与 SMTP 测试邮件使用当前请求语言；会员开通与付款驳回邮件使用收件人的 `users.locale`。

### 明确边界

Phase 6 只完成界面、错误和系统邮件的本地化。管理员录入的作品标题、摘要、正文、会员等级名等内容数据仍保持原文，不在 UI 语言切换时自动翻译。

## Phase 7：Content i18n + AI Translation 🚧

### 7·0 Japanese UI locale

- **7·0A foundation ✅**：locale 类型、cookie / Accept-Language 解析、用户偏好持久化、`PUT /api/me/locale` 与语言切换器支持 `ja`；默认语言保持 `zh`。
- **7·0B dictionaries ✅**：公开站点、admin/setup、API 错误与系统邮件已具备完整日语字典；zh/en/ja 的 key 由类型和同构测试共同约束。
- 该步骤只扩展系统 UI locale，不翻译作品内容，也不引入 AI 能力。

> 7·1A 的内容 schema 与 content module、7·1B 的公开前台渲染与回退均已落地；人工管理与 AI Translation 仍按后续步骤串行推进，每步是后一步前提。

### 7·1 内容多语言数据模型 + 前台渲染回退

**当前状态**

- **7·1A schema + content module ✅**：以下数据模型、索引、版本生命周期与 Core API 已实现。
- **7·1B 前台渲染与回退 ✅**：公开首页、作品列表与详情页按当前 locale 读取 published 译文，缺失时回落 `posts` 原文。

**数据模型（方案 A：原文保留 + 译文版本表）**

- `posts` 增 `original_locale text not null default 'zh'`，标记现有 `title/summary/body` 是哪种语言。
- 新表 `post_translations`（**状态版本化**，而非每 `(post, locale)` 单行可变）：

  | 列 | 说明 |
  |---|---|
  | `id` | uuid pk |
  | `post_id` | uuid fk → posts（on delete cascade） |
  | `locale` | text |
  | `title` | text not null |
  | `summary` / `body` | text null |
  | `status` | enum `draft` / `published` / `archived`，默认 `draft` |
  | `source` | enum `manual` / `machine`，默认 `manual` |
  | `source_updated_at` | timestamptz null —— 生成该译文时原文的版本时间，供后续「译文过期」判断（`posts.updated_at > source_updated_at` ⇒ 可能过期） |
  | `published_at` | timestamptz null —— 置为发布时间，供审计与「译文发布于…」展示 |
  | `created_at` / `updated_at` | |

- **索引**：`UNIQUE (post_id, locale) WHERE status='published'`（部分唯一索引，DB 层硬保证「每 `(post,locale)` 至多一条 published」，前台取版本不歧义；draft/archived 不受限可多行）。**不使用**全量 `UNIQUE(post_id, locale)`。辅助索引 `(post_id, locale, status)` 供查询。
- **生命周期**：
  - 编辑 / AI 生成 → 写 `draft`（每 `(post,locale)` 维护单个工作草稿，upsert；AI 重生成覆盖该 draft）。
  - 发布 → **事务**内**先**将现有 `published` 置 `archived`、**再**将 draft 置 `published` 并填 `published_at`（顺序保证任一时刻不出现两条 published、不撞部分唯一索引；并发败者回滚重试）。
  - 编辑已发布译文 = 改 draft，不动线上 published；published 与 draft 可并存（为 7·3 AI 草稿、7·4 审核服务）。

**Core（`@/modules/content`）**

- `getLocalizedPost(post, locale)`：`locale===original_locale` 用原文；否则查 `status='published'` 的该 locale 译文（部分索引保证 ≤1，仍 `limit 1` 防御），命中用译文、否则回落原文；返回 `{ title, summary, body, contentLocale, isFallback }`。
- 列表本地化：一条 `where post_id IN (...) and locale=? and status='published'` 批量取，避免 N+1。
- 译文 CRUD（供 7·2/7·3）：upsert draft、publish（事务）、unpublish、delete。

**前台**：home / posts / posts/[slug] 用 `resolveLocale()` 选版本，把本地化文本填入**现有 view-model**，**主题组件零改动**；缺失译文回落原文。

**范围**：仅 posts（标题/摘要/正文）；tier 名/描述、收款方式说明后置。**slug 不本地化**（URL 语言无关，locale 走 cookie/协商）。

### 7·2 后台手动译文管理

- **7·2A Admin translation APIs ✅**：后台可通过 requireAdmin API 获取概览、保存 en/ja 草稿、发布、取消发布和删除工作草稿；发布前校验标题及正文完整性。
- **7·2B Admin translation UI ✅**：post 编辑器支持 en/ja 手动录入、草稿保存、发布、撤回、丢弃草稿与状态展示。
- post 编辑器增「按语言」译文区：语言选择器（`SUPPORTED_LOCALES` 去掉 `original_locale`）+ 每语言 title/summary/body + 草稿/发布切换 + 覆盖度提示；发布前校验 title 非空。
- API `/api/admin/posts/[id]/translations`（`GET` 列出各 locale 译文与状态 / `PUT` 按 locale upsert draft / publish / unpublish / `DELETE`），均 `requireAdmin`，复用 7·1 CRUD。
- 后台界面文案走 Phase 6 i18n。

### 7·3 AI 译文草稿（创作者控制）

- **7·3A Translation Integration + provider config ✅**：translation 配置组通过 `app_settings` 加密保存，默认关闭；支持 OpenAI-compatible endpoint/model/API key 与可选月度字符上限，并纳入 Integration 状态。本步没有生成 API，不调用 provider。
- **7·3B AI draft generation 🚧**：后台显式触发生成 `draft(source=machine)`，并接入额度与频率限制。
- 翻译服务对接复用 **Integration 架构**；服务密钥通过**配置中心加密保存**。`translation` 配置组包含 `enabled`（默认 **false**）、provider、加密 apiKey、model/endpoint 与可选月度字符上限，并纳入 Integration 状态注册表。
- 后台动作「AI 生成 {locale} 草稿」→ 服务端调 provider → 写 `post_translations`（`status=draft, source=machine`），并记录 `source_updated_at`。
- provider：先做通用「OpenAI 兼容 chat completions」适配器（base URL + key + model，最灵活），可选再加 DeepL；key 归创作者。
- 创作者控制：启用与否、provider/model/key、目标语言、范围（单篇/批量）、额度/频率上限（服务端强制）。

### 7·4 审核 / 发布 + 策略

- 「待审译文」列表（尤其 `source=machine` 的 draft）→ 预览/对照原文 → 编辑 → 发布（事务归档旧 published）/ 丢弃；支持批量发布。
- 机翻透明：已发布且 `source=machine` 的译文，前台可显示「机器翻译」标注（开关）；详情页可显示「当前为译文/原文回落」。
- 过期提示：基于 `source_updated_at` 标记「原文已更新、译文可能过期」。
- 发布策略：`草稿待审`（默认，安全）vs `标注机翻直接发布`（**必须创作者显式开启**，不作默认）。

### AI Translation 边界

- **默认关闭**：系统不替创作者自动启用 AI 翻译。
- **不默认消耗创作者额度**：没有显式配置和操作时不调用翻译服务。
- **不自动发布**：AI 结果默认保存为草稿，未经创作者确认不得公开。
- **不替创作者决定策略**：目标语言、内容范围、翻译服务、审核和发布方式由创作者选择。
- **不让访客触发创作者成本**：访客请求只能读取已有译文，不能触发实时翻译或付费调用（前台只读 `published`，AI 仅经 `requireAdmin` 的后台动作触发）。

### 与其他系统的关系

- 翻译服务对接复用 Integration 架构；服务密钥通过配置中心加密保存。
- 内容版本选择与回落规则属于 Core；Theme 只负责渲染 Core 提供的当前语言内容。
- OpenLayerlyPro 仍是开源、自托管、单画师会员站，不因内容多语言或 AI 翻译扩展为多创作者平台。

### 不在 Phase 7（7·1–7·4）范围

- **SEO / hreflang**：当前 locale 走 cookie/协商、不进 URL，多语言 SEO 影响有限；hreflang/路径式 locale 留作后续单独评估。
- **archived 译文保留/清理策略**：单创作者量小，留后续。
- posts 以外内容（tier 名/描述、收款方式说明等）的多语言。
