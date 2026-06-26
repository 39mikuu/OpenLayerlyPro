# v0.2.0 验收清单（历史，已被取代）

> **不要再按本文档创建 `v0.2.0` tag 或 GitHub Release。** v0.2 候选范围已继续演进并合并到 v1.0 主线；当前唯一发布门槛是 [v1.0.0 最终验收与发布清单](./release-v1.0-checklist.md)和 issue #88。

本文档原用于一次性 Stripe Checkout、列表分页、流式上传和早期视频附件的候选验收。此后以下能力已经进入 `main`，原清单中的边界与发布命令不再准确：

- 全额退款、拒付、reversal-first 与 reconciliation；
- Stripe 自动订阅与手动周期提醒；
- local/S3 单段 HTTP Range 200/206/416 与内联播放器；
- S1a/S1b/S2/S3/S4/S5 安全硬化；
- v1.0 的 S6、S7 和统一真实环境发布门槛。

历史 v0.2 范围与当时的候选说明保留在 `CHANGELOG.md` 的对应章节，但不再构成可执行的运维或发布流程。

## 当前应执行的流程

1. 完成 #86（S6 安全响应头）。
2. 完成 #87（S7 备份一致性）。
3. 按 [v1.0.0 最终验收与发布清单](./release-v1.0-checklist.md)执行 #88。
4. 只有 #88 全部通过后才创建 `v1.0.0` tag 和 GitHub Release。
