import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { listFiles } from "@/modules/file";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await listFiles());
  } catch (err) {
    return handleApiError(err);
  }
}
