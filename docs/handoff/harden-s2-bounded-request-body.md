# 交接：S2 请求体有界化（防内存 DoS）

> 自包含实现说明。前置依赖:当前 `main`。属 v1.0 安全硬化 P1(epic #64),**与 S3 一同先于订阅 #61**(订阅新增 webhook inbox,须从一开始就有界读取)。开工前建 issue;Draft 直到 CI 全绿。

## 0. 红线
1. **业务校验前**就拒绝超大体:`Content-Length` 超限**预拒**;无 / 谎报 `Content-Length` 时按 chunked **累计字节超限即中止**。
2. 超限后**不**进 Zod / Stripe SDK / sharp / DB / storage。
3. **Stripe webhook 必须保留精确原始字节**用于验签(bounded **raw** reader,不得改写字节)。
4. 反向代理可再加一层上限,但**应用层不得只依赖代理**。

## 1. 现状(受影响入口)
- `src/app/api/payments/webhook/stripe/route.ts`:`await req.text()`(验签前,**公开未鉴权**,最高危)。
- 付款截图上传路由:`await req.formData()` 后 `saveUploadedFile` 才看 `file.size`(10MB 限制非传输层上限)。
- `setup` / `admin/login` / 验证码校验等:直接 `req.json()`(App Router 无默认 body 上限)。

## 2. 实现:统一有界读取工具(新建 `src/lib/request-body.ts`)
```ts
export class RequestBodyTooLargeError extends Error {}

// 读取 req.body(ReadableStream)累计字节，超过 maxBytes 立即 abort 抛错；返回精确 Buffer
export async function readBoundedRawBody(req: Request, maxBytes: number): Promise<Buffer>;

export async function readJsonWithLimit<T>(req: Request, maxBytes: number, schema: ZodSchema<T>): Promise<T>;
export async function readTextWithLimit(req: Request, maxBytes: number): Promise<string>;
```
要点:
- **先看 `Content-Length`**:能解析且 > `maxBytes` → 立即 413,不读流。
- 再**流式累计**:`for await (chunk of req.body)` 累加 `byteLength`,超 `maxBytes` → `RequestBodyTooLargeError`(防谎报/chunked)。
- `readBoundedRawBody` 返回**未改写**的精确字节(webhook 验签用)。
- `readJsonWithLimit` = bounded text → `JSON.parse` → Zod;**超限不进 parse/Zod**。
- 统一在 `handleApiError` 把 `RequestBodyTooLargeError` 映射成 **413 `requestBodyTooLarge`**。

## 3. 各入口接线
- **Stripe webhook**:`const raw = await readBoundedRawBody(req, STRIPE_WEBHOOK_MAX_BYTES)` → 验签用 `raw`。限额合理(Stripe 事件体不大,如 256KB,设上下限的 env)。
- **付款截图(必须二选一,不得弱化成只查 `Content-Length`)**:
  > **禁止**:直接对原始请求调 `req.formData()`;**禁止**只依赖 `Content-Length`(挡不住无 CL 的 chunked、谎报小 CL、formData 在业务校验前完整缓冲)。
  - **方案 A(真流式 multipart)**:原始流 → 累计总字节 + 每字段/文件单独上限 → 超限**立即取消流** → 临时文件 → 成功后才 sharp。(对齐 B1 `content_attachment` 流式范式,最稳。)
  - **方案 B(先 bounded raw 再解析)**:`readBoundedRawBody(req, PROOF_TOTAL_LIMIT)` → 用这个**有上限的 Buffer** 构造新 `Request` → `newRequest.formData()`。占用有限内存但安全边界明确,适合当前 10MB 场景。
  - 两方案都使**配置的 proof 上限成为传输层上限**;超限前不落盘、不写库、不调 sharp。
- **JSON 路由(全量,不留"等")**:**审计仓库内所有生产 route handler 的 `req.json()`/`req.text()`/`req.formData()`**,全部改走 bounded helper。至少覆盖(grep 核对补全):webhook、付款截图、payment request、checkout、tiers、memberships、SMTP/storage/Stripe/Turnstile 配置、posts/translations、account email/password、theme/locale、setup、admin-login、code-verify、request-code。
  - `req.json()` → `readJsonWithLimit(req, REQUEST_JSON_MAX_BYTES, schema)`。
  - **加 CI 静态检查**(lint 规则 / grep gate):禁止生产路由直接 `req.json()/req.text()/req.formData()`(只能用 bounded helper),防新增回潮。

## 4. 配置(env,有界正整数 + 上下限)
```text
REQUEST_JSON_MAX_BYTES           # 默认 ~64KB
STRIPE_WEBHOOK_MAX_BYTES         # 默认 ~256KB
PAYMENT_PROOF_MAX_SIZE_MB        # 已存在；本切片使其成为传输层上限
```
测试默认 / 合法覆盖 / 过小 / 过大 / NaN / 负数。

## 5. 测试
- webhook:超 `Content-Length` → 413,**未调** Stripe SDK / 未读全量;chunked 谎报 `Content-Length` 但实体超限 → 中途 abort 413;正常事件 → 验签字节**精确一致**(签名通过)。
- 付款截图:超限 → 413,**未落盘、未写库、未调 sharp**;正常 → 成功。
- JSON 路由:超限 → 413,**未进 Zod**;正常 → 通过。
- 反代第二层限额不影响应用层独立生效(应用层单测覆盖)。

## 6. 提交前验证
```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```
(无 schema 迁移。)

## 7. PR
base `main`,Draft 直到 CI 全绿,关联 issue,标题 `fix(api): bound request bodies before business validation`。

## 8. 验收 checklist
- [ ] `readBoundedRawBody`/`readJsonWithLimit`/`readTextWithLimit`;413 统一映射
- [ ] Content-Length 预拒 + chunked 累计中止;超限不进 Zod/SDK/sharp/DB/storage
- [ ] Stripe webhook 用 bounded raw,字节精确、验签通过
- [ ] 付款截图走方案 A(流式)或 B(bounded raw→重构 Request→formData);**不直接对原始请求 formData、不只查 CL**;上限=传输层上限(超限不落盘/不写库/不调 sharp)
- [ ] **全量审计** JSON/text/formData 入口改 bounded helper(grep 核对,无"等");**CI 静态检查**禁止生产路由直接 `req.json()/text()/formData()`
- [ ] env 上下限 + NaN/负数测试;无 schema 迁移
