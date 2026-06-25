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
import { requireUser } from "@/modules/auth/session";
import { saveUploadedFile } from "@/modules/file";

export const runtime = "nodejs";

const PRE_AUTH_UPLOAD_WINDOW_MS = 60_000;
const PRE_AUTH_UPLOAD_IP_MAX = 10;
const PRE_AUTH_UPLOAD_UNRESOLVED_MAX = 100;

export async function POST(req: NextRequest) {
  try {
    const transferLimit = multipartTransferLimitBytes(getEnv().PAYMENT_PROOF_MAX_SIZE_MB);
    assertContentLengthWithinLimit(req, transferLimit);

    const ip = getClientIp(req);
    const preAuthKey = ip ? `proof-upload-preauth-ip:${ip}` : "proof-upload-preauth-unresolved";
    const preAuthMax = ip ? PRE_AUTH_UPLOAD_IP_MAX : PRE_AUTH_UPLOAD_UNRESOLVED_MAX;
    if (!rateLimit(preAuthKey, preAuthMax, PRE_AUTH_UPLOAD_WINDOW_MS)) {
      return jsonError(429, "uploadRateLimited");
    }

    const user = await requireUser();
    if (!rateLimit(`proof-upload:${user.id}`, 10, 60 * 60 * 1000)) {
      return jsonError(429, "uploadRateLimited");
    }
    if (!rateLimit(`proof-upload-ip:${ip ?? "unresolved"}`, 30, 60 * 60 * 1000)) {
      return jsonError(429, "uploadRateLimited");
    }

    // Bounded read intentionally runs after auth so unauthenticated requests cannot trigger large buffering;
    // absent or understated Content-Length paths are covered by the lightweight pre-auth IP bucket above.
    const rawBody = await readBoundedRawBody(req, transferLimit);
    const form = await parseFormDataBody(req, rawBody);
    const file = form.get("file");
    const uploadedFiles = [...form.values()].filter((value) => value instanceof File);
    if (!(file instanceof File) || uploadedFiles.length !== 1) {
      return jsonError(400, "fileRequired");
    }
    const record = await saveUploadedFile({
      file,
      purpose: "payment_proof",
      createdBy: user.id,
    });
    return jsonOk({ id: record.id, originalName: record.originalName });
  } catch (err) {
    return handleApiError(err);
  }
}
