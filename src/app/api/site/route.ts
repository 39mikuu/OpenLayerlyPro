import { handleApiError, jsonOk } from "@/lib/api";
import { getPublicSiteInfo } from "@/modules/site";

export const runtime = "nodejs";

export async function GET() {
  try {
    const info = await getPublicSiteInfo();
    return jsonOk(info);
  } catch (err) {
    return handleApiError(err);
  }
}
