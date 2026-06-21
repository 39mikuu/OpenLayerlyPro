import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";

import { getClientIp, getUserAgent, handleApiError, jsonError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/modules/auth/session";
import {
  authorizeFileAccess,
  prepareAuthorizedDownload,
  shouldLogInitialFileRequest,
} from "@/modules/download";
import { parseSingleRange } from "@/modules/download/range";
import { isInlineVideoMime } from "@/modules/download/video";
import { getFileById } from "@/modules/file";

export const runtime = "nodejs";

const DOWNLOAD_RATE_LIMIT_MAX = 120;
const DOWNLOAD_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

// Existing preview assets remain inline. content_attachment is inline only for
// an explicit, allowlisted video playback request.
const INLINE_PURPOSES = new Set([
  "artist_avatar",
  "payment_qr",
  "cover",
  "thumbnail",
  "payment_proof",
  "content_image",
]);

function secureStreamHeaders(input: {
  mimeType: string;
  originalName: string;
  inline: boolean;
  contentLength: number;
  contentRange?: string;
}): HeadersInit {
  return {
    "Content-Type": input.mimeType,
    "Content-Length": String(input.contentLength),
    "Content-Disposition": `${input.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(input.originalName)}`,
    "Accept-Ranges": "bytes",
    ...(input.contentRange ? { "Content-Range": input.contentRange } : {}),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const ip = getClientIp(req) ?? "unknown";
    const env = getEnv();

    // This bucket intentionally precedes parameter parsing, file lookup, auth,
    // and Range handling so all file IDs share one indistinguishable IP budget.
    if (
      !rateLimit(
        `file-preauth:${ip}`,
        env.FILE_PREAUTH_RATE_LIMIT_MAX,
        env.FILE_PREAUTH_RATE_LIMIT_WINDOW_MS,
      )
    ) {
      return jsonError(429, "downloadRateLimited");
    }

    const { id } = await ctx.params;
    const file = await getFileById(id);
    if (!file) return jsonError(404, "fileNotFound");

    const user = await getCurrentUser();
    const access = await authorizeFileAccess(user, file);

    const rangeHeader = req.headers.get("range");
    const inlineRequested = req.nextUrl.searchParams.get("mode") === "inline";
    const video = file.purpose === "content_attachment" && isInlineVideoMime(file.mimeType);
    const inline = video && inlineRequested;
    const videoRequest = video && (inlineRequested || rangeHeader !== null);

    if (videoRequest) {
      const principal = user?.id ?? ip;
      if (
        !rateLimit(
          `video:${principal}:${file.id}`,
          env.VIDEO_RANGE_RATE_LIMIT_MAX,
          env.VIDEO_RANGE_RATE_LIMIT_WINDOW_MS,
        )
      ) {
        return jsonError(429, "downloadRateLimited");
      }
    } else {
      const key = user ? `download:${user.id}` : `download-ip:${ip}`;
      if (!rateLimit(key, DOWNLOAD_RATE_LIMIT_MAX, DOWNLOAD_RATE_LIMIT_WINDOW_MS)) {
        return jsonError(429, "downloadRateLimited");
      }
    }

    // Only authorized requests may receive a size-derived 416 or Range header.
    const parsedRange = parseSingleRange(rangeHeader, file.sizeBytes);
    if (parsedRange === "unsatisfiable") {
      return new NextResponse(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${file.sizeBytes}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const result = await prepareAuthorizedDownload({
      user,
      file,
      access,
      range: parsedRange ?? undefined,
      inline,
      log: shouldLogInitialFileRequest(file, parsedRange),
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
    });

    if (result.mode === "redirect") {
      const response = NextResponse.redirect(result.url, 302);
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    }

    const dispositionInline = inline || (!inlineRequested && INLINE_PURPOSES.has(file.purpose));
    if (parsedRange) {
      return new NextResponse(Readable.toWeb(result.stream) as ReadableStream, {
        status: 206,
        headers: secureStreamHeaders({
          mimeType: file.mimeType,
          originalName: file.originalName,
          inline: dispositionInline,
          contentLength: parsedRange.end - parsedRange.start + 1,
          contentRange: `bytes ${parsedRange.start}-${parsedRange.end}/${file.sizeBytes}`,
        }),
      });
    }

    return new NextResponse(Readable.toWeb(result.stream) as ReadableStream, {
      headers: secureStreamHeaders({
        mimeType: file.mimeType,
        originalName: file.originalName,
        inline: dispositionInline,
        contentLength: file.sizeBytes,
      }),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
