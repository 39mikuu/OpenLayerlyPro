# 交接：B2 视频 #1 — 浏览器内播放（Range/206 + 内联播放器）

> 给执行 agent 的自包含实施说明。前置依赖：当前 `main`，B1 流式上传已合并。设计依据：[ADR 0007](../adr/0007-inline-video-playback.md)。
>
> 开工前创建独立 Issue；实施 PR 保持 Draft，直到真实 PostgreSQL 集成测试和完整 CI 全绿。
>
> 与编辑器/公开嵌入都会修改主题契约和帖子详情展示，必须串行实施。本切片无 schema 迁移、无 ffmpeg。

## 1. 目标

让 `content_attachment` 视频支持：

- 浏览器内播放；
- 精确 seek；
- 本地与 S3 Range；
- member/login 视频逐请求鉴权；
- public S3 视频签名 URL卸载；
- 独立视频限流；
- 播放和下载 disposition 分离。

## 2. 红线

1. 所有请求先经过粗粒度 pre-auth IP 限流。
2. 鉴权通过前不得解析出基于文件大小的 416 或响应头。
3. member/login 视频在 local 和 S3 都必须应用代理，每个 Range 请求重新鉴权。
4. 只有 public 视频可走 S3 redirect。
5. `mode=inline` 只允许视频 MIME 白名单，并始终 `nosniff`。
6. 视频 Range 不得使用会误杀播放的普通 120/10min 下载桶。
7. local objectKey 继续经过 `resolveSafePath`。
8. 不实现 multipart Range、转码、HLS、封面或时长探测。

## 3. 常量与配置

新增统一常量：

```ts
export const INLINE_VIDEO_MIME = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
]);
```

新增配置：

```text
PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS
FILE_PREAUTH_RATE_LIMIT_MAX
FILE_PREAUTH_RATE_LIMIT_WINDOW_MS
VIDEO_RANGE_RATE_LIMIT_MAX
VIDEO_RANGE_RATE_LIMIT_WINDOW_MS
```

建议默认：

```text
public video signed URL = 6 小时
pre-auth IP bucket      = 1200 / 10 分钟
video user/ip+file      = 600 / 10 分钟
```

配置必须设上下限，防止误设为无限或过低。

## 4. Storage API

`GetObjectInput`：

```ts
export type GetObjectInput = {
  objectKey: string;
  bucket?: string | null;
  start?: number;
  end?: number; // inclusive
};
```

local：

```ts
createReadStream(resolveSafePath(input.objectKey), {
  start: input.start,
  end: input.end,
});
```

S3 proxy：

```ts
const range =
  input.start !== undefined || input.end !== undefined
    ? `bytes=${input.start ?? 0}-${input.end ?? ""}`
    : undefined;

new GetObjectCommand({
  Bucket,
  Key,
  Range: range,
});
```

`SignedUrlInput` 增加：

```ts
disposition?: "inline" | "attachment";
contentType?: string;
```

S3 签名 URL设置 `ResponseContentDisposition` / `ResponseContentType`。不传时保持现有普通附件行为。

## 5. 下载授权拆分

将“访问判断”和“准备字节”拆开：

```ts
authorizeFileAccess(user, file): Promise<{
  visibility: "public" | "login" | "member" | null;
  postId: string | null;
}>;

prepareAuthorizedDownload(input: {
  file: FileRecord;
  visibility: "public" | "login" | "member" | null;
  range?: { start: number; end: number };
  inline: boolean;
  log: boolean;
}): Promise<DownloadResult>;
```

规则：

- local → 应用流；
- S3 + public video → 签名 URL redirect；
- S3 + login/member video → `GetObjectCommand.Range` 应用代理；
- 非视频 S3 附件继续现有短 TTL 下载流程；
- `visibility` 必须来自实际授予访问的 published post，不从 query 参数推导。

## 6. 路由固定顺序

`src/app/api/files/[id]/download/route.ts`：

```ts
// 0. 统一 pre-auth 防滥用桶；不存在、未授权、授权请求都计入同一个 IP key
if (!rateLimit(`file-preauth:${ip}`, PREAUTH_MAX, PREAUTH_WINDOW)) {
  return jsonError(429, "downloadRateLimited");
}

const file = await getFileById(id);
if (!file) return jsonError(404, "fileNotFound");

// 1. 鉴权，不解析 Range，不返回大小
const access = await authorizeFileAccess(user, file);

const rangeHeader = req.headers.get("range");
const inlineRequested = req.nextUrl.searchParams.get("mode") === "inline";
const inline = inlineRequested && INLINE_VIDEO_MIME.has(file.mimeType);
const isVideoPlayback = INLINE_VIDEO_MIME.has(file.mimeType) &&
  (inlineRequested || rangeHeader !== null);

// 2. 鉴权后的功能限流
if (isVideoPlayback) {
  const principal = user?.id ?? ip;
  if (!rateLimit(`video:${principal}:${file.id}`, VIDEO_MAX, VIDEO_WINDOW)) {
    return jsonError(429, "downloadRateLimited");
  }
} else {
  const key = user ? `download:${user.id}` : `download-ip:${ip}`;
  if (!rateLimit(key, 120, 10 * 60 * 1000)) {
    return jsonError(429, "downloadRateLimited");
  }
}

// 3. 只有鉴权后才使用 size 解析 Range
const range = parseSingleRange(rangeHeader, file.sizeBytes);
if (range === "unsatisfiable") {
  return new NextResponse(null, {
    status: 416,
    headers: {
      "Content-Range": `bytes */${file.sizeBytes}`,
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const result = await prepareAuthorizedDownload({
  file,
  visibility: access.visibility,
  range: range ?? undefined,
  inline,
  log: shouldLogInitialRequest(file, range),
});
```

