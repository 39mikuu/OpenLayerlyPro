# v0.2.0 验收清单（历史，已被取代）

> **不要再按本文档创建 `v0.2.0` tag 或 GitHub Release。** v0.2 候选范围已继续演进并合并到 v1.0 主线，`v1.0.0` 已于 2026-07-06 正式发布（tag、GitHub Release、#104 与 #88 均已关闭）。本文档不再包含任何当前可执行流程，仅作历史存档；见 [v1.0.0 最终验收与发布清单](./release-v1.0-checklist.md)了解已完成的验收记录。

本文档原用于一次性 Stripe Checkout、列表分页、流式上传和早期视频附件的候选验收。此后以下能力已经进入 `main`，原清单中的边界与发布命令不再准确：

- 全额退款、拒付、reversal-first 与 reconciliation；
- Stripe 自动订阅与手动周期提醒；
- local/S3 单段 HTTP Range 200/206/416 与内联播放器；
- S1a/S1b/S2/S3/S4/S5 安全硬化；
- v1.0 的 S6、S7、审计修复和统一真实环境发布门槛。

历史 v0.2 范围与当时的候选说明保留在 `CHANGELOG.md` 的对应章节，但不再构成可执行的运维或发布流程。

## 历史流程（已全部完成）

S6 #86、S7 #87、审计修复、#58 与 #119、真实 Stripe/SMTP/S3/R2/Turnstile/CSP/密钥托管/恢复验收、#104 发布报告与 exact-final-SHA CI 均已完成；`v1.0.0` tag 与 GitHub Release 已发布，验收证据见 Release 附录。