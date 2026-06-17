import { and, asc, desc, eq, gt, lte } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import {
  type Membership,
  memberships,
  type MembershipTier,
  membershipTiers,
  users,
} from "@/db/schema";
import { ApiError } from "@/lib/api";
import { addDays } from "@/lib/dates";
import { recordEvent } from "@/modules/system/events";

export type ActiveMembership = {
  membership: Membership;
  tier: MembershipTier;
};

export async function listTiers(opts?: { activeOnly?: boolean }): Promise<MembershipTier[]> {
  const db = getDb();
  const query = db.select().from(membershipTiers);
  const rows = opts?.activeOnly
    ? await query.where(eq(membershipTiers.isActive, true))
    : await query;
  return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.level - b.level);
}

export async function getTierById(
  id: string,
  dbc: DbClient = getDb(),
): Promise<MembershipTier | null> {
  const [tier] = await dbc
    .select()
    .from(membershipTiers)
    .where(eq(membershipTiers.id, id))
    .limit(1);
  return tier ?? null;
}

/** 用户当前有效会员中 level 最高的一条（tier 必须启用） */
export async function getActiveMembership(
  userId: string,
  dbc: DbClient = getDb(),
): Promise<ActiveMembership | null> {
  const now = new Date();
  const rows = await dbc
    .select({ membership: memberships, tier: membershipTiers })
    .from(memberships)
    .innerJoin(membershipTiers, eq(memberships.tierId, membershipTiers.id))
    .where(
      and(
        eq(memberships.userId, userId),
        lte(memberships.startsAt, now),
        gt(memberships.endsAt, now),
        eq(membershipTiers.isActive, true),
      ),
    )
    .orderBy(desc(membershipTiers.level), desc(memberships.endsAt));
  return rows[0] ?? null;
}

export async function getActiveLevel(userId: string): Promise<number> {
  const active = await getActiveMembership(userId);
  return active?.tier.level ?? 0;
}

/**
 * 开通会员。
 * 若用户已有同等级或更高等级的有效会员，新会员从现有会员到期时间顺延开始（PRD §12.6）。
 * 低等级有效会员不影响：直接从现在开始创建新的高等级会员。
 */
export async function grantMembership(
  input: {
    userId: string;
    tierId: string;
    source: "manual" | "payment_review" | "gift" | "external";
    durationDays?: number;
    note?: string | null;
    createdBy?: string | null;
  },
  dbc: DbClient = getDb(),
): Promise<{ membership: Membership; tier: MembershipTier }> {
  const tier = await getTierById(input.tierId, dbc);
  if (!tier) throw new ApiError(404, "tierNotFound");

  const duration = input.durationDays ?? tier.durationDays;
  const now = new Date();

  const current = await getActiveMembership(input.userId, dbc);
  const startsAt =
    current && current.tier.level >= tier.level && current.membership.endsAt > now
      ? current.membership.endsAt
      : now;
  const endsAt = addDays(startsAt, duration);

  const [membership] = await dbc
    .insert(memberships)
    .values({
      userId: input.userId,
      tierId: input.tierId,
      source: input.source,
      startsAt,
      endsAt,
      note: input.note ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();

  await recordEvent("membership_created", {
    userId: input.userId,
    tierId: input.tierId,
    source: input.source,
    endsAt: endsAt.toISOString(),
  });

  return { membership, tier };
}

export async function listMemberships(): Promise<
  { membership: Membership; tier: MembershipTier; userEmail: string }[]
> {
  const rows = await getDb()
    .select({ membership: memberships, tier: membershipTiers, userEmail: users.email })
    .from(memberships)
    .innerJoin(membershipTiers, eq(memberships.tierId, membershipTiers.id))
    .innerJoin(users, eq(memberships.userId, users.id))
    .orderBy(desc(memberships.createdAt));
  return rows;
}

export async function updateMembership(
  id: string,
  patch: { startsAt?: Date; endsAt?: Date; note?: string | null },
): Promise<Membership> {
  const [updated] = await getDb()
    .update(memberships)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(memberships.id, id))
    .returning();
  if (!updated) throw new ApiError(404, "membershipNotFound");
  return updated;
}

export async function deleteMembership(id: string): Promise<void> {
  await getDb().delete(memberships).where(eq(memberships.id, id));
}

export async function listTiersOrdered(): Promise<MembershipTier[]> {
  return getDb()
    .select()
    .from(membershipTiers)
    .orderBy(asc(membershipTiers.sortOrder), asc(membershipTiers.level));
}
