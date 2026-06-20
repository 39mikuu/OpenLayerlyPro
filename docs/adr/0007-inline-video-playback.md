# ADR 0007：浏览器内视频播放(HTTP Range/206 + 内联播放器)

- **Status**：Accepted ✅（2026-06-20）
- **相关 issue**：v0.3 B2 视频（待建 issue）
- **依赖**：B1 流式上传(已在 main:`content_attachment` 流式 + S3 有界 multipart)、下载鉴权(`src/modules/download`)、存储抽象(`src/modules/storage`)、主题契约(`src/modules/theme`)

## Context

视频(`mp4`/`webm`/`mov`/`m4v`)目前作为 `content_attachment` 上传(B1 已支持大文件流式上传),但在公开页**只渲染成下载链接**,无法在浏览器内播放/拖动。Roadmap 的 B2 列了一堆:**本地 Range/206、内联播放、封面/时长/缩略图/转码、直传 S3**——这是多个量级不同的事,塞进一刀会失控,尤其**转码**(ffmpeg、后台作业、HLS/ABR)是独立 epic。

现状关键事实(调研结论):

- **下载路由 `src/app/api/files/[id]/download/route.ts` 不读 `Range` 头、不返回 206**:本地存储恒返回整文件(`fs.createReadStream` 无 offset),无 `Accept-Ranges`。
- **S3 路径已 OK**:下载对 S3 返回 302 跳转到**签名 URL**,浏览器对签名 URL 的 Range 请求由 S3 原生支持(返回 206)。当前签名 URL TTL = 5 分钟。
- 存储抽象 `GetObjectInput` 无 `start`/`end`;本地 `createReadStream` 支持 `{start,end}` 部分读。
- `files` 表有 `sizeBytes`/`mimeType`,**无 `duration`/`poster`**;**仓库无任何 ffmpeg/ffprobe**;Dockerfile 基于 `node:22-bookworm-slim`,未装任何 apt 包。
- 下载鉴权 `canAccessFile` 按 `file.purpose` 判定(`content_attachment` → 关联 published post + `canAccessPost`);`authorizeAndPrepareDownload` **每次调用都写 `download_logs` + `recordEvent`**。
- 主题 `PostAttachmentView = { downloadHref, name, sizeBytes }`,内置主题把视频当普通下载项渲染。

最危险/最易错的点:① Range 解析的边界与**鉴权必须先于发字节**;② 内联视频播放会产生**大量 range 请求**,会把 `download_logs` 刷爆;③ S3 签名 URL **5 分钟 TTL 短于视频时长**会导致播放中途 403。

## Decision

