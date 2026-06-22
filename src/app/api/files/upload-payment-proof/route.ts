import { NextRequest } from "next/server";

import { getClientIp, handleApiError, jsonError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { multipartTransferLimitBytes, readFormDataWithLimit } from "@/lib/request-body";
import { requireUser } from "@/modules/auth/session";
import { saveUploadedFile } from "@/modules/file";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const form = await readFormDataWithLimit(
      req,
      multipartTransferLimitBytes(getEnv().PAYMENT_PROOF_MAX_SIZE_MB),
    );
    const user = await requireUser();
    const ip = getClientIp(req) ?? "unknown";
    if (!rateLimit(`proof-upload:${user.id}`, 10, 60 * 60 * 1000)) {
      return jsonError(429, "uploadRateLimited");
    }
    if (!rateLimit(`proof-upload-ip:${ip}`, 30, 60 * 60 * 1000)) {
      return jsonError(429, "uploadRateLimited");
    }
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
