import { NextRequest } from "next/server";

import { getClientIp, handleApiError, jsonError, jsonOk } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { requireUser } from "@/modules/auth/session";
import { saveUploadedFile } from "@/modules/file";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    const ip = getClientIp(req) ?? "unknown";
    if (!rateLimit(`proof-upload:${user.id}`, 10, 60 * 60 * 1000)) {
      return jsonError(429, "uploadRateLimited");
    }
    if (!rateLimit(`proof-upload-ip:${ip}`, 30, 60 * 60 * 1000)) {
      return jsonError(429, "uploadRateLimited");
    }
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonError(400, "fileRequired");
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
