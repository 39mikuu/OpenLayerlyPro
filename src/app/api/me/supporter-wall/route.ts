import { NextRequest } from "next/server";
import { z } from "zod";

import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireUser } from "@/modules/auth/session";
import { requireBlogReaderAccess } from "@/modules/blog/access";
import { getMyWallEntry, optOut, upsertOptIn } from "@/modules/supporter-wall";

export const runtime = "nodejs";

const bodySchema = z.object({
  dedication: z.union([z.string().max(200), z.null()]).optional(),
});

export async function GET() {
  try {
    const user = await requireUser();
    await requireBlogReaderAccess(user);
    return jsonOk({ entry: await getMyWallEntry(user.id) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await requireUser();
    await requireBlogReaderAccess(user);
    const body = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    return jsonOk(await upsertOptIn({ userId: user.id, dedication: body.dedication }));
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE() {
  try {
    const user = await requireUser();
    await requireBlogReaderAccess(user);
    return jsonOk(await optOut({ userId: user.id }));
  } catch (error) {
    return handleApiError(error);
  }
}
