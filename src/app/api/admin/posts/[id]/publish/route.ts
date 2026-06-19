import { NextRequest } from "next/server";

import { handleApiError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { derivePostState, getPostById, publishPostNow } from "@/modules/content";

export const runtime = "nodejs";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await ctx.params;
    const post = await getPostById(id);
    if (!post) {
      return jsonOk(
        await publishPostNow(id, {
          expectedState: "draft",
          actor: { type: "admin", id: admin.id },
        }),
      );
    }
    const state = derivePostState(post);
    const actor = { type: "admin" as const, id: admin.id };
    return jsonOk(
      state === "scheduled" && post.scheduleToken
        ? await publishPostNow(id, {
            expectedState: "scheduled",
            expectedScheduleToken: post.scheduleToken,
            actor,
          })
        : await publishPostNow(id, { expectedState: "draft", actor }),
    );
  } catch (err) {
    return handleApiError(err);
  }
}
