import { NextRequest } from "next/server";

import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { resolveLocale } from "@/modules/i18n/server";
import { integrations } from "@/modules/integration";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    const integration = integrations.find((item) => item.id === id);
    // 单一守卫覆盖未知 id 以及任何未实现 test() 的集成（如 Turnstile、Translation、Tunnel）。
    if (!integration?.test) {
      return jsonError(400, "integrationTestUnsupported");
    }
    await integration.test({ adminEmail: admin.email, locale: await resolveLocale() });
    return jsonOk({ tested: true });
  } catch (err) {
    return handleApiError(err);
  }
}
