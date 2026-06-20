# ADR 0007：浏览器内视频播放（HTTP Range/206 + 内联播放器）

- **Status**：Accepted ✅（2026-06-20）
- **相关 issue**：v0.3 B2 视频（待建 issue）
- **依赖**：B1 流式上传、下载鉴权、存储抽象、主题契约

## Context

视频附件目前只能下载，无法在浏览器内播放和拖动。本切片只实现：

- 单段 HTTP Range；
- 200 / 206 / 416；
- 本地和 S3 的受控字节读取；
- 内联 `<video>`；
- 会员权限即时生效。

不实现 ffmpeg、转码、HLS、时长、自动封面和直传 S3。

核心矛盾：S3 签名 URL 是时限 bearer capability。302 后的 seek 和重连不再经过应用鉴权，因此不能用于要求“会员撤销后立即失效”的内容。

## Decision

### 1. 按内容可见性决定交付方式

| 内容 | 后端 | 交付方式 | 权限语义 |
|---|---|---|---|
| member / login | local | 应用代理 Range | 每次请求重新鉴权 |
| member / login | S3 | 应用代理 S3 Range | 每次请求重新鉴权 |
| public | local | 应用代理 Range | 公开内容 |
| public | S3 | 302 签名 URL | 公开内容，卸载带宽 |

只有授予访问的 published post 明确为 `public` 时，视频才能走 S3 签名 URL。member/login 视频永不签发直连 URL。

公开视频使用独立配置：

```text
PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS
```

默认建议 6 小时，并设合理上下限。普通非视频附件继续使用现有短 TTL。

### 2. Range 支持

`GetObjectInput` 增加：

```ts
start?: number;
end?: number; // 含首含尾
```

- local：`createReadStream(path, { start, end })`，路径继续经过 `resolveSafePath`；
- S3 proxy：`GetObjectCommand.Range = bytes=start-end`；
- public S3 redirect：浏览器直接向 S3 发 Range。

仅支持单段 `bytes=`。不实现 multipart/byteranges。

### 3. 鉴权先于文件大小和 Range 结果

顺序必须是：

```text
粗粒度 pre-auth IP 限流
→ getFileById
→ canAccessFile
→ 鉴权后的播放/下载限流
→ parseSingleRange(size)
→ 200 / 206 / 416
```

未授权响应不得包含：

- `Content-Range`；
- 文件大小；
- 基于文件大小推导的状态差异。

416 只允许在鉴权通过后返回。

### 4. 两级限流

#### pre-auth 防滥用桶

所有文件请求先进入同一个粗粒度 IP 桶，包括：

- 不存在的 UUID；
- 未授权文件；
- 授权文件；
- Range 与非 Range。

建议默认：

```text
file-preauth:<ip> = 1200 次 / 10 分钟
```

要求：

- key 不包含 fileId，避免形成存在性侧信道；
- 429 不返回文件大小或授权细节；
- 配置可调；
- 阈值足够高，不干扰正常视频分片。

#### 鉴权后桶

- 普通下载继续使用现有用户/IP 下载桶；
- 视频播放使用独立 `per-user-or-ip + per-file` 高阈值桶；
- 正常 metadata、seek、续传不得触发 429；
- 不完全关闭限流。

### 5. Range 解析语义

`parseSingleRange(header, size)` 返回：

```ts
null;
{ start: number; end: number };
"unsatisfiable";
```

规则：

- 无 Range → null，返回 200；
- 未知单位、多段、畸形、空白、超大整数、`last < first` → 非法，忽略并返回 200；
- `start >= size` → unsatisfiable；
- `bytes=-0` → unsatisfiable；
- `size === 0` 的有效 Range → unsatisfiable；
- end 超出文件大小时截断到 `size - 1`；
- 数字转换前限制长度，并拒绝 `> Number.MAX_SAFE_INTEGER`。

### 6. play 与 download 语义分离

```text
playHref     = /api/files/{id}/download?mode=inline
downloadHref = /download/{id}
```

`mode=inline` 只对明确视频 MIME 白名单生效：

```text
video/mp4
video/webm
video/quicktime
video/x-m4v
```

非白名单即使携带 query 仍返回 attachment。

所有响应保留：

```http
X-Content-Type-Options: nosniff
```

S3 public video 签名 URL同步设置 `ResponseContentDisposition=inline` 和正确 Content-Type。

### 7. 主题契约

`PostAttachmentView` 增加：

```ts
mimeType: string;
inlineCandidate: boolean;
playHref?: string;
```

`inlineCandidate` 只表示“尝试显示播放器”，不保证容器和 codec 可解码。

主题行为：

- `inlineCandidate` 时渲染 `<video controls preload="metadata">`；
- 始终保留下载按钮；
- 提供浏览器不支持时的回退文案；
- 不把 `preload="metadata"` 当作可靠首帧封面。

### 8. 日志语义

- `start > 0` 的续传/seek 不记下载日志；
- 无 Range 或 `start === 0` 按启发式记录；
- 浏览器重试可能产生少量重复；
- 该记录不是精确播放次数。

## Security requirements

- 未授权请求不能探测文件大小；
- member/login 视频每个 Range 请求重新鉴权；
- public S3 签名 URL只用于本来就公开的内容；
- inline 只允许视频 MIME 白名单；
- local 路径继续防穿越；
- pre-auth 与 post-auth 两层限流都必须存在。

## Alternatives

- **所有 S3 视频使用长签名 URL**：拒绝，会员撤销无法即时生效。
- **会员视频使用 5 分钟签名 URL**：拒绝，长视频 seek/reconnect 会中断。
- **完全关闭视频 Range 限流**：拒绝，会产生带宽和连接滥用面。
- **一次实现转码/HLS**：拒绝，超出切片边界。
- **新增 post_files.kind=video**：暂不需要，按 MIME 判定即可。

## Consequences

- ✅ 本地和 S3 的会员视频都具备强门禁；
- ✅ 公开视频仍可卸载到 S3；
- ✅ 无 schema 迁移、无 ffmpeg；
- ✅ 416、限流和 disposition 的安全语义明确；
- ⚠️ 私有 S3 视频带宽经过应用；
- ⚠️ MOV/M4V 仅尽力播放；
- ⚠️ 与 ADR 0006/0008 都可能修改主题展示，必须串行实施。

## 已确认决策

1. member/login 视频始终应用代理。
2. public S3 视频允许较长签名 URL。
3. pre-auth 默认 IP 桶为 1200/10 分钟，可配置。
4. post-auth 视频桶按用户或 IP + fileId 分桶。
5. inline MIME 白名单如上。
