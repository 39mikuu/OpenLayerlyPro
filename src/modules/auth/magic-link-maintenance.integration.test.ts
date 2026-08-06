import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  appEvents,
  magicLinkDeadIntakeAlerts,
  magicLinkDeliveryDispositions,
  magicLinkMintLedger,
  magicLinkRequests,
  magicLinkStuckFenceAlerts,
  magicLinkTokens,
  tasks,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import {
  alertOnDeadMagicLinkIntakes,
  alertOnStuckMagicLinkFences,
  cleanupRetainedMagicLinkRequests,
  reconcileTerminalMagicLinkDeliveries,
} from "./magic-link-maintenance";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("Magic Link reservation maintenance", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  async function seedPendingDelivery(input: {
    reservationId?: string | null;
    reservationUntil?: Date | null;
    taskStatus: "dead" | "succeeded" | "failed" | "processing";
  }) {
    const [request] = await db
      .insert(magicLinkRequests)
      .values({ email: `request-${randomUUID()}@example.test` })
      .returning();
    const [candidate] = await db
      .insert(magicLinkTokens)
      .values({
        email: request.email,
        tokenHash: randomUUID().replaceAll("-", ""),
        keyId: "test",
        expiresAt: new Date(0),
        deliveryState: "pending",
        deliveredAt: null,
        deliveryReservationId: input.reservationId ?? null,
        deliveryReservationUntil: input.reservationUntil ?? null,
        createdAt: new Date(Date.now() - 31 * 60_000),
      })
      .returning();
    const [task] = await db
      .insert(tasks)
      .values({
        kind: "auth.magic_link_email",
        dedupeKey: `maintenance-${candidate.id}`,
        payloadJson: {
          version: 1,
          deliveryProtocol: 2,
          tokenId: candidate.id,
          encryptedToken: "test-encrypted-token",
        },
        queueClass: "auth_delivery_v2",
        status: input.taskStatus,
      })
      .returning();
    const mintedAt = new Date();
    await db
      .update(magicLinkRequests)
      .set({ resolvedAt: mintedAt, mintedAt, mintedTokenId: candidate.id })
      .where(eq(magicLinkRequests.id, request.id));
    await db.insert(magicLinkMintLedger).values({
      requestId: request.id,
      mintedTokenId: candidate.id,
      deliveryTaskId: task.id,
      mintedAt,
    });
    return { request, candidate, task };
  }

  it("only cancels a terminal pending candidate when its reservation is NULL", async () => {
    const seeded = await seedPendingDelivery({ taskStatus: "dead" });

    await expect(reconcileTerminalMagicLinkDeliveries()).resolves.toBe(1);

    const [candidate] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, seeded.candidate.id));
    const [disposition] = await db
      .select()
      .from(magicLinkDeliveryDispositions)
      .where(eq(magicLinkDeliveryDispositions.candidateId, seeded.candidate.id));
    expect(candidate).toMatchObject({
      deliveryState: "cancelled",
      deliveryReservationId: null,
      deliveryReservationUntil: null,
    });
    expect(disposition).toMatchObject({ finalState: "cancelled", reservationId: null });
  });

  it("fails closed when a terminal ledger points at a non-v2 delivery task", async () => {
    const seeded = await seedPendingDelivery({ taskStatus: "dead" });
    const [wrongTask] = await db
      .insert(tasks)
      .values({
        kind: "auth.login_code_email",
        dedupeKey: `maintenance-wrong-task-${seeded.candidate.id}`,
        payloadJson: {
          version: 1,
          codeId: randomUUID(),
          encryptedCode: "test-encrypted-code",
        },
        queueClass: "transactional",
        status: "dead",
      })
      .returning();
    await db
      .update(magicLinkMintLedger)
      .set({ deliveryTaskId: wrongTask!.id })
      .where(eq(magicLinkMintLedger.mintedTokenId, seeded.candidate.id));

    await expect(reconcileTerminalMagicLinkDeliveries()).resolves.toBe(0);
    await expect(
      db.select().from(magicLinkTokens).where(eq(magicLinkTokens.id, seeded.candidate.id)),
    ).resolves.toMatchObject([{ deliveryState: "pending" }]);
    await expect(
      db
        .select()
        .from(magicLinkDeliveryDispositions)
        .where(eq(magicLinkDeliveryDispositions.candidateId, seeded.candidate.id)),
    ).resolves.toHaveLength(0);
  });

  it("retains every non-null reservation fence for terminal tasks and throttles its alert", async () => {
    const reservationId = randomUUID();
    const seeded = await seedPendingDelivery({
      taskStatus: "dead",
      reservationId,
      reservationUntil: new Date(Date.now() - 60_000),
    });

    await expect(reconcileTerminalMagicLinkDeliveries()).resolves.toBe(0);
    await expect(alertOnStuckMagicLinkFences()).resolves.toBe(1);
    await expect(alertOnStuckMagicLinkFences()).resolves.toBe(0);

    const [candidate] = await db
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.id, seeded.candidate.id));
    const alerts = await db
      .select()
      .from(magicLinkStuckFenceAlerts)
      .where(
        and(
          eq(magicLinkStuckFenceAlerts.candidateId, seeded.candidate.id),
          eq(magicLinkStuckFenceAlerts.reservationId, reservationId),
        ),
      );
    const events = await db
      .select()
      .from(appEvents)
      .where(eq(appEvents.type, "magic_link_stuck_fence"));
    expect(candidate).toMatchObject({
      deliveryState: "pending",
      deliveryReservationId: reservationId,
    });
    expect(alerts).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.payloadJson)).not.toContain(seeded.request.email);
  });

  it("durably throttles a dead intake alert without exposing request data", async () => {
    const [request] = await db
      .insert(magicLinkRequests)
      .values({ email: `dead-intake-${randomUUID()}@example.test` })
      .returning();
    const [task] = await db
      .insert(tasks)
      .values({
        kind: "auth.magic_link_request",
        dedupeKey: `dead-intake-${request.id}`,
        payloadJson: { version: 1, requestId: request.id },
        queueClass: "auth_intake",
        status: "dead",
        attempts: 5,
      })
      .returning();

    await expect(alertOnDeadMagicLinkIntakes()).resolves.toBe(1);
    await expect(alertOnDeadMagicLinkIntakes()).resolves.toBe(0);

    const alerts = await db
      .select()
      .from(magicLinkDeadIntakeAlerts)
      .where(eq(magicLinkDeadIntakeAlerts.taskId, task.id));
    const [event] = await db
      .select()
      .from(appEvents)
      .where(eq(appEvents.type, "magic_link_intake_dead"));
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(event?.payloadJson)).not.toContain(request.email);
  });

  it("retains unresolved/dead intake state but removes only aged resolved successful intake rows", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    const [resolved] = await db
      .insert(magicLinkRequests)
      .values({
        email: `retained-${randomUUID()}@example.test`,
        createdAt: old,
        resolvedAt: old,
      })
      .returning();
    const [unresolved] = await db
      .insert(magicLinkRequests)
      .values({
        email: `unresolved-${randomUUID()}@example.test`,
        createdAt: old,
      })
      .returning();
    await db.insert(tasks).values([
      {
        kind: "auth.magic_link_request",
        dedupeKey: `auth-magic-link-request:${resolved.id}`,
        payloadJson: { version: 1, requestId: resolved.id },
        queueClass: "auth_intake",
        status: "succeeded",
      },
      {
        kind: "auth.magic_link_request",
        dedupeKey: `auth-magic-link-request:${unresolved.id}`,
        payloadJson: { version: 1, requestId: unresolved.id },
        queueClass: "auth_intake",
        status: "dead",
      },
    ]);

    await expect(cleanupRetainedMagicLinkRequests()).resolves.toBe(1);
    await expect(
      db.select().from(magicLinkRequests).where(eq(magicLinkRequests.id, resolved.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(magicLinkRequests).where(eq(magicLinkRequests.id, unresolved.id)),
    ).resolves.toHaveLength(1);
  });
});
