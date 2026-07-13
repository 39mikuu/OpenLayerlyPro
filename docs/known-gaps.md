# 已知缺口账本（Known Gaps）

> 本文档是「以前的部分」中已确认、但尚未立项的改进空间的活账本。
> 维护规则：每次版本发布复盘时过一遍；条目立项后填写 issue 编号并移入「已立项」；
> 修复合并后移入「已完成」并注明 PR。本账本不含未经证实的猜测——
> 假设类问题先走取证 issue；#101/#102/#103 已完成取证、记录结论并关闭。
>
> 配套流程约定：
>
> 1. 每个 minor 版本预留 10–20% 体量作为债务预算；不再依赖固定发布后等待窗口，债务随当前里程碑一起排期处理。
> 2. 关闭或取代一个被文档引用的门禁 issue 时，同一 PR 内更新全部文档指针
>    （教训：#88 关闭后指针在多份文档中失效，见 2026-07 文档审查）。
> 3. 官网（`website/`，三语）纳入发布例程：功能可见变化时同步官网文案。

## 待立项

### G2 `monthlyCharLimit` 保存但不强制

- **现状**：AI 翻译的月字符预算仅保存与展示，不做本地强制（PRD §Phase 7 自注）。
- **风险**：诚实性缺口——创作者会误以为存在成本保护。
- **方向**：二选一：实现本地用量记账与强制；或在后台 UI 明确标注「仅记录，不限制」。
- **建议时机**：半天体量，搭车当前里程碑或任意小型维护批次。
- **体量**：小。

### G3 legacy 兼容面没有退场时间表

- **现状**：v1 archive 探测、legacy footer 迁移、历史文件 backfill 等兼容代码
  无限期存活，构成永久维护税。
- **方向**：制定并公告弃用政策（例：v1 archive 支持至 v1.2；更旧实例须先升级到
  v1.x 再跳）。弃用宣布得越早成本越低。
- **建议时机**：v1.0.0 已发布但公告尚未包含弃用政策——**随 v1.1 首个沟通（release notes 或官网更新）补上**，代码移除按公告的时间表执行。
- **体量**：政策宣布小；后续移除各自小。

### G5 CI actions 的 Node 20 弃用警告

- **现状**：`checkout@v4`、`configure-pages@v5` 等被 runner 强制运行于 Node 24
  并打印弃用警告（2026-07 Pages 部署日志可见）。
- **方向**：下次修改 workflow 时顺手升级各 action 到当前主版本；仍须保持第三方 action 使用不可变 commit SHA。
- **建议时机**：搭车任意 workflow 改动，不单独立项。
- **体量**：微。

### G7 Plausible SPA 自动 pageview 未按公开页边界重判

- **现状**：Plausible adapter 仍沿用其脚本默认自动追踪行为；若公开页上的 root layout 脚本在 SPA 导航后继续存活，客户端路由切到 `/me`、`/checkout/*`、`/admin` 等非公开页时仍可能上报 pageview。WP6 仅授权修复 Umami adapter；`release-v1.1-plan.md` §WP6 明确 Plausible 只做回归、兼容性和文档验收，不重复实现。
  同一范围边界也适用于后台集成面板：PR #164 只把 Umami 纳入 System integrations registry，Plausible 仍不进入该 registry，待单独立项补齐同等状态语义。
- **风险**：与 Umami 修复后的公开页边界存在 parity gap，可能把非公开路径暴露给 Plausible 事件端。
- **方向**：为 Plausible 单独立项时复用共享公开页路径谓词，关闭默认自动追踪并增加同等 nonce inline 手动追踪器；迁移前保持部署文档标注该差异。
- **建议时机**：Plausible adapter 后续维护批次或隐私硬化批次。
- **体量**：小。

## 已立项

（当前无已立项但未完成的条目。）

## 已完成

- **G1**：随 v1.1 WP2 Phase 5 完成并移入本节。业务邮件任务 payload 改为 v2 domain-reference 格式；worker 在发送时根据业务行重新解析最新邮箱和 locale。迁移会移除 `kind='email'` 任务里的 `payload_json.to`：可安全还原业务事件的 retryable 行改写为 v2，不能安全还原的 retryable 行 dead-letter 并脱敏，terminal 行脱敏保留。登录码任务保持不存收件人地址。
- **G4**：随 PR #123 完成，exact-head CI run #554 通过。`src/modules/i18n/key-completeness.test.ts` 递归比较 zh/en/ja 完整 key 路径集合，一次性报出所有 missing/extra；`tsc --noEmit` 已隐式保护多余/缺失 key（本条目把这层保护改为显式、具名、CI 可见，防止未来重构悄悄移除）。
- **G6**：随 PR #123 完成，exact-head CI run #554 通过。`e2e/theme-visual-baseline.spec.ts` 覆盖 12 张截图（Home/Posts/PostDetail × 明暗 × `builtin`/`blog`，各主题用自己的真实默认预设）。过程中发现并修复：CI 渲染环境字体度量与本地不同（基线改为直接采集 CI 实际渲染结果，而非本地近似）、页脚年份（`new Date().getFullYear()`）会导致基线逐年失效（已加 mask）。**范围说明**：视觉基线集中覆盖主题实际存在布局分歧的三个页面和默认预设；直接复用 builtin 正文组件的页面由组件身份断言与代表性权限 smoke 提供证据；全部具名预设/custom hue 由参数化功能测试覆盖；zh/en/ja 由 G4 key 完整性与逐语言浏览器 smoke 覆盖。不是全页面 × 权限 × 预设 × 语言的组合视觉矩阵，见 `release-v1.1-plan.md` §3 WP1 验收项。

- **Theme follow-up**：WordPress 经典作为 WP1 follow-up 单独授权提前实现；本 follow-up 将主题视觉基线扩展到 `wordpress`。稳定窗口约束已由 `release-v1.1-plan.md` 的 2026-07-12 决策记录取消。