pre-auth 429 必须对所有 fileId 使用相同响应形态，不包含文件存在性、大小或授权原因。

## 7. Range parser

```ts
parseSingleRange(
  header: string | null,
  size: number,
): null | { start: number; end: number } | "unsatisfiable";
```

规则：

- 无 header → null；
- 仅支持 `bytes=`；
- 多段、未知单位、畸形、前后空白、超大整数 → null；
- `bytes=a-b`：`b < a` → null；`a >= size` → unsatisfiable；end 截断；
- `bytes=a-`：从 a 到 EOF；
- `bytes=-n`：最后 n 字节；`n===0` → unsatisfiable；
- `size===0` 的有效 Range → unsatisfiable；
- 解析前检查位数和 `Number.MAX_SAFE_INTEGER`。

非法 Range 按 RFC 容错策略忽略，返回整文件 200；合法但无法满足才返回 416。

## 8. 200 / 206 响应

stream 模式公共头：

```http
Content-Type: <file.mimeType>
Content-Disposition: inline|attachment; filename*=UTF-8''...
Accept-Ranges: bytes
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
```

- `inline=true` 才返回 inline；
- 非视频即使带 `mode=inline` 仍返回 attachment；
- Range 响应返回 206、`Content-Range` 和区间 `Content-Length`；
- 无 Range 返回 200 和完整 `Content-Length`。

public S3 redirect 的签名 URL同样设置正确 MIME 和 inline disposition。

## 9. 日志

```ts
function shouldLogInitialRequest(file, range) {
  const loggable =
    file.purpose === "content_attachment" ||
    file.purpose === "content_image";

  return loggable && (!range || range.start === 0);
}
```

语义：

- seek/续传不记；
- 初始请求启发式记录；
- 两次 `bytes=0-...` 可能产生两条；
- 不作为播放次数统计。

## 10. 主题契约

```ts
export type PostAttachmentView = {
  downloadHref: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  inlineCandidate: boolean;
  playHref?: string;
};
```

映射：

```ts
inlineCandidate: INLINE_VIDEO_MIME.has(file.mimeType),
playHref: INLINE_VIDEO_MIME.has(file.mimeType)
  ? `/api/files/${file.id}/download?mode=inline`
  : undefined,
```

主题：

```tsx
{att.inlineCandidate && att.playHref && (
  <video controls preload="metadata" src={att.playHref}>
    {t("post.videoUnsupported")}
  </video>
)}
```

始终保留下载按钮。MOV/M4V 只是尽力播放，不承诺 codec 支持。

## 11. 测试

### pre-auth 与信息泄漏

- 不存在 ID、未授权 ID、授权 ID 都进入同一 pre-auth IP 桶；
- pre-auth 429 不含文件大小和授权信息；
- 未授权 Range 返回 401/403，不含 `Content-Range` / `Content-Length`；
- 未授权请求不产生 416。

### post-auth 限流

- 正常数十次 metadata/seek/续传不误报 429；
- 达到视频桶上限后返回 429；
- 普通附件继续受现有 120/10min；
- key 按 user-or-ip + fileId 隔离。

### 可见性分流

- member/login + S3 → stream，无 redirect；
- public + S3 → redirect，长 TTL、inline、正确 MIME；
- local → stream；
- 权限撤销、会员过期、文章下架后下一次私有 Range 立即失败。

### Range

覆盖：

- `bytes=0-1023`；
- open-ended；
- suffix；
- `bytes=-0`；
- `last < first`；
- start 超出 size；
- size 0；
- 多段；
- 未知单位；
- 前导/内部空白；
- 超大整数和溢出；
- 无 Range。

### disposition / storage / theme

- inline 视频；
- 非视频带 inline query 仍 attachment；
- nosniff；
- local 与 S3 区间字节正确；
- 播放器与下载按钮同时存在；
- locked 页面不显示附件。

## 12. 验证

```bash
pnpm lint
pnpm format:check
pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator
pnpm build
```

## 13. 验收清单

- [ ] pre-auth IP 桶存在且无侧信道
- [ ] 鉴权先于 Range/size 响应
- [ ] member/login local+S3 逐请求鉴权
- [ ] public S3 使用独立长 TTL
- [ ] Range 200/206/416 正确
- [ ] 视频独立 post-auth 限流不误杀播放
- [ ] inline 仅 MIME 白名单 + nosniff
- [ ] 日志明确为启发式
- [ ] 主题始终保留下载
- [ ] 无 schema 迁移、无 ffmpeg
- [ ] 完整 CI 全绿

## 不在本切片

- ffmpeg/ffprobe；
- 自动封面、时长、缩略图；
- 转码、HLS/ABR；
- 直传 S3；
- 自定义播放器库。
