import { NextRequest } from "next/server";
import { Readable } from "stream";

import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import {
  getContentAttachmentUploadLimit,
  parseStreamFileName,
  saveStreamedFile,
} from "@/modules/file";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const requestedPurpose = req.headers.get("x-file-purpose");
    if (requestedPurpose && requestedPurpose !== "content_attachment") {
      return jsonError(400, "unsupportedFilePurpose");
    }
    if (!req.body) return jsonError(400, "fileRequired");

    const fileName = parseStreamFileName(req.headers.get("x-file-name"));
    const { maxMb, maxBytes } = await getContentAttachmentUploadLimit();
    const contentLength = req.headers.get("content-length");
    if (contentLength) {
      const declaredBytes = Number(contentLength);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
        return jsonError(413, "fileTooLarge", { maxMb });
      }
    }

    const body = Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]);
    const record = await saveStreamedFile({
      body,
      fileName,
      purpose: "content_attachment",
      createdBy: admin.id,
      signal: req.signal,
    });
    return jsonOk(record);
  } catch (err) {
    return handleApiError(err);
  }
}
