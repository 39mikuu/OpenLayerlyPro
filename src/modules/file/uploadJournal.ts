import { randomUUID } from "crypto";
import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";

import { type DbClient, getDb, type TxClient } from "@/db";
import { files, storageUploadJournal, tasks } from "@/db/schema";
import { deleteStorageObject } from "@/modules/file/cleanup";
import type { StorageDeletePayload } from "@/modules/file/storageDeleteTask";
import { enqueueTask } from "@/modules/tasks/enqueue";

import {
  STORAGE_UPLOAD_RECONCILE_MAX_ATTEMPTS,
  storageUploadCleanupTaskDedupeKey,
} from "./uploadJournalRestore";

export {
  rearmStorageUploadJournalsAfterRestore,
  STORAGE_UPLOAD_RECONCILE_MAX_ATTEMPTS,
} from "./uploadJournalRestore";

const STORAGE_UPLOAD_RECONCILE_GRACE_MS = 24 * 60 * 60 * 1_000;
export const STORAGE_UPLOAD_TOMBSTONE_RECHECK_MS = 24 * 60 * 60 * 1_000;
export const STORAGE_UPLOAD_RECONCILE_REARM_DELAY_MS = 6 * 60 * 60 * 1_000;

export class StorageUploadJournalOwnershipLostError extends Error {
  constructor() {
    super("Storage upload journal ownership was lost");
    this.name = "StorageUploadJournalOwnershipLostError";
  }
}

export class StorageUploadReconciliationError extends Error {
  constructor(cause: unknown) {
    super("Storage upload reconciliation failed", { cause });
    this.name = "StorageUploadReconciliationError";
  }
}

export type StorageUploadReconcileResult =
  | { outcome: "missing" | "referenced" }
  | { outcome: "defer"; deferUntil: Date };

function assertExactLocation(payload: StorageDeletePayload): void {
  if (
    (payload.storageDriver === "local" && payload.bucket !== null) ||
    (payload.storageDriver === "s3" && !payload.bucket)
  ) {
    throw new Error("Storage upload journal requires an exact object location");
  }
}

export async function createStorageUploadJournal(
  payload: StorageDeletePayload,
  db: DbClient = getDb(),
): Promise<{ id: string; reconcileAfter: Date }> {
  assertExactLocation(payload);
  const id = randomUUID();
  return db.transaction(async (tx) => {
    const [journal] = await tx
      .insert(storageUploadJournal)
      .values({
        id,
        ...payload,
        reconcileAfter: sql`now() + (${STORAGE_UPLOAD_RECONCILE_GRACE_MS} * interval '1 millisecond')`,
      })
      .returning({
        id: storageUploadJournal.id,
        reconcileAfter: storageUploadJournal.reconcileAfter,
      });
    if (!journal) throw new Error("Storage upload journal creation failed");

    await enqueueTask(tx, {
      id,
      kind: "storage.reconcile_upload",
      dedupeKey: storageUploadCleanupTaskDedupeKey(id),
      payload: { journalId: id },
      runAfter: journal.reconcileAfter,
      maxAttempts: STORAGE_UPLOAD_RECONCILE_MAX_ATTEMPTS,
    });
    return journal;
  });
}

async function removeUnclaimedCleanupTask(tx: TxClient, journalId: string): Promise<void> {
  await tx
    .delete(tasks)
    .where(
      and(
        eq(tasks.id, journalId),
        inArray(tasks.status, ["pending", "failed"]),
        eq(tasks.attempts, 0),
      ),
    );
}

export async function consumeStorageUploadJournal(tx: TxClient, journalId: string): Promise<void> {
  const [consumed] = await tx
    .delete(storageUploadJournal)
    .where(and(eq(storageUploadJournal.id, journalId), eq(storageUploadJournal.status, "pending")))
    .returning({ id: storageUploadJournal.id });
  if (!consumed) throw new StorageUploadJournalOwnershipLostError();
  await removeUnclaimedCleanupTask(tx, journalId);
}

