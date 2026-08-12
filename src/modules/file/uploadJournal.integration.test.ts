import { and, eq, lte, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getDb } from "@/db";
import { files, storageUploadJournal, tasks } from "@/db/schema";
import { resetDatabase } from "@/modules/__invariants__/db-reset";

import {
  consumeStorageUploadJournal,
  createStorageUploadJournal,
  rearmExhaustedStorageUploadReconciliationTasks,
  reconcileStorageUploadJournal,
  STORAGE_UPLOAD_RECONCILE_REARM_DELAY_MS,
  StorageUploadJournalOwnershipLostError,
  StorageUploadReconciliationError,
} from "./uploadJournal";

const describeWithDatabase =
  process.env.RUN_DB_INTEGRATION_TESTS === "true" ? describe : describe.skip;

const object = {
  storageDriver: "s3" as const,
  bucket: "upload-bucket",
  objectKey: "content/2026/08/crash-window.png",
};

describeWithDatabase("durable storage upload journal", () => {
  const db = getDb();

  beforeEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await resetDatabase(db);
  });

  it("creates the journal and its delayed cleanup task in one transaction", async () => {
    const journal = await createStorageUploadJournal(object);

    await expect(
      db.select().from(storageUploadJournal).where(eq(storageUploadJournal.id, journal.id)),
    ).resolves.toMatchObject([
      {
        id: journal.id,
        ...object,
        status: "pending",
        reconcileAfter: journal.reconcileAfter,
      },
    ]);
    await expect(db.select().from(tasks).where(eq(tasks.id, journal.id))).resolves.toMatchObject([
      {
        id: journal.id,
        kind: "storage.reconcile_upload",
        dedupeKey: `storage:reconcile_upload:${journal.id}`,
        payloadJson: { journalId: journal.id },
        status: "pending",
        maxAttempts: 10,
        queueClass: "maintenance",
      },
    ]);
  });

  it("atomically consumes the journal and unclaimed task with the files row", async () => {
    const journal = await createStorageUploadJournal(object);

    await db.transaction(async (tx) => {
      await consumeStorageUploadJournal(tx, journal.id);
      await tx.insert(files).values({
        ...object,
        originalName: "image.png",
        mimeType: "image/png",
        sizeBytes: 4,
        purpose: "content_image",
      });
    });

    await expect(
      db.select().from(storageUploadJournal).where(eq(storageUploadJournal.id, journal.id)),
    ).resolves.toHaveLength(0);
    await expect(db.select().from(tasks).where(eq(tasks.id, journal.id))).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(files)
        .where(and(eq(files.objectKey, object.objectKey), eq(files.bucket, object.bucket))),
    ).resolves.toHaveLength(1);
  });

  it("keeps failed deletion durable, expedites retry, then reconciles idempotently", async () => {
    const journal = await createStorageUploadJournal(object);
    const deleteObject = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("provider denied delete"), { code: "EACCES" }))
      .mockResolvedValueOnce(undefined);

    await expect(
      reconcileStorageUploadJournal(journal.id, { force: true, deleteObject }),
    ).rejects.toBeInstanceOf(StorageUploadReconciliationError);

    await expect(
      db.select().from(storageUploadJournal).where(eq(storageUploadJournal.id, journal.id)),
    ).resolves.toMatchObject([{ id: journal.id, status: "deleting" }]);
    await expect(
      db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, journal.id), lte(tasks.runAfter, sql`now()`))),
    ).resolves.toHaveLength(1);

    await expect(reconcileStorageUploadJournal(journal.id, { deleteObject })).resolves.toEqual({
      outcome: "deleted",
    });
    await expect(reconcileStorageUploadJournal(journal.id, { deleteObject })).resolves.toEqual({
      outcome: "missing",
    });
    expect(deleteObject).toHaveBeenCalledTimes(2);
    await expect(
      db.select().from(storageUploadJournal).where(eq(storageUploadJournal.id, journal.id)),
    ).resolves.toHaveLength(0);
  });

  it("re-arms an exhausted cleanup task after a cooldown until its journal converges", async () => {
    const journal = await createStorageUploadJournal(object);
    await db
      .update(tasks)
      .set({
        status: "dead",
        attempts: 10,
        lastError: "StorageUploadReconciliationError: Storage upload reconciliation failed",
      })
      .where(eq(tasks.id, journal.id));

    await expect(rearmExhaustedStorageUploadReconciliationTasks(db)).resolves.toBe(1);

    const [rearmed] = await db
      .select({
        task: tasks,
        delayIsBounded: sql<boolean>`${tasks.runAfter} between
          now() + (${STORAGE_UPLOAD_RECONCILE_REARM_DELAY_MS - 1_000} * interval '1 millisecond')
          and now() + (${STORAGE_UPLOAD_RECONCILE_REARM_DELAY_MS + 1_000} * interval '1 millisecond')`,
      })
      .from(tasks)
      .where(eq(tasks.id, journal.id));
    expect(rearmed).toMatchObject({
      task: {
        status: "pending",
        attempts: 0,
        lastError: "StorageUploadReconciliationError: Storage upload reconciliation failed",
      },
      delayIsBounded: true,
    });
    await expect(rearmExhaustedStorageUploadReconciliationTasks(db)).resolves.toBe(0);
  });

  it("does not delete a journal object that already has an exact files reference", async () => {
    const journal = await createStorageUploadJournal(object);
    await db.insert(files).values({
      ...object,
      originalName: "image.png",
      mimeType: "image/png",
      sizeBytes: 4,
      purpose: "content_image",
    });
    const deleteObject = vi.fn();

    await expect(
      reconcileStorageUploadJournal(journal.id, { force: true, deleteObject }),
    ).resolves.toEqual({ outcome: "referenced" });

    expect(deleteObject).not.toHaveBeenCalled();
    await expect(
      db.select().from(storageUploadJournal).where(eq(storageUploadJournal.id, journal.id)),
    ).resolves.toHaveLength(0);
  });

  it("fences a late upload finalizer after cleanup has claimed the journal", async () => {
    const journal = await createStorageUploadJournal(object);
    let releaseDelete!: () => void;
    const deleteBlocked = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deleteObject = vi.fn(async () => deleteBlocked);
    const cleanup = reconcileStorageUploadJournal(journal.id, { force: true, deleteObject });
    await vi.waitFor(() => expect(deleteObject).toHaveBeenCalledOnce());

    await expect(
      db.transaction((tx) => consumeStorageUploadJournal(tx, journal.id)),
    ).rejects.toBeInstanceOf(StorageUploadJournalOwnershipLostError);

    releaseDelete();
    await expect(cleanup).resolves.toEqual({ outcome: "deleted" });
  });

  it("releases the database transaction before external object deletion", async () => {
    const journal = await createStorageUploadJournal(object);
    const deleteObject = vi.fn(async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local lock_timeout = '100ms'`);
        await tx
          .select({ id: storageUploadJournal.id })
          .from(storageUploadJournal)
          .where(eq(storageUploadJournal.id, journal.id))
          .for("update");
      });
    });

    await expect(
      reconcileStorageUploadJournal(journal.id, { force: true, deleteObject }),
    ).resolves.toEqual({ outcome: "deleted" });
  });

  it("defers before the PostgreSQL-authored grace deadline", async () => {
    const journal = await createStorageUploadJournal(object);
    const deleteObject = vi.fn();

    await expect(reconcileStorageUploadJournal(journal.id, { deleteObject })).resolves.toEqual({
      outcome: "defer",
      deferUntil: journal.reconcileAfter,
    });
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("rejects ambiguous driver and bucket identities before any object write", async () => {
    await expect(createStorageUploadJournal({ ...object, bucket: null })).rejects.toThrow(
      "exact object location",
    );
    await expect(
      createStorageUploadJournal({
        storageDriver: "local",
        bucket: "unexpected",
        objectKey: object.objectKey,
      }),
    ).rejects.toThrow("exact object location");
    await expect(db.select().from(storageUploadJournal)).resolves.toHaveLength(0);
    await expect(db.select().from(tasks)).resolves.toHaveLength(0);
  });
});
