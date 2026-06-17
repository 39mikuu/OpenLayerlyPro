import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";

import { getClientIp, getUserAgent, handleApiError, jsonError } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/modules/auth/session";
import { authorizeAndPrepareDownload } from "@/modules/download";
import { getFileById } from "@/modules/file";

export const runtime = "nodejs";

// 预览类文件 inline 展示且不计入下载日志
const INLINE_PURPOSES = new Set([
  "artist_avatar",
  "payment_qr",
  "cover",
  "thumbnail",
  "payment_proof",
  "content_image",
]);

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const file = await getFileById(id);
    if (!file) return jsonError(404, "fileNotFound");

    const user = await getCurrentUser();
    const ip = getClientIp(req) ?? "unknown";
    const limitKey = user ? `download:${user.id}` : `download-ip:${ip}`;
    if (!rateLimit(limitKey, 120, 10 * 60 * 1000)) {
      return jsonError(429, "downloadRateLimited");
    }

    const isAttachment = file.purpose === "content_attachment";
    const result = await authorizeAndPrepareDownload({
      user,
      file,
      ip: getClientIp(req),
      userAgent: getUserAgent(req),
      log: isAttachment || file.purpose === "content_image",
    });

    if (result.mode === "redirect") {
      return NextResponse.redirect(result.url, 302);
    }

    const disposition = INLINE_PURPOSES.has(file.purpose) ? "inline" : "attachment";
    const encodedName = encodeURIComponent(file.originalName);
    return new NextResponse(Readable.toWeb(result.stream) as ReadableStream, {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.sizeBytes),
        "Content-Disposition": `${disposition}; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return handleApiError(err);
  }
}
