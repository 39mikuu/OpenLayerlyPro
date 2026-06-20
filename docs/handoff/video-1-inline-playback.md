# 交接：B2 视频 #1 — 浏览器内播放(Range/206 + 内联播放器)

> 给执行 agent 的自包含实现说明。**前置依赖:当前 `main` 即可(B1 流式上传已合并)**。落地决策见 [ADR 0007](../adr/0007-inline-video-playback.md)。
>
> 开工前建 issue;Draft 直到真实 PG 集成 + CI 全绿。
>
> ⚠️ **顺序**:与编辑器 Markdown 切片**都改主题契约 + `post-detail.tsx`**,必须**串行**。本切片**无 schema 迁移**。

让 `content_attachment` 视频在公开页**内联播放且精确拖动**。会员专属是核心:**会员/登录视频在本地与 S3 都经应用代理 Range、逐请求鉴权**;只有**公开文章**视频才用 S3 签名 URL 卸载带宽。不含 ffmpeg/时长/封面/转码/直传 S3(B2 #2)。

## 0. 红线(务必遵守)

1. **鉴权先于任何基于文件大小的响应**:严格两阶段——先 `canAccessFile` 通过,**再** `parseSingleRange`。**绝不**在鉴权前返回 416 或任何含 `Content-Range: */size` / `Content-Length` 的响应(否则未授权者能探测受限文件的存在与精确大小)。
2. **会员/登录视频逐请求鉴权**:本地代理 Range、**S3 也应用代理 Range**(不发签名 URL);每个 range 请求都过鉴权,会员撤销/过期、文章下架即时生效。
3. **仅公开文章视频**(授予访问的 post `visibility==='public'`)才走 S3 302 签名 URL 卸载。
4. **Range 解析**:非法(`last<first`、未知单位、畸形)→ 忽略→200;合法但无法满足(`start>=size`、后缀 0)→ 416(**鉴权后**);防大整数溢出。
5. **play/download 分离**:`?mode=inline` 仅对**视频 MIME 白名单**置 `Content-Disposition: inline`,其余 `attachment`;始终 `X-Content-Type-Options: nosniff`。
6. **本地路径过 `resolveSafePath`**;**无 schema 迁移、无 ffmpeg**。

## 1. 现状(必读)

- 路由 `src/app/api/files/[id]/download/route.ts`:整文件 200(L50-58),无 Range/`Accept-Ranges`;S3 `NextResponse.redirect(url,302)`(L44-46);`log` 按 purpose(L41);`getFileById`→404(L25-26)在鉴权前(既有;file id 为 uuid 不可枚举,保持)。
- `authorizeAndPrepareDownload` `src/modules/download/index.ts`:`canAccessFile`(按 purpose,内部已取关联 published post,知 `post.visibility`)→ 写日志(`input.log`)→ S3 `{mode:"redirect",url}`(`SIGNED_URL_TTL_SECONDS=5*60`)/ 本地 `{mode:"stream",stream,file}`。
- 存储:`GetObjectInput={objectKey,bucket?}`;本地 `getObject=createReadStream(resolveSafePath)`;S3 `getObject` 用 `GetObjectCommand`(未传 Range);`createSignedDownloadUrl(SignedUrlInput{expiresInSeconds,downloadName})`。
- 公开页 `src/app/(site)/posts/[slug]/page.tsx` L39-55:attachments=`listPostFiles` 过滤 `kind="attachment"` →`{downloadHref:`/download/${id}`,name,sizeBytes}`。
- 主题 `PostAttachmentView={downloadHref,name,sizeBytes}`;`post-detail.tsx` L117-145 渲染下载按钮。
- 视频 MIME 映射已在 `src/modules/file/index.ts`(`mp4→video/mp4`,`webm→video/webm`,`mov→video/quicktime`,`m4v→video/x-m4v`)。

## 2. 锁定决策(见 ADR 0007)

| # | 决策 |
|---|---|
| D1 | 本地 Range/206 应用代理;无 schema 迁移、无 ffmpeg。 |
| D2 | 会员/登录视频:本地 + **S3 均应用代理 Range**,逐请求鉴权;公开视频:S3 302 签名 URL(可较长 TTL)。仅视频改动,非视频附件 S3 不变。 |
| D3 | `GetObjectInput` 加 `start?/end?`;本地 `createReadStream({start,end})`;**S3 `getObject` 传 `Range`**。 |
| D4 | 鉴权先行;416 仅鉴权后;非法 Range→200;防溢出。 |
| D5 | `playHref=/api/files/{id}/download?mode=inline`(视频 MIME 白名单→inline+nosniff);`downloadHref` 不变(attachment)。 |
| D6 | `PostAttachmentView` 加 `mimeType`+`inlineCandidate`+`playHref?`;主题渲染 `<video>`+回退文案+**始终保留下载**。 |
| D7 | 视频 MIME 白名单 `INLINE_VIDEO_MIME = {video/mp4, video/webm, video/quicktime, video/x-m4v}`(mp4/webm 可靠;mov/m4v 尽力而为)。 |

## 3. 存储层:Range

`src/modules/storage/types.ts`:
```ts
export type GetObjectInput = { objectKey: string; bucket?: string | null; start?: number; end?: number };
```
本地 `local.ts`:
```ts
async getObject(input: GetObjectInput): Promise<Readable> {
  const full = resolveSafePath(input.objectKey);
  if (input.start !== undefined || input.end !== undefined) {
    return createReadStream(full, { start: input.start ?? 0, end: input.end }); // end 含,与 Node 语义一致
  }
  return createReadStream(full);
}
```
S3 `s3.ts`(**本切片需要**,会员视频代理用):
```ts
async getObject(input: GetObjectInput): Promise<Readable> {
  const Range = input.start !== undefined || input.end !== undefined
    ? `bytes=${input.start ?? 0}-${input.end ?? ""}` : undefined;
  const res = await this.client.send(new GetObjectCommand({ Bucket: input.bucket ?? this.bucket, Key: input.objectKey, Range }));
  return res.Body as Readable;
}
```
`createSignedDownloadUrl` 增加可选 `disposition?: "inline"|"attachment"` → 设到签名 URL 的 `ResponseContentDisposition`(公开视频 inline 播放用)。

## 4. 下载授权层:两阶段 + 可见性分流

把「鉴权」与「准备字节」拆开,顺序固定:

```ts
// 1) 鉴权（不碰 range/size）
authorizeFileAccess(user, file): Promise<{ visibility: PostVisibility | null; postId: string | null }>
//    内部即现有 canAccessFile；失败 throw 401/403。返回授予访问的 post 可见性（用于 §决定代理/重定向）。

// 2) 鉴权通过后再解析 range（见 §5 路由）

// 3) 准备：本地/或会员 S3 → 代理流（可带 range）；公开 S3 → 签名 URL
prepareAuthorizedDownload(input: {
  file; range?: {start:number; end:number};
  visibility: PostVisibility | null;
  inline: boolean;            // mode=inline 且 MIME 白名单
  log: boolean;
}): Promise<DownloadResult>
```

`prepareAuthorizedDownload` 规则:
- **本地** → `storage.getObject({...,start,end})` 流(带 range)。
- **S3 且 `visibility==='public'`** → `createSignedDownloadUrl({ ..., disposition: inline?"inline":"attachment" })`,返回 `{mode:"redirect",url}`(浏览器自行对 S3 range)。
- **S3 且 `visibility!=='public'`(会员/登录)** → `storage.getObject({...,start,end})`(**应用代理 S3 Range**),返回 `{mode:"stream",...}`;**不发签名 URL**。
- `DownloadResult` 的 stream 分支带回 `{start,end,size}` 供路由设 206 头。
- 日志:`input.log` 由路由按「是否续传 range」决定(见 §6)。

> 也可直接扩展现有 `authorizeAndPrepareDownload` 接收原始 `Range` 字符串,在其内部保证「鉴权→解析→准备」顺序;关键是**对外不可能在鉴权前拿到基于大小的响应**。

## 5. 路由:两阶段、206/416、disposition

`src/app/api/files/[id]/download/route.ts`:
```ts
const file = await getFileById(id);
if (!file) return jsonError(404, "fileNotFound");   // uuid 不可枚举，保持既有
// 限流……
// —— 阶段一：鉴权（先于任何 range/size 响应）——
const access = await authorizeFileAccess(user, file); // 失败 throw 401/403

// —— 阶段二：鉴权后才解析 range ——
const inline = req.nextUrl.searchParams.get("mode") === "inline"
  && INLINE_VIDEO_MIME.has(file.mimeType);
const range = parseSingleRange(req.headers.get("range"), file.sizeBytes); // null | {start,end} | "unsatisfiable"

if (range === "unsatisfiable") {
  return new NextResponse(null, { status: 416,
    headers: { "Content-Range": `bytes */${file.sizeBytes}`, "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" } });
}

const isRangeContinuation = !!range && range.start > 0;
const result = await prepareAuthorizedDownload({
  file, range: range || undefined, visibility: access.visibility,
  inline, log: (file.purpose === "content_attachment" || file.purpose === "content_image") && !isRangeContinuation,
});
if (result.mode === "redirect") return NextResponse.redirect(result.url, 302);

const disposition = inline ? "inline" : (INLINE_PURPOSES.has(file.purpose) ? "inline" : "attachment");
const common = {
  "Content-Type": file.mimeType,
  "Content-Disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
  "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
};
if (range) {
  const len = range.end - range.start + 1;
  return new NextResponse(Readable.toWeb(result.stream) as ReadableStream, { status: 206,
    headers: { ...common, "Content-Range": `bytes ${range.start}-${range.end}/${file.sizeBytes}`, "Content-Length": String(len) } });
}
return new NextResponse(Readable.toWeb(result.stream) as ReadableStream, { status: 200,
  headers: { ...common, "Content-Length": String(file.sizeBytes) } });
```

`parseSingleRange(header, size)`(严格区分**非法**与**无法满足**):
- 无 header → `null`(200)。
- 仅支持 `bytes=` 单位;其它单位 → `null`(忽略→200)。
- 单段;多段(逗号)→ `null`(不实现 multipart/byteranges)。
- `bytes=a-b`:`a`、`b` 为非负十进制;**先校验位数/上界防溢出**(如长度 >15 位或 `> Number.MAX_SAFE_INTEGER` → `null`);`b<a`(`last<first`)→**非法**→`null`(200);`a>=size` → `"unsatisfiable"`;否则 `b=min(b,size-1)` → `{a,b}`。
- `bytes=a-`(开放)→ `a>=size?"unsatisfiable":{a,size-1}`。
- `bytes=-n`(后缀):`n===0` → `"unsatisfiable"`;否则 `{max(0,size-n),size-1}`。
- `size===0` 的任意有效 range → `"unsatisfiable"`。
- 前导零/空白/缺数字/负号 → 视情况 `null`(忽略)。

> `INLINE_PURPOSES`(现有)与新的 `?mode=inline` 不冲突;视频走 `content_attachment` + `mode=inline` + MIME 白名单置 inline。**绝不**让非视频 MIME 经 `mode=inline` 变 inline(白名单拦截),保留 `nosniff`。

## 6. 下载日志(启发式,非精确计数)

- 续传/seek(`start>0`)**不写** `download_logs`/`recordEvent`。
- 初始请求(无 Range 或 `start===0`)**按启发式记录**:浏览器 metadata 探测、重试、重载可能产生**多次** `bytes=0-`,故**可能少量重复**;**不作为精确播放次数**。在 PR/文档注明此语义。

## 7. 主题:内联 `<video>`

`src/modules/theme/types.ts`(与 ADR 0007 §5 一致):
```ts
export type PostAttachmentView = {
  downloadHref: string; name: string; sizeBytes: number;
  mimeType: string;
  inlineCandidate: boolean;   // mimeType ∈ INLINE_VIDEO_MIME；仅表示“渲染播放器”，不保证可解码
  playHref?: string;          // inlineCandidate 时 = /api/files/{id}/download?mode=inline
};
```
公开页映射:
```ts
const INLINE_VIDEO_MIME = new Set(["video/mp4","video/webm","video/quicktime","video/x-m4v"]);
...
mimeType: f.file.mimeType,
inlineCandidate: INLINE_VIDEO_MIME.has(f.file.mimeType),
playHref: INLINE_VIDEO_MIME.has(f.file.mimeType) ? `/api/files/${f.file.id}/download?mode=inline` : undefined,
```
内置主题 `post-detail.tsx`:`inlineCandidate` 渲染
```tsx
<video controls preload="metadata" src={att.playHref} className="w-full rounded-xl border">
  {t("post.videoUnsupported")}
</video>
```
并**始终保留**该附件的下载按钮(mov/m4v 在部分浏览器无法解码时用户仍可下载)。非视频附件不变。不把 `preload="metadata"` 当可靠封面。

## 8. i18n

`{zh,en,ja}.ts` 补:`post.videoUnsupported`(`<video>` 回退)等。

## 9. 测试

**鉴权 / 信息泄漏(最关键)**:
- 未授权访客对**会员视频**发 `Range` 请求 → **401/403**,响应**不含** `Content-Range`/`Content-Length`/文件大小;**不产生 416**。
- 授权会员 → 206 正常。
- 会员**撤销/过期**或文章**下架**后,S3 会员视频后续 range 请求 → 立即 401/403(因应用代理逐请求鉴权,非签名 URL)。

**可见性分流**:
- 会员/登录视频 + S3 → `{mode:"stream"}`(代理,无 redirect)。
- 公开视频 + S3 → `{mode:"redirect"}` 签名 URL(含 inline disposition)。
- 本地 → 始终代理流。

**Range 解析**:
- `bytes=0-1023` → 206 + `Content-Range: bytes 0-1023/size` + `Content-Length:1024`。
- `bytes=1000-`→到 EOF;`bytes=-500`→末 500;`bytes=-0`→**416**。
- `bytes=500-400`(last<first)→**非法→200 整文件**(非 416)。
- `bytes=500-` 且 size=100 →**416**;`start>=size`→416 + `Content-Range: bytes */size`。
- 超大十进制(溢出)→ 当作 null→200,**不崩**。
- 未知单位 / 多段 / 空白 / 前导零 → 各加用例(忽略→200)。
- 无 Range → 200 + `Accept-Ranges`。

**disposition**:`?mode=inline` 且 video MIME → `inline`;`?mode=inline` 但**非视频** MIME → 仍 `attachment`(白名单拦截);始终 `nosniff`。

**日志**:`bytes=2000-3000`(start>0)不新增日志;**连续两次** `bytes=0-...` → 断言当前是否产生两条(明确启发式,允许重复)。

**主题/视图**:`inlineCandidate`/`playHref` 正确;`<video>` 渲染且保留下载;locked(`!allowed`)不渲染。

**存储**:本地 `getObject({start,end})` 与 S3 `getObject` 传 `Range` 返回正确字节区间。

## 10. 提交前验证
```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```
(无 schema 迁移。)

## 11. PR
- base `main`,draft,标题 `feat(content): inline video playback with HTTP range`。
- 描述:本地+S3 应用代理 Range/206;按可见性分流(会员代理、公开签名 URL);鉴权先行(无大小泄漏);`?mode=inline` + 视频 MIME 白名单 + nosniff;`PostAttachmentView` 加 `mimeType/inlineCandidate/playHref` + 主题 `<video>`+保留下载;日志启发式;无迁移、无 ffmpeg。主题契约变更需自定义主题适配。

## 12. 验收 checklist
- [ ] 鉴权先于任何基于大小的响应;未授权得 401/403 而非 416/大小
- [ ] 会员/登录视频本地+S3 均逐请求鉴权(撤销/过期/下架即时生效)
- [ ] 仅公开视频用 S3 签名 URL 卸载(可较长 TTL)
- [ ] 本地+S3 Range/206 正确(`Content-Range`/`Content-Length`/`Accept-Ranges`)
- [ ] 非法 Range→200、无法满足→416(鉴权后)、防溢出
- [ ] `?mode=inline` 仅视频 MIME 白名单生效 + nosniff;play/download disposition 分离
- [ ] `inlineCandidate` 渲染 `<video>` + 回退 + **始终保留下载**
- [ ] 日志:seek 不记;初始启发式(语义已注明,非精确计数)
- [ ] 无 schema 迁移、无新依赖、无 ffmpeg;路径防穿越不破坏

## 不在本切片(B2 #2 / 后续)
- ffmpeg/ffprobe:时长、自动封面/缩略图、转码、HLS/ABR。
- 创作者自定义封面 + `files` 加 `duration`/`poster_file_id`。
- 直传 S3(presigned)。自定义播放器库。
