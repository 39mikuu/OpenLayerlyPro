# Theme 主题系统架构 ▶（进行中）

> Phase 5 进行中。**第一步（试点）+ 第一步 b（全部公开页面契约化）+ 第二步（明暗/字体/颜色）已落地**：主题数据契约 + 内置主题标准化（全部 (site) 页面），以及明暗切换、字体、颜色预设与自由取色。主题切换 UI 留到存在第二个主题时再做。

## 定位

Theme 只负责**表现层**：页面布局、样式、组件渲染、文案展示。

## 边界（硬性约束）

1. **Theme 不负责业务逻辑**：权限判断、会员状态、价格计算、审核流程一律由 Core 提供结果，主题只渲染。
2. Theme 不直接访问数据库，只消费 Core 暴露的数据契约（props / API）。
3. Theme 不持有 secret，不调用第三方服务的服务端密钥。
4. 卸载或更换主题不得影响数据与业务正确性。

## 设计方向

- 定义主题数据契约：每类页面（首页、作品页、会员页、收银台、登录页）对应一份稳定的数据结构。
- 内置主题在 Phase 5 重构为第一个标准主题，作为契约的参考实现。
- 主题切换由 Core 配置驱动；主题自身的可配置项（颜色、布局开关）归主题，业务配置归 Core。

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

## 路线

Phase 5（Theme v1）：契约定稿 + 内置主题标准化 + 颜色配置。**第一步（试点）✅**（chrome/首页/posts）、**第一步 b ✅**（其余 (site) 页面）、**第二步 ✅**（明暗/字体/颜色预设/自由取色）；主题切换 UI 留到存在第二个主题时再做。详见 [../roadmap.md](../roadmap.md)。
