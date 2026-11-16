import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/modules/auth/session";
import { requireBlogReaderAccess } from "@/modules/blog/access";
import { listTiers } from "@/modules/membership";

export const runtime = "nodejs";

export async function GET() {
  try {
    if (getEnv().PERSONAL_BLOG_MODE) {
      const reader = await getCurrentUser();
      if (!reader) return jsonError(401, "authRequired");
      await requireBlogReaderAccess(reader);
    }
    const tiers = await listTiers({ activeOnly: true });
    return jsonOk(tiers, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return handleApiError(err);
  }
}
