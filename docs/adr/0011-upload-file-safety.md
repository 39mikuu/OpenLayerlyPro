# ADR 0011：上传文件安全 —— 服务端权威 MIME + 强制重编码 + 文件响应隔离

- **Status**：Proposed ▶（2026-06-25）
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
- **三者一致性**:扩展名 ↔ 嗅探类型 ↔(栅格)重编码输出类型,三者必须落在同一 purpose 白名单内且彼此相符;任一不符 → 拒绝(`unsupportedFileType`),不做「猜测纠正」。

### 2. 栅格图片 purpose 强制重编码(artist_avatar / payment_qr / payment_proof / content_image / cover / thumbnail）

- 接受的嗅探类型**仅** `{ image/jpeg, image/png, image/webp }`(`content_image` 另议 GIF,见 §3);**显式拒绝 `image/svg+xml`、`text/html`、以及任何非栅格/未知类型**。SVG 在**任何** purpose 都不接受。
- **强制经 sharp 解码→重编码**为规范输出(同族格式即可:jpeg/png/webp),从而:
  - 剥离尾部/夹带字节(polyglot)、EXIF/元数据(附带隐私收益)、任何非像素负载;
  - 输出字节 = 落盘字节,`mimeType` = **输出格式**的规范类型。
- sharp 加固:`failOn` 从严、设 `limitInputPixels`(防解压炸弹)、配合既有 byte 上限;解码失败 → `imageInvalid` 拒绝。
- **不再**把原始上传字节落盘;落盘的是重编码产物。

### 3. content_image 的 GIF 处理（已锁定：动图 WebP）

- `content_image` 继续允许 gif,但 GIF **必须重编码为动图 WebP**(`sharp(input, { animated: true }).webp()`):保动画、更小、统一走 sharp 安全管线;输出 `mimeType = image/webp`。
- 重编码失败 → `imageInvalid` 拒绝(不退回原 GIF 落盘)。其它栅格 purpose 不收 GIF。

### 4. content_attachment(不可重编码的创作产物)

- 维持扩展名白名单 + **扩展名推导的服务端 MIME**(现状),**不**采信客户端 `file.type`(现状已如此,确认保留)。
- **始终 attachment 直出**(`Content-Disposition: attachment`),**永不 inline**——唯一例外是 ADR 0007 既有的**白名单内联视频**(受控 `Content-Type`、Range 流式),该例外保留。
- 不可重编码 → 安全性由「attachment + 文件响应 CSP(§5)+ nosniff + 不采信客户端 MIME」保证。

### 5. 文件响应脚本隔离(下载路由,纵深防御）

- **所有**文件字节响应(`/api/files/[id]/download` 及 `/download/[fileId]`、以及 S3 签名直出的等价 disposition)统一附加**强限制 CSP**:
  `Content-Security-Policy: default-src 'none'; script-src 'none'; object-src 'none'; frame-ancestors 'none'; sandbox` —— 即便有坏文件漏网,也无法执行脚本/插件/被 iframe 嵌入。保留既有 `X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`。
- **`payment_proof` 改为 attachment(不再 inline,已锁定）**:管理员查看付款凭证不需要同源内联渲染;attachment 彻底消除「管理员会话内同源渲染」这一最高危面。后台 UI 以下载方式呈现(从 `INLINE_PURPOSES` 移除 `payment_proof`)。
- `content_image`(正文插图,必须 inline 给所有会员)与 `cover/thumbnail/avatar/qr` 预览**保留 inline**,但此时它们已是「重编码后的纯栅格 + 服务端权威 MIME + 上述 CSP」,渲染安全。
- S3 签名直出路径的 `disposition/contentType` 必须与上述每 purpose 策略一致(proof=attachment、权威 contentType),不得绕过。

### 6. 既有数据 remediation（已锁定：强制 backfill）

- §5 的服务端硬化对存量**立即生效**,是第一道兜底;但本 ADR 进一步**要求一次性强制 backfill**(不止兜底):
  - 对存量栅格图(image purpose)**重新嗅探真实字节并按 §2/§3 重编码**,改写 `mimeType` 为权威输出类型、落盘为重编码产物;
  - 嗅探为 **svg/html/非栅格**的存量行 → **隔离并告警**(标记 + 后台可见),**不静默删除**财务/凭证文件(对齐 ADR 0010 的「不自动改财务」原则);需管理员审阅后处置。
  - backfill 以独立脚本 + 进度/审计执行,**幂等**、可分批、dry-run 默认;不可重编码的 `content_attachment` 不动(其安全性由 attachment + CSP 保证)。
  - 升级文档写明:backfill 在部署新版本后运行;运行前后均受 §5 服务端硬化保护。

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

## 已锁定决策（owner 确认 2026-06-25）

1. **GIF(content_image)= 重编码为动图 WebP**(保动画,§3)。
2. **payment_proof = attachment 下载**(从 `INLINE_PURPOSES` 移除,§5)。
3. **存量 = 强制一次性 backfill**(重编码 + 改写 mimeType;svg/html 存量隔离告警不静默删,§6)。

## 必须覆盖的测试

- 上传 `evil.png`(实体 SVG / 声明 `image/svg+xml`)→ **拒绝**(不落盘、不写库);声明 `text/html` 的 polyglot → 拒绝或重编码后为纯栅格、`mimeType` 为输出类型,**绝不**为 svg/html。
- 每栅格 purpose:上传合法 jpeg/png/webp → 落盘为**重编码产物**、`mimeType`=输出类型;EXIF 被剥离;尾部夹带字节被去除(落盘 sha 与原始不同)。
- 三者不一致(`.png` 扩展名 + 实体 jpeg / 声明 webp)→ 按策略拒绝,不静默纠正。
- 下载响应:image/attachment 均带 `script-src 'none'; object-src 'none'; sandbox` CSP + `nosniff`;`payment_proof` 为 `attachment`;`content_image` 为 `inline` 且为纯栅格类型;S3 签名直出 disposition/contentType 与策略一致。
- 解压炸弹(超大 pixel)→ `limitInputPixels` 拒绝;损坏图片 → `imageInvalid`。
- content_attachment 仍 attachment(白名单视频内联例外保留),MIME 为扩展名推导而非客户端值。
- GIF(content_image)上传 → 落盘为动图 WebP、`mimeType=image/webp`、动画保留。
- **backfill 脚本**:存量栅格图被重嗅探/重编码、`mimeType` 改写为权威值;存量 svg/html 行被隔离告警**不删除**;脚本幂等、dry-run 默认、可分批、有审计。
- 回归:既有上传/下载/视频 Range/内联插图正常。
