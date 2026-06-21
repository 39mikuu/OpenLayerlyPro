# Inline video playback

OpenLayerlyPro can play selected `content_attachment` video files directly in the built-in post theme while keeping the normal download action available.

## Supported MIME types

The inline player is offered only for these stored MIME types:

- `video/mp4`
- `video/webm`
- `video/quicktime`
- `video/x-m4v`

The check uses the normalized base MIME type, so letter case and parameters such as `; codecs=...` do not expand the allowlist. An inline candidate is only a best-effort browser playback hint; actual container and codec support still depends on the visitor's browser. Download remains available when playback fails.

## Delivery matrix

| Granted content path | Storage | Inline playback delivery |
| --- | --- | --- |
| public | local | application proxy with 200/206 |
| public | S3-compatible | bounded long-lived inline signed URL |
| login | local | application proxy with per-request authorization |
| login | S3-compatible | application proxy with per-request authorization and S3 Range |
| member | local | application proxy with per-request authorization |
| member | S3-compatible | application proxy with per-request authorization and S3 Range |
| admin or draft | local/S3-compatible | application proxy |

Only an actual accessible published `public` post can grant the public S3 redirect. If the same file is attached to both public and private posts, the public granting path is preferred. Login/member videos never receive a signed playback capability, so membership revocation, expiry, tier changes, logout, and post archival take effect on the next request.

Ordinary downloads remain separate from inline playback. Public S3 video downloads and non-video S3 attachments continue to use the short-lived attachment signed URL path. Private S3 video downloads remain proxied.

## HTTP Range behavior

The application supports one `bytes=` range per request:

- `bytes=0-1023`
- `bytes=100-`
- `bytes=-500`

Valid ranges return `206` with `Content-Range`, the exact interval length, and `Accept-Ranges: bytes`. Valid but impossible ranges return `416` only after authorization. Unsupported or malformed ranges, including multipart ranges, are ignored and return the complete `200` response.

The request order is fixed:

```text
pre-auth IP limit
→ file lookup
→ authorization
→ playback/download limit
→ Range parsing
→ 200 / 206 / 416 / redirect
```

This prevents unauthorized clients from using `416`, `Content-Range`, or `Content-Length` to discover a private file's size.

## Environment settings

```text
PUBLIC_VIDEO_SIGNED_URL_TTL_SECONDS=21600
FILE_PREAUTH_RATE_LIMIT_MAX=1200
FILE_PREAUTH_RATE_LIMIT_WINDOW_MS=600000
VIDEO_RANGE_RATE_LIMIT_MAX=600
VIDEO_RANGE_RATE_LIMIT_WINDOW_MS=600000
```

The application validates all values as bounded positive integers. The pre-auth bucket is shared by all file IDs for an IP. After authorization, video metadata, seek, and resume requests use a separate user-or-IP plus file bucket. Ordinary non-video downloads retain the existing 120 requests per 10 minutes bucket.

## Reverse proxy and storage notes

- Preserve the `Range` request header and the application's `206`, `416`, `Content-Range`, `Content-Length`, and `Accept-Ranges` response headers.
- Do not rewrite private file responses into public cacheable responses. The route sends `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.
- Local Range reads remain inside the configured upload root.
- Private S3 video bytes are streamed directly through the application; no temporary local video is created.
- Public S3 signed playback URLs set inline disposition and the MIME saved in the file record.

## Logging semantics

A request without Range, or a Range beginning at byte zero, records the existing download/event heuristic. Seek and resume requests beginning after byte zero do not record another event. Browsers can repeat a byte-zero request, so these events are not an exact play counter.

## Current limitations

This feature does not perform transcoding, codec detection, duration probing, thumbnail extraction, HLS/DASH packaging, multipart Range, or playback progress tracking. MOV and M4V playback is best effort.
