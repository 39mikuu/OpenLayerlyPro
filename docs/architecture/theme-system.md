# Theme 主题系统架构 ✅（基座已完成）

> Theme v1 基座已落地：主题数据契约、全部公开页面契约化、内置主题标准化，以及明暗切换、字体、颜色预设与自由取色。第二主题、安装式主题包和主题切换 UI 属于 v1.0 之后的按需扩展，不是当前 S7 → #88 发布主线。

## 定位

Theme 只负责**表现层**：页面布局、样式、组件渲染、文案展示。

## 边界（硬性约束）

1. **Theme 不负责业务逻辑**：权限判断、会员状态、价格计算、审核流程一律由 Core 提供结果，主题只渲染。
2. Theme 不直接访问数据库，只消费 Core 暴露的数据契约（props / API）。
3. Theme 不持有 secret，不调用第三方服务的服务端密钥。
4. 卸载或更换主题不得影响数据与业务正确性。

## 设计方向

- 定义主题数据契约：每类页面（首页、作品页、会员页、收银台、登录页）对应一份稳定的数据结构。
- 内置主题是第一个标准主题，作为契约的参考实现。
- 未来主题切换由 Core 配置驱动；主题自身的可配置项（颜色、布局开关）归主题，业务配置归 Core。

## 已落地（第一步·试点）✅

- `src/modules/theme/`：主题数据契约（`SiteChromeView` / `HomeView` / `PostListView` / `PostDetailView`）、`Theme` 描述符（组件槽）、注册表与 `getActiveTheme()`——读 `site_settings.theme`，未知/缺省回落内置主题（Core 配置驱动切换的接缝，当前仅内置主题）。
- `src/themes/builtin/`：内置主题作为第一个标准主题（契约参考实现），纯按 view-model 渲染；已迁移 chrome（header/nav/footer）+ 首页 + 作品列表 + 作品详情（含锁定/登录/会员三态、图片/附件）。
- 边界落地：页面（Core 侧）负责业务决策（access 判定、`requiredTierName`、下载 URL）与取数；主题只做展示（标签文案、日期/大小格式化、布局），且只 `import type` 契约、复用 `components/ui`，不 import Core 业务或 `@/db`。

## 已落地（第一步 b：其余 (site) 页面契约化）✅

- tiers / login / me / me/orders / checkout 五页全部抽到内置主题契约（`Tiers/Login/Me/MeOrders/Checkout` 组件 + 对应 view-model）；页面瘦身为薄壳（Core 取数 + 业务决策），主题只做展示（`STATUS_LABEL`、日期格式化、价格/状态文案、布局）。
- 交互件（`LoginForm` / `CheckoutForm` / `OrderActions`）作为共享组件由主题渲染——主题边界仍成立：只 `import type` 契约 + 复用 `components/*` 表现层组件，不 import Core 业务或 `@/db`。
- 至此**全部公开 (site) 页面表现层 / 业务分离完成**，内置主题为完整契约参考实现。

## 已落地（第二步：明暗 + 字体 + 颜色）✅

- **明暗切换（无新依赖）**：访客偏好存 `theme_mode` cookie（`light/dark/system`，**不入 site_settings**）；根布局按 cookie 给 `<html>` 加 `.dark`（显式 dark），并注入极小内联脚本（只读 cookie + `matchMedia` 解析 system、消除首屏闪烁，不含任何配置）；`ThemeToggle`（站点 chrome）两态切换、默认跟随系统。
- **字体**：`globals.css` 用源变量 `--app-font-sans` / `--app-font-mono`（系统 + CJK 栈）映射到 `@theme` 的 `--font-sans` / `--font-mono`，消除自引用；不引外部 webfont。
- **主题颜色预设（站点级）**：`Theme.colorPresets` 保存具名预设的 hue；活动预设存 `site_settings.theme_config`。默认 `neutral` 的 hue 为 null，保持零覆盖（不注入、视觉等同第一步）。
- **自由取色（色相 + 模板）**：管理员可选择 `custom` 并提交单个整数 hue；服务端调用活动主题的 `colorVarsFromHue(hue)`，沿用固定 L/C 模板生成整套明/暗 OKLCH 变量。前端不能提交 CSS 变量名或值，可读性由主题模板约束。
- **作用域与回退**：`buildColorPresetCss` 只生成 `.site-theme{}` / `.dark .site-theme{}` 覆盖（内置主题 `Chrome` 最外层带 `.site-theme`），SSR 注入——**只影响公开站点，不影响 admin**。
- **后台**：`/admin/site`「外观」卡 + `GET/PUT /api/admin/theme`；PUT 只接受活动主题的预设 id，或 `custom` + `[0, 360)` 整数 hue——**禁止提交任意 CSS 变量/值**。

## 已落地（第三步：第二主题与活动主题选择器）✅

- **博客主题（`src/themes/blog/`）**：文字优先的阅读形态——窄栏外壳、列表流首页（作者简介 + 紧凑会员入口 + 无封面文章条目）、divide-y 文章列表。交易性页面（详情/会员/登录/账号/订单/收银台）与内置主题无形态分歧，通过展开 `builtinTheme.components` 复用其契约参考实现，未来分化按槽 copy-on-write。
- **注册表**：`ThemeId = "builtin" | "blog"` 编译期联合类型；主题为静态注册表条目（一等公民代码，无运行时加载/上传面），`resolveThemeId` 未知回落不变。
- **配置分键**：`site_settings.theme_config` 改为按主题 id 分键（`{ builtin: {...}, blog: {...} }`），各主题的颜色选择独立保存、来回切换不丢失；旧平铺形态读取时归属内置主题、首次写入时自动迁移，无数据库迁移。
- **后台选择器**：外观卡新增主题下拉，`PUT /api/admin/theme` 接受可选 `theme` 字段（仅注册表内 id），预设校验以目标主题为准；仍禁止提交任意 CSS 变量/值。
- **博客主题预设**：`ink`（零覆盖默认）/ 靛蓝 / 青 / 琥珀，取色模板与内置主题共用同一 L/C 约束。
- **原子写入与 audit**：`applyThemeUpdate` 在同一事务内 seed-then-lock `theme_config` 行（`SELECT ... FOR UPDATE`）、按主题 id 合并配色、可选切换活动主题、记录 audit 事件（`entityId` 为 `site_settings` 行的真实 uuid），避免跨主题并发写入互相覆盖，且配置/活动主题/audit 三者失败时不留半更新。
- **视觉回归基线（known-gaps G4/G6）**：`src/modules/i18n/key-completeness.test.ts` 显式校验 zh/en/ja key 集合一致；`e2e/theme-visual-baseline.spec.ts` 覆盖 Home/Posts/PostDetail × 明暗 × 两主题的 Playwright 截图基线。

## Deferred follow-up

主题包生命周期与第三方主题安装边界推迟到 Plugin 阶段。当前发布状态与唯一主线见 [../roadmap.md](../roadmap.md)。
