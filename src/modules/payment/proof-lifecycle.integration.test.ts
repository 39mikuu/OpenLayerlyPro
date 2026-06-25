import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  auditEvents,
  files,
  membershipTiers,
  paymentProofUploadReservations,
  paymentRequests,
  postFiles,
  posts,
  siteSettings,
  tasks,
  users,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { deleteFile } from "@/modules/file";
import { cleanupPaymentProof, enqueuePaymentProofCleanup } from "@/modules/payment/proof-lifecycle";
import {
  completePaymentProofUploadReservation,
  reservePaymentProofUpload,
} from "@/modules/payment/proof-upload-quota";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("payment proof lifecycle integration", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  async function seedIdentity() {
    const [user] = await db
      .insert(users)
      .values({ email: `${randomUUID()}@example.test`, role: "member" })
      .returning();
    const [tier] = await db
      .insert(membershipTiers)
      .values({
        name: "Supporter",
        slug: randomUUID(),
        priceLabel: "$10",
        level: 10,
        durationDays: 31,
      })
      .returning();
    return { user: user!, tier: tier! };
  }

  async function seedFile(
    userId: string,
    purpose: "payment_proof" | "content_image" = "payment_proof",
  ) {
    const [file] = await db
      .insert(files)
      .values({
        storageDriver: "local",
        bucket: null,
        objectKey: `${purpose}/${randomUUID()}`,
        originalName: `${purpose}.png`,
        mimeType: "image/png",
        sizeBytes: 10,
        purpose,
        createdBy: userId,
      })
      .returning();
    return file!;
  }

  async function seedRequest(input: {
    userId: string;
    tierId: string;
    fileId: string;
    status: "pending_review" | "approved" | "rejected" | "cancelled" | "reversed";
    reviewedAt: Date | null;
  }) {
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: input.userId,
        tierId: input.tierId,
        status: input.status,
        flow: "manual",
        amountLabel: "$10",
        durationDays: 31,
        proofFileId: input.fileId,
        reviewedAt: input.reviewedAt,
      })
      .returning();
    return request!;
  }

  it("rejects admin deletion when post_files references the file", async () => {
    const { user } = await seedIdentity();
    const file = await seedFile(user.id, "content_image");
    const [post] = await db
      .insert(posts)
      .values({
        title: "Post",
        slug: randomUUID(),
        visibility: "public",
        status: "draft",
      })
      .returning();
    await db.insert(postFiles).values({ postId: post!.id, fileId: file.id, kind: "inline" });

    await expect(deleteFile(file.id)).rejects.toMatchObject({
      status: 400,
      code: "fileInUse",
    });
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);
  });

  it("deletes an unreferenced file row and enqueues storage deletion atomically", async () => {
    const { user } = await seedIdentity();
    const file = await seedFile(user.id, "content_image");

    await deleteFile(file.id);

    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(0);
    const queued = await db.select().from(tasks).where(eq(tasks.kind, "storage.delete_object"));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payloadJson).toMatchObject({ objectKey: file.objectKey, bucket: null });
  });

  it("enqueues rejected cleanup and preserves request plus audit while deleting proof", async () => {
    const { user, tier } = await seedIdentity();
    const file = await seedFile(user.id);
    const reviewedAt = new Date("2026-01-01T00:00:00.000Z");
    const request = await seedRequest({
      userId: user.id,
      tierId: tier.id,
      fileId: file.id,
      status: "rejected",
      reviewedAt,
    });
    await db.insert(auditEvents).values({
      entityType: "payment_request",
      entityId: request.id,
      action: "reject",
      actorType: "admin",
      actorId: null,
      correlationId: randomUUID(),
    });

    await db.transaction((tx) => enqueuePaymentProofCleanup(tx, request));
    const cleanupTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.kind, "payment_proof.cleanup"));
    expect(cleanupTasks).toHaveLength(1);

    const result = await cleanupPaymentProof({
      requestId: request.id,
      fileId: file.id,
      now: new Date("2026-03-01T00:00:00.000Z"),
    });
    expect(result.note).toBe("Payment proof deleted");

    const [keptRequest] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    expect(keptRequest?.proofFileId).toBeNull();
    await expect(
      db.select().from(auditEvents).where(eq(auditEvents.entityId, request.id)),
    ).resolves.toHaveLength(1);
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(0);
  });

  it("recomputes approved retention and defers when the setting is extended", async () => {
    const { user, tier } = await seedIdentity();
    const file = await seedFile(user.id);
    const reviewedAt = new Date("2026-01-01T00:00:00.000Z");
    const request = await seedRequest({
      userId: user.id,
      tierId: tier.id,
      fileId: file.id,
      status: "approved",
      reviewedAt,
    });
    await db
      .insert(siteSettings)
      .values({ key: "payment_proof_approved_retention_days", valueJson: 10 });
    await db.transaction((tx) => enqueuePaymentProofCleanup(tx, request));
    await db
      .update(siteSettings)
      .set({ valueJson: 40 })
      .where(eq(siteSettings.key, "payment_proof_approved_retention_days"));

    const result = await cleanupPaymentProof({
      requestId: request.id,
      fileId: file.id,
      now: new Date("2026-01-20T00:00:00.000Z"),
    });
    expect(result.deferUntil?.toISOString()).toBe("2026-02-10T00:00:00.000Z");
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);
  });

  it("keeps approved proof when current setting returns to zero", async () => {
    const { user, tier } = await seedIdentity();
    const file = await seedFile(user.id);
    const request = await seedRequest({
      userId: user.id,
      tierId: tier.id,
      fileId: file.id,
      status: "approved",
      reviewedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await db
      .insert(siteSettings)
      .values({ key: "payment_proof_approved_retention_days", valueJson: 0 });

    const result = await cleanupPaymentProof({
      requestId: request.id,
      fileId: file.id,
      now: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(result.note).toContain("permanent");
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);
  });

  it("deletes a detached resubmitted proof when its original task becomes due", async () => {
    const { user, tier } = await seedIdentity();
    const oldFile = await seedFile(user.id);
    const newFile = await seedFile(user.id);
    const request = await seedRequest({
      userId: user.id,
      tierId: tier.id,
      fileId: newFile.id,
      status: "pending_review",
      reviewedAt: null,
    });

    const result = await cleanupPaymentProof({ requestId: request.id, fileId: oldFile.id });
    expect(result.note).toBe("Payment proof deleted");
    const [kept] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    expect(kept?.proofFileId).toBe(newFile.id);
  });

  it("rolls back both file insertion and reservation success when finalization fails", async () => {
    const { user } = await seedIdentity();
    const reservationId = await reservePaymentProofUpload(user.id);
    const objectKey = `payment_proof/${randomUUID()}`;

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(files).values({
          storageDriver: "local",
          bucket: null,
          objectKey,
          originalName: "proof.png",
          mimeType: "image/png",
          sizeBytes: 10,
          purpose: "payment_proof",
          createdBy: user.id,
        });
        await completePaymentProofUploadReservation(reservationId, true, tx);
        throw new Error("force rollback after finalize");
      }),
    ).rejects.toThrow("force rollback after finalize");

    await expect(
      db.select().from(files).where(eq(files.objectKey, objectKey)),
    ).resolves.toHaveLength(0);
    const [reservation] = await db
      .select()
      .from(paymentProofUploadReservations)
      .where(eq(paymentProofUploadReservations.id, reservationId));
    expect(reservation?.status).toBe("pending");
  });

  it("does not permanently consume quota for failed or expired pending reservations", async () => {
    const { user } = await seedIdentity();
    const failedId = await reservePaymentProofUpload(user.id);
    await completePaymentProofUploadReservation(failedId, false);

    await db.insert(paymentProofUploadReservations).values({
      userId: user.id,
      status: "pending",
      expiresAt: sql`now() - interval '1 minute'`,
    });

    await expect(reservePaymentProofUpload(user.id)).resolves.toEqual(expect.any(String));
  });

  it("serializes concurrent reservations and never exceeds the configured daily limit", async () => {
    const { user } = await seedIdentity();
    const attempts = await Promise.allSettled(
      Array.from({ length: 25 }, () => reservePaymentProofUpload(user.id)),
    );
    const succeeded = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(succeeded).toHaveLength(20);
    expect(rejected).toHaveLength(5);
    for (const attempt of rejected) {
      expect((attempt as PromiseRejectedResult).reason).toMatchObject({
        status: 429,
        code: "uploadQuotaExceeded",
      });
    }
    const active = await db
      .select()
      .from(paymentProofUploadReservations)
      .where(
        and(
          eq(paymentProofUploadReservations.userId, user.id),
          eq(paymentProofUploadReservations.status, "pending"),
        ),
      );
    expect(active).toHaveLength(20);
  });
});
