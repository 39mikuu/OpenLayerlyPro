# ADR 0001：会员生命周期模型——叠加时间窗 + 存储状态态

- **Status**：Accepted ✅（2026-06-18）
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
   - **行级而非用户级**：`suspend` 只冻结某一条 grant。若用户还有另一条有效且未暂停的 grant，他仍拥有会员访问权。后台文案必须叫「暂停此会员记录」，不可叫「暂停该用户会员」。将来若要「一键冻结某用户全部会员访问」，应**另做用户级限制**（如 `users` 上的访问开关），不得偷改行级 `suspend` 的语义。
5. **拆分「已有权益是否有效」与「是否可售卖/展示」**（修正现有代码行为）：
   - **grant 是否有效 = `status = 'active'` ∧ 时间窗有效**（`startsAt <= now < endsAt`）。**不再包含 `tier.isActive`**。
   - **该等级是否可购买 / 是否展示 = `tier.purchaseEnabled` / `tier.isActive`**，仅作用于售卖与列表，不影响已发放的 grant。
   - 即：**停售 / 隐藏一个等级，不会取消已付款用户的权益**。这是对现状的有意修正——当前 `getActiveMembership` 带 `tier.isActive` 过滤，会导致停用等级即砍掉存量会员权限。
   - `getActiveMembership` / `getActiveLevel` 改用「grant 是否有效」规则，作为唯一的权限判定入口；等级名称/level 仍按 grant 记录的 `tierId` 关联读取（即便该 tier 已停用）。
6. **并发防覆盖**：`memberships` 增加 `version integer not null default 0`（乐观锁）。所有生命周期写操作走 `where id = ? and version = ?` 条件更新，命中 0 行即抛 stale 错误，满足 #5「不得静默覆盖更新态」。

### 允许的状态转移

状态转移（suspend / resume / revoke）**只改存储态，与时间窗无关**；访问权 = `active` ∧ 时间窗有效，二者正交。`extend` **只改时间窗、保持存储态不变**。

| 当前存储态 | 操作 | 结果存储态 | 时间窗 | 备注 |
|---|---|---|---|---|
| active | suspend | suspended | 不变 | 需 reason |
| suspended | resume | active | 不变 | 仅恢复存储态；若已过期仍无访问权 |
| active / suspended | revoke | revoked | 不变 | 终态，需 reason |
| active | extend | active（不变） | 延长 endsAt | 见下方过期前置条件 |
| suspended | extend | suspended（不变） | 延长 endsAt | **不会顺便恢复**；恢复请用 resume |

- `revoked` 为终态，不可再转移（含 extend）。
- 非法转移在服务层确定性拒绝（`ApiError(409, ...)`），不依赖 UI 拦截。

### 派生态的操作前置条件（统一口径，消除歧义）

`expired`（`endsAt <= now`）与 `scheduled`（`startsAt > now`）是派生态，不落库，但会约束操作：

| 场景 | suspend | resume | revoke | extend |
|---|:--:|:--:|:--:|:--:|
| **scheduled**（startsAt > now，尚未开始） | ✅ 取消未来 grant | ✅ | ✅ | ✅ 延长 endsAt |
| **未过期 active/suspended**（endsAt > now） | 按上表 | 按上表 | ✅ | ✅ 延长 endsAt |
| **expired active**（status=active 但 endsAt ≤ now） | ✅（无意义但允许） | — | ✅ | ❌ **不可 extend** |
| **expired suspended** | — | ✅（仅改态，仍无访问权） | ✅ | ❌ **不可 extend** |

- **过期记录一律不 extend，要再开通走新的 `grantMembership`**（renew = 新增 grant 行，保持「分段会员历史」与叠加模型一致）。这条彻底取代旧稿中「允许所有 active 记录 extend」的含糊表述。
- `extend` 仅在 `endsAt > now` 时允许，延长后 `endsAt = endsAt + days`（不从 now 重新计）。

## Alternatives

- **纯状态机、放弃叠加行**：每个用户一条 membership，续费即改 endsAt。语义更简单，但要重写续费/顺延逻辑、迁移历史多行数据，且丢失「分段会员历史」。回退成本高，否决。
- **五态全部落库（含 expired/pending）**：需要后台定时把到期会员刷成 expired，引入一致性窗口和定时任务依赖；pending 还会和付款表职责重叠。否决。
- **用 updatedAt 做并发令牌**：可行但语义弱（时钟/同毫秒多写）。显式 `version` 更清晰，成本极低。

## Consequences

- ✅ 不破坏现有有效期/续费语义，迁移只是「加列 + 回填 `status='active'` + 加 version」，低风险。
- ✅ 权限判定收敛到单一规则，#12 的不变量测试有明确目标。
- ✅ 停售/隐藏等级与吊销权益解耦：管理员可安全下架等级而不误伤已付费用户。
- ⚠️ **这是对现有行为的有意修正**：之前停用 tier 会连带停掉存量会员，改后不再如此。需在 #5/迁移说明与 CHANGELOG 标注，避免运营者误解。
- ⚠️ 所有读取「有效会员」的地方必须同步：去掉 `tier.isActive` 过滤、加 `status='active'` 过滤，需全量排查（payment 的等级比较、content 权限、me 页面、tiers/checkout）。
- ⚠️ `suspend` 作用于单行：用户若有多条叠加有效行，后台需展示并允许逐条操作；#5 UI 要呈现「行级」而非「用户级」状态，文案用「暂停此会员记录」。
- 后续：ADR 0002 定义 membership 变更如何写入审计历史。
