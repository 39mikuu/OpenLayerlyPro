# 配置中心（Config Center）

把运行时配置（SMTP、S3/R2、Turnstile、上传限制等）从环境变量迁到后台、加密落库，让运维不必编辑 `.env` 或重启容器即可改配置。配置中心基座、SMTP、Turnstile、S3/R2 与上传限制分组均已落地。

## 数据模型

- **`app_settings` 表**(`src/db/schema/index.ts`):`key`(配置组名,如 `smtp`)主键 + `value_encrypted`(整组配置 JSON 的密文)+ `updated_at`。
- 与明文公开的 `site_settings` **分表**,避免密钥与公开站点设置混存。
- 整组配置一次性加密(而非逐字段),at-rest 全密;掩码是后台 UI 层职责。

## 加密

`src/lib/crypto.ts`:

- `encryptSecret(plaintext)` / `decryptSecret(payload)`:AES-256-GCM。
- 密钥取自 Phase 1 的 `getConfigEncryptionKey()`(env `CONFIG_ENCRYPTION_KEY` 优先,否则读 `CONFIG_ENCRYPTION_KEY_FILE`),用 `sha256` 归一化为 32 字节以兼容任意格式的根密钥。
- 密文格式 `v1:<ivBase64>:<authTagBase64>:<密文Base64>`,版本前缀便于将来轮换。
- 密钥缺失、格式非法、密文/authTag 被篡改、密钥不匹配 → **抛错,不静默返回错值**。日志不输出密钥与密文。

## 配置收口与优先级

`src/modules/config/`:

- `store.ts`:`getStoredGroup<T>(group)`(查 `app_settings` → 解密 → `JSON.parse`,无记录返回 `null`)、`setStoredGroup(group, value)`(加密 upsert)。
- `smtp.ts`:`getSmtpConfig()` 解析最终生效配置,**优先级 DB ＞ 环境变量 ＞ 默认值**,并给出 `configured` 标志(`host && from`)。
- `turnstile.ts`:`getTurnstileConfig()` 逐字段解析 DB ＞ env；`enabled=false` 是有效后台值，可覆盖 env 的 `true`。
- `storage.ts`:`getStorageConfig()` 解析 local / S3 最终驱动与 S3/R2 参数；后台 local 可覆盖 env s3，反之亦然。
- `upload.ts`:`getUploadConfig()` 解析内容附件与付款截图的单文件上限，逐字段 DB ＞ env ＞ 默认。
- 消费方(如 `src/modules/mail`)只调 `getSmtpConfig()`,不再直接读 `getEnv()`。`app_settings` 无记录时全程回落环境变量,与配置中心落地前行为完全一致。

## 密钥依赖与备份

- 读写加密配置需要配置加密根密钥;**纯环境变量回落路径不需要密钥**,故配置中心落地不影响现有 `.env` 部署。
- 生产 readiness(`/api/ready`)已要求密钥存在。
- **迁移服务器务必备份 secrets volume**:根密钥丢失 → 已加密配置无法解密(需用环境变量重新配置)。

## 后台 UI(SMTP,已实现)

- **页面**:`/admin/settings`(系统配置),SSR `getSmtpAdminView()` 传入表单。
- **接口**:`/api/admin/config/smtp` —— `GET`(掩码视图)、`PUT`(保存)、`DELETE`(清除回落环境变量),均 `requireAdmin()`。
- **掩码**:仅 `password` 敏感,GET 从不返回明文,只给 `passwordSet`;保存时密码留空表示不修改(保留原值)。
- **三态回退**:「从环境变量导入」用 `envDefaults` 填表(不立即保存);「恢复为环境变量」DELETE 整行清除,干净回落,避免空串歧义。
- **测试连接**:统一走 Integration 连接测试契约 `POST /api/admin/integrations/smtp/test`(发送测试邮件到管理员邮箱),测试当前生效配置。
- **守卫收敛**:`login-code`、`payment`(审核通过/驳回)、`status`、`test-email` 均已改走 `getSmtpConfig()`,后台配置在所有发信/状态路径生效;`isSmtpConfigured()` 已移除。

