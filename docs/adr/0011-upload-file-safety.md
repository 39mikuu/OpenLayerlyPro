# ADR 0011：上传文件安全 —— 服务端权威 MIME + 强制重编码 + 文件响应隔离

- **Status**：Accepted ✅（2026-06-25）
- **相关 issue**：v1.0 安全硬化 / S1a（epic #64）
- **依赖**：[ADR 0006](0006-markdown-editor.md)（正文内联插图）、[ADR 0007](0007-inline-video-playback.md)（内联视频 Range）、[ADR 0008](0008-public-video-embeds.md)（嵌入白名单）。本 ADR 收紧的是「**上传入口 + 文件响应**」的安全契约,不改既有访问控制/计费语义。

## Context

文件上传与分发当前的真实行为(已核对 `src/modules/file/index.ts` 与 `src/app/api/files/[id]/download/route.ts`):

1. **仅按扩展名校验**:`saveUploadedFile` 用 `getExtension(file.name)` 对照每 purpose 的扩展名白名单;**不校验真实字节内容**。
2. **存储 + 持久化客户端声明的 `file.type`**:`mimeType: file.type || "application/octet-stream"`,storage `contentType` 同样取 `file.type`。`file.type` **完全由客户端控制**。
3. **仅 `sharp(body).metadata()` 取宽高**,**不重编码**;且 **sharp(librsvg)能解析 SVG** —— SVG 字节不会被 metadata() 拒绝。
4. **多个 purpose 以 `inline` 同源直出**:`INLINE_PURPOSES = { payment_qr, cover, thumbnail, payment_proof, content_image }`,响应 `Content-Type = 数据库 mimeType`(即客户端 `file.type`)、`Content-Disposition: inline`、有 `X-Content-Type-Options: nosniff`、**无 `Content-Security-Policy`**。

**可利用的同源 Stored XSS 链(P1)**:

- 攻击者上传 `evil.png`(扩展名过白名单),`Content-Type: image/svg+xml`,实体是带 `<script>` 的 SVG。
- `sharp(svg).metadata()` **成功**(librsvg 解析 SVG)→ 不被拒;`mimeType` 落库为客户端的 `image/svg+xml`。
- 该文件以 **inline** 直出、`Content-Type: image/svg+xml` → 浏览器**渲染 SVG 并执行脚本** → **同源 Stored XSS**。`nosniff` 在「声明类型本身就危险」时无效。
- 同理 polyglot(合法 JPEG 尾接 HTML)+ 客户端声明 `text/html` → inline 直出为 `text/html` → 渲染执行。

**影响面与权限放大**:`payment_proof` 由**管理员**在后台查看(攻击者=任意提交付款凭证的粉丝 → 打管理员会话);`content_image` 对**所有会员**内联渲染(打任意访客/会员)。这是面向高权限会话的存储型 XSS,定为 **P1**。

`content_attachment`(psd/clip/zip/pdf/mp4 等创作产物)走另一条 `saveStreamedFile` 路径,已用**扩展名推导的服务端 MIME**(`normalizedContentType`),且默认 attachment(仅白名单内联视频例外)——风险较低,本 ADR 主要补齐**栅格图片 purpose** 与**文件响应隔离**。

## Decision

按 purpose 分层,核心是「**绝不信任客户端 MIME**」+「**栅格图片强制重编码**」+「**文件响应脚本隔离**」三道纵深。

### 1. 服务端权威 MIME(全 purpose,绝不持久化/直出客户端 `file.type`）

- 上传时**按真实字节内容嗅探**类型(magic number;栅格图由 sharp 解码结果确定),得到**权威 content type**。
- 数据库 `mimeType` 与 storage `contentType` **只允许**写入服务端确定的类型,**永不**写入 `file.name` 之外的客户端 `file.type`。
- **权威判定 = 嗅探类型**,经**显式输入→输出转换矩阵**(§2 表)决定落盘格式/MIME/扩展名;**扩展名只作上传前的廉价预过滤**(不在 purpose 扩展名白名单 → 早拒),**不参与**最终类型决策、不做「按扩展名猜测纠正」。嗅探类型 ∉ 该 purpose 的矩阵输入集 → 拒绝(`unsupportedFileType`)。

### 2. 栅格图片 purpose 强制重编码（显式转换矩阵）

涉及 purpose:`artist_avatar / payment_qr / payment_proof / content_image / cover / thumbnail`。

**输入→输出转换矩阵(权威,唯一真相源)**:

