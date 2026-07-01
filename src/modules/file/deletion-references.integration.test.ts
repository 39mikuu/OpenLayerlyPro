import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "@/db";
import {
  files,
  membershipTiers,
  paymentMethods,
  paymentRequests,
  postFiles,
  posts,
  siteSettings,
  tasks,
  users,
} from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { deleteFile } from "@/modules/file";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("file deletion reference existence checks", () => {
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
    purpose: "payment_proof" | "content_image" | "cover" | "payment_qr" = "content_image",
    createdBy?: string,
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
        createdBy: createdBy ?? null,
      })
      .returning();
    return file!;
  }

  async function seedPost(overrides: { coverFileId?: string } = {}) {
    const [post] = await db
      .insert(posts)
      .values({
        title: "Post",
        slug: randomUUID(),
        visibility: "public",
        status: "draft",
        coverFileId: overrides.coverFileId ?? null,
      })
      .returning();
    return post!;
  }

  async function seedPaymentRequest(input: {
    userId: string;
    tierId: string;
    proofFileId: string;
  }) {
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: input.userId,
        tierId: input.tierId,
        status: "approved",
        flow: "manual",
        amountLabel: "$10",
        durationDays: 31,
        proofFileId: input.proofFileId,
      })
      .returning();
    return request!;
  }

  it("deletes an unreferenced file and enqueues the storage-delete task", async () => {
    const file = await seedFile("content_image");

    await deleteFile(file.id);

    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(0);
    const queued = await db.select().from(tasks).where(eq(tasks.kind, "storage.delete_object"));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payloadJson).toMatchObject({ objectKey: file.objectKey, bucket: null });
  });

  it("blocks deletion when a post cover references the file", async () => {
    const file = await seedFile("cover");
    await seedPost({ coverFileId: file.id });

    await expect(deleteFile(file.id)).rejects.toMatchObject({
      status: 400,
      code: "fileInUse",
      params: { covers: 1 },
    });
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);
  });

  it("reports the exact cover count when multiple posts reference one cover file", async () => {
    const file = await seedFile("cover");
    await seedPost({ coverFileId: file.id });
    await seedPost({ coverFileId: file.id });
    await seedPost({ coverFileId: file.id });

    await expect(deleteFile(file.id)).rejects.toMatchObject({
      status: 400,
      code: "fileInUse",
      params: { covers: 3 },
    });
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);
  });

  it("blocks deletion when a payment request proof references the file", async () => {
    const { user, tier } = await seedIdentity();
    const file = await seedFile("payment_proof", user.id);
    await seedPaymentRequest({ userId: user.id, tierId: tier.id, proofFileId: file.id });

    await expect(deleteFile(file.id)).rejects.toMatchObject({
      status: 400,
      code: "fileInUse",
      params: { proofs: 1 },
    });
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);
  });

  it("reports the exact shared-proof count when multiple payment requests reference one proof", async () => {
    const { user, tier } = await seedIdentity();
    const file = await seedFile("payment_proof", user.id);
    await seedPaymentRequest({ userId: user.id, tierId: tier.id, proofFileId: file.id });
    await seedPaymentRequest({ userId: user.id, tierId: tier.id, proofFileId: file.id });

    await expect(deleteFile(file.id)).rejects.toMatchObject({
      status: 400,
      code: "fileInUse",
      // The blocked path reports the exact reference count (counted contract), not
      // just presence: two payment requests share this proof.
      params: { proofs: 2 },
    });
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);
  });

  it("blocks deletion when a protected site setting references the file", async () => {
    const file = await seedFile("content_image");
    await db.insert(siteSettings).values({ key: "site_logo_file_id", valueJson: file.id });

    await expect(deleteFile(file.id)).rejects.toMatchObject({
      status: 400,
      code: "fileInUse",
      params: { settings: 1 },
    });
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);
  });

  it("blocks deletion when a payment method QR references the file", async () => {
    const file = await seedFile("payment_qr");
    await db.insert(paymentMethods).values({ name: "Bank", qrFileId: file.id });

    await expect(deleteFile(file.id)).rejects.toMatchObject({
      status: 400,
      code: "fileInUse",
      params: { paymentMethods: 1 },
    });
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);
  });

  it("blocks deletion when a post_files row references the file", async () => {
    const file = await seedFile("content_image");
    const post = await seedPost();
    await db.insert(postFiles).values({ postId: post.id, fileId: file.id, kind: "inline" });

    await expect(deleteFile(file.id)).rejects.toMatchObject({
      status: 400,
      code: "fileInUse",
      params: { postFiles: 1 },
    });
    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);
  });

  it("deletes a file whose only referencing row was removed", async () => {
    const file = await seedFile("cover");
    const post = await seedPost({ coverFileId: file.id });

    await expect(deleteFile(file.id)).rejects.toMatchObject({ code: "fileInUse" });

    await db.delete(posts).where(eq(posts.id, post.id));
    await deleteFile(file.id);

    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(0);
  });
});