## 后台 UI（Turnstile，已实现）

- **页面**：`/admin/settings` 的 Turnstile 卡片，可保存 enabled、公开 Site Key 与敏感 Secret Key。
- **接口**：`/api/admin/config/turnstile` 提供 GET / PUT / DELETE，均要求管理员身份。
- **掩码**：Secret Key 永不返回前端，仅给 `secretKeySet`；整个配置组仍由 `app_settings` 加密保存。
- **三态覆盖**：后台 `enabled=false` 可覆盖 env `TURNSTILE_ENABLED=true`；删除配置组才整体回落 env。
- **空字符串语义**：Site Key 保存前 trim，空串不落库并回退 env；Secret Key 保存前 trim，空串保留旧 DB 值。
- **开启校验**：仅最终生效的 `enabled=true` 时要求 Site Key 与 Secret Key 都存在；关闭时允许两者为空。
- **消费收敛**：登录页 widget 与发码接口守卫都读取 `getTurnstileConfig()`，后台修改无需重启。

## 后台 UI（S3/R2，已实现）

- **页面**：`/admin/settings` 的文件存储卡片，可切换 local / S3，并配置兼容 AWS S3、Cloudflare R2、MinIO 的参数。
- **接口**：`/api/admin/config/storage` 提供 GET / PUT / DELETE；连接测试统一走 Integration 契约 `POST /api/admin/integrations/storage/test`（S3/R2 Put/Get/Delete 闭环），均要求管理员身份。
- **凭据保护**：Access Key ID 与 Secret Access Key 都视为敏感字段；随配置组加密存储，GET 只返回 `accessKeyIdSet` / `secretAccessKeySet`。
- **空字符串语义**：endpoint、region、bucket 保存前 trim，空串不落库并回退 env；两个凭据空串保留旧 DB 值。region 留空表示回退环境变量，显式使用 `auto` 需填写 `auto`。
- **开启校验**：仅最终驱动为 s3 时要求 endpoint、bucket、Access Key ID、Secret Access Key 完整；local 模式允许 S3 字段为空。
- **热更新**：S3 adapter 不按 driver 永久缓存，每次操作读取最终配置并创建 adapter；后台修改后下一次上传、下载或删除立即生效。
- **连接测试**：使用独立随机前缀创建临时对象，依次执行 PutObject、GetObject 并校验内容、DeleteObject；失败路径也尽力删除对象。
- **历史文件**：新上传记录的 `files.storage_driver` 必须等于上传时最终驱动；历史 local / S3 文件按记录驱动处理，S3 操作优先使用记录中的 bucket。

### 单 S3 profile 限制

本轮只维护一个当前 S3 profile。`files` 表尚未记录 endpoint 与凭据版本，因此切换到完全不同的 S3 服务或账号后，旧 S3 文件不保证可访问。未来支持多个对象存储配置时，需要新增 `storageProfileId` 并让每个文件绑定其上传时使用的 profile。

## 后台 UI（上传限制，已实现）

- **页面**：`/admin/settings` 的「上传限制」卡片，可配置内容附件上限（`maxUploadSizeMb`）与付款截图/收款码上限（`paymentProofMaxSizeMb`）。
- **接口**：`/api/admin/config/upload` 提供 GET / PUT / DELETE，均要求管理员身份。
- **非敏感字段**：两个上限都是正整数 MB，不涉及密钥，admin view 无掩码；整组仍按统一模式加密落 `app_settings`。
- **回退语义**：未传字段保留旧 DB 值；DELETE 整组清除后逐字段回落环境变量（`MAX_UPLOAD_SIZE_MB` / `PAYMENT_PROOF_MAX_SIZE_MB`）。
- **热更新**：消费方 `src/modules/file` 的 `saveUploadedFile` 每次校验都读 `getUploadConfig()`，后台修改后下一次上传立即生效，无需重启。
- **内存提示**：上传仍整文件读入内存，上限应与部署机器可用内存匹配。

## 尚未实现

配置读取当前每次查库，后续如增加短 TTL 缓存，需要设计跨进程失效策略。
