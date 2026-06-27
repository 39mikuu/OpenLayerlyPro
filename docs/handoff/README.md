# Handoff 文档状态说明

`docs/handoff/` 保存的是各 issue、ADR 或安全切片在实施时使用的交接记录。它们用于解释当时锁定的范围、风险、不变量和验收方案，**不是当前运行时或生产运维手册**。

因此，已完成 handoff 中的“当前 main 尚未实现”“本任务保持内联”“需要新增字段”等表述应按其编写时点理解，不应覆盖后来已经合并的实现。例如：

- `issue-7.md` 记录了最初 outbox 切片中登录验证码保持内联的范围；当前登录码已经使用持久任务与投递 fence。
- `issue-9.md` 记录了实施前尚无 `scheduledAt`、`scheduleToken`、`contentUpdatedAt` 的状态；这些能力现在已经落地。

查询当前状态时，按以下顺序使用资料：

1. 当前代码、数据库迁移与测试；
2. [v1.0 最终验收清单](../release-v1.0-checklist.md)与对应 issue；
3. [路线图](../roadmap.md)；
4. `docs/architecture/`、`docs/admin/`、`docs/deployment/` 中的现行文档；
5. ADR 与 handoff，作为历史设计和实施依据。

当前唯一发布主线是 S7 #87 → v1.0 最终验收 #88。已完成 handoff 不应仅因正文保留历史时态而被当作未完成任务，也不应直接复制为当前运维步骤。
