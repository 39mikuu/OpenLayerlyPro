import { and, eq, inArray, ne } from "drizzle-orm";

import { type DbClient, getDb } from "@/db";
import {
  files,
  paymentMethods,
  paymentRequests,
  postFiles,
  posts,
  siteSettings,
} from "@/db/schema";
import { getEnv } from "@/lib/env";
import { deleteFileRowWithStorageTask } from "@/modules/file/cleanup";
import { enqueueTask } from "@/modules/tasks";

const RETENTION_KEY = "payment_proof_approved_retention_days";
const FILE_SETTING_KEYS = [
  "artist_avatar_file_id",
  "site_logo_file_id",
  "site_icon_file_id",
] as const;
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);

async function getApprovedRetentionDays(tx: DbClient): Promise<number> {
  const [row] = await tx
    .select({ value: siteSettings.valueJson })
    .from(siteSettings)
    .where(eq(siteSettings.key, RETENTION_KEY))
    .limit(1);
  return typeof row?.value === "number" && Number.isInteger(row.value) ? row.value : 0;
}

export async function enqueuePaymentProofCleanup(
  tx: DbClient,
  request: Pick<
    typeof paymentRequests.$inferSelect,
    "id" | "proofFileId" | "status" | "reviewedAt"
  >,
): Promise<void> {
  if (!request.proofFileId || !request.reviewedAt) return;
  let days: number | null = null;
  if (request.status === "rejected" || request.status === "cancelled") {
    days = getEnv().PAYMENT_PROOF_RETENTION_DAYS;
  } else if (request.status === "approved" || request.status === "reversed") {
    const configured = await getApprovedRetentionDays(tx);
    if (configured > 0) days = configured;
  }
  if (days === null) return;
  await enqueueTask(tx, {
    kind: "payment_proof.cleanup",
    dedupeKey: `proof-cleanup:${request.id}:${request.proofFileId}`,
    payload: { requestId: request.id, fileId: request.proofFileId },
    runAfter: addDays(request.reviewedAt, days),
  });
}

export async function cleanupPaymentProof(input: {
  requestId: string;
  fileId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return getDb().transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(paymentRequests)
      .where(eq(paymentRequests.id, input.requestId))
      .limit(1)
      .for("update");
    const [file] = await tx
      .select()
      .from(files)
      .where(eq(files.id, input.fileId))
      .limit(1)
      .for("update");
    if (!file) return { note: "Payment proof already missing" };

    const [[postRef], [coverRef], [qrRef], settingRefs] = await Promise.all([
      tx
        .select({ id: postFiles.id })
        .from(postFiles)
        .where(eq(postFiles.fileId, input.fileId))
        .limit(1),
      tx.select({ id: posts.id }).from(posts).where(eq(posts.coverFileId, input.fileId)).limit(1),
      tx
        .select({ id: paymentMethods.id })
        .from(paymentMethods)
        .where(eq(paymentMethods.qrFileId, input.fileId))
        .limit(1),
      tx
        .select({ value: siteSettings.valueJson })
        .from(siteSettings)
        .where(inArray(siteSettings.key, [...FILE_SETTING_KEYS])),
    ]);
    if (postRef || coverRef || qrRef || settingRefs.some((row) => row.value === input.fileId)) {
      return { note: "Payment proof is referenced elsewhere" };
    }

    if (request?.proofFileId === input.fileId) {
      if (request.status === "pending_review" || request.status === "pending_payment")
        return { note: "Payment proof is active" };
      if (!request.reviewedAt) return { note: "Payment proof has no review timestamp" };
      let days: number;
      if (request.status === "approved" || request.status === "reversed") {
        days = await getApprovedRetentionDays(tx);
        if (days === 0) return { note: "Approved payment proof retention is permanent" };
      } else if (request.status === "rejected" || request.status === "cancelled") {
        days = getEnv().PAYMENT_PROOF_RETENTION_DAYS;
      } else {
        return { note: "Payment proof state is not eligible" };
      }
      const due = addDays(request.reviewedAt, days);
      if (now < due) return { note: "Payment proof cleanup deferred", deferUntil: due };
    }

    const [otherProofRef] = await tx
      .select({ id: paymentRequests.id })
      .from(paymentRequests)
      .where(
        and(eq(paymentRequests.proofFileId, input.fileId), ne(paymentRequests.id, input.requestId)),
      )
      .limit(1);

    if (request?.proofFileId === input.fileId) {
      await tx
        .update(paymentRequests)
        .set({ proofFileId: null, updatedAt: now })
        .where(eq(paymentRequests.id, request.id));
    }
    if (otherProofRef) {
      return { note: "Payment proof is referenced by another payment request" };
    }

    await deleteFileRowWithStorageTask(tx, file);
    return { note: "Payment proof deleted" };
  });
}