| 嗅探输入类型 | 允许的 purpose | sharp 输出 | 落盘 mimeType / 扩展名 |
|---|---|---|---|
| `image/jpeg` | 全部栅格 purpose | re-encode JPEG(strip metadata) | `image/jpeg` / `.jpg` |
| `image/png` | 全部栅格 purpose | re-encode PNG | `image/png` / `.png` |
| `image/webp`(静态) | 全部栅格 purpose | re-encode WebP | `image/webp` / `.webp` |
| `image/webp`(动图) | **仅 `content_image` 保留动画;其它 purpose 压平为静态首帧** | re-encode WebP(content_image 动图,余者静态) | `image/webp` / `.webp` |
| `image/gif` | **仅 `content_image`** | re-encode **动图 WebP** | `image/webp` / `.webp` |
| 其它(svg/html/tiff/bmp/avif/heic/未知…) | —— | —— | **拒绝 `unsupportedFileType`** |

- **动画仅 `content_image`**:`artist_avatar / payment_qr / payment_proof / cover / thumbnail` 一律输出**静态**(动图输入 → 取首帧压平),不产生动画文件。
- 落盘 `mimeType`、storage `contentType`、objectKey 扩展名**一律取矩阵输出列**(非原扩展名、非客户端 `file.type`);原始 `originalName` 仅作展示保留。
- **重编码管线**:`sharp(input).rotate()`(**先按 EXIF Orientation 物理旋转、规范方向**,避免剥元数据后图片转向)→ 重编码为矩阵输出 → **剥离 EXIF/元数据**、尾部/夹带字节(polyglot)、任何非像素负载;**落盘的是重编码产物,绝不落原始上传字节**。
- **purpose `maxSizeMb` 同时约束输入与输出**:**解码前**先对输入字节校验(超限 → 早拒,不进 sharp,省解码开销 + 防超大输入);**重编码后**再对输出字节校验(超限 → 拒绝)。两道都过才落盘。
- **DB 元数据一律基于【输出字节】**:`sizeBytes`/`sha256`/`width`/`height`/`mimeType` 全部取**重编码输出**(非原始上传)。输入另受 S2 传输上限 + 下列解码上限(pixel/frame)约束,仅为传输/解码安全,不作落盘真相。
- **解码资源上限(防解压炸弹 / 帧炸弹)**:
  - `limitInputPixels` 限单帧像素;
  - **动画输入额外限制**:`metadata().pages`(帧数)≤ `IMAGE_MAX_FRAMES`(env,默认如 300)、**总解码像素**(`pages × width × height`)≤ `IMAGE_MAX_TOTAL_PIXELS`(env);**先读 metadata 预检超限即拒**,再全量解码;
  - `failOn` 从严;配合既有 byte 上限。任一超限/解码失败 → `imageInvalid`/`fileTooLarge` 拒绝(不落盘、不写库)。

### 3. content_image 的 GIF 处理（已锁定：动图 WebP）

- `content_image` 继续允许 gif,但 GIF **必须重编码为动图 WebP**(`sharp(input, { animated: true }).webp()`):保动画、更小、统一走 sharp 安全管线;输出 `mimeType = image/webp`。
- 重编码失败 → `imageInvalid` 拒绝(不退回原 GIF 落盘)。其它栅格 purpose 不收 GIF。

### 4. content_attachment(不可重编码的创作产物)

- 维持扩展名白名单 + **扩展名推导的服务端 MIME**(现状),**不**采信客户端 `file.type`(现状已如此,确认保留)。
- **始终 attachment 直出**(`Content-Disposition: attachment`),**永不 inline**——唯一例外是 ADR 0007 既有的**白名单内联视频**(受控 `Content-Type`、Range 流式),该例外保留。
- 不可重编码 → 安全性由「attachment + 文件响应 CSP(§5)+ nosniff + 不采信客户端 MIME」保证。

### 5. 文件响应脚本隔离（按服务层锁定实现边界）

> 关键约束:文件可能由**应用直接流式**(local 驱动 / 私有视频)或由 **S3 预签名 URL 直出**(浏览器直连 S3)送达。**S3 预签名响应不经过应用,应用无法在其上设置 `Content-Security-Policy` / `X-Content-Type-Options`**;S3 预签名仅支持有限的 `response-content-type` / `response-content-disposition` 覆盖。因此安全保证**不得依赖 CSP**,CSP 只作可得即用的纵深加固。

