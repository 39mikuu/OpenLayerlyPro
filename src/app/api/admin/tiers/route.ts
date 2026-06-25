import { NextRequest } from "next/server";
import { z } from "zod";

import { getDb } from "@/db";
import { membershipTiers } from "@/db/schema";
import { handleApiError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { listTiers } from "@/modules/membership";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return jsonOk(await listTiers());
  } catch (err) {
    return handleApiError(err);
  }
}

const bodySchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "slug 只能包含小写字母、数字和连字符"),
  description: z.string().max(2000).nullable().optional(),
  priceLabel: z.string().min(1).max(100),
  priceAmountMinor: z.number().int().positive().nullable().optional(),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toLowerCase())
    .nullable()
    .optional(),
  level: z.number().int().min(1),
  durationDays: z.number().int().min(1).default(31),
  purchaseEnabled: z.boolean().default(true),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});

export async function POST(req: NextRequest) {
  try {
    const input = await readJsonWithLimit(req, getEnv().REQUEST_JSON_MAX_BYTES, bodySchema);
    await requireAdmin();
    const [tier] = await getDb().insert(membershipTiers).values(input).returning();
    return jsonOk(tier);
  } catch (err) {
    return handleApiError(err);
  }
}
