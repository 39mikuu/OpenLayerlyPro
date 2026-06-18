# ADR 0002：审计与事件策略——统一审计表 + 因果引用

- **Status**：Proposed ▶
- **相关 issue**：#4（会员历史）、#6（付款审计链路）、#8（管理员操作历史）

## Context

现状已有一张通用事件表 `app_events`（`type` + `payload_json` + `created_at`），由 `recordEvent` 写入，用于登录、付款审核等。但它有两个问题：

1. **不满足审计要求**：没有 actor、reason、before/after、目标实体引用，且 `recordEvent` 当前在**事务提交之后**调用（见 `payment/index.ts`），状态提交了事件却可能丢失——违反 #6「状态与审计同提交或同回滚」。
2. **规划要再叠三套**：#4 要会员历史、#6 要付款事件、#8 要管理员操作历史。若各自建表，会出现 4 套并行审计，且 #6 要求的「付款事件 ↔ 会员授权事件共享稳定因果引用」难以跨表实现。

需要在动 #4/#6 之前定清楚审计的承载方式。

## Decision

1. **新增一张统一审计表 `audit_events`**，取代在敏感路径上直接用 `app_events`：

   | 列 | 说明 |
   |---|---|
   | `id` | uuid 主键 |
   | `entity_type` | `membership` / `payment_request` / `admin` / … |
   | `entity_id` | 目标实体 id |
   | `action` | `grant` / `suspend` / `resume` / `revoke` / `extend` / `approve` / `reject` / `resubmit` / `cancel` / `correct` / … |
   | `actor_type` | `admin` / `user` / `system` |
   | `actor_id` | 操作者 id（system 为 null） |
   | `reason` | 文本，敏感操作必填 |
   | `before_json` / `after_json` | jsonb，状态快照 |
   | `correlation_id` | uuid，**同一业务动作内的所有事件共享**，用于跨实体因果串联 |
   | `created_at` | 时间戳 |

2. **审计写入必须在业务事务内**：`recordAudit(tx, ...)` 接收事务句柄，与状态变更同提交/同回滚。禁止在敏感路径事务外补记。
3. **因果引用用 `correlation_id`，不用外键链**：付款 `approve` 与其触发的会员 `grant` 写两条 `audit_events`，共享同一个 `correlation_id`。这样反转/更正（#6）也能挂同一条因果链，且不需要表间硬外键。
4. **`app_events` 降级为「非审计的运行遥测」**：保留给登录计数、轻量统计等不需要 actor/before-after 的事件；不再承载会员/付款/管理员的审计语义。
5. **索引**：`(entity_type, entity_id, created_at desc)` 取实体时间线；`(correlation_id)` 取一次动作的全部事件。

## Alternatives

- **每个域一张历史表**（membership_events / payment_events / admin_logs）：领域内更贴合，但跨域因果（#6 核心诉求）要么冗余存双向 id，要么 join 多表。统一表 + correlation_id 更直接。否决，但保留：若某域审计字段差异极大，可后续派生专用视图。
- **继续用 `app_events` 扩字段**：它已被大量非审计场景使用，加 actor/before/after 会让语义含混，且历史数据没有这些字段。分表更干净。否决。
- **事务外补记审计**：实现简单，但无法保证状态与审计一致，直接违反 #6 验收标准。否决。

## Consequences

- ✅ #6 的「共享稳定因果引用」「partial failure 一起回滚」「每个转移恰好一条 durable event」直接可满足。
- ✅ #4 会员历史、#8 管理员操作历史复用同一张表与同一套 `recordAudit`，不重复造轮子。
- ✅ 前台/后台「时间线」组件只查一张表。
- ⚠️ 现有 `payment/index.ts` 里事务外的 `recordEvent` 调用要迁移进事务并改写为 `recordAudit`，属于行为变更，需测试覆盖。
- ⚠️ `correlation_id` 需要在 service 入口生成并贯穿整个事务，调用约定要在 #4/#6 实现时统一。
