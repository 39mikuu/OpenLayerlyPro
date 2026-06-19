import { NextRequest } from "next/server";

import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { type FilePurpose, saveUploadedFile } from "@/modules/file";

export const runtime = "nodejs";

const ADMIN_PURPOSES: FilePurpose[] = [
  "artist_avatar",
  "payment_qr",
  "content_image",
  "cover",
  "thumbnail",
];

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const form = await req.formData();
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