- **首要保证(全服务层一致,不依赖响应头)**:§2 重编码后的**纯净字节** + **权威 content-type** + **disposition**。proof 与一切非内联 purpose = `attachment`;内联 purpose 的字节本身已无脚本。
- **应用直接流式响应**(`/api/files/[id]/download`、`/download/[fileId]` 的 `mode:stream`):由统一响应头函数设置
  `Content-Security-Policy: default-src 'none'; script-src 'none'; object-src 'none'; frame-ancestors 'none'; sandbox` + `X-Content-Type-Options: nosniff` + `Cache-Control: private, no-store` + 正确 disposition/权威 content-type。
- **S3 预签名直出**:应用在生成预签名 URL 时**必须**设 `response-content-disposition`(proof 及非内联=attachment)与 `response-content-type`=权威类型;并在 **PUT 时**把对象自身的 `Content-Type`/`Content-Disposition` 也设为权威值(双保险)。**CSP/nosniff 在此层不可得**——这是**显式记录的边界**,其安全由「重编码纯净字节 + 权威类型 + attachment」承担。
- **CDN / 应用前置代理(推荐部署形态)**:若文件域前置 CDN 或反代,**应在该层为文件路径统一注入** `Content-Security-Policy` + `X-Content-Type-Options: nosniff`,从而对 local 与 S3 两种 origin 都补齐 CSP。ADR 推荐生产以 CDN/代理承载文件响应头;无 CDN 时 S3-direct 按上一条的残余边界运行(已由重编码兜底)。
- **`payment_proof` = attachment(从 `INLINE_PURPOSES` 移除,已锁定)**:无论哪一层都消除「管理员会话内同源渲染」最高危面。
- `content_image`(正文插图,内联给会员)与 `cover/thumbnail/avatar/qr` 预览保留内联,字节已是重编码纯栅格 + 权威 MIME;CSP 按其所在服务层(应用流式直接得到、S3 经 CDN 得到)。

### 6. 既有数据 remediation（已锁定：强制 backfill）

- §5 的服务端硬化对存量**立即生效**,是第一道兜底;但本 ADR 进一步**要求一次性强制 backfill**(不止兜底):
  - 对存量栅格图(image purpose)**重新嗅探真实字节并按 §2/§3 重编码**,改写 `mimeType`/`sizeBytes`/`sha256`/`width`/`height` 为**输出字节**的权威值;
  - **不原地覆盖,单事务原子切换 + 同事务入队删除**:重编码产物写入**新 object key**(由 `(fileId, 目标 version)` **确定性派生**,retry 覆盖同一新对象、不堆积新侧孤儿;仍区别于旧 key);在**同一事务**内:UPDATE 该行指向新 key + 写输出元数据 + bump `remediation_version` + **入队 `storage.delete_object` task 删旧对象(ADR 0003 outbox 范式,与切换原子提交)**。崩溃/并发读不读半写对象。
  - **旧 key 的唯一持久来源 = 该删除 task 行**:旧 `{driver,bucket,objectKey}` 持久在 task payload;因与切换**原子提交**,该 task **不会相对切换丢失**(切换提交 ⇒ task 必在)。**故不存在「切换后靠 backfill 重新派生旧 key」**——切换后 `files` 行上已无旧 key、无从派生,这条歧义路径**删除**。
  - **删除可恢复幂等**:task 失败重试 / 进 `dead` 均为**持久行**,旧 key 仍在其 payload,经现有 dead-task 重试恢复;删除**幂等**——对象已不存在视为**成功 no-op**;切换事务**未提交**即崩溃 → 行仍指旧 key、`remediation_version` 未变、新侧确定性对象被下次 retry 覆盖,重跑 backfill 正常重处理(无孤儿、无双删);
  - 嗅探为 **svg/html/非栅格**的存量行 → **进入 quarantine 状态**(见下),**不静默删除**财务/凭证文件(对齐 ADR 0010「不自动改财务」原则);
  - **持久化 remediation version**:`files` 加 `remediation_version int NOT NULL DEFAULT 0`;backfill 处理 `remediation_version < TARGET` 的行、成功后(在上述同一事务内)置为 `TARGET`。由此:进度跨运行/崩溃**durable**、只重处理落后行(幂等)、未来加固可 **bump TARGET 触发全量再处理**。(旧对象删除的恢复由 §上「持久 task 行」承担,**不**靠 version 反推旧 key。)
  - backfill 以独立脚本 + 进度/审计执行,**幂等**、可分批、dry-run 默认;不可重编码的 `content_attachment` 不动(安全性由 attachment + CSP 承担);
  - 升级文档写明:backfill 在部署新版本后运行;运行前后均受 §5 服务端硬化保护。

