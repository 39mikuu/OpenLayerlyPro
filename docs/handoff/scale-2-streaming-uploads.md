# 交接：规模化 B1 — 流式上传(消除「整文件读内存」)

> 给执行 agent 的自包含实现说明。**前置依赖:当前 main 即可**。与支付、分页**完全独立**(本任务改 file/storage + 上传路由 + 上传前端),可并行。
>
> 开工前建 issue(如「perf(file): stream large uploads instead of buffering」),PR 关联。

## 0. 现状(问题根源)

当前上传**两次把整文件读进内存**:
- 路由层 `req.formData()` —— multipart 整体缓冲进内存(`src/app/api/admin/files/upload/route.ts`、`src/app/api/files/upload-payment-proof/route.ts`)。
- `saveUploadedFile`(`src/modules/file/index.ts:99`)—— `Buffer.from(await file.arrayBuffer())` 再缓冲一次,然后算 sha256、`sharp` 量尺寸、`storage.putObject({ body: Buffer })`。
- 存储适配器 `StorageAdapter.putObject({ body: Buffer })`(`src/modules/storage/types.ts`);S3 用 `PutObjectCommand(Body=Buffer)`(需 Content-Length),local 写 Buffer。

→ 大文件 / 视频直接打爆内存。README 已把这列为已知限制。

## 1. 范围 / 非目标

**本切片(B1)**:让**大文件 / 附件**上传**流式穿过应用**到存储,不再整文件缓冲;保留并放宽大小限制(限制改为流式计数,不再受内存制约)。

**不含(留 B2 / v0.3)**:浏览器直传 S3(presigned multipart)、视频 Range 播放 / 封面 / 缩略图、媒体库 UI 改版、断点续传。本切片只是「服务端流式、去掉内存缓冲」。

## 2. 已锁定决策(动工前若有异议先提)

| # | 决策 | 理由 |
|---|---|---|
| D1 | **按 purpose 分流**:`content_attachment`(PSD/ZIP/视频等大文件)走**流式**;图片类(`content_image`/`cover`/`thumbnail`/`artist_avatar`/`payment_qr`/`payment_proof`)**保留现有缓冲路径**(本就小,且要 `sharp` 量尺寸)。 | 内存问题只在大附件/视频;图片小且需尺寸。最小改动解决真问题,不动图片处理风险面 |
| D2 | **流式端点用原始二进制 body**,不用 multipart:文件即 `req.body`(Web `ReadableStream`),文件名/purpose/类型走 header/query。`Readable.fromWeb(req.body)` 转 Node 流。 | `req.formData()` 必然缓冲;单文件上传用 raw body 最干净,避免引 multipart 解析器 |
| D3 | **S3 流式用 `@aws-sdk/lib-storage` 的 `Upload`**(自动分片、无需 Content-Length);**local 用 `fs.createWriteStream` 管道**。 | 标准流式上传;新增依赖 `@aws-sdk/lib-storage` |
| D4 | **sha256 + 字节计数在流中算**(管道经 `createHash` + 计数器);**大小超限在流中即时中止**(S3 `Upload.abort()` / local 删半成品)并抛 `fileTooLarge`。 | 不信 Content-Length;不落孤儿对象 |
| D5 | 流式分支**不量图片尺寸**(`width/height=null`);大附件无需尺寸。 | 视频/附件无尺寸概念;要视频元数据是 B2(ffprobe) |

> 结论:**无 schema 迁移**(`files` 表已有 `width/height` 可空、`sizeBytes` 等)。新增依赖 `@aws-sdk/lib-storage`。

## 3. 存储适配器 `src/modules/storage/`

`types.ts`:`StorageAdapter` 增加流式方法:

```ts
putObjectStream(input: {
  objectKey: string;
  body: Readable;          // Node 可读流
  contentType: string;
  maxBytes: number;        // 超限即中止
}): Promise<{ stored: StoredObject; sizeBytes: number; sha256: string }>;
```

- 实现里把 `body` 经 `createHash('sha256')` + 字节计数 transform 串起来,再喂存储。
- **local**(`local.ts`):`pipeline(countedHashedStream, fs.createWriteStream(tmpPath))`,完成后落定;超限/出错 `unlink`。
- **S3**(`s3.ts`):`new Upload({ client, params:{ Bucket, Key, Body: countedHashedStream, ContentType } })` → `await upload.done()`;超限时 `await upload.abort()`。
- 保留现有 `putObject(Buffer)` 给图片缓冲路径。

## 4. file 模块 `src/modules/file/index.ts`

新增流式入口(图片仍走老 `saveUploadedFile`):

