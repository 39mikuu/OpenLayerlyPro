# ADR 0005：自动收付款 + 可插拔支付服务商

- **Status**：Proposed ▶
- **相关 issue**：v0.2 旗舰（待建 issue）
- **依赖**：ADR 0001（会员生命周期）、ADR 0002（事务内审计 + 因果链）、ADR 0003（durable tasks / outbox）

## Context

v0.1 只有**人工审核收银台**：粉丝扫收款码 → 上传付款截图 → 管理员人工 approve → `grantMembership`。这条链路（`payment_requests`、approve/reject/**reverse**、`granted_membership_id`、审计因果、会员生命周期、outbox 邮件）已经事务化、可审计、有回归测试。

现在要加**自动收付款**:粉丝在线支付 → 服务商回调确认 → **自动开通会员**,无需人工。用户要求 **provider 可插拔(国际 Stripe + 国内 支付宝/微信都要),首版先接一个**。

最危险的点是「钱」:回调可重放/乱序/伪造,退款要联动撤销会员,绝不能把卡号等敏感数据落到本应用。

## Decision

### 1. provider 抽象(可插拔)

新增 `src/modules/payment/providers/`:一个 `PaymentProvider` 契约 + 注册表(仿 `src/modules/integration` 的 registry 风格):

```ts
interface PaymentProvider {
  id: "stripe" | "alipay" | "wechat";
  // 创建一次支付会话，返回跳转/二维码所需信息
  createCheckout(input: { requestId; amountMinor; currency; tier; returnUrl }): Promise<{ redirectUrl?; qrPayload?; providerRef }>;
  // 验签 + 解析回调为归一化事件
  parseWebhook(rawBody, headers): Promise<NormalizedPaymentEvent>; // { type: 'paid'|'refunded'|'failed', providerRef, providerEventId, amountMinor, currency }
}
```

**首版只实现一个参考适配器 = Stripe**(推荐,见 D-首选;可否决),`alipay`/`wechat` 留接口、后续接入。

### 2. 与人工流共存,不替换

`payment_requests` 仍是统一载体,扩列区分两条路径:

- 加 `flow text not null default 'manual'`(`manual` | `auto`)。
- 加 `provider text`(auto 时非空)、`provider_ref text`(服务商订单/会话 id)、`provider_event_id` 去重(见 D5)。
- 加结构化金额 `amount_minor bigint` + `currency text(3)`(auto 必需;manual 仍可只用 `amountLabel` 展示)。
- 复用现有 `status` 枚举:auto 路径**不经过 `pending_review`**——创建即 `pending_payment`(新增枚举值)→ 回调成功 → `approved`(走与人工 approve **同一** grant 路径)→ 失败/超时 → `cancelled`。

> 人工 QR 收款码(`payment_methods`)保持原样;auto provider 的密钥/开关走**配置中心**(加密 `app_settings`,与 SMTP/S3 同范式),不塞进 `payment_methods`。

### 3. tier 结构化定价

`membership_tiers` 加 `price_amount_minor bigint` + `currency text(3)`(可空;仅「可在线支付」的 tier 需要)。`price_label` 继续用于展示与人工流。auto checkout 用结构化金额,杜绝「拿展示文本当金额」。

### 4. webhook = 唯一权威确认

- 新增 `POST /api/payments/webhook/[provider]`(**不**走 `requireAdmin`;靠**签名验签**鉴权)。
- 流程:读 raw body → `provider.parseWebhook` 验签(失败 401)→ 归一化事件 → **幂等处理**(见 D5)→ 事务内:把对应 `payment_request` 由 `pending_payment` 条件更新为 `approved` + `grantMembership(tx)` + `recordAudit(tx, action='auto_paid', causationId=...)` + `enqueueTask(tx, 邮件)`。**完全复用 #6 approve 的同一套事务/审计/outbox**。
- 返回 2xx 要快;失败返回非 2xx 让服务商重试(重试由 D5 幂等兜住)。

### 5. 幂等 + 安全(碰钱的红线)

- **绝不接触卡号/敏感支付数据**:一律用服务商托管 checkout / 跳转 / 官方 SDK;本应用只存 `provider_ref` 与归一化结果。
- **回调幂等**:`provider_event_id` 唯一约束;重复事件→查到已处理→直接 200 no-op。重放/乱序安全。
- **条件更新做并发守卫**:`where id=? and status='pending_payment'` 命中 0 行即已处理,不重复开通(与人工 approve 的双击防护同理)。
- **验签密钥**走配置中心加密存储;webhook secret 不入日志/审计。
- 金额校验:回调金额必须与 `payment_request.amount_minor` 一致,否则拒绝并告警。

### 6. 退款 / 拒付 → 复用反转

服务商 `refunded`/`chargeback` 回调 → 复用 **#6 的 `reversePaymentApproval`** 路径:撤销 `granted_membership_id` 对应会员,审计 `causation_id` 指向退款事件。零新增状态机。

### 7. 一次性优先,订阅推迟

**v0.2 只做一次性付款**(付一笔 → 固定 `durationDays` 会员,与现有 tier 模型一致)。**自动续费/订阅(recurring)明确推迟**到后续里程碑——它会引入续费扣款、失败重试、宽限期、dunning,体量是另一个 epic。

### 8. 配置与启用

- provider 配置(api key、webhook secret、启用开关、currency)走配置中心加密组 + 后台「支付」配置页 + Integration 注册表状态/测试(复用现有范式)。
- 未配置/未启用时,前台只显示人工收款码流(零行为变化)。

## Alternatives

- **直接替换人工流**:否决。人工收款码对国内小创作者仍刚需,且无需服务商资质即可用;两条路并存。
- **webhook 处理塞进 tasks 异步**:可选(更稳),但一次性付款的 grant 很快,**首版在 webhook 内同事务处理 + 幂等**即可;provider 自带重试。若将来慢/重,再改成「入队 raw 事件 → 派发器处理」(tasks 已就绪)。
- **自己做收银台/存卡**:绝对否决(PCI 合规 + 安全风险)。一律托管 checkout。
- **首版就接支付宝/微信**:可行但回调/验签/资质更重;Stripe 测试态零摩擦、最快验证抽象正确性。故推荐 Stripe 先行(可否决)。

## Consequences

- ✅ 高度复用 v1 Core 地基:审计因果、outbox、付款反转、会员生命周期、配置中心——自动支付主要是「在确认入口接上服务商」。
- ✅ provider 抽象让国内/国际后续可增量接入。
- ✅ 一次性优先,范围可控,money 风险面最小。
- ⚠️ 需 schema 迁移:`payment_requests`(flow/provider/provider_ref/provider_event_id/amount_minor/currency + 新状态 `pending_payment`)、`membership_tiers`(amount_minor/currency)。新增枚举值是增量、低风险。
- ⚠️ webhook 是无 admin 鉴权的公开端点,**安全完全依赖验签 + 幂等 + 金额校验**,必须有针对性测试(伪造签名拒绝、重放只开通一次、金额不符拒绝、退款联动撤销)。
- ⚠️ 订阅/续费、对账报表、多币种展示均不在本 ADR;后续单独评估。

## 待你确认的两个分叉(baked 为推荐,可改)

1. **首个参考适配器 = Stripe**(测试态零摩擦、最快跑通抽象)。若你的首要受众是国内创作者,可改为「支付宝/微信先行」——但开发/测试摩擦更大。
2. **v0.2 只做一次性付款**,订阅续费推迟。若你要 v0.2 就上订阅,范围与风险显著增大,需重新评估排期。
