import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";

import { getClientIp, getUserAgent, handleApiError, jsonError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/modules/auth/session";
import {
  authorizeFileAccess,
  prepareAuthorizedDownload,
  shouldInlineFileByDefault,
  shouldLogInitialFileRequest,
} from "@/modules/download";
import { parseSingleRange } from "@/modules/download/range";
import {
  getDownloadRateLimit,
  getFilePreAuthRateLimit,
  getVideoRateLimit,
  resolveClientRateLimitIdentity,
  warnUnresolvedClientRateLimitIdentity,
} from "@/modules/download/rate-limit-policy";
import { isInlineVideoMime } from "@/modules/download/video";
import { getFileById } from "@/modules/file";

export const runtime = "nodejs";

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
    "Content-Security-Policy":
      "default-src 'none'; script-src 'none'; object-src 'none'; frame-ancestors 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const clientIp = getClientIp(req);
    const identity = resolveClientRateLimitIdentity(clientIp);
    const env = getEnv();
    if (identity.kind === "unresolved" && env.NODE_ENV === "production") {
      warnUnresolvedClientRateLimitIdentity();
    }

    // This bucket intentionally precedes parameter parsing, file lookup, auth,
    // and Range handling so all file IDs share one indistinguishable budget.
    // When a trusted IP is unavailable, a separate high-threshold emergency
    // bucket is used instead of merging clients into the normal per-IP budget.
    const preAuthLimit = getFilePreAuthRateLimit(identity, env);
    if (!rateLimit(preAuthLimit.key, preAuthLimit.max, preAuthLimit.windowMs)) {
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
    const inline = video ? inlineRequested : !inlineRequested && shouldInlineFileByDefault(file);
    const videoRequest = video && (inlineRequested || rangeHeader !== null);

    if (videoRequest) {
      const videoLimit = getVideoRateLimit({
        identity,
        userId: user?.id ?? null,
        fileId: file.id,
        env,
      });
      if (!rateLimit(videoLimit.key, videoLimit.max, videoLimit.windowMs)) {
        return jsonError(429, "downloadRateLimited");
      }
    } else {
      const downloadLimit = getDownloadRateLimit({
        identity,
        userId: user?.id ?? null,
        env,
      });
      if (!rateLimit(downloadLimit.key, downloadLimit.max, downloadLimit.windowMs)) {
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
          "Content-Security-Policy":
            "default-src 'none'; script-src 'none'; object-src 'none'; frame-ancestors 'none'; sandbox",
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
      ip: clientIp,
      userAgent: getUserAgent(req),
    });

    if (result.mode === "redirect") {
      const response = NextResponse.redirect(result.url, 302);
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    }

    if (parsedRange) {
      return new NextResponse(Readable.toWeb(result.stream) as ReadableStream, {
        status: 206,
        headers: secureStreamHeaders({
          mimeType: file.mimeType,
          originalName: file.originalName,
          inline,
          contentLength: parsedRange.end - parsedRange.start + 1,
          contentRange: `bytes ${parsedRange.start}-${parsedRange.end}/${file.sizeBytes}`,
        }),
      });
    }

    return new NextResponse(Readable.toWeb(result.stream) as ReadableStream, {
      headers: secureStreamHeaders({
        mimeType: file.mimeType,
        originalName: file.originalName,
        inline,
        contentLength: file.sizeBytes,
      }),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
