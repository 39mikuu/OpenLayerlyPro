# 交接：B2 视频 #1 — 浏览器内播放(Range/206 + 内联播放器)

> 给执行 agent 的自包含实现说明。**前置依赖:当前 `main` 即可(B1 流式上传已合并)**。落地决策见 [ADR 0007](../adr/0007-inline-video-playback.md)。
>
> 开工前建 issue(如「feat(content): inline video playback with HTTP range」),PR 关联;Draft 直到真实 PG 集成 + CI 全绿。
>
> ⚠️ **顺序**:本切片与「编辑器 Markdown 切片」**都改主题契约 + `post-detail.tsx`**。务必**串行**(等编辑器切片合并后再做本切片,或反之),不要并行。本切片**无 schema 迁移**,不与编辑器争迁移编号。

让 `content_attachment` 里的视频(`mp4`/`webm`/`mov`/`m4v`)在公开页**内联播放且可拖动**:本地存储补 HTTP Range/206;S3 沿用签名 URL(原生 range)但延长 TTL;主题渲染 `<video>`。**不含** ffmpeg/时长/封面/转码/直传 S3(B2 #2)。

## 0. 红线

1. **鉴权先于发字节**:每个 range 请求都必须先过 `authorizeAndPrepareDownload`/`canAccessFile`(member-only 视频逐 range 鉴权),**不得**为 range 走任何绕过鉴权的快路径。
2. **Range 解析要严谨**:边界 clamp、`start>=size` 返回 416、畸形/多段退化为 200 整文件;绝不读越界字节。
3. **本地路径仍过 `resolveSafePath`**(防穿越),`createReadStream` 仅加 `{start,end}`。
4. **下载日志防刷**:内联播放的续传 range(start>0 的 seek)**不写** `download_logs`/`recordEvent`,只在「无 Range 或 Range 从 0 开始」记一次。
5. **S3 签名 URL TTL** 对视频要够长(默认 6h,可配),否则长视频播放中途过期 403。

## 1. 现状(必读)

- 下载路由 `src/app/api/files/[id]/download/route.ts`:整文件 200,无 Range/`Accept-Ranges`(L50-58);S3 走 `NextResponse.redirect(result.url, 302)`(L44-46);`log` 按 purpose 决定(L41)。
- `authorizeAndPrepareDownload` `src/modules/download/index.ts`:鉴权 `canAccessFile`(按 `file.purpose`)→ 写日志(受 `input.log` 控)→ S3 返回 `{mode:"redirect",url}`(签名 URL,`SIGNED_URL_TTL_SECONDS=5*60`,L11)、本地返回 `{mode:"stream",stream,file}`。
- 存储 `src/modules/storage/types.ts`:`GetObjectInput = { objectKey, bucket? }`(无 range);`createSignedDownloadUrl?(SignedUrlInput{expiresInSeconds})`。
- 本地 `src/modules/storage/local.ts` L126-128:`getObject` = `createReadStream(resolveSafePath(objectKey))`(无 offset)。
- S3 `src/modules/storage/s3.ts`:`getObject` 用 `GetObjectCommand`(未传 Range);`createSignedDownloadUrl` 生成签名 URL(浏览器对其 range,S3 原生 206)。
- 公开页 `src/app/(site)/posts/[slug]/page.tsx` L39-55:attachments 由 `listPostFiles` 过滤 `kind="attachment"` 映射成 `{downloadHref:`/download/${id}`, name, sizeBytes}`。
- 主题契约 `src/modules/theme/types.ts`:`PostAttachmentView = { downloadHref, name, sizeBytes }`;内置 `src/themes/builtin/post-detail.tsx` L117-145 把附件渲染成下载按钮。
- 视频 MIME:`src/modules/file/index.ts` 已把 `mp4/webm/mov/m4v` 映射到 `video/*`。

## 2. 锁定决策

| # | 决策 |
|---|---|
| D1 | 本切片仅「内联播放 + 拖动」;**无 ffmpeg、无 schema 迁移、无新依赖**。时长/封面/缩略图/转码/直传 S3 → B2 #2。 |
| D2 | 本地存储支持单段 Range/206;S3 沿用 302→签名 URL(原生 range),视频 TTL 延长(默认 6h,可配)。 |
| D3 | `GetObjectInput` 加可选 `start?/end?`;本地 `createReadStream(path,{start,end})`。 |
| D4 | `PostAttachmentView` 加 `mimeType` + `playable`;按 `mimeType.startsWith("video/")` 内联 `<video>`,**保留下载按钮**;不新增 `post_files.kind`。 |
| D5 | 内联视频 `src` 直指 `/api/files/{id}/download`(range 端点),不走 `/download/{id}` 的 307。 |
| D6 | 续传 range(start>0)不写下载日志;只记一次 play。 |

## 3. 存储层:Range

`src/modules/storage/types.ts`:
```ts
export type GetObjectInput = {
  objectKey: string;
  bucket?: string | null;
  start?: number; // 含
  end?: number;   // 含
};
```

`local.ts` `getObject`:
```ts
async getObject(input: GetObjectInput): Promise<Readable> {
  const full = resolveSafePath(input.objectKey);
  if (input.start !== undefined || input.end !== undefined) {
    return createReadStream(full, { start: input.start ?? 0, end: input.end }); // end 含,Node 语义一致
  }
  return createReadStream(full);
}
```

`s3.ts` `getObject`(可选,仅当选「app 代理 range」强门禁模式才需要;默认 S3 走签名 URL 不用改):若要支持,给 `GetObjectCommand` 传 `Range: bytes=${start}-${end ?? ""}`。**默认本切片 S3 不代理 range**。

## 4. 下载授权层:透传 range + 视频 TTL

`src/modules/download/index.ts` `authorizeAndPrepareDownload` 入参加可选 `range?: { start: number; end: number }`:
- 鉴权与日志逻辑不变(`log` 仍由调用方控)。
- **本地**:`storage.getObject({ ...obj, start: range.start, end: range.end })` 返回部分流;`DownloadResult` 的 stream 模式增加回传 `range`(或路由自己持有 range 信息构造 206 头)。建议 `DownloadResult` stream 分支带上 `{ start, end, size }` 便于路由设头。
- **S3**:签名 URL TTL 按文件类型:视频(`file.mimeType.startsWith("video/")`)用更长 TTL(常量/配置,默认 `6*60*60`),其余沿用 5 分钟。range 不影响签名 URL(浏览器自行对 S3 range)。

## 5. 路由:解析 Range、206/416、日志开关

`src/app/api/files/[id]/download/route.ts`:
```ts
const rangeHeader = req.headers.get("range");
const range = parseSingleRange(rangeHeader, file.sizeBytes); // null | {start,end} | "unsatisfiable"

if (range === "unsatisfiable") {
  return new NextResponse(null, {
    status: 416,
    headers: { "Content-Range": `bytes */${file.sizeBytes}`, "Accept-Ranges": "bytes" },
  });
}

const isRangeContinuation = !!range && range.start > 0;
const result = await authorizeAndPrepareDownload({
  user, file, ip, userAgent,
  log: (isAttachment || file.purpose === "content_image") && !isRangeContinuation,
  range: range || undefined,
});

if (result.mode === "redirect") return NextResponse.redirect(result.url, 302); // S3：浏览器自行 range

const common = {
  "Content-Type": file.mimeType,
  "Content-Disposition": `${disposition}; filename*=UTF-8''${encodedName}`,
  "Accept-Ranges": "bytes",
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
if (range) {
  const len = range.end - range.start + 1;
  return new NextResponse(Readable.toWeb(result.stream) as ReadableStream, {
    status: 206,
    headers: { ...common, "Content-Range": `bytes ${range.start}-${range.end}/${file.sizeBytes}`, "Content-Length": String(len) },
  });
}
return new NextResponse(Readable.toWeb(result.stream) as ReadableStream, {
  status: 200,
  headers: { ...common, "Content-Length": String(file.sizeBytes) },
});
```

`parseSingleRange(header, size)` 规则:
- 无 header → `null`(走 200)。
- `bytes=a-b`:clamp `b=min(b,size-1)`;`a>b` 或 `a>=size` → `"unsatisfiable"`。
- `bytes=a-`(开放)→ `{a, size-1}`。
- `bytes=-n`(后缀)→ `{max(0,size-n), size-1}`。
- 多段(逗号)/畸形 → `null`(退化 200,不实现 multipart/byteranges)。
- `size===0` 的 range → `"unsatisfiable"`。

> 注意 `INLINE_PURPOSES` 已含 `content_image` 等;`content_attachment` 视频此前是 `attachment` disposition。内联播放靠 `<video src>` 标签,disposition 不影响播放(浏览器 range 取流即可);保持视频 `attachment` disposition 也能播,**无需**改 disposition。

## 6. 主题:内联 `<video>`

`src/modules/theme/types.ts`:
```ts
export type PostAttachmentView = {
  downloadHref: string;
  name: string;
  sizeBytes: number;
  mimeType: string;     // 新增
  playable: boolean;    // 新增：mimeType.startsWith("video/")
  playHref?: string;    // 新增：range 端点 /api/files/{id}/download（playable 时）
};
```

公开页 `posts/[slug]/page.tsx` attachments 映射加:
```ts
mimeType: f.file.mimeType,
playable: f.file.mimeType.startsWith("video/"),
playHref: f.file.mimeType.startsWith("video/") ? `/api/files/${f.file.id}/download` : undefined,
```

内置主题 `post-detail.tsx`:`playable` 的项渲染:
```tsx
<video controls preload="metadata" src={att.playHref} className="w-full rounded-xl border">
  {t("post.videoUnsupported")}
</video>
```
并**保留**下方下载按钮(同一文件既可播也可下);非视频附件渲染不变。`preload="metadata"` 让浏览器自取首帧作封面(免 ffmpeg)。

## 7. i18n

`{zh,en,ja}.ts` 补:`post.videoUnsupported`(`<video>` 回退文案)等。

## 8. 测试

**Range / 路由(最关键)**:
- 本地:`Range: bytes=0-1023` → 206、`Content-Range: bytes 0-1023/size`、`Content-Length:1024`、body 为该段。
- 开放 `bytes=1000-` → 到 EOF;后缀 `bytes=-500` → 末 500。
- `start>=size` → 416 + `Content-Range: bytes */size`。
- 畸形/多段 → 200 整文件 + `Accept-Ranges: bytes`。
- 无 Range → 200 + `Accept-Ranges: bytes` + 完整 `Content-Length`。
- **鉴权**:member-only 视频,未授权访客的 range 请求 → 401/403(逐 range 鉴权,不绕过);授权会员 → 206。
- **日志防刷**:`bytes=2000-3000`(start>0)**不**新增 `download_logs`;`bytes=0-...` 或无 Range 记一次。
- S3:视频 mimeType → 签名 URL TTL = 长 TTL(断言);非视频 → 5 分钟。
- 存储单测:本地 `getObject({start,end})` 返回正确字节区间。

**主题/视图**:`PostAttachmentView.playable`/`playHref` 正确;视频渲染 `<video>` 且保留下载;locked(`!allowed`)不渲染。

## 9. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```
(无 schema 迁移。)

## 10. PR

- base `main`,draft,标题 `feat(content): inline video playback with HTTP range`。
- 描述:本地 Range/206 + `Accept-Ranges`;`GetObjectInput.start/end`;视频签名 URL 长 TTL;`PostAttachmentView` 加 `mimeType/playable/playHref` + 内置主题 `<video>`;下载日志防刷;无迁移、无 ffmpeg。主题契约变更需自定义主题适配。
- 关联 issue。

## 11. 验收 checklist

- [ ] 本地 Range/206:正确 `Content-Range`/`Content-Length`/`Accept-Ranges`;416 与畸形退化正确
- [ ] 鉴权先于发字节;member-only 视频逐 range 受门禁
- [ ] 续传 range 不刷下载日志;play 记一次
- [ ] S3 视频签名 URL 长 TTL(可配),其余不变
- [ ] 主题内联 `<video>` 可拖动 + 保留下载;非视频附件不变
- [ ] 无 schema 迁移、无新依赖、无 ffmpeg
- [ ] 路径防穿越不破坏

## 不在本切片(B2 #2 / 后续)

- ffmpeg/ffprobe:时长提取、自动封面/缩略图、转码、HLS/ABR(届时再决定 ffmpeg 进 Dockerfile)。
- 创作者自定义封面 UI + `files` 加 `duration`/`poster_file_id` 列。
- 直传 S3(presigned PUT/multipart)。
- 自定义播放器库(Plyr/Video.js)/播放分析。
