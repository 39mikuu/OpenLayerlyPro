import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { requireAdmin } from "@/modules/auth/session";
import { getMembershipDetail, listMembershipHistory } from "@/modules/membership";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const detail = await getMembershipDetail(id);
    if (!detail) return jsonError(404, "membershipNotFound");
    const history = await listMembershipHistory(id);
    return jsonOk({ ...detail, history });
  } catch (err) {
    return handleApiError(err);
  }
}
