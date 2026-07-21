import { count, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";

import { getDb } from "@/db";
import { memberships, membershipTiers, paymentRequests, posts } from "@/db/schema";
import { handleApiError, jsonError, jsonOk } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { readJsonWithLimit } from "@/lib/request-body";
import { requireAdmin } from "@/modules/auth/session";
import { updateTier } from "@/modules/membership";

export const runtime = "nodejs";

const optionalStripePriceId = z
  .string()
  .trim()
  .max(255)
  .transform((value) => value || null)
  .nullable()
  .optional();

const patchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().max(2000).nullable().optional(),
  priceLabel: z.string().min(1).max(100).optional(),
  priceAmountMinor: z.number().int().positive().nullable().optional(),
  stripePriceId: optionalStripePriceId,
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toLowerCase())
    .nullable()
    .optional(),
  level: z.number().int().min(1).optional(),
  durationDays: z.number().int().min(1).optional(),
  purchaseEnabled: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
  entitlements: z.array(z.string()).optional(),
  reason: z.string().trim().min(1).max(500),
});

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { reason, ...input } = await readJsonWithLimit(
      req,
      getEnv().REQUEST_JSON_MAX_BYTES,
      patchSchema,
    );
    const { id } = await ctx.params;
    const tier = await updateTier(id, input, {
      actor: { type: "admin", id: admin.id },
      reason,
    });
    return jsonOk(tier);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await ctx.params;
    const db = getDb();
    const [[m], [pr], [po]] = await Promise.all([
      db.select({ c: count() }).from(memberships).where(eq(memberships.tierId, id)),
      db.select({ c: count() }).from(paymentRequests).where(eq(paymentRequests.tierId, id)),
      db.select({ c: count() }).from(posts).where(eq(posts.requiredTierId, id)),
    ]);
    const refs = {
      memberships: Number(m.c),
      payments: Number(pr.c),
      posts: Number(po.c),
    };
    if (Object.values(refs).some((value) => value > 0)) {
      return jsonError(400, "tierInUse", refs);
    }
    await db.delete(membershipTiers).where(eq(membershipTiers.id, id));
    return jsonOk({ deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}
