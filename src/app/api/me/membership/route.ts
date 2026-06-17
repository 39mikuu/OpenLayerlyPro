import { handleApiError, jsonOk } from "@/lib/api";
import { requireUser } from "@/modules/auth/session";
import { getActiveMembership } from "@/modules/membership";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser();
    const active = await getActiveMembership(user.id);
    if (!active) return jsonOk(null);
    return jsonOk({
      tierName: active.tier.name,
      level: active.tier.level,
      startsAt: active.membership.startsAt,
      endsAt: active.membership.endsAt,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
