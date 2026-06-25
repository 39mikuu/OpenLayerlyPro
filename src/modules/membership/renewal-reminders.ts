import { and, eq, gt, gte, max, ne, sql } from "drizzle-orm";

import { type DbClient, getDb, type TxClient } from "@/db";
import { memberships, membershipTiers, subscriptions, users } from "@/db/schema";
import { ApiError } from "@/lib/api";
import { getEnv } from "@/lib/env";
import { enqueueTask } from "@/modules/tasks";

function periodIso(periodEndsAt: Date): string {
  return periodEndsAt.toISOString();
}

export function reminderRunAfter(periodEndsAt: Date): Date {
  return new Date(
    periodEndsAt.getTime() - getEnv().SUBSCRIPTION_REMINDER_LEAD_DAYS * 24 * 60 * 60 * 1000,
  );
}

export async function enqueueRenewalReminder(
  tx: DbClient,
  subscriptionId: string,
  periodEndsAt: Date,
): Promise<void> {
  const iso = periodIso(periodEndsAt);
  await enqueueTask(tx, {
    kind: "subscription.renewal_reminder",
    dedupeKey: `subscription-reminder:${subscriptionId}:${iso}`,
    runAfter: reminderRunAfter(periodEndsAt),
    payload: { subscriptionId, periodEndsAt: iso },
  });
}

async function latestEligibleEnd(
  tx: DbClient,
  userId: string,
  targetLevel: number,
): Promise<Date | null> {
  const now = new Date();
  const [row] = await tx
    .select({ latestEndsAt: max(memberships.endsAt) })
    .from(memberships)
    .innerJoin(membershipTiers, eq(memberships.tierId, membershipTiers.id))
    .where(
      and(
        eq(memberships.userId, userId),
        ne(memberships.status, "revoked"),
        gt(memberships.endsAt, now),
        gte(membershipTiers.level, targetLevel),
      ),
    );
  return row?.latestEndsAt ?? null;
}

export async function advanceManualReminderAfterGrant(
  tx: TxClient,
  input: { userId: string; tierId: string; targetLevel: number },
): Promise<void> {
  const [subscription] = await tx
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, input.userId),
        eq(subscriptions.tierId, input.tierId),
        sql`${subscriptions.provider} is null`,
        eq(subscriptions.status, "active"),
      ),
    )
    .limit(1);
  if (!subscription) return;

  const periodEndsAt = await latestEligibleEnd(tx, input.userId, input.targetLevel);
  if (!periodEndsAt) return;

  await tx
    .update(subscriptions)
    .set({ currentPeriodEndsAt: periodEndsAt, updatedAt: sql`now()` })
    .where(eq(subscriptions.id, subscription.id));
  await enqueueRenewalReminder(tx, subscription.id, periodEndsAt);
}

export async function enableManualRenewalReminder(input: {
  userId: string;
  tierId: string;
}): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [tier] = await tx
      .select({ id: membershipTiers.id, level: membershipTiers.level })
      .from(membershipTiers)
      .where(eq(membershipTiers.id, input.tierId))
      .limit(1);
    if (!tier) throw new ApiError(404, "tierNotFound");

    const periodEndsAt = await latestEligibleEnd(tx, input.userId, tier.level);
    if (!periodEndsAt) throw new ApiError(400, "membershipNotActive");

    const [inserted] = await tx
      .insert(subscriptions)
      .values({
        userId: input.userId,
        tierId: input.tierId,
        provider: null,
        status: "active",
        currentPeriodEndsAt: periodEndsAt,
      })
      .onConflictDoNothing({
        target: [subscriptions.userId, subscriptions.tierId, subscriptions.provider],
        where: sql`${subscriptions.status} not in ('canceled', 'expired')`,
      })
      .returning();

    const subscription =
      inserted ??
      (
        await tx
          .select()
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.userId, input.userId),
              eq(subscriptions.tierId, input.tierId),
              sql`${subscriptions.provider} is null`,
              sql`${subscriptions.status} not in ('canceled', 'expired')`,
            ),
          )
          .limit(1)
      )[0];
    if (!subscription) throw new ApiError(409, "subscriptionConflict");

    await tx
      .update(subscriptions)
      .set({
        status: "active",
        cancelAtPeriodEnd: false,
        canceledAt: null,
        currentPeriodEndsAt: periodEndsAt,
        updatedAt: sql`now()`,
      })
      .where(eq(subscriptions.id, subscription.id));
    await enqueueRenewalReminder(tx, subscription.id, periodEndsAt);
  });
}

export async function disableManualRenewalReminder(input: {
  userId: string;
  tierId: string;
}): Promise<void> {
  await getDb()
    .update(subscriptions)
    .set({
      status: "canceled",
      cancelAtPeriodEnd: true,
      canceledAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(subscriptions.userId, input.userId),
        eq(subscriptions.tierId, input.tierId),
        sql`${subscriptions.provider} is null`,
        sql`${subscriptions.status} not in ('canceled', 'expired')`,
      ),
    );
}

export async function getManualReminderTiers(userId: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ tierId: subscriptions.tierId })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        sql`${subscriptions.provider} is null`,
        eq(subscriptions.status, "active"),
      ),
    );
  return new Set(rows.map((row) => row.tierId));
}

export async function handleRenewalReminder(input: {
  subscriptionId: string;
  periodEndsAt: Date;
}): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({
        subscription: subscriptions,
        email: users.email,
        locale: users.locale,
        tierName: membershipTiers.name,
      })
      .from(subscriptions)
      .innerJoin(users, eq(users.id, subscriptions.userId))
      .innerJoin(membershipTiers, eq(membershipTiers.id, subscriptions.tierId))
      .where(eq(subscriptions.id, input.subscriptionId))
      .limit(1);
    if (!row || row.subscription.status !== "active") return;
    if (
      row.subscription.currentPeriodEndsAt &&
      row.subscription.currentPeriodEndsAt > input.periodEndsAt
    )
      return;

    const iso = periodIso(input.periodEndsAt);
    await enqueueTask(tx, {
      kind: "email",
      dedupeKey: `email:renewal_reminder:${input.subscriptionId}:${iso}`,
      payload: {
        template: "renewal_reminder",
        to: row.email,
        locale: row.locale,
        params: { tierName: row.tierName, endsAt: iso },
      },
    });
  });
}
