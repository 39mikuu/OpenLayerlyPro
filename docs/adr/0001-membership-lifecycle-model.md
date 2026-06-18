# ADR 0001：会员生命周期模型——叠加时间窗 + 存储状态态

- **Status**：Proposed ▶
- **相关 issue**：#4（生命周期与历史）、#5（后台控制）、#6（付款审计链路）

## Context

当前 `memberships` 表是**叠加时间窗**模型：

- 没有 `status` 字段；「是否有效」由 `getActiveMembership` 在查询时用 `startsAt <= now < endsAt` 且 `tier.isActive` 派生。
- `grantMembership` 对同级或更高级的有效会员**插入新行并顺延** `startsAt`（续费叠加），而非修改原行。
- 一个用户可能同时存在多条会员行（不同等级、不同时间段）。

#4 要求引入 `active / expired / suspended / revoked / pending` 状态、非法转移确定性拒绝、全程可审计。直接把这五个值塞进一个枚举，会和现有叠加模型冲突，并把**派生态**（过期）和**人工干预态**（封禁/撤销）混为一谈，导致「字段写 active 但时间已过期」之类的不一致。

需要先定清楚：状态作用在哪一层、哪些态存储、哪些态派生、并发如何防覆盖。

## Decision

1. **保留叠加时间窗作为有效期事实来源**，不改 `grantMembership` 的顺延语义。
2. **状态分两类**：
   - **存储态**（落库到 `memberships.status` 枚举）：`active`、`suspended`、`revoked`。
   - **派生态**（运行时计算，不落库）：`expired`（`endsAt <= now`）、`scheduled`（`startsAt > now`，预留）。
3. **删除「membership 上的 pending」**：付款待处理属于 `payment_requests`，不是会员状态（见 #6 / ADR 0002）。
4. **生命周期操作的作用对象是「单条 membership 行」**：`suspend` / `resume` / `revoke` / `extend` 都针对具体 membership id。"用户当前有效会员" 仍由 `getActiveMembership` 聚合，并新增过滤 `status = 'active'`。
5. **有效性判定 = 存储态 active ∧ 时间窗有效 ∧ tier 启用**。`getActiveMembership` / `getActiveLevel` 全部改用这一规则，作为唯一的权限判定入口。
6. **并发防覆盖**：`memberships` 增加 `version integer not null default 0`（乐观锁）。所有生命周期写操作走 `where id = ? and version = ?` 条件更新，命中 0 行即抛 stale 错误，满足 #5「不得静默覆盖更新态」。

### 允许的状态转移

| 当前 | 目标 | 操作 | 备注 |
|---|---|---|---|
| active | suspended | suspend | 需 reason |
| suspended | active | resume | 恢复后仍受时间窗约束 |
| active / suspended | revoked | revoke | 终态，需 reason |
| active / suspended | active | extend | 延长 endsAt；revoked 不可延长 |

- `revoked` 为终态，不可再转移。
- `expired` 是派生态，不参与转移；过期会员若要再开通，走新的 `grantMembership`。
- 非法转移在服务层确定性拒绝（`ApiError(409, ...)`），不依赖 UI 拦截。

## Alternatives

- **纯状态机、放弃叠加行**：每个用户一条 membership，续费即改 endsAt。语义更简单，但要重写续费/顺延逻辑、迁移历史多行数据，且丢失「分段会员历史」。回退成本高，否决。
- **五态全部落库（含 expired/pending）**：需要后台定时把到期会员刷成 expired，引入一致性窗口和定时任务依赖；pending 还会和付款表职责重叠。否决。
- **用 updatedAt 做并发令牌**：可行但语义弱（时钟/同毫秒多写）。显式 `version` 更清晰，成本极低。

## Consequences

- ✅ 不破坏现有有效期/续费语义，迁移只是「加列 + 回填 `status='active'` + 加 version」，低风险。
- ✅ 权限判定收敛到单一规则，#12 的不变量测试有明确目标。
- ⚠️ 所有读取「有效会员」的地方必须同步加 `status='active'` 过滤，需全量排查（payment、content 权限、me 页面）。
- ⚠️ `suspend` 作用于单行：用户若有多条叠加有效行，后台需展示并允许逐条操作；#5 UI 要呈现「行级」而非「用户级」状态。
- 后续：ADR 0002 定义 membership 变更如何写入审计历史。
