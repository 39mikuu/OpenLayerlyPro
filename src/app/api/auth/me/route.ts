import { handleApiError, jsonOk } from "@/lib/api";
import { getCurrentUser } from "@/modules/auth/session";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return jsonOk(null);
    return jsonOk({
      id: user.id,
      email: user.email,
      role: user.role,
      displayName: user.displayName,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