**quarantine 的持久化状态与访问规则(锁定)**:

- **持久化状态**:`files` 加 `quarantined_at timestamptz NULL` + `quarantine_reason text NULL`(`quarantined_at IS NOT NULL` 即隔离)。状态是**行级持久**的,不靠运行时推断。
- **谁会进入**:仅 backfill 发现的「存量 svg/html/非栅格」行;**新上传永不进入 quarantine**(新上传不合规直接拒绝、根本不落盘)。
- **访问规则**:
  - **`410` 必须在通过正常授权之后才返回**(先跑与正常下载相同的鉴权/可见性判定):**有权下载该文件者** → `410 Gone`、**绝不**出字节、绝不签发 S3 预签名 URL;**无权者** → 得到与任意普通文件**完全相同**的 404/403,**不泄露该文件是否处于 quarantine**(防 file id 枚举出隔离清单);
  - 隔离文件**不参与**任何渲染/引用/内联;
  - 仅在后台**「隔离文件」专用列表**可见其元数据 + `quarantine_reason`(不直出内容);
  - **不自动删除**;清除/导出需管理员**显式操作**(如需取证下载,走显式 override + 强制 attachment + CSP,留审计)。
- backfill 对每个 quarantine 行写审计事件(file id / purpose / 原 mimeType / 嗅探结果 / reason)。

### 7. 不变的边界

- 不改访问控制(谁能下载)、计费、Range/视频内联(ADR 0007)、嵌入白名单(ADR 0008)、markdown 渲染(html:false + sanitize)语义。本 ADR 只收紧「字节进/字节出」的类型与隔离。

## Alternatives

- **沿用客户端 MIME,仅靠 `nosniff`**:否决——声明类型本身为 `image/svg+xml`/`text/html` 时 `nosniff` 不防护;且 SVG 经 sharp.metadata() 不被拒。
- **接受 SVG + 服务端 sanitize(DOMPurify 等)**:否决——SVG 清洗绕过史复杂(`<use>`、外部实体、CSS、事件属性),对一个会员站收益不抵风险;直接不收 SVG。
- **仅校验/嗅探但不重编码**:否决——polyglot(合法图片 + 夹带负载)可同时通过嗅探;唯有**重编码**能保证落盘字节即纯像素。
- **独立无 cookie 域/沙箱域直出文件**:更强,但属基础设施改动;v1.0 以「重编码 + attachment(proof)+ 文件响应 CSP」达成等效防护,沙箱域留作后续。
- **把校验/重编码做在下载时**:否决——应在**入口**就规范化落盘,避免坏字节长期驻留与每次下载重复开销。

## Consequences

- ✅ 关闭 SVG-经-sharp 与 polyglot+text/html 两条同源 Stored XSS;高权限(管理员看 proof)面经 attachment 额外消除。
- ✅ 服务端权威 MIME + 重编码使「扩展名/声明类型/真实字节」不再可分离欺骗;EXIF 被剥离(隐私收益)。
- ✅ 文件响应 CSP 为所有 purpose(含不可重编码的 attachment)提供统一兜底。
- ⚠️ **CPU/延迟**:所有栅格图上传都过一次 sharp 解码→编码(payment_proof/content_image 等);有界(受 byte/pixel 上限约束),可接受。
- ⚠️ **画质/格式变化**:重编码可能轻微改变画质;GIF→WebP 改变格式(§3 owner 确认)。
- ⚠️ **后台 proof 查看 UX 变化**:inline→attachment,后台需以下载/受控预览呈现。
- ⚠️ **存量数据**:旧 `mimeType` 仍为客户端值,靠 §5 服务端硬化兜底;如需彻底纠正需 §6 backfill。
- ⚠️ 所有 purpose 的落盘/直出都必须经统一入口与统一响应头函数——**审计每一处 `saveUploadedFile`/`saveStreamedFile` 调用与每一处文件字节响应**,确保无旁路。
- ⚠️ **schema 变更**:`files` 加 `quarantined_at` / `quarantine_reason` / `remediation_version`(迁移);新增 env `IMAGE_MAX_FRAMES` / `IMAGE_MAX_TOTAL_PIXELS`(有界正整数,越界拒绝)。
- ⚠️ **CSP 依赖部署形态**:S3-direct 无法承载 CSP/nosniff,完整 CSP 覆盖需 CDN/前置代理;无 CDN 时该面由重编码 + attachment + 权威类型兜底(已记录的残余边界)。

