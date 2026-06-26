# i18n 与 AI Translation 架构

> Phase 6 UI i18n 与 Phase 7 Content i18n + AI Translation（7·0–7·4）均已实现。后续范围只包括 SEO/hreflang、posts 之外的内容翻译和 archived 历史策略。

## Phase 6：UI i18n v1 ✅

### 基础架构

- 支持语言：中文（`zh`）、英文（`en`）和日文（`ja`），默认语言为 `zh`。
- `src/modules/i18n/` 提供最小自研字典，无新增运行时 i18n 依赖；三套语言包保持同构，并支持点路径、默认语言回落和参数插值。
- 服务端语言解析顺序：`locale` cookie → `Accept-Language` → 默认 `zh`。
- 服务端通过 `resolveLocale()` / `getT()`；客户端通过 `I18nProvider` / `useT()`。
- client/server split 保证客户端模块不引入 `next/headers`。
- 根布局设置 `<html lang>`；语言切换器更新 cookie 并刷新 Server Components。

### 用户语言偏好

- 已登录用户的偏好保存到 `users.locale`；旧用户默认 `zh`。
- `PUT /api/me/locale` 同步主动选择的语言。
- 验证码登录和登录后的语言切换都会更新偏好。
- durable 邮件任务按收件人的持久化 locale 渲染，不依赖发送时浏览器状态。

### 覆盖范围

- 公开站点：chrome、首页、作品列表/详情、会员、登录、账号、订单、收银台及交互组件。
- 管理界面：`/admin/*`、`/admin/setup`、表单、状态、确认框和通知。
- API 错误：稳定 `code` + 结构化 `params` + 兼容 `error` 字段；客户端按 locale 翻译。
- 邮件：登录码、会员开通/撤销、付款驳回、续费提醒和 SMTP 测试等当前模板支持 zh/en/ja。

UI i18n 不会自动翻译创作者录入的作品、等级或付款说明；内容版本由 Phase 7 单独管理。

## Phase 7：Content i18n + AI Translation ✅

### 7·0 Japanese locale ✅

- locale 类型、cookie / Accept-Language、用户偏好、API 与语言切换器支持 `ja`。
- 公开站点、admin/setup、API 错误与系统邮件具备完整日语字典。
- 该步骤只扩展系统 UI locale，不改变内容版本或触发 AI。

### 7·1 内容多语言数据模型与前台回退 ✅

#### 数据模型

- `posts.original_locale text not null default 'zh'` 标记原文语言。
- `post_translations` 使用版本化行：

  | 列 | 说明 |
  |---|---|
  | `id` | uuid 主键 |
  | `post_id` | 关联 posts，删除文章时级联 |
  | `locale` | 目标语言 |
  | `title` / `summary` / `body` | 译文内容 |
  | `status` | `draft` / `published` / `archived` |
  | `source` | `manual` / `machine` |
  | `source_updated_at` | 生成/编辑时的原文版本时间，用于 stale 判断 |
  | `published_at` | 发布时间 |
  | `created_at` / `updated_at` | 行时间戳 |

- `UNIQUE(post_id, locale) WHERE status='published'` 保证每个语言最多一个线上版本；draft/archived 可以保留历史版本。
- 发布在事务中先归档旧 published，再 promote draft 并写 `published_at`。
- 编辑线上译文只修改/创建 draft，不直接覆盖公开版本。

#### Core 与前台

- `getLocalizedPost(post, locale)`：请求原文语言时用 `posts`；否则读取对应 published 译文，缺失时回落原文，并返回 `contentLocale` / `isFallback`。
- 列表批量读取译文，避免 N+1。
- home、posts 列表和详情使用当前 locale 生成现有 Theme view-model；Theme 不查询翻译表。
- 范围仅为 post title/summary/body；slug 不本地化。

### 7·2 后台手动译文管理 ✅

- requireAdmin API 支持各 locale 概览、保存 draft、发布、取消发布和删除工作草稿。
- post 编辑器支持 en/ja 手动录入、状态显示、预览、撤回和丢弃。
- 发布前校验 title 与正文完整性；API 错误走统一 i18n code/params。

### 7·3 AI 译文草稿 ✅

- `translation` 配置组通过 `app_settings` 加密保存，默认关闭。
- 当前 provider 为 OpenAI-compatible chat completions，配置 endpoint、model、API key 与可选月度字符上限。
- 只有 requireAdmin 的后台动作能调用 provider；访客与公开页面永远不能触发翻译费用。
- 管理员显式执行“AI 生成 {locale} 草稿”后，服务端调用 provider，写入/更新 `draft(source='machine')` 并记录 `source_updated_at`。
- provider key 不返回前端、不进入日志；请求失败不发布半成品。

### 7·4 审核、发布与策略 ✅

- 待审列表聚合 machine/manual draft，支持原文对照、编辑、发布和丢弃。
- 默认策略是“生成草稿，人工审核后发布”。
- `directPublishEnabled` 只能由创作者显式开启；provider 或访客不能自动改变策略。
- `showMachineTranslationLabel` 控制公开 machine 译文标注。
- 原文 `content_updated_at` 晚于译文 `source_updated_at` 时显示 stale 提示。
- 发布继续使用 7·1 的事务归档/promote 语义。

### 安全与成本边界

- **默认关闭**：没有管理员配置与操作时不调用外部服务。
- **不让访客触发成本**：公开请求只读取已发布译文。
- **默认不自动发布**：machine 结果默认是 draft。
- **Core 决定版本**：locale 选择、权限、回退和发布状态属于 Core；Theme 只渲染 view-model。
- **密钥加密**：API key 只存在于加密配置与服务端内存。

## 后续范围

- SEO / hreflang / 路径式 locale：当前 locale 通过 cookie/协商，不在 URL 中。
- tier 名/描述、付款方式说明等 posts 之外的数据多语言。
- archived 译文的历史查看/恢复与长期 retention；低优先级 #58 需在增加历史恢复前处理。