**本切片(B2 #1)= 仅「浏览器内可播放 + 可拖动」,无 ffmpeg、无 schema 迁移。** 转码/缩略图/时长提取/直传 S3 推迟到 B2 #2(单独 ADR)。

### 1. 本地存储支持 HTTP Range/206

- `GetObjectInput` 增可选 `start?: number; end?: number`;本地 `getObject` 用 `fs.createReadStream(path, { start, end })`(路径仍过现有 `resolveSafePath`,不破坏防穿越)。
- 下载路由解析 `Range: bytes=a-b`(单段):
  - 合法 → **206**,头含 `Content-Range: bytes a-b/size`、`Content-Length:(b-a+1)`、`Accept-Ranges: bytes`,body 为该段流。
  - 无 Range → **200**,但加 `Accept-Ranges: bytes`(告知可拖动)。
  - 开放式 `bytes=a-`→到 EOF;后缀 `bytes=-n`→末 n 字节;`start>=size`→**416** + `Content-Range: bytes */size`;畸形/多段 → 退化为 **200** 整文件(不实现 multipart/byteranges)。
- **鉴权先行**:Range 分支必须在 `authorizeAndPrepareDownload`/`canAccessFile` 通过**之后**才发任何字节(member-only 视频每个 range 请求都带 cookie、同源、逐次鉴权)。

### 2. S3 视频:延长签名 URL TTL(避免播放中途过期)

- S3 仍走 302→签名 URL(浏览器对其 range,S3 原生 206),保留 S3 带宽卸载。
- **视频类下载的签名 URL TTL 调长**(可配置,默认如 6h),否则长视频播放中途签名过期 → 403。
- ⚠️ 代价:签名 URL 在 TTL 内可被转发分享(与现有「所有下载都用 5 分钟签名 URL」是同性质、更长的权衡)。见「待确认」给出可选的「app 代理 range」强门禁方案。

### 3. 内联播放器(主题层)

- `PostAttachmentView` 增 `mimeType: string` 与 `playable: boolean`(`mimeType.startsWith("video/")`);**不新增 `post_files.kind`**(按 mimeType 判定)。
- 内置主题:`playable` 项渲染 `<video controls preload="metadata" src={…}>`(`preload=metadata` 让浏览器自取首帧作封面,免 ffmpeg),**同时保留下载按钮**;非视频附件不变。
- 内联视频 `src` 直指 `/api/files/{id}/download`(range 端点),**不走** `/download/{id}` 的额外 307 跳转(避免每个 range 多一跳)。

### 4. 下载日志防刷

- 内联播放的 range 请求只在「无 Range 或 Range 从 0 开始」时记一次(视为一次 play),后续 seek 的 range 不写 `download_logs`/`recordEvent`(复用 `authorizeAndPrepareDownload` 已有的 `log` 开关,由路由按是否为续传 range 决定)。

### 5. 不做(本切片明确推迟到 B2 #2)

- **ffmpeg/ffprobe**:时长提取、自动封面/缩略图、转码、HLS/ABR。
- **创作者自定义封面**(需列 + UI)。
- **直传 S3**(presigned PUT/multipart):现有经 app 流式上传已能传大视频;直传是带宽优化,非播放必需。

## Alternatives

- **一次性做全套 B2(含转码)**:否决。转码引入 ffmpeg 系统依赖、后台作业、存储与失败重试,是独立 epic;先交付「能播能拖」的高价值小刀。
- **S3 视频也经 app 代理 range**(对 S3 发带 Range 的 GetObject,流回浏览器):强门禁(逐请求鉴权、无长效签名 URL),与本地同一套代码;但视频带宽全过 app,抵消 S3 卸载。列为「待确认」的可选强门禁模式。
- **新增 `post_files.kind='video'`**:否决(本切片);按 mimeType 判定零迁移,且视频既可内联播放又可下载。未来若需「下载专用视频」再引入。
- **slice 1 就做创作者封面 / ffprobe 时长**:否决;`<video preload=metadata>` 客户端即可显示首帧与时长,服务端无需,避免 ffmpeg 依赖与迁移。

## Consequences

- ✅ 高价值、低风险:**无 ffmpeg、无 schema 迁移、无新依赖**;主要是本地 Range/206 + 主题播放器 + view 扩字段。
- ✅ 复用 B1 上传与现有下载鉴权;member-only 视频逐 range 请求仍受门禁。
- ✅ **无迁移 → 不与编辑器切片争迁移编号**;唯一共享文件是主题契约 + `post-detail.tsx`,故**编辑器与本切片串行做**(别并行改主题层)。
- ⚠️ Range 解析必须严谨(边界、416、鉴权先行),需针对性测试。
- ⚠️ S3 长 TTL 签名 URL 的转发分享窗口变大(可配置/可选强门禁,见待确认)。
- ⚠️ 主题契约 `PostAttachmentView` 扩字段;自定义主题需消费(内置主题随切片更新)。
- ⚠️ 时长/封面/缩略图/转码/直传 S3 不在本切片;B2 #2 单独评估(届时再决定 ffmpeg 进 Dockerfile)。

## 待确认的决策

1. **S3 视频门禁 vs 卸载**:默认「延长签名 URL TTL(6h,可配)」保留 S3 带宽卸载;还是改「app 代理 range」走强逐请求门禁(牺牲 S3 卸载)?(推荐默认 TTL 方案,与现有签名 URL 模型一致。)
2. 视频内联播放是否**默认对所有 `video/*` 附件**开启,还是要一个「以播放器展示」的显式开关?(推荐:默认全部内联 + 保留下载。)
