# ADR 0007：浏览器内视频播放(HTTP Range/206 + 内联播放器)

- **Status**：Proposed ▶（2026-06-20；评审阻塞项修订中，锁定后转 Accepted）
- **相关 issue**：v0.3 B2 视频（待建 issue）
- **依赖**：B1 流式上传(已在 main)、下载鉴权(`src/modules/download`)、存储抽象(`src/modules/storage`)、主题契约(`src/modules/theme`)

## Context

视频(`mp4`/`webm`/`mov`/`m4v`)目前作为 `content_attachment` 上传(B1 已支持流式),但公开页只渲染成下载链接,无法在浏览器内播放/拖动。本切片(B2 #1)做**浏览器内播放 + 精确拖动**,**无 ffmpeg、无 schema 迁移**;转码/缩略图/时长/直传 S3 推迟到 B2 #2。

现状关键事实:

- 下载路由 `src/app/api/files/[id]/download/route.ts` 不读 `Range`、不返回 206;本地恒返回整文件(`fs.createReadStream` 无 offset);S3 走 302→签名 URL(`SIGNED_URL_TTL_SECONDS=5*60`)。
- 存储 `GetObjectInput` 无 range;本地 `createReadStream` 支持 `{start,end}`;S3 `GetObjectCommand` 支持 `Range`(当前未用)。
- 下载鉴权 `canAccessFile` 按 `file.purpose` 判定;`content_attachment` → 关联 published post + `canAccessPost`(已知 post `visibility` = public/login/member)。
- 仓库无 ffmpeg。

**核心矛盾(本 ADR 必须解决)**:既要「会员专属视频逐请求鉴权」(会员过期/撤销/文章下架后立即失效),又想用 S3 签名 URL 卸载带宽。但**签名 URL 是一段时长内的 bearer 凭证**:302 之后浏览器后续的 seek/重连直接打 S3,应用不再鉴权,且 URL 在有效期内可被转发。长视频需要长 TTL,会把这个泄漏窗口放大到不可接受。二者不可兼得,必须按内容可见性分流。

## Decision

### 1. 本地存储支持 HTTP Range/206(应用代理)

- `GetObjectInput` 加可选 `start?/end?`(含端);本地 `getObject` 用 `fs.createReadStream(path,{start,end})`(路径仍过 `resolveSafePath`)。
- 路由解析单段 `Range`,合法→206(`Content-Range`/`Content-Length`/`Accept-Ranges: bytes`);无 Range→200 + `Accept-Ranges`。

### 2. 按可见性分流的 S3 安全模型(解决核心矛盾)

| 内容 | 后端 | 交付方式 | 鉴权保证 |
|---|---|---|---|
| **会员/登录限定视频** | 本地 | 应用代理 Range | **逐请求鉴权** |
| **会员/登录限定视频** | S3 | **应用代理 S3 Range**(给 `GetObjectCommand` 传 `Range`,流回浏览器) | **逐请求鉴权**(会员撤销/过期/下架立即生效) |
| **公开文章视频** | S3 | 302→签名 URL(**显式加长 TTL**,如 6h) | 公开内容,签名 URL 卸载带宽可接受 |
| **公开文章视频** | 本地 | 应用代理 Range | — |

- 「是否公开」由关联 published post 的 `visibility` 决定:**仅当授予访问的 post `visibility==='public'`** 才走 S3 签名 URL 卸载;`login`/`member` 一律**应用代理 Range**。
- 这样「会员专属视频逐请求鉴权」对**本地与 S3 都成立**;签名 URL 只用于本就公开的视频。
- 公开视频签名 URL 须用**显式加长 TTL**(默认 5min 太短,seek/续传会撞 S3 403):另设 `PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS`(如 6h)。这是已接受的权衡——公开内容,bearer 凭证在有效期内不可撤销可接受;会员视频永不签 URL。
- 需让 S3 `getObject` 支持 `Range`(本切片新增);**无迁移、无 ffmpeg**。
- **范围限定**:本规则只针对**视频内联播放**。非视频附件(zip/psd 等)的 S3 下载沿用现有 5 分钟签名 URL 模型,不在本切片改动。

### 3. 鉴权先于任何基于文件大小的响应(防信息泄漏)

两阶段顺序,**不得在鉴权前返回 416 或任何含文件大小的响应**(否则未授权者可探测受限文件的存在与精确大小):

1. 加载文件 + `canAccessFile` 鉴权(失败 → 401/403,不泄漏大小)。
2. 鉴权通过后才 `parseSingleRange`。
3. 合法但无法满足 → 416(此时才可含 `Content-Range: */size`);不写下载日志。
4. 合法 → 打开本地/S3 代理流(或公开视频生成签名 URL)。

### 4. 播放与下载语义分离(disposition)

- `playHref` = `/api/files/{id}/download?mode=inline` → `Content-Disposition: inline`,**仅对显式视频 MIME 白名单**生效(`video/mp4`,`video/webm`,`video/quicktime`,`video/x-m4v`);非白名单一律 `attachment`。始终保留 `X-Content-Type-Options: nosniff`,杜绝任意 HTML/SVG 经 query 变成同源内联。
- `downloadHref` = `/download/{id}` → `Content-Disposition: attachment`(不变)。
- 公开视频的 S3 签名 URL 同步设置 response content-disposition = inline。

### 5. 内联候选 ≠ 一定可解码(主题契约)

- `PostAttachmentView` 统一新增三字段(ADR 与 handoff 一致):`mimeType: string`、`inlineCandidate: boolean`、`playHref?: string`。
- `inlineCandidate` = mimeType ∈ 视频 MIME 白名单(`video/mp4`/`video/webm` 为可靠基线;`video/quicktime`/`video/x-m4v` 为尽力而为,浏览器可能因容器/codec 不支持而无法解码)。**它只表示「渲染播放器」,不保证可解码**。
- 主题对 `inlineCandidate` 渲染 `<video controls preload="metadata">` + `<video>` 内回退文案,且**始终保留下载按钮**作为兜底。不把 `preload="metadata"` 宣称为可靠首帧封面(标准仅「可能」取前几帧)。

### 6. 下载日志:启发式,非精确播放计数

- 续传/seek(`start>0`)的 range **不写**日志;初始请求(无 Range 或 `start===0`)按**启发式**记录——浏览器的 metadata 探测、重试、重载可能产生多次 `bytes=0-`,故**可能少量重复**,**不作为精确播放次数**。

### 7. 限流必须区分「下载」与「Range 播放」(否则正常播放被 429)

现有下载端点对每用户/IP **120 次 / 10 分钟**(`rateLimit("download:<uid>", 120, 600000)`)。视频内联播放会把这个额度迅速打爆:浏览器的 metadata 探测、seek、重连、分块续传**每个都是一次 GET**,正常看一段长视频就可能几十上百次请求 → 误触 429、播放中断。

- 对**鉴权通过后**的视频 Range 播放,采用**独立的 per-user + per-file** 限流桶(粒度更细、阈值更高,或对 `start>0` 的续传 range 基本不限),与通用下载额度分开。
- 限流在**鉴权之后**(不可成为未授权探测信号)。
- 必须有「连续多次 range 请求不误报 429」的测试。

## Alternatives

- **所有 S3 视频都用长 TTL 签名 URL**:否决。与「会员专属逐请求鉴权」红线矛盾——会员撤销/过期/下架后,签名 URL 在 TTL 内仍可播放且可转发。仅对公开视频可接受。
- **会员视频也用短(5min)签名 URL**:否决。长视频播放超 5 分钟,seek/重连会因 URL 过期 403,播放中断。
- **一次性做全套 B2(含转码)**:否决,转码是独立 epic(ffmpeg/后台作业)。
- **新增 `post_files.kind='video'`**:否决(本切片);按 mimeType 判定零迁移。

## Consequences

- ✅ 会员专属视频在本地与 S3 **都逐请求鉴权**(撤销/过期/下架即时生效),矛盾消除。
- ✅ 公开视频仍可用 S3 签名 URL 卸载带宽。
- ✅ 无 schema 迁移、无 ffmpeg、无新依赖;S3 仅需 `getObject` 支持 Range。
- ⚠️ 会员视频经应用代理 → 视频带宽走应用(自托管运维成本);这是「强门禁」的必要代价,公开视频不受影响。
- ⚠️ Range 解析须区分「非法(忽略→200)」与「合法但无法满足(416)」,并防大整数溢出;鉴权必须先行。需针对性测试。
- ⚠️ 通用下载限流(120/10min)会误杀 Range 播放;须为鉴权后的视频 Range 设独立 per-user+per-file 桶(§7),并测连续请求不误报 429。
- ⚠️ 主题契约 `PostAttachmentView` 扩字段;自定义主题需适配(内置主题随切片更新)。
- ⚠️ 与编辑器切片**都改主题契约 + `post-detail.tsx`**,**串行**做。
- ⚠️ 时长/封面/缩略图/转码/直传 S3 在 B2 #2 评估。

## 已确认的决策（2026-06-20）

1. **范围 = 含本地 Range/206 完整版**;会员专属是核心目标,自托管两后端都支持精确拖动。
2. **S3 安全模型 = 按可见性分流**(§2):会员/登录视频应用代理 S3 Range(逐请求鉴权);公开视频 302 签名 URL 卸载带宽。**不**用「所有 S3 视频长 TTL」。
3. **鉴权先于任何基于大小的响应**(§3),416 仅在鉴权后。
4. **play/download 语义分离 + 视频 MIME 白名单 inline + nosniff**(§4)。
5. **默认对视频 MIME 白名单内联播放 + 始终保留下载**;字段 `inlineCandidate`,不保证可解码(§5)。
