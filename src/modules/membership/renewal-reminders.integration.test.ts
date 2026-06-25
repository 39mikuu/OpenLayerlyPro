import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { memberships, membershipTiers, subscriptions, tasks, users } from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { grantMembership } from "@/modules/membership";
import { runTaskHandler } from "@/modules/tasks/handlers";

import {
  disableManualRenewalReminder,
  enableManualRenewalReminder,
  handleRenewalReminder,
  reminderRunAfter,
} from "./renewal-reminders";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("manual renewal reminders", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  async function seed() {
    const [user] = await db
      .insert(users)
      .values({ email: `reminder-${randomUUID()}@example.test`, locale: "ja" })
      .returning();
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name: "Supporter",
        slug: `supporter-${randomUUID()}`,
        priceLabel: "$5",
        level: 10,
        durationDays: 30,
      })
      .returning();
    const granted = await grantMembership({
      userId: user!.id,
      tierId: tier!.id,
      source: "manual",
      durationDays: 30,
    });
    return { user: user!, tier: tier!, membership: granted.membership };
  }

  it("creates one provider-null non-terminal row concurrently and schedules the exact lead time", async () => {
    const { user, tier, membership } = await seed();

    await Promise.all([
      enableManualRenewalReminder({ userId: user.id, tierId: tier.id }),
      enableManualRenewalReminder({ userId: user.id, tierId: tier.id }),
    ]);

    const rows = await db.select().from(subscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: null, status: "active", tierId: tier.id });
    expect(rows[0]!.currentPeriodEndsAt?.toISOString()).toBe(membership.endsAt.toISOString());

    const reminderTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.kind, "subscription.renewal_reminder"));
    expect(reminderTasks).toHaveLength(1);
    expect(reminderTasks[0]!.runAfter.toISOString()).toBe(
      reminderRunAfter(membership.endsAt).toISOString(),
    );
    expect(reminderTasks[0]!.dedupeKey).toBe(
      `subscription-reminder:${rows[0]!.id}:${membership.endsAt.toISOString()}`,
    );
  });

  it("enqueues one localized email for a period and no-ops for duplicate, stale, or canceled work", async () => {
    const { user, tier, membership } = await seed();
    await enableManualRenewalReminder({ userId: user.id, tierId: tier.id });
    const [subscription] = await db.select().from(subscriptions);

    await Promise.all([
      handleRenewalReminder({
        subscriptionId: subscription!.id,
        periodEndsAt: membership.endsAt,
      }),
      handleRenewalReminder({
        subscriptionId: subscription!.id,
        periodEndsAt: membership.endsAt,
      }),
    ]);

    let emailTasks = await db.select().from(tasks).where(eq(tasks.kind, "email"));
    expect(emailTasks).toHaveLength(1);
    expect(emailTasks[0]!.dedupeKey).toBe(
      `email:renewal_reminder:${subscription!.id}:${membership.endsAt.toISOString()}`,
    );
    expect(emailTasks[0]!.payloadJson).toMatchObject({
      template: "renewal_reminder",
      to: user.email,
      locale: "ja",
      params: { tierName: tier.name, endsAt: membership.endsAt.toISOString() },
    });

    const later = new Date(membership.endsAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    await db
      .update(subscriptions)
      .set({ currentPeriodEndsAt: later })
      .where(eq(subscriptions.id, subscription!.id));
    await handleRenewalReminder({
      subscriptionId: subscription!.id,
      periodEndsAt: membership.endsAt,
    });

    await disableManualRenewalReminder({ userId: user.id, tierId: tier.id });
    await handleRenewalReminder({ subscriptionId: subscription!.id, periodEndsAt: later });
    emailTasks = await db.select().from(tasks).where(eq(tasks.kind, "email"));
    expect(emailTasks).toHaveLength(1);
  });

  it("advances the period and schedules the next reminder inside a successful grant transaction", async () => {
    const { user, tier, membership } = await seed();
    await enableManualRenewalReminder({ userId: user.id, tierId: tier.id });
    const [subscription] = await db.select().from(subscriptions);

    const next = await grantMembership({
      userId: user.id,
      tierId: tier.id,
      source: "payment_review",
      durationDays: 30,
    });

    const [updated] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscription!.id));
    expect(updated!.currentPeriodEndsAt?.toISOString()).toBe(next.membership.endsAt.toISOString());

    const [nextTask] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.kind, "subscription.renewal_reminder"),
          eq(
            tasks.dedupeKey,
            `subscription-reminder:${subscription!.id}:${next.membership.endsAt.toISOString()}`,
          ),
        ),
      );
    expect(nextTask).toBeDefined();
    expect(next.membership.startsAt.toISOString()).toBe(membership.endsAt.toISOString());
  });

  it("uses the maximum eligible non-revoked end as the grant anchor", async () => {
    const { user, tier } = await seed();
    await enableManualRenewalReminder({ userId: user.id, tierId: tier.id });
    const [subscription] = await db.select().from(subscriptions);

    const futureStart = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const futureEnd = new Date(Date.now() + 70 * 24 * 60 * 60 * 1000);
    await db.insert(memberships).values({
      userId: user.id,
      tierId: tier.id,
      source: "gift",
      startsAt: futureStart,
      endsAt: futureEnd,
      status: "active",
    });

    const grant = await grantMembership({
      userId: user.id,
      tierId: tier.id,
      source: "manual",
      durationDays: 10,
    });
    expect(grant.membership.startsAt.toISOString()).toBe(futureEnd.toISOString());

    const [updated] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscription!.id));
    expect(updated!.currentPeriodEndsAt?.toISOString()).toBe(grant.membership.endsAt.toISOString());
  });

  it("task dispatch does not reschedule another reminder", async () => {
    const { user, tier } = await seed();
    await enableManualRenewalReminder({ userId: user.id, tierId: tier.id });
    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.kind, "subscription.renewal_reminder"));

    await runTaskHandler(task!);

    const reminderTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.kind, "subscription.renewal_reminder"));
    expect(reminderTasks).toHaveLength(1);
  });
});
