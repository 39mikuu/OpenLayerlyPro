import { NextRequest } from "next/server";

import { getClientIp, handleApiError, jsonError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import {
  assertContentLengthWithinLimit,
  multipartTransferLimitBytes,
  parseFormDataBody,
  readBoundedRawBody,
} from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { type FilePurpose, saveUploadedFile } from "@/modules/file";

export const runtime = "nodejs";

const PRE_AUTH_UPLOAD_WINDOW_MS = 60_000;
const PRE_AUTH_UPLOAD_IP_MAX = 10;
const PRE_AUTH_UPLOAD_UNRESOLVED_MAX = 100;

const ADMIN_PURPOSES: FilePurpose[] = [
  "artist_avatar",
  "payment_qr",
  "content_image",
  "cover",
  "thumbnail",
];

export async function POST(req: NextRequest) {
  try {
    const transferLimit = multipartTransferLimitBytes(
      Math.max(50, getEnv().PAYMENT_PROOF_MAX_SIZE_MB),
    );
    assertContentLengthWithinLimit(req, transferLimit);

    const ip = getClientIp(req);
    const preAuthKey = ip ? `admin-upload-preauth-ip:${ip}` : "admin-upload-preauth-unresolved";
    const preAuthMax = ip ? PRE_AUTH_UPLOAD_IP_MAX : PRE_AUTH_UPLOAD_UNRESOLVED_MAX;
    if (!rateLimit(preAuthKey, preAuthMax, PRE_AUTH_UPLOAD_WINDOW_MS)) {
      return jsonError(429, "uploadRateLimited");
    }

    const admin = await requireAdmin();
    const rawBody = await readBoundedRawBody(req, transferLimit);
    const form = await parseFormDataBody(req, rawBody);
    const file = form.get("file");
    const purpose = form.get("purpose");
    if (!(file instanceof File)) return jsonError(400, "fileRequired");
    if (typeof purpose !== "string" || !ADMIN_PURPOSES.includes(purpose as FilePurpose)) {
      return jsonError(400, "unsupportedFilePurpose");
    }
    const record = await saveUploadedFile({
      file,
      purpose: purpose as FilePurpose,
      createdBy: admin.id,
    });
    return jsonOk(record);
  } catch (err) {
    return handleApiError(err);
  }
}
