import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import { paymentProviderEvents, tasks } from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { createStorageDeleteDedupeKeyForTests } from "@/modules/file/cleanup";

import { NEUTRALIZED_EMAIL_LAST_ERROR, neutralizeRestoredTasks } from "./neutralize";

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
        dedupeKey: `email:membership_activated:${randomUUID()}`,
        payloadJson: { template: "membership_activated", to: "fan@example.com" },
        status: "pending",
      },
    ]);

    const report = await neutralizeRestoredTasks(db);

    expect(report.deletedStorageDeleteTasks).toBe(1);
    expect(report.providerEventsReset).toBe(1);
    expect(report.providerDispatchTasksEnsured).toBe(1);
    expect(report.emailRenewalRemindersReset).toBe(1);
    expect(report.emailDeliveryNeutralized).toBe(1);
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
    });

    const resetPublish = remainingTasks.find((task) => task.kind === "publish_post");
    expect(resetPublish).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
    });
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
