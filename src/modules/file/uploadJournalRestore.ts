import { eq, sql } from "drizzle-orm";

import type { TxClient } from "@/db";
import { storageUploadJournal, tasks } from "@/db/schema";
import { enqueueTask } from "@/modules/tasks/enqueue";

export const STORAGE_UPLOAD_RECONCILE_MAX_ATTEMPTS = 10;

export function storageUploadCleanupTaskDedupeKey(journalId: string): string {
  return `storage:reconcile_upload:${journalId}`;
}

/** Database-only restore path; keep this isolated from storage adapters and web runtime imports. */
export async function rearmStorageUploadJournalsAfterRestore(tx: TxClient): Promise<number> {
  await tx.delete(tasks).where(eq(tasks.kind, "storage.reconcile_upload"));

  const journals = await tx
    .update(storageUploadJournal)
    .set({
      status: "deleting",
      reconcileAfter: sql`now()`,
      updatedAt: sql`now()`,
    })
    .returning({
      id: storageUploadJournal.id,
      reconcileAfter: storageUploadJournal.reconcileAfter,
    });

  for (const journal of journals) {
    await enqueueTask(tx, {
      id: journal.id,
      kind: "storage.reconcile_upload",
      dedupeKey: storageUploadCleanupTaskDedupeKey(journal.id),
      payload: { journalId: journal.id },
      runAfter: journal.reconcileAfter,
      maxAttempts: STORAGE_UPLOAD_RECONCILE_MAX_ATTEMPTS,
    });
  }

  return journals.length;
}