## 已锁定决策（owner 确认 2026-06-25）

1. **GIF(content_image)= 重编码为动图 WebP**(保动画,§3)。
2. **payment_proof = attachment 下载**(从 `INLINE_PURPOSES` 移除,§5)。
3. **存量 = 强制一次性 backfill**(重编码 + 改写 mimeType;svg/html 存量隔离告警不静默删,§6)。

## 必须覆盖的测试

- 上传 `evil.png`(实体 SVG / 声明 `image/svg+xml`)→ **拒绝**(不落盘、不写库);声明 `text/html` 的 polyglot → 拒绝或重编码后为纯栅格、`mimeType` 为矩阵输出类型,**绝不**为 svg/html。
- **转换矩阵**:每个矩阵输入(jpeg/png/webp,content_image 的 gif)→ 落盘为对应输出格式、`mimeType`/objectKey 扩展名=输出列;矩阵外输入(tiff/bmp/avif/svg/html)→ 拒绝。`.png` 扩展名 + 实体 jpeg → 权威判定按嗅探(jpeg),落盘为 jpeg 输出(不按扩展名纠正、不拒绝)。
- 每栅格 purpose:合法 jpeg/png/webp → 落盘为**重编码产物**、EXIF 被剥离、尾部夹带字节去除(落盘 sha ≠ 原始)。
- **输入+输出双重限额**:输入超 `maxSizeMb` → **解码前**早拒(不进 sharp);重编码后输出超 `maxSizeMb` → 拒绝(输入合格但输出超限样例)。
- **输出基准元数据**:`sizeBytes`/`sha256`/`width`/`height` 取**输出字节**(动图压平后 dims/size 反映输出)。
- **EXIF orientation**:带 Orientation=6 的竖拍 JPEG → 输出像素已物理旋转(`width/height` 互换体现),EXIF 被剥离仍正向显示。
- **动画仅 content_image**:动图 WebP 传 `avatar/proof/cover/thumbnail` → 输出**静态首帧**(`pages`=1);传 `content_image` → 保留动画。
- GIF(content_image)→ 动图 WebP、`mimeType=image/webp`、动画保留;其它 purpose 的 gif → 拒绝。
- **帧炸弹 / 解压炸弹**:超 `IMAGE_MAX_FRAMES` 帧的动图、或总解码像素超 `IMAGE_MAX_TOTAL_PIXELS`、或单帧超 `limitInputPixels` → **metadata 预检即拒**,不进全量解码;损坏图片 → `imageInvalid`。env 越界拒绝(非 clamp)。
- **响应分层**:应用流式响应带 `script-src 'none'; object-src 'none'; sandbox` CSP + `nosniff` + 正确 disposition;S3 预签名 URL 带 `response-content-disposition`(proof/非内联=attachment)+ `response-content-type`=权威类型(断言 CSP 不在 S3-direct 上、由重编码+attachment 兜底);`payment_proof` 任何层均 attachment;`content_image` 内联且为纯栅格类型。
- content_attachment 仍 attachment(白名单视频内联例外保留),MIME 为扩展名推导而非客户端值。
- **backfill 脚本**:存量栅格图被重嗅探/重编码、元数据按输出改写;**新 object key(确定性派生)+ DB 切换 + bump `remediation_version` + 入队删除 task 全在同一事务**(非原地覆盖);`remediation_version < TARGET` 才处理、成功置 TARGET;bump TARGET 可触发再处理。
- **旧对象删除可恢复幂等**:切换提交 ⇒ 删除 task 必在(原子),其 payload 带旧 {driver,bucket,objectKey} = 旧 key 唯一持久来源;对象已删 → 成功 no-op;task 失败/dead 经现有重试恢复;切换事务未提交即崩溃 → 行仍指旧 key、version 未变、确定性新对象被 retry 覆盖、重跑正常重处理(无孤儿、无双删)。
- **quarantine**:存量 svg/html 行 backfill 后 `quarantined_at` 置值;**有权下载者** → `410`、**不签发 S3 URL**、**不删除**;**无权者** → 与普通文件相同的 404/403(授权前不暴露 quarantine 状态,防枚举);仅后台隔离列表可见元数据。
- 回归:既有上传/下载/视频 Range/内联插图正常。
