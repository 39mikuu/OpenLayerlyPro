# 配置中心（Config Center）

配置中心把运行时设置放入后台并加密落库，让运维不必编辑 `.env` 或重启容器即可修改常用集成。当前已实现 SMTP、Turnstile、Storage、Upload、Stripe 与 Translation 配置组。

## 数据模型

- `app_settings`：`key`（配置组名）主键、`value_encrypted`（整组 JSON 密文）、`updated_at`。
- 与公开的 `site_settings` 分表，避免 secret 与可公开站点资料混存。
- 整组 AES-256-GCM 加密；掩码与“是否已设置”属于 admin view，不改变密文存储。

## 加密

`src/lib/crypto.ts` 提供：

- `encryptSecret(plaintext)` / `decryptSecret(payload)`：AES-256-GCM。
- 根密钥来自 `getConfigEncryptionKey()`：`CONFIG_ENCRYPTION_KEY` 优先，否则读取 `CONFIG_ENCRYPTION_KEY_FILE`。
- 密文带版本前缀、IV 和 auth tag，便于检测篡改并为未来轮换留接缝。
- 密钥缺失、格式错误、密文损坏或认证失败都抛错；不静默返回空配置，也不记录密钥/密文。

## 配置收口与优先级

`src/modules/config/` 是唯一最终配置入口：

- `store.ts`：读取、加密 upsert、删除配置组。
- `smtp.ts`：DB ＞ env ＞ default；配置完整性由 host/from 判断。
- `turnstile.ts`：逐字段 DB ＞ env；DB `enabled=false` 可覆盖 env `true`。
- `storage.ts`：DB ＞ env ＞ default，支持 local / S3；历史文件仍按行内 driver/bucket。
- `upload.ts`：内容附件上限直接按 DB ＞ env；付款凭证/二维码上限按 DB 请求值与 env hard ceiling 取较小值。
- `stripe.ts`：后台加密配置，默认 disabled；secret key/webhook secret 必须完整后才能启用。
- `translation.ts`：后台加密配置，默认 disabled；provider/model/endpoint/API key 完整后才 configured。

消费者只调用 config 模块，不能在 mail、storage、payment、login page、Integration status 或 admin UI 中复制配置优先级。

## 密钥依赖与备份

- 读写 `app_settings` 需要配置加密根密钥；env-only fallback 组在没有 DB override 时仍可读取环境变量。
- `/api/ready` 要求配置读取和根密钥可用。
- 迁移/恢复必须备份 secrets volume 或外部 `CONFIG_ENCRYPTION_KEY`；丢失后已加密设置无法恢复。
- `SESSION_SECRET` 不是配置加密根密钥，必须独立备份；它影响会话和在途登录码任务。

## SMTP ✅

- 页面：`/admin/settings`。
- API：`/api/admin/config/smtp` GET/PUT/DELETE，均 requireAdmin。
- password 永不返回；空 password 表示保留已有 DB 值。
- 可从 env 填表、保存 DB override，或删除整组回落 env。
- 连接测试统一走 `POST /api/admin/integrations/smtp/test`。
- login code、会员/付款/续费等业务邮件和状态页读取同一最终配置。
- S5 未配置/鉴权失败不再被当作成功跳过；业务邮件进入 defer/dead/retry 流程。

## Turnstile ✅

- API：`/api/admin/config/turnstile` GET/PUT/DELETE。
- Secret Key 只返回 `secretKeySet`；配置组整体加密。
- `enabled=false` 是有效 DB override；删除配置组才回落 env。
- 最终 enabled 时要求 Site Key + Secret Key。
- 登录页 widget、request-code 守卫、Integration status 与未来 S6 CSP 必须读取同一 effective config。

## Storage ✅

- API：`/api/admin/config/storage` GET/PUT/DELETE。
- 支持 local、AWS S3、Cloudflare R2、MinIO 兼容参数。
- Access Key ID 与 Secret Access Key 均按 secret 处理，GET 只返回 set flags。
- S3 连接测试通过 Integration 端点执行随机对象 Put/Get/Delete，并在失败路径尽力清理。
- adapter 不按 driver 永久缓存；后台修改后下一次操作读取新配置。
- 每个文件记录上传时的 `storage_driver` 和 bucket；切换 active driver 不迁移历史文件。

### 单 S3 profile 限制

当前只维护一个 active S3 profile。`files` 未绑定 endpoint/credential version；切换到完全不同的账号或服务后，历史 S3 对象不保证仍可访问。多 profile 需要未来新增稳定 storage profile identity。

## Upload ✅

- API：`/api/admin/config/upload` GET/PUT/DELETE。
- **内容附件 `maxUploadSizeMb`**：最终值直接按 DB ＞ `MAX_UPLOAD_SIZE_MB` env ＞ default 解析。后台 DB 值可以高于 env fallback；运维必须同步检查反向代理、磁盘、对象存储和业务容量，不能把 env 值误当成不可突破的 hard ceiling。
- **付款凭证/二维码 `paymentProofMaxSizeMb`**：后台值只能降低或等于 `PAYMENT_PROOF_MAX_SIZE_MB` env ceiling，解析时使用 `Math.min(DB-or-env, env)`；DB 不能提高这一图片传输上限。
- **内容附件**通过 raw-body 流式写入 local/S3，并在流中计算字节数与 SHA-256，不随整文件线性占用应用内存。
- **图片用途**（avatar、QR、proof、content image、cover、thumbnail）会有界缓冲并交给 sharp 做权威格式检测、像素/帧限制、重编码和 metadata stripping。
- 反向代理 body limit 只是第二层；应用实际字节累计仍是权威限制。代理上限应覆盖计划允许的应用上限，但不应被当作应用校验替代品。

## Stripe ✅

- API/UI 位于 `/admin/settings` 对应 Stripe 配置卡片。
- 存储 `enabled`、secret key、webhook secret、可选 publishable key 和 currency。
- secret key/webhook secret 不返回前端；enabled 且配置不完整时拒绝保存/启用。
- Integration registry 提供结构化状态和 Stripe 连接测试。
- 一次性 Checkout、订阅 Checkout、webhook 与 reconcile 只读取 `getStripeConfig()`。

## Translation ✅

- API/UI 位于 `/admin/settings` Translation 配置卡片。
- 支持 OpenAI-compatible provider、endpoint、model、API key、`monthlyCharLimit`、direct publish 与 machine label policy。
- 默认 disabled；API key 不返回前端。
- **`monthlyCharLimit` 当前仅被持久化/展示，调用路径没有用量账本或 quota 检查，因此不是强制预算。** 运维必须使用 provider 侧 hard limit/alert；本地 enforcement 属于后续工作。
- Integration registry 提供状态；当前不伪造独立“连接测试”按钮，真实 provider 调用只由 requireAdmin 的生成动作触发。

## 缓存与多实例边界

配置读取当前按需查库，修改后无需进程重启。如果未来加入短 TTL 缓存，必须以 revision/失效机制保证多实例不会出现“新渲染计划 + 旧安全配置”的竞态；S6 CSP 尤其要求页面与响应头使用同一配置 revision。