```ts
saveStreamedFile(input: {
  body: Readable;
  fileName: string;
  contentType: string;
  purpose: FilePurpose;   // 本切片限 content_attachment（其它 purpose 仍走缓冲路径）
  createdBy?: string | null;
}): Promise<FileRecord>
```

- 校验:扩展名(沿用 `PURPOSE_RULES`)、`maxBytes = maxUploadSizeMb * 1MB`(`getUploadConfig()`)。
- 调 `storage.putObjectStream({ ..., maxBytes })` 拿回 `{ sizeBytes, sha256 }`;`width/height=null`。
- `sizeBytes` 以**流式实测**为准(不依赖客户端);`size===0` → `fileEmpty`。
- 入库 `files`(driver/bucket/objectKey/originalName/mimeType/sizeBytes/sha256/purpose/createdBy)+ `recordEvent("file_uploaded")`,与现有一致。

## 5. 上传路由

- `src/app/api/admin/files/upload/route.ts`:当 `purpose=content_attachment` 时走**流式分支**——读 header(如 `x-file-name`、`x-file-purpose`、`content-type`)+ `Readable.fromWeb(req.body)` → `saveStreamedFile`;其它 purpose 仍走 `req.formData()` + `saveUploadedFile`。
  - `export const runtime = "nodejs"` 已设;确认 Next 不对该路由施加 body 大小上限(App Router route handler 读 `req.body` 流不受旧 pages API 4MB 限制;如有 `next.config` 限制需放开)。
- `requireAdmin()` 鉴权不变。
- 付款截图端点(`upload-payment-proof`)是图片,**保持缓冲**,不动。

## 6. 上传前端

- 后台附件上传组件:`content_attachment` 改为**直接把 File 作为 body** `fetch(url,{ method:'POST', body:file, headers:{ 'content-type':file.type, 'x-file-name':encodeURIComponent(file.name), 'x-file-purpose':'content_attachment' } })`(浏览器会流式发送),并显示上传进度(可选,用 `XMLHttpRequest`/`fetch` 进度)。
- 图片上传 UI 不变。

## 7. 大小限制 / 配置

- `MAX_UPLOAD_SIZE_MB` 现在是**流式实测上限**(不再受内存约束),可在文档说明大附件/视频建议配 S3 + 提高该值。
- 超限:流式分支命中即中止 + 清理 + `fileTooLarge`。

## 8. 下载侧(本切片仅需保证不回退)

- 现有下载:local 走 `getObject` 流式响应、S3 走签名 URL。大文件下载**已是流式**,本切片不改。
- **视频 Range 播放**(local 路由支持 `Range`、S3 签名 URL 原生支持)留 B2,注明即可。

## 9. 测试

- 流式上传正确性:大输入(构造一个超过旧典型内存阈值的流)→ `sizeBytes`/`sha256` 与逐块计算一致、对象可被 `getObject` 取回。
- **大小超限**:流超过 `maxBytes` → 中止 + 抛 `fileTooLarge` + **无孤儿对象**(S3 abort / local 无残留文件)。
- 两驱动:local 真写盘 + S3(mock `Upload`/SDK)。
- 图片路径回归:`content_image` 仍量出 `width/height`(缓冲路径未动)。
- 路由:`content_attachment` 走流式分支、其它走 formData;`requireAdmin`。

## 10. 提交前验证

```bash
pnpm lint && pnpm format:check && pnpm exec tsc --noEmit
RUN_DB_INTEGRATION_TESTS=true pnpm test
pnpm build:migrator && pnpm build
```

## 11. PR

- base `main`,draft,标题 `perf(file): stream content attachments instead of buffering`。
- 描述:无 schema 迁移;新增 `@aws-sdk/lib-storage`;`putObjectStream`(local fs 管道 / S3 lib-storage)、`saveStreamedFile`、`content_attachment` 走 raw-body 流式路由 + 前端直传 body;sha256/字节数/大小限制流式处理;图片与付款截图路径不变。
- 关联对应 issue。

## 12. 验收 checklist

- [ ] `content_attachment` 全程**不把整文件读入内存**(raw body 流 → 存储)
- [ ] sha256 + sizeBytes 流式计算且正确
- [ ] 超限即时中止 + 清理,无孤儿对象
- [ ] local 与 S3 两驱动均流式
- [ ] 图片(尺寸)与付款截图路径回归不变
- [ ] 无 schema 迁移;`requireAdmin` 不变

## 不在本切片(后续 B2 / v0.3)

浏览器直传 S3(presigned multipart)、视频 Range 播放 / 封面 / 缩略图 / 时长、媒体库 UI、断点续传。