export async function rearmExhaustedStorageUploadReconciliationTasks(
  db: DbClient = getDb(),
): Promise<number> {
  const journalExists = exists(
    db
      .select({ id: storageUploadJournal.id })
      .from(storageUploadJournal)
      .where(eq(storageUploadJournal.id, tasks.id)),
  );
  const rearmed = await db
    .update(tasks)
    .set({
      status: "pending",
      attempts: 0,
      runAfter: sql`now() + (${STORAGE_UPLOAD_RECONCILE_REARM_DELAY_MS} * interval '1 millisecond')`,
      lockedAt: null,
      lockedBy: null,
      leaseUntil: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(tasks.kind, "storage.reconcile_upload"), eq(tasks.status, "dead"), journalExists))
    .returning({ id: tasks.id });
  return rearmed.length;
}

function exactFileReferenceCondition(input: StorageDeletePayload) {
  return and(
    eq(files.storageDriver, input.storageDriver),
    eq(files.objectKey, input.objectKey),
    input.bucket === null ? isNull(files.bucket) : eq(files.bucket, input.bucket),
  );
}

export async function reconcileStorageUploadJournal(
  journalId: string,
  options: {
    force?: boolean;
    assertOwnership?: () => Promise<void>;
    deleteObject?: (payload: StorageDeletePayload) => Promise<void>;
  } = {},
): Promise<StorageUploadReconcileResult> {
  const phase = await getDb().transaction(async (tx) => {
    const [selected] = await tx
      .select({
        journal: storageUploadJournal,
        due: sql<boolean>`${storageUploadJournal.reconcileAfter} <= now()`,
      })
      .from(storageUploadJournal)
      .where(eq(storageUploadJournal.id, journalId))
      .limit(1)
      .for("update");
    if (!selected) return { outcome: "missing" } as const;
    const { journal, due } = selected;

    if (options.force !== true && !due) {
      return { outcome: "defer", deferUntil: journal.reconcileAfter } as const;
    }

    const payload: StorageDeletePayload = {
      storageDriver: journal.storageDriver,
      bucket: journal.bucket,
      objectKey: journal.objectKey,
    };
    const [reference] = await tx
      .select({ id: files.id })
      .from(files)
      .where(exactFileReferenceCondition(payload))
      .limit(1);
    if (reference) {
      await tx.delete(storageUploadJournal).where(eq(storageUploadJournal.id, journalId));
      await removeUnclaimedCleanupTask(tx, journalId);
      return { outcome: "referenced" } as const;
    }

    if (journal.status === "pending") {
      await tx
        .update(storageUploadJournal)
        .set({ status: "deleting", updatedAt: sql`now()` })
        .where(eq(storageUploadJournal.id, journalId));
    }
    if (options.force === true) {
      await tx
        .update(tasks)
        .set({ runAfter: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(tasks.id, journalId), inArray(tasks.status, ["pending", "failed"])));
    }
    return { outcome: "delete", payload } as const;
  });

  if (phase.outcome !== "delete") return phase;

  await options.assertOwnership?.();
  try {
    await (
      options.deleteObject ??
      ((payload) => deleteStorageObject(payload, { assertOwnership: options.assertOwnership }))
    )(phase.payload);
  } catch (error) {
    throw new StorageUploadReconciliationError(error);
  }
  await options.assertOwnership?.();

  const [retained] = await getDb()
    .update(storageUploadJournal)
    .set({
      reconcileAfter: sql`now() + (${STORAGE_UPLOAD_TOMBSTONE_RECHECK_MS} * interval '1 millisecond')`,
      updatedAt: sql`now()`,
    })
    .where(eq(storageUploadJournal.id, journalId))
    .returning({ reconcileAfter: storageUploadJournal.reconcileAfter });
  if (!retained) return { outcome: "missing" };
  return { outcome: "defer", deferUntil: retained.reconcileAfter };
}
