import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/modules/auth/session";
import { requireBlogReaderAccess } from "@/modules/blog/access";
import { listPaymentMethods } from "@/modules/payment";

export const runtime = "nodejs";

export async function GET() {
  try {
    if (getEnv().PERSONAL_BLOG_MODE) {
      const reader = await getCurrentUser();
      if (!reader) return jsonError(401, "authRequired");
      await requireBlogReaderAccess(reader);
    }
    const methods = await listPaymentMethods({ activeOnly: true });
    return jsonOk(methods, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}
