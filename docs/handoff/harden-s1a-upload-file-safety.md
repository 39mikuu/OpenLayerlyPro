# 交接：S1a 上传文件安全（服务端权威 MIME + 强制重编码 + 文件响应隔离）

> 自包含实现说明。前置依赖:当前 `main`(已含 S2 有界请求体、durable tasks + `storage.delete_object`、文件下载路由)。设计见 **[ADR 0011](../adr/0011-upload-file-safety.md)**(Accepted)。属 v1.0 安全硬化 P1(epic #64,S1a)。
>
> 开工前建 issue;PR base `main`,Draft 直到真实 PG 集成 + 完整 CI 全绿。**ADR 0011 是红线来源,以下为落地步骤**——遇到与 ADR 冲突以 ADR 为准并回报。

## 0. 红线(ADR 0011)

1. **绝不信任客户端 `file.type`**:落库 `mimeType`、storage `contentType`、objectKey 扩展名一律取**服务端权威**值。
2. **栅格图强制 sharp 重编码**,落盘 = 重编码产物,绝不落原始上传字节;**SVG/HTML/非栅格一律拒绝**。
3. **文件响应脚本隔离**:app-stream 设 CSP;`payment_proof` 改 attachment;S3 预签名设 disposition/content-type。
4. **backfill 原子可恢复**:确定性新 key + 同事务切换 + 同事务入队删除 task;svg/html 存量进 quarantine 不删。
5. 不改访问控制/计费/视频 Range(ADR 0007)/嵌入(0008)/markdown sanitize 语义。

## 1. 现状（必读,直接改造别重写）

- `src/modules/file/index.ts`:
  - `saveUploadedFile`(栅格图入口)**仅按扩展名校验**、落 `mimeType: file.type`、storage `contentType: file.type`、只 `sharp(body).metadata()` 取宽高(**不重编码**、**sharp 能解析 SVG 不拒**)。
  - `PURPOSE_RULES`:`IMAGE_EXTENSIONS=[jpg,jpeg,png,webp]`;`content_image=[...IMAGE,gif]`;`artist_avatar/payment_qr/payment_proof/cover/thumbnail` = IMAGE。
  - `saveStreamedFile`(`content_attachment`)已用 `normalizedContentType`(扩展名推导)+ attachment——**本切片不动其安全语义**。
  - `createObjectKey(purpose, fileName)`、`MIME_BY_EXTENSION`、`getExtension` 可复用。
- `src/db/schema/index.ts`:`files` 表(`mimeType/sizeBytes/sha256/width/height/purpose/objectKey/storageDriver/bucket`)。
- `src/app/api/files/[id]/download/route.ts`:`secureStreamHeaders`(设 Content-Type/Disposition/nosniff/cache);`INLINE_PURPOSES = { payment_qr, cover, thumbnail, payment_proof, content_image }`;`dispositionInline = inline || (!inlineRequested && INLINE_PURPOSES.has(purpose))`。
- `src/app/download/[fileId]/route.ts`:另一文件出口(同样需收口)。
- `src/modules/download/index.ts`:`authorizeAndPrepareDownload*` 返回 `{mode:'redirect',url}`(S3 预签名,目前非视频文件已 `disposition:'attachment'`)或 `{mode:'stream'}`;S3 `createSignedDownloadUrl({disposition,contentType,...})`。
- `src/modules/storage/{local,s3}.ts`:`putObject({contentType})`、`createSignedDownloadUrl`(S3 支持 `response-content-disposition/type`)、`deleteObject`。
- `src/modules/tasks/handlers.ts`:已有 `storage.delete_object`(payload `{driver,bucket,objectKey}`)——backfill 删旧对象复用它(**确保幂等**:对象已不存在视为成功)。
- `src/lib/env.ts`:env schema(`z.coerce.number().int().min().max().default()` 越界即拒,沿用)。

## 2. 上传规范化（`saveUploadedFile`,核心）

把「扩展名校验 + 存 file.type + 只取 metadata」改为统一规范化管线(抽成可复用函数,backfill 也用):

```
normalizeRasterUpload(inputBuffer, purpose) -> { outputBuffer, mimeType, ext, width, height }
```

步骤:
1. **扩展名预过滤**(廉价早拒):`getExtension(name)` 不在该 purpose 扩展名白名单 → `unsupportedFileType`。**仅预过滤,不参与权威判定。**
2. **输入字节 maxSize 预检**(解码前):> `PURPOSE_RULES[purpose].maxSizeMb` → `fileTooLarge`(省解码、防超大输入)。
3. **嗅探权威类型 + 解码上限**:`const meta = await sharp(input, { failOn: 'error', limitInputPixels: <单帧上限> }).metadata()`;
   - `meta.format ∈ { jpeg, png, webp, gif }` 才继续;**`'svg'` 显式拒、其它(tiff/bmp/avif/heic/…)拒** → `unsupportedFileType`(不落盘、不写库)。
   - **动画上限**:`(meta.pages ?? 1) > IMAGE_MAX_FRAMES` 或 `(meta.pages ?? 1) * meta.width * meta.height > IMAGE_MAX_TOTAL_PIXELS` → `imageInvalid`/`fileTooLarge`(**metadata 预检即拒,不进全量解码**)。
4. **转换矩阵 → 选输出格式**(权威=嗅探 format):

   | 嗅探 format | 输出(全部栅格 purpose,除非标注) |
   |---|---|
   | jpeg | jpeg |
   | png | png |
   | webp(静态) | webp |
   | webp(动图,`pages>1`) | **content_image:动图 webp;其它 purpose:静态 webp(首帧)** |
   | gif | **仅 content_image → 动图 webp;其它 purpose → 拒绝** |

5. **重编码管线**:`let pipe = sharp(input, { failOn:'error', limitInputPixels, animated: <保留动画?> }).rotate()`(`.rotate()` 无参 = 按 EXIF Orientation 物理旋转、规范方向)→ `.toFormat(outFormat, opts)`(默认剥 EXIF/元数据;动图 webp 用 `animated:true`;非 content_image 的动图输入用 `animated:false`/`pages:1` 取首帧)→ `const outputBuffer = await pipe.toBuffer()`。
6. **输出字节 maxSize 复检**:`outputBuffer.length > maxBytes` → `fileTooLarge`。
7. **输出基准元数据**:`width/height` 取**输出** `sharp(outputBuffer).metadata()`;`sizeBytes=outputBuffer.length`;`sha256=sha256(outputBuffer)`;`mimeType` = 输出格式规范类型(`image/jpeg|png|webp`);objectKey 用输出扩展名(`createObjectKey` 传规范化文件名)。
8. **落盘 + 写库**:`storage.putObject({ objectKey, body: outputBuffer, contentType: mimeType })`;`files` 写**输出**元数据;`createdBy`、cleanup_orphan(content_image)等现状保留。**绝不**再写 `file.type`。

> `payment_qr` 等管理员图片同样走此管线。`content_attachment` 仍走 `saveStreamedFile`(不变)。

## 3. Schema + 迁移

`src/db/schema/index.ts` `files` 加:
```ts
quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),   // null=正常
quarantineReason: text("quarantine_reason"),
remediationVersion: integer("remediation_version").notNull().default(0),
```
`pnpm exec drizzle-kit generate` → 提交迁移 + snapshot,核对仅本切片变更(三列,无数据改写)。

## 4. env

```text
IMAGE_MAX_FRAMES            # int,默认 300,设上下限(如 1–2000),越界拒绝(非 clamp)
IMAGE_MAX_TOTAL_PIXELS      # int,默认如 3 亿(300_000_000),设上下限,越界拒绝
```
`.env.example` 同步;测试默认/合法/越界拒绝(参照 `SUBSCRIPTION_RECONCILE_INTERVAL_MINUTES` 写法)。

## 5. 文件响应隔离（两个下载出口 + S3 预签名 + download 模块）

- **`INLINE_PURPOSES` 移除 `payment_proof`**(改 attachment)。`content_image/cover/thumbnail/payment_qr` 仍可内联;`content_attachment` 白名单内联视频例外保留(ADR 0007)。
- **app-stream 响应**(`secureStreamHeaders` 及 `download/[fileId]` 等价处)统一加:
  `Content-Security-Policy: default-src 'none'; script-src 'none'; object-src 'none'; frame-ancestors 'none'; sandbox`,保留 `X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`、正确 disposition、`Content-Type=权威 mimeType`。
- **S3 预签名直出**(`modules/download` + `storage/s3`):生成 URL 必带 `response-content-disposition`(proof 及一切非内联 = attachment)+ `response-content-type` = 权威 `mimeType`;**PUT 时**(§2/§8)对象 `Content-Type`/`Content-Disposition` 也设权威值。CSP/nosniff 在 S3-direct 不可得 = 已记录边界,安全由「重编码 + attachment + 权威类型」承担。
- **升级文档**写明:生产推荐文件域前置 CDN/反代,在该层为文件路径统一注入 CSP + nosniff(覆盖 local 与 S3)。

## 6. quarantine 访问规则（防枚举）

在两个下载出口与 `authorizeAndPrepareDownload*` 中:
- **先跑与正常下载完全相同的鉴权/可见性判定**;
- **授权通过** 且 `file.quarantinedAt != null` → **`410 Gone`**:不出字节、**不签发 S3 预签名 URL**、不进 stream;
- **授权未通过** → 返回与任意普通文件**完全相同**的 404/403(**quarantine 判定必须在授权之后**,授权前不得因 quarantine 改变响应,防 file id 枚举隔离清单)。
- 后台加一个**「隔离文件」列表**(可复用 `admin/files` 加 `quarantined` 过滤):仅显示元数据 + `quarantine_reason`,**不直出内容**;删除/导出需管理员显式操作。

## 7. backfill（强制一次性,原子可恢复）

新建 `scripts/backfill-file-safety.mjs`(+ `pnpm files:backfill-safety`),`TARGET` = 当前 remediation 版本常量:
- 选 `purpose ∈ image purpose 且 remediation_version < TARGET` 的行,分批。
- 每行加载对象字节,按 §2 嗅探:
  - **栅格(jpeg/png/webp/gif 按矩阵)**:重编码 → 写**确定性新 key** `remediated/v{TARGET}/{fileId}.{ext}`(retry 覆盖同一对象,不堆新孤儿;区别于旧 key);**同一事务**:`UPDATE files SET objectKey=新, mimeType/sizeBytes/sha256/width/height=输出, remediation_version=TARGET` + **`enqueueTask(tx, { kind:'storage.delete_object', payload:{driver,bucket,objectKey: 旧 key} })`**(ADR 0003 outbox,与切换原子提交 → 旧 key 唯一持久来源 = 该 task 行,绝不相对切换丢失);
  - **svg/html/非栅格**:`UPDATE files SET quarantined_at=now(), quarantine_reason=..., remediation_version=TARGET`(**不重编码、不删对象、不动财务/凭证**);
  - 每行写审计(file id/purpose/原 mimeType/嗅探结果/动作)。
- **幂等**:`remediation_version` 门控(已达 TARGET 跳过);中断重跑安全(确定性新 key 覆盖、删除 task 幂等)。dry-run 默认;`--apply` 才落。
- `content_attachment` 不动。
- **`storage.delete_object` handler 确保幂等**:对象已不存在 → 成功 no-op(非失败);若现状未保证,补之。
- 升级文档:部署新版本后运行;运行前后均受 §5/§6 服务端硬化保护。

## 8. 测试（全部必须,真实 PG / 真实 sharp）

**上传规范化**
- `evil.png`(实体 SVG / 声明 `image/svg+xml`)→ **拒绝**(不落盘/不写库);polyglot(合法 jpeg 尾接 HTML)→ 重编码后为纯栅格、`mimeType`=输出类型、落盘 sha≠原始(夹带字节去除)、EXIF 剥离。
- **转换矩阵**:jpeg/png/webp/(content_image)gif 各 → 对应输出格式 + `mimeType`/objectKey 扩展名=输出;矩阵外(tiff/bmp/avif/svg/html)拒;`.png` 装 jpeg → 按嗅探落 jpeg(不按扩展名纠正)。
- **动画仅 content_image**:动图 webp/gif 传 `avatar/proof/cover/thumbnail` → 静态首帧(`pages`=1);传 `content_image` → 保留动画。
- **输入+输出双限额**:输入超 maxSize → 解码前早拒(sharp 未调用);输出超 maxSize → 拒。
- **EXIF orientation**:Orientation=6 竖拍 jpeg → 输出像素已旋转(w/h 互换)、EXIF 剥离仍正向。
- **帧/解压炸弹**:超 `IMAGE_MAX_FRAMES`/`IMAGE_MAX_TOTAL_PIXELS`/`limitInputPixels` → metadata 预检即拒(未全量解码);env 越界拒绝。
- 输出基准元数据:`sizeBytes/sha256/width/height` 取输出。

**响应隔离 + quarantine**
- app-stream 文件响应带 `script-src 'none'; object-src 'none'; sandbox` CSP + nosniff;`payment_proof`=attachment;`content_image`=inline 且纯栅格类型。
- S3 预签名带 `response-content-disposition`(proof=attachment)+ `response-content-type`=权威类型。
- quarantine:**有权下载者** → `410`、不签 S3 URL、不删;**无权者** → 与普通文件相同 404/403(授权前不暴露 quarantine 状态)。

**backfill**
- 存量栅格图 → 重编码、新 key 原子切换、bump version、入队删除 task;`remediation_version<TARGET` 才处理、成功置 TARGET。
- 旧对象删除幂等(已删=成功);切换提交⇒删除 task 必在(原子);切换未提交即崩溃 → 行仍指旧 key、version 未变、确定性新对象被 retry 覆盖、重跑正常(无孤儿、无双删)。
- 存量 svg/html → quarantine 置位、对象不删;dry-run 不落、`--apply` 落;重跑幂等。

**回归**:既有上传/下载/视频 Range/内联插图/`content_attachment` 正常。

## 9. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
pnpm check:request-bodies
pnpm exec drizzle-kit generate   # 三列迁移,核对仅本切片
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

## 10. PR

base `main`,Draft 直到真实 PG + 完整 CI 全绿,关联 issue,标题 `fix(files): server-authoritative MIME, mandatory re-encode, response isolation`。描述列出:规范化入口、转换矩阵、解码上限、`INLINE_PURPOSES` 去 proof + 分层响应/CSP、quarantine post-auth 410、`files` 三列迁移、两个 env、原子可恢复 backfill、CDN 升级说明、全部测试。

## 11. 验收 checklist

- [ ] `saveUploadedFile` 走统一规范化:嗅探权威 format(拒 svg/非栅格)、转换矩阵、`.rotate()` + 重编码、输入&输出双 maxSize、输出基准元数据;绝不存 `file.type`
- [ ] 解码上限:`limitInputPixels` + `IMAGE_MAX_FRAMES` + `IMAGE_MAX_TOTAL_PIXELS`(metadata 预检即拒;env 越界拒绝)
- [ ] 动画仅 content_image;GIF→动图 webp 仅 content_image
- [ ] `files` 加 `quarantined_at`/`quarantine_reason`/`remediation_version`(迁移仅此)
- [ ] `INLINE_PURPOSES` 去 `payment_proof`;app-stream 加 CSP+nosniff;S3 预签名 disposition/content-type=权威;PUT 对象头权威
- [ ] quarantine:**授权后**才 410、不签 S3 URL、不删;无权者同普通 404/403(防枚举);后台隔离列表
- [ ] backfill:确定性新 key + 同事务切换 + 同事务入队删除 task;svg/html→quarantine 不删;version 门控幂等;dry-run 默认;删除 task 幂等
- [ ] CDN 部署说明;升级文档 backfill 步骤
- [ ] `content_attachment` 安全语义不变;视频 Range/内联插图回归绿
