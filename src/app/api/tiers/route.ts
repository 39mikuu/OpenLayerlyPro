import { handleApiError, jsonOk } from "@/lib/api";
import { listTiers } from "@/modules/membership";

export const runtime = "nodejs";

export async function GET() {
  try {
    const tiers = await listTiers({ activeOnly: true });
    return jsonOk(tiers);
  } catch (err) {
    return handleApiError(err);
  }
}
