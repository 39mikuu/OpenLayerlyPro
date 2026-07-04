import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { mkdir, rm, stat, writeFile } from "fs/promises";
import path from "path";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

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
import { getEnv } from "@/lib/env";
import { resetDatabase } from "@/modules/__invariants__/db-reset";
import { deleteFile } from "@/modules/file";
import { deleteFileRowWithStorageTask } from "@/modules/file/cleanup";
import { lockFileReferences, lockSiteFileSettingReferences } from "@/modules/file/references";
import { resubmitPaymentProof } from "@/modules/payment";
import { cleanupPaymentProof } from "@/modules/payment/proof-lifecycle";
import { setSetting } from "@/modules/site";
import { runTaskHandler } from "@/modules/tasks/handlers";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

describeWithDatabase("file deletion reference existence checks", () => {
  const db = getDb();
  const raw = postgres(getEnv().DATABASE_URL, { max: 12, onnotice: () => {} });

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await raw.end({ timeout: 5 });
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  async function waitForBackendLock(pid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [activity] = await raw<
        {
          wait_event_type: string | null;
        }[]
      >`select wait_event_type from pg_stat_activity where pid = ${pid}`;
      if (activity?.wait_event_type === "Lock") return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`backend ${pid} did not enter a PostgreSQL lock wait`);
  }

  async function waitForQueryLock(queryPattern: string): Promise<{ pid: number; query: string }> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [activity] = await raw<
        {
          pid: number;
          query: string;
        }[]
      >`
        select pid::integer, query
          from pg_stat_activity
         where wait_event_type = 'Lock'
           and query ilike ${queryPattern}
         order by query_start desc
         limit 1
      `;
      if (activity) return activity;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no backend entered a PostgreSQL lock wait for ${queryPattern}`);
  }

  async function waitForLockCount(queryPattern: string, count: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [row] = await raw<{ waiting: number }[]>`
        select count(*)::integer as waiting
          from pg_stat_activity
         where wait_event_type = 'Lock'
           and query ilike ${queryPattern}
      `;
      if ((row?.waiting ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`${count} backends did not enter a PostgreSQL lock wait for ${queryPattern}`);
  }

  async function waitForGrantedTupleLock(pid: number, relation: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const [lock] = await raw<{ granted: boolean }[]>`
        select l.granted
          from pg_locks l
         where l.pid = ${pid}
           and l.locktype = 'tuple'
           and l.relation = ${raw.unsafe(`'${relation}'::regclass`)}
           and l.granted
         limit 1
      `;
      if (lock?.granted) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`backend ${pid} did not show a granted tuple lock on ${relation}`);
  }

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
    purpose:
      | "payment_proof"
      | "content_image"
      | "cover"
      | "payment_qr"
      | "artist_avatar" = "content_image",
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
    status?: "approved" | "rejected";
    reviewedAt?: Date | null;
  }) {
    const [request] = await db
      .insert(paymentRequests)
      .values({
        userId: input.userId,
        tierId: input.tierId,
        status: input.status ?? "approved",
        flow: "manual",
        amountLabel: "$10",
        durationDays: 31,
        proofFileId: input.proofFileId,
        reviewedAt: input.reviewedAt,
      })
      .returning();
    return request!;
  }

  function task(payloadJson: Record<string, unknown>, kind = "storage.delete_object") {
    const now = new Date();
    return {
      id: randomUUID(),
      kind,
      dedupeKey: null,
      payloadJson,
      runAfter: now,
      status: "processing" as const,
      attempts: 1,
      maxAttempts: 5,
      lockedAt: now,
      lockedBy: "worker",
      leaseUntil: new Date(now.getTime() + 60_000),
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
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
    const file = await seedFile("artist_avatar");
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

  it("blocks a quarantine update while a reference transaction holds its file lock", async () => {
    const file = await seedFile("content_image");
    const releaseReference = deferred();
    const referenceLocked = deferred();

    const referenceTransaction = db.transaction(async (tx) => {
      await lockFileReferences(tx, [
        {
          fileId: file.id,
          invalid: (reason) => new Error(reason),
        },
      ]);
      referenceLocked.resolve();
      await releaseReference.promise;
    });
    await referenceLocked.promise;

    const updater = await raw.reserve();
    let quarantineUpdate: Promise<unknown> | undefined;
    try {
      await updater`begin`;
      const [{ pid }] = await updater<{ pid: number }[]>`select pg_backend_pid()::integer as pid`;
      quarantineUpdate =
        updater`update files set quarantined_at = now(), quarantine_reason = 'test' where id = ${file.id}`.then(
          (rows) => rows,
        );

      try {
        await waitForBackendLock(pid!);
      } finally {
        releaseReference.resolve();
        await referenceTransaction;
      }
      await quarantineUpdate;
      await updater`commit`;
    } finally {
      releaseReference.resolve();
      await referenceTransaction.catch(() => {});
      await updater`rollback`.catch(() => {});
      await quarantineUpdate?.catch(() => {});
      await updater.release();
    }

    const [updated] = await db.select().from(files).where(eq(files.id, file.id));
    expect(updated?.quarantinedAt).toBeInstanceOf(Date);
  });

  it("serializes file deletion and reference creation in either arrival order", async () => {
    const post = await seedPost();

    const referenceFirstFile = await seedFile("content_image");
    const reference = await raw.reserve();
    const deletion = await raw.reserve();
    try {
      await reference`begin`;
      await reference`select id from files where id = ${referenceFirstFile.id} for share`;
      await reference`
        insert into post_files (post_id, file_id, kind)
        values (${post.id}, ${referenceFirstFile.id}, 'image')
      `;

      await deletion`begin`;
      const [{ pid }] = await deletion<{ pid: number }[]>`select pg_backend_pid()::integer as pid`;
      const deleteLock =
        deletion`select id from files where id = ${referenceFirstFile.id} for update`.then(
          (rows) => rows,
        );
      try {
        await waitForBackendLock(pid!);
      } catch (error) {
        await reference`rollback`;
        await deleteLock.catch(() => {});
        throw error;
      }
      await reference`commit`;
      await deleteLock;

      const [{ referenced }] = await deletion<{ referenced: boolean }[]>`
        select exists (
          select 1 from post_files where file_id = ${referenceFirstFile.id}
        ) as referenced
      `;
      expect(referenced).toBe(true);
      await deletion`rollback`;

      const deletionFirstFile = await seedFile("content_image");
      await deletion`begin`;
      await deletion`select id from files where id = ${deletionFirstFile.id} for update`;

      await reference`begin`;
      const [{ pid: referencePid }] = await reference<
        { pid: number }[]
      >`select pg_backend_pid()::integer as pid`;
      const referenceLock =
        reference`select id from files where id = ${deletionFirstFile.id} for share`.then(
          (rows) => rows,
        );
      try {
        await waitForBackendLock(referencePid!);
      } catch (error) {
        await deletion`rollback`;
        await referenceLock.catch(() => {});
        throw error;
      }

      await deletion`delete from files where id = ${deletionFirstFile.id}`;
      await deletion`commit`;
      const lockedRows = await referenceLock;
      expect(lockedRows).toHaveLength(0);
      await reference`rollback`;
    } finally {
      await reference`rollback`.catch(() => {});
      await deletion`rollback`.catch(() => {});
      await reference.release();
      await deletion.release();
    }
  });

  it("serializes cleanupPaymentProof and resubmitPaymentProof on the same rejected request without deadlock", async () => {
    const { user, tier } = await seedIdentity();
    const oldProof = await seedFile("payment_proof", user.id);
    const newProof = await seedFile("payment_proof", user.id);
    const request = await seedPaymentRequest({
      userId: user.id,
      tierId: tier.id,
      proofFileId: oldProof.id,
      status: "rejected",
      reviewedAt: new Date(Date.now() - 60 * 86_400_000),
    });
    const fileGate = await raw.reserve();
    try {
      await fileGate`begin`;
      await fileGate`select id from files where id = ${oldProof.id} for update`;

      const cleanup = cleanupPaymentProof({
        requestId: request.id,
        fileId: oldProof.id,
        now: new Date(),
      });
      await waitForQueryLock('%from "files"%');

      const resubmit = resubmitPaymentProof({
        requestId: request.id,
        userId: user.id,
        proofFileId: newProof.id,
      });
      await waitForQueryLock('%from "payment_requests"%');

      await fileGate`commit`;
      await expect(cleanup).resolves.toMatchObject({ note: "Payment proof deleted" });
      await expect(resubmit).resolves.toMatchObject({
        id: request.id,
        status: "pending_review",
        proofFileId: newProof.id,
      });
    } finally {
      await fileGate`rollback`.catch(() => {});
      await fileGate.release();
    }

    await expect(db.select().from(files).where(eq(files.id, oldProof.id))).resolves.toHaveLength(0);
    await expect(db.select().from(files).where(eq(files.id, newProof.id))).resolves.toHaveLength(1);
    const [updated] = await db
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, request.id));
    expect(updated).toMatchObject({ status: "pending_review", proofFileId: newProof.id });
  });

  it("locks multi-file reference requests in deterministic id order when callers pass opposite order", async () => {
    const first = await seedFile("content_image");
    const second = await seedFile("content_image");
    const [lower, higher] = [first, second].sort((a, b) => a.id.localeCompare(b.id));
    const blocker = await raw.reserve();
    const releaseA = deferred();
    const releaseB = deferred();
    let txA: Promise<void> | undefined;
    let txB: Promise<void> | undefined;
    try {
      await blocker`begin`;
      await blocker`select id from files where id = ${lower.id} for update`;

      txA = db.transaction(async (tx) => {
        await lockFileReferences(tx, [
          { fileId: lower.id, invalid: (reason) => new Error(reason) },
          { fileId: higher.id, invalid: (reason) => new Error(reason) },
        ]);
        await releaseA.promise;
      });
      txB = db.transaction(async (tx) => {
        await lockFileReferences(tx, [
          { fileId: higher.id, invalid: (reason) => new Error(reason) },
          { fileId: lower.id, invalid: (reason) => new Error(reason) },
        ]);
        await releaseB.promise;
      });

      await waitForLockCount('%from "files"%', 2);
      const waitingQueries = await raw<{ query: string }[]>`
        select query
          from pg_stat_activity
         where wait_event_type = 'Lock'
           and query ilike '%from "files"%'
      `;
      expect(waitingQueries).toHaveLength(2);
      for (const row of waitingQueries) {
        expect(row.query).toContain('order by "files"."id" asc');
      }

      await blocker`commit`;
      releaseA.resolve();
      releaseB.resolve();
      await Promise.all([txA, txB]);
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      await blocker`rollback`.catch(() => {});
      await txA?.catch(() => {});
      await txB?.catch(() => {});
      await blocker.release();
    }
  });

  it("rolls back file row deletion and storage-delete task enqueue when the caller transaction aborts", async () => {
    const file = await seedFile("content_image");
    const referencedFile = await seedFile("content_image");
    const post = await seedPost();
    const [reference] = await db
      .insert(postFiles)
      .values({ postId: post.id, fileId: referencedFile.id, kind: "inline" })
      .returning();

    await expect(
      db.transaction(async (tx) => {
        await deleteFileRowWithStorageTask(tx, file);
        throw new Error("force rollback after file delete enqueue");
      }),
    ).rejects.toThrow("force rollback after file delete enqueue");

    await expect(db.select().from(files).where(eq(files.id, file.id))).resolves.toHaveLength(1);
    await expect(
      db.select().from(postFiles).where(eq(postFiles.id, reference!.id)),
    ).resolves.toHaveLength(1);
    await expect(
      db.select().from(tasks).where(eq(tasks.kind, "storage.delete_object")),
    ).resolves.toHaveLength(0);
  });

  it("treats retried local storage.delete_object tasks for already-deleted objects as idempotent no-ops", async () => {
    const objectKey = `content_image/${randomUUID()}.png`;
    const fullPath = path.resolve(getEnv().UPLOAD_DIR, objectKey);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, "proof");

    const deleteTask = task({
      storageDriver: "local",
      bucket: null,
      objectKey,
    });

    await expect(runTaskHandler(deleteTask)).resolves.toEqual({});
    await expect(stat(fullPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runTaskHandler(deleteTask)).resolves.toEqual({});
    await expect(stat(fullPath)).rejects.toMatchObject({ code: "ENOENT" });

    // S3/R2 deletion of missing objects is intentionally left to the restore/file
    // E2E environment where a compatible object store is configured.
    await rm(path.dirname(fullPath), { recursive: true, force: true });
  });

  it("does not delete the old site logo while a concurrent setting change to a new file is waiting to commit", async () => {
    const oldLogo = await seedFile("artist_avatar");
    const newLogo = await seedFile("artist_avatar");
    await db.insert(siteSettings).values({ key: "site_logo_file_id", valueJson: oldLogo.id });

    const settingGate = await raw.reserve();
    try {
      await settingGate`begin`;
      await settingGate`select id from files where id = ${newLogo.id} for update`;
      const settingUpdate = setSetting("site_logo_file_id", newLogo.id);
      await waitForQueryLock('%from "files"%');

      await expect(deleteFile(oldLogo.id)).rejects.toMatchObject({ code: "fileInUse" });
      await settingGate`commit`;
      await settingUpdate;
    } finally {
      await settingGate`rollback`.catch(() => {});
      await settingGate.release();
    }

    const [setting] = await db
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.key, "site_logo_file_id"));
    expect(setting?.valueJson).toBe(newLogo.id);
    await expect(db.select().from(files).where(eq(files.id, oldLogo.id))).resolves.toHaveLength(1);
    await expect(db.select().from(files).where(eq(files.id, newLogo.id))).resolves.toHaveLength(1);
  });

  it("does not write a site logo setting to a file that a concurrent delete has already locked", async () => {
    const logo = await seedFile("artist_avatar");
    const deletion = await raw.reserve();
    try {
      await deletion`begin`;
      await deletion`select id from files where id = ${logo.id} for update`;

      const settingUpdate = setSetting("site_logo_file_id", logo.id);
      const waiting = await waitForQueryLock('%from "files"%');
      await waitForGrantedTupleLock(waiting.pid, "files");

      await deletion`delete from files where id = ${logo.id}`;
      await deletion`commit`;
      await expect(settingUpdate).rejects.toMatchObject({
        status: 400,
        code: "invalidRequest",
      });
    } finally {
      await deletion`rollback`.catch(() => {});
      await deletion.release();
    }

    await expect(
      db.select().from(siteSettings).where(eq(siteSettings.key, "site_logo_file_id")),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(files).where(eq(files.id, logo.id))).resolves.toHaveLength(0);
  });

  it("serializes concurrent multi-key site file setting updates without deadlock despite opposite caller order", async () => {
    const avatar = await seedFile("artist_avatar");
    const logo = await seedFile("artist_avatar");
    const [lower, higher] = [avatar, logo].sort((a, b) => a.id.localeCompare(b.id));
    const blocker = await raw.reserve();
    const releaseA = deferred();
    const releaseB = deferred();
    let txA: Promise<void> | undefined;
    let txB: Promise<void> | undefined;
    try {
      await blocker`begin`;
      await blocker`select id from files where id = ${lower.id} for update`;

      txA = db.transaction(async (tx) => {
        await lockSiteFileSettingReferences(tx, {
          artist_avatar_file_id: lower.id,
          site_logo_file_id: higher.id,
        });
        await releaseA.promise;
      });
      txB = db.transaction(async (tx) => {
        await lockSiteFileSettingReferences(tx, {
          site_logo_file_id: higher.id,
          artist_avatar_file_id: lower.id,
        });
        await releaseB.promise;
      });

      await waitForLockCount('%from "files"%', 2);
      await blocker`commit`;
      releaseA.resolve();
      releaseB.resolve();
      await Promise.all([txA, txB]);
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      await blocker`rollback`.catch(() => {});
      await txA?.catch(() => {});
      await txB?.catch(() => {});
      await blocker.release();
    }
  });
});
