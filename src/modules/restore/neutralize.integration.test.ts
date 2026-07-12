import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  notificationCampaigns,
  notificationDeliveries,
  paymentProviderEvents,
  posts,
  tasks,
  users,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { createStorageDeleteDedupeKeyForTests } from "@/modules/file/cleanup";

import {
  NEUTRALIZED_EMAIL_LAST_ERROR,
  NEUTRALIZED_NOTIFICATION_LAST_ERROR,
  neutralizeRestoredTasks,
} from "./neutralize";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("restore neutralize integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  it("deletes all storage.delete_object tasks and normalizes provider events and reconcile", async () => {
    const [event] = await db
      .insert(paymentProviderEvents)
      .values({
        provider: "stripe",
        providerEventId: `evt_${randomUUID()}`,
        eventType: "invoice.paid",
        providerCreatedAt: new Date(),
        payloadJson: { id: "evt" },
        status: "processing",
        lockedBy: "worker",
        leaseUntil: new Date(Date.now() + 60_000),
        attempts: 3,
      })
      .returning();

    const deletePayload = {
      storageDriver: "local" as const,
      bucket: null,
      objectKey: "orphan.png",
    };

    await db.insert(tasks).values([
      {
        kind: "storage.delete_object",
        dedupeKey: createStorageDeleteDedupeKeyForTests(deletePayload),
        payloadJson: deletePayload,
        status: "succeeded",
      },
      {
        kind: "payment_provider_event.dispatch",
        dedupeKey: `payment-provider-event:${event!.id}`,
        payloadJson: { eventRowId: event!.id },
        status: "processing",
        attempts: 2,
        lockedBy: "worker",
      },
      {
        kind: "subscription.reconcile",
        dedupeKey: "subscription.reconcile",
        payloadJson: {},
        status: "dead",
      },
      {
        kind: "publish_post",
        payloadJson: { postId: randomUUID() },
        status: "failed",
        attempts: 4,
        lastError: "boom",
      },
      {
        kind: "email",
        dedupeKey: `email:renewal_reminder:${randomUUID()}`,
        payloadJson: { template: "renewal_reminder", to: "fan@example.com" },
        status: "processing",
        attempts: 2,
      },
      {
        kind: "email",
        dedupeKey: `email:renewal_reminder:${randomUUID()}:${new Date("2026-07-12T00:00:00.000Z").toISOString()}`,
        payloadJson: {
          version: 2,
          template: "renewal_reminder",
          subscriptionId: randomUUID(),
          periodEndsAt: "2026-07-12T00:00:00.000Z",
        },
        status: "processing",
        attempts: 2,
      },
      {
        kind: "email",
        dedupeKey: `email:membership_activated:${randomUUID()}`,
        payloadJson: {
          version: 2,
          template: "membership_activated",
          paymentRequestId: randomUUID(),
          membershipId: randomUUID(),
        },
        status: "pending",
      },
    ]);

    const report = await neutralizeRestoredTasks(db);

    expect(report.deletedStorageDeleteTasks).toBe(1);
    expect(report.providerEventsReset).toBe(1);
    expect(report.providerDispatchTasksEnsured).toBe(1);
    expect(report.emailRenewalRemindersReset).toBe(1);
    expect(report.emailDeliveryNeutralized).toBe(2);
    expect(report.otherTasksReset).toBe(2);
    expect(report.subscriptionReconcileNormalized).toBe(true);

    const remainingTasks = await db.select().from(tasks);
    expect(remainingTasks.some((task) => task.kind === "storage.delete_object")).toBe(false);

    const [updatedEvent] = await db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.id, event!.id));
    expect(updatedEvent).toMatchObject({
      status: "received",
      lockedBy: null,
      leaseUntil: null,
      error: null,
      attempts: 0,
    });

    const dispatchTasks = remainingTasks.filter(
      (task) => task.kind === "payment_provider_event.dispatch",
    );
    expect(dispatchTasks).toHaveLength(1);
    expect(dispatchTasks[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      dedupeKey: `payment-provider-event:${event!.id}`,
    });

    const reconcileTasks = remainingTasks.filter((task) => task.kind === "subscription.reconcile");
    expect(reconcileTasks).toHaveLength(1);
    expect(reconcileTasks[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      dedupeKey: "subscription.reconcile",
    });

    const neutralizedEmail = remainingTasks.find(
      (task) =>
        task.kind === "email" &&
        (task.payloadJson as { template?: string }).template === "membership_activated",
    );
    expect(neutralizedEmail).toMatchObject({
      status: "dead",
      lastError: NEUTRALIZED_EMAIL_LAST_ERROR,
      payloadJson: {
        version: 2,
        template: "membership_activated",
        recipientRedacted: true,
      },
    });
    expect(JSON.stringify(neutralizedEmail!.payloadJson)).not.toContain("@");

    const resetRenewal = remainingTasks.find(
      (task) =>
        task.kind === "email" &&
        (task.payloadJson as { template?: string; version?: number }).template ===
          "renewal_reminder" &&
        (task.payloadJson as { version?: number }).version === 2,
    );
    expect(resetRenewal).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
    });

    const rawRecipientEmailTasks = remainingTasks.filter(
      (task) =>
        task.kind === "email" &&
        typeof task.payloadJson === "object" &&
        task.payloadJson !== null &&
        "to" in task.payloadJson,
    );
    expect(rawRecipientEmailTasks).toHaveLength(0);

    const resetPublish = remainingTasks.find((task) => task.kind === "publish_post");
    expect(resetPublish).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
    });
  });

  it("dead-letters restored notification tasks and related campaign state", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `restore-${randomUUID()}@example.test` })
      .returning();
    const postRows = await db
      .insert(posts)
      .values([
        {
          title: "Deliver",
          slug: `deliver-${randomUUID()}`,
          visibility: "public",
          status: "published",
          publishedAt: new Date(),
        },
        {
          title: "Expand",
          slug: `expand-${randomUUID()}`,
          visibility: "public",
          status: "published",
          publishedAt: new Date(),
        },
        {
          title: "Finalize",
          slug: `finalize-${randomUUID()}`,
          visibility: "public",
          status: "published",
          publishedAt: new Date(),
        },
      ])
      .returning();
    const campaigns = await db
      .insert(notificationCampaigns)
      .values(
        postRows.map((post) => ({
          postId: post.id,
          source: "manual_publish" as const,
          status: "sending" as const,
          publishedAt: post.publishedAt!,
        })),
      )
      .returning();
    const taskRows = await db
      .insert(tasks)
      .values([
        {
          kind: "notification.deliver",
          dedupeKey: `notification:delivery:${randomUUID()}`,
          payloadJson: { version: 1, userId: user!.id },
          status: "processing",
          attempts: 2,
          lockedBy: "worker",
        },
        {
          kind: "notification.campaign_expand",
          dedupeKey: `notification:campaign_expand:${campaigns[1]!.id}`,
          payloadJson: { version: 1, campaignId: campaigns[1]!.id },
          status: "pending",
        },
        {
          kind: "notification.campaign_finalize",
          dedupeKey: `notification:campaign_finalize:${campaigns[2]!.id}`,
          payloadJson: { version: 1, campaignId: campaigns[2]!.id },
          status: "failed",
          attempts: 1,
        },
      ])
      .returning();
    await db.insert(notificationDeliveries).values({
      campaignId: campaigns[0]!.id,
      userId: user!.id,
      taskId: taskRows[0]!.id,
      status: "sending",
      attemptCount: 1,
    });

    const report = await neutralizeRestoredTasks(db);

    expect(report.notificationTasksNeutralized).toBe(3);
    expect(report.notificationDeliveriesNeutralized).toBe(1);
    expect(report.notificationCampaignsNeutralized).toBe(3);

    const storedTasks = await db
      .select()
      .from(tasks)
      .where(
        inArray(
          tasks.id,
          taskRows.map((row) => row.id),
        ),
      );
    expect(storedTasks).toHaveLength(3);
    expect(storedTasks.every((task) => task.status === "dead")).toBe(true);
    expect(
      storedTasks.every((task) => task.lastError === NEUTRALIZED_NOTIFICATION_LAST_ERROR),
    ).toBe(true);

    const storedCampaigns = await db.select().from(notificationCampaigns);
    expect(storedCampaigns.every((campaign) => campaign.status === "dead")).toBe(true);
    expect(
      storedCampaigns.every(
        (campaign) => campaign.lastError === NEUTRALIZED_NOTIFICATION_LAST_ERROR,
      ),
    ).toBe(true);

    const [storedDelivery] = await db.select().from(notificationDeliveries);
    expect(storedDelivery).toMatchObject({
      status: "dead",
      lastError: NEUTRALIZED_NOTIFICATION_LAST_ERROR,
    });
  });

  it("preserves terminal delivery and campaign outcomes when only the task lagged behind", async () => {
    const [user] = await db
      .insert(users)
      .values({ email: `restore-${randomUUID()}@example.test` })
      .returning();
    const postRows = await db
      .insert(posts)
      .values([
        {
          title: "Accepted delivery",
          slug: `accepted-${randomUUID()}`,
          visibility: "public",
          status: "published",
          publishedAt: new Date(),
        },
        {
          title: "Completed campaign",
          slug: `completed-${randomUUID()}`,
          visibility: "public",
          status: "published",
          publishedAt: new Date(),
        },
      ])
      .returning();
    const campaigns = await db
      .insert(notificationCampaigns)
      .values([
        {
          postId: postRows[0]!.id,
          source: "manual_publish" as const,
          status: "completed" as const,
          publishedAt: postRows[0]!.publishedAt!,
          completedAt: new Date(),
        },
        {
          postId: postRows[1]!.id,
          source: "manual_publish" as const,
          status: "completed" as const,
          publishedAt: postRows[1]!.publishedAt!,
          completedAt: new Date(),
        },
      ])
      .returning();
    const taskRows = await db
      .insert(tasks)
      .values([
        {
          kind: "notification.deliver",
          dedupeKey: `notification:delivery:${randomUUID()}`,
          payloadJson: { version: 1, userId: user!.id },
          status: "processing",
          attempts: 1,
          lockedBy: "worker",
        },
        {
          kind: "notification.campaign_finalize",
          dedupeKey: `notification:campaign_finalize:${campaigns[1]!.id}`,
          payloadJson: { version: 1, campaignId: campaigns[1]!.id },
          status: "processing",
          attempts: 1,
          lockedBy: "worker",
        },
      ])
      .returning();
    await db.insert(notificationDeliveries).values({
      campaignId: campaigns[0]!.id,
      userId: user!.id,
      taskId: taskRows[0]!.id,
      status: "accepted",
      attemptCount: 1,
      lastOutcome: "accepted",
    });

    const report = await neutralizeRestoredTasks(db);

    expect(report.notificationTasksNeutralized).toBe(2);
    expect(report.notificationDeliveriesNeutralized).toBe(0);
    expect(report.notificationCampaignsNeutralized).toBe(0);

    const storedTasks = await db
      .select()
      .from(tasks)
      .where(
        inArray(
          tasks.id,
          taskRows.map((row) => row.id),
        ),
      );
    expect(storedTasks.every((task) => task.status === "dead")).toBe(true);

    const [storedDelivery] = await db.select().from(notificationDeliveries);
    expect(storedDelivery).toMatchObject({ status: "accepted", lastError: null });

    const storedCampaigns = await db.select().from(notificationCampaigns);
    expect(storedCampaigns).toHaveLength(2);
    expect(storedCampaigns.every((campaign) => campaign.status === "completed")).toBe(true);
    expect(storedCampaigns.every((campaign) => campaign.lastError === null)).toBe(true);
  });

  it("releases storage delete dedupe keys so converge can enqueue orphan cleanup later", async () => {
    const deletePayload = {
      storageDriver: "local" as const,
      bucket: null,
      objectKey: "recovered/orphan.png",
    };
    const dedupeKey = createStorageDeleteDedupeKeyForTests(deletePayload);

    await db.insert(tasks).values({
      kind: "storage.delete_object",
      dedupeKey,
      payloadJson: deletePayload,
      status: "dead",
    });

    await neutralizeRestoredTasks(db);

    await db.insert(tasks).values({
      kind: "storage.delete_object",
      dedupeKey,
      payloadJson: deletePayload,
      status: "pending",
    });

    const rows = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.status, ["pending", "processing", "failed", "dead", "succeeded"]));
    expect(rows.filter((task) => task.dedupeKey === dedupeKey)).toHaveLength(1);
    expect(rows.find((task) => task.dedupeKey === dedupeKey)?.status).toBe("pending");
  });
});
