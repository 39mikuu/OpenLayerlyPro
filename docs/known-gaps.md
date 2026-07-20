# 已知缺口账本（Known Gaps）

> 本文档是「以前的部分」中已确认、但尚未立项的改进空间的活账本。
> 维护规则：每次版本发布复盘时过一遍；条目纳入版本计划后注明工作包或 issue 并移入「已排期」；
> 修复合并或结论归档后移入「已完成」，有对应 PR 时一并注明。本账本不含未经证实的猜测——
> 假设类问题先走取证 issue；#101/#102/#103 已完成取证、记录结论并关闭。
>
> 配套流程约定：
>
> 1. 每个 minor 版本预留 10–20% 体量作为债务预算；不再依赖固定发布后等待窗口，债务随当前里程碑一起排期处理。
> 2. 关闭或取代一个被文档引用的门禁 issue 时，同一 PR 内更新全部文档指针
>    （教训：#88 关闭后指针在多份文档中失效，见 2026-07 文档审查）。
> 3. 官网（`website/`，三语）纳入发布例程：功能可见变化时同步官网文案。

## 待立项

- **G3（legacy compatibility removal，待立项）**：移除 v1 archive restore（含 `--allow-legacy-v1-unknown-schema`）、legacy footer 迁移、pre-v1.0 文件 backfill 三条兼容路径。目标为 2026-10-14 之后的首个 release（预期 v1.3）；v1.2 不搭载本移除项，更旧实例须先经 v1.1.x 升级/恢复。

## 已排期

- **G5（v1.2 M4 债务包）**：处理 CI actions 的 Node 20 deprecation 警告，升级相关 action 到当前主版本；仍须保持第三方 action 使用不可变 commit SHA，`pages.yml` 不再使用浮动 tag。体量：微。
- **G7（v1.2 M4 债务包）**：补齐 Plausible SPA tracking parity，复用共享公开页路径谓词，关闭默认自动 pageview 并增加同等 nonce inline 手动追踪器；后台 Integration status registry 补齐 Plausible 同等状态语义。体量：小。

## 已完成

- **G2（label-only 关闭）**：Translation `monthlyCharLimit` 已在后台三语文案和 `docs/architecture/config-center.md` 中明确标为「仅记录，不限制」。本地用量账本与强制预算不进入 v1.2；运维使用 provider 侧 hard limit/alert。

- **G3（政策公告部分）**：v1.1.0 release notes 已公告三条 legacy compatibility 路径的弃用计划。2026-07-17 的修订明确 v1.2 保留这些路径；移除另行立项，且不得早于 2026-10-14。实际移除工作记录在上方 G3 待立项条目。

- **G1**：随 v1.1 WP2 Phase 5 完成并移入本节。业务邮件任务 payload 改为 v2 domain-reference 格式；worker 在发送时根据业务行重新解析最新邮箱和 locale。迁移会移除 `kind='email'` 任务里的 `payload_json.to`：可安全还原业务事件的 retryable 行改写为 v2，不能安全还原的 retryable 行 dead-letter 并脱敏，terminal 行脱敏保留。登录码任务保持不存收件人地址。
- **G4**：随 PR #123 完成，exact-head CI run #554 通过。`src/modules/i18n/key-completeness.test.ts` 递归比较 zh/en/ja 完整 key 路径集合，一次性报出所有 missing/extra；`tsc --noEmit` 已隐式保护多余/缺失 key（本条目把这层保护改为显式、具名、CI 可见，防止未来重构悄悄移除）。
- **G6**：随 PR #123 完成，exact-head CI run #554 通过。`e2e/theme-visual-baseline.spec.ts` 覆盖 12 张截图（Home/Posts/PostDetail × 明暗 × `builtin`/`blog`，各主题用自己的真实默认预设）。过程中发现并修复：CI 渲染环境字体度量与本地不同（基线改为直接采集 CI 实际渲染结果，而非本地近似）、页脚年份（`new Date().getFullYear()`）会导致基线逐年失效（已加 mask）。**范围说明**：视觉基线集中覆盖主题实际存在布局分歧的三个页面和默认预设；直接复用 builtin 正文组件的页面由组件身份断言与代表性权限 smoke 提供证据；全部具名预设/custom hue 由参数化功能测试覆盖；zh/en/ja 由 G4 key 完整性与逐语言浏览器 smoke 覆盖。不是全页面 × 权限 × 预设 × 语言的组合视觉矩阵，见 `release-v1.1-plan.md` §3 WP1 验收项。

- **Theme follow-up**：WordPress 经典作为 WP1 follow-up 单独授权提前实现；本 follow-up 将主题视觉基线扩展到 `wordpress`。稳定窗口约束已由 `release-v1.1-plan.md` 的 2026-07-12 决策记录取消。
